import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Session } from "../src/session.js";
import { executeTool } from "../src/tools/basic.js";
import { ToolResult } from "../src/providers/base.js";
import { createAssistantText, createReasoning, createUserMessage } from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      supportsMultimodal: false,
    },
  } as any;

  const sessionArtifacts = mkdtempSync(join(tmpdir(), "longeragent-test-artifacts-"));
  const config = {
    pathOverrides: {
      projectRoot,
      sessionArtifacts,
      systemData: sessionArtifacts,
    },
    subAgentModelName: undefined,
    getModel: () => ({ model: "test" }),
  } as any;

  return new Session({
    primaryAgent,
    config,
  });
}

describe("P4 shell governance", () => {
  it("filters inherited environment variables for bash tool", async () => {
    const prev = process.env["AGENTFLOW_TEST_SECRET"];
    process.env["AGENTFLOW_TEST_SECRET"] = "super-secret-value";
    try {
      const result = await executeTool(
        "bash",
        { command: "printf %s \"$AGENTFLOW_TEST_SECRET\"" },
        { projectRoot: process.cwd() },
      );
      expect(result.content).not.toContain("super-secret-value");
      expect(result.content).toContain("EXIT CODE: 0");
    } finally {
      if (prev === undefined) {
        delete process.env["AGENTFLOW_TEST_SECRET"];
      } else {
        process.env["AGENTFLOW_TEST_SECRET"] = prev;
      }
    }
  });

  it("enforces project-root boundary for bash cwd and supports approved external cwd allowlist", async () => {
    const projectRoot = makeTempDir("longeragent-p4-bash-proj-");
    const externalRoot = makeTempDir("longeragent-p4-bash-ext-");
    try {
      const denied = await executeTool(
        "bash",
        { command: "pwd", cwd: externalRoot },
        { projectRoot },
      );
      expect(denied.content).toContain("project root boundary");

      const allowed = await executeTool(
        "bash",
        { command: "pwd", cwd: externalRoot },
        { projectRoot, externalPathAllowlist: [externalRoot] },
      );
      expect(allowed.content).toContain("STDOUT:");
      expect(allowed.content).toContain(externalRoot);
      expect(allowed.content).toContain("EXIT CODE: 0");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("does not trigger ask preflight for external cwd", () => {
    const projectRoot = makeTempDir("longeragent-p4-preflight-proj-");
    const externalRoot = makeTempDir("longeragent-p4-preflight-ext-");
    try {
      const session = makeSession(projectRoot);

      const preflight = (session as any)._beforeToolExecute({
        agentName: "Primary",
        toolName: "bash",
        toolArgs: { command: "pwd", cwd: externalRoot },
        toolCallId: "tc1",
        summary: "",
      });
      expect(preflight).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("P6 summarize_context behavior", () => {
  it("summarize_context succeeds and hint state is preserved until next API call", () => {
    const projectRoot = makeTempDir("longeragent-p6-summarize-hint-");
    try {
      const session = makeSession(projectRoot);
      (session as any)._hintState = "level1_sent";
      // Add a LogEntry so the projection has the right conversation
      (session as any)._log.push(
        createUserMessage("user-001", 1, "hello", "hello", "seed1"),
      );

      const success = (session as any)._execSummarizeContext({
        operations: [{ context_ids: ["seed1"], summary: "compressed" }],
      }) as ToolResult;
      expect(success.content).toContain("1 succeeded");
      // Hint state is NOT reset by summarize_context itself —
      // it's updated by _updateHintStateAfterApiCall based on actual inputTokens
      expect((session as any)._hintState).toBe("level1_sent");

      const fail = (session as any)._execSummarizeContext({
        operations: [{ context_ids: ["missing"], summary: "will fail" }],
      }) as ToolResult;
      expect(fail.content).toContain("0 succeeded");
      expect((session as any)._hintState).toBe("level1_sent");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("retags text-only final rounds to the preceding user-side context", () => {
    const projectRoot = makeTempDir("longeragent-p6-round-retag-");
    try {
      const session = makeSession(projectRoot) as any;
      session._turnCount = 1;
      session._log.push(
        createUserMessage("user-001", 1, "hello", "hello", "u1"),
        createReasoning("rsn-001", 1, 0, "thinking", "thinking", undefined, "tmp-round"),
        createAssistantText("asst-001", 1, 0, "answer", "answer", "tmp-round"),
      );

      const resolved = session._resolveOutputRoundContextId(1, 0);
      expect(resolved).toBe("u1");

      session._retagRoundEntries(1, 0, resolved);
      expect(session._log[1].meta.contextId).toBe("u1");
      expect(session._log[2].meta.contextId).toBe("u1");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("consumes show_context annotations only after a successful provider round", async () => {
    const projectRoot = makeTempDir("longeragent-p6-show-context-round-");
    try {
      const session = makeSession(projectRoot) as any;
      session._turnCount = 1;
      session._log.push(createUserMessage("user-001", 1, "hello", "hello", "u1"));
      session._showContextRoundsRemaining = 1;
      session._showContextAnnotations = new Map([["u1", "CTX-ANNOT"]]);
      session.primaryAgent._provider = {
        budgetCalcMode: "full_context",
        requiresAlternatingRoles: false,
      };
      session.primaryAgent.modelConfig.maxTokens = 1024;

      session.primaryAgent.asyncRunWithMessages = async (
        getMessages: () => Array<Record<string, unknown>>,
        _appendEntry: unknown,
        _allocId: unknown,
        _turnIndex: unknown,
        _baseRoundIndex: unknown,
        _toolExecutors: unknown,
        _onToolCall: unknown,
        _onTextChunk: unknown,
        _onReasoningChunk: unknown,
        _signal: unknown,
        _contextIdAllocator: unknown,
        _compactCheck: unknown,
        onTokenUpdate?: (inputTokens: number, usage?: { totalTokens?: number }) => void,
      ) => {
        const first = getMessages();
        const second = getMessages();
        expect(String(first[1].content)).toContain("CTX-ANNOT");
        expect(String(second[1].content)).toContain("CTX-ANNOT");
        onTokenUpdate?.(100, { totalTokens: 100 });
        const third = getMessages();
        expect(String(third[1].content)).not.toContain("CTX-ANNOT");
        return {
          text: "",
          toolHistory: [],
          totalUsage: { inputTokens: 100, outputTokens: 0 },
          intermediateText: [],
          lastInputTokens: 100,
          reasoningContent: "",
          reasoningState: null,
          lastTotalTokens: 100,
          textHandledInLog: false,
          reasoningHandledInLog: false,
        };
      };

      await session._runActivation();
      expect(session._showContextRoundsRemaining).toBe(0);
      expect(session._showContextAnnotations).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
