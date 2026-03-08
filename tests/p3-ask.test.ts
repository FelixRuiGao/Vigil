import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AskPendingError } from "../src/ask.js";
import { createEphemeralLogState } from "../src/ephemeral-log.js";
import { Session } from "../src/session.js";
import { LogIdAllocator, createToolCall } from "../src/log-entry.js";
import { SessionStore, saveLog, createLogSessionMeta } from "../src/persistence.js";
import { asyncRunToolLoop } from "../src/agents/tool-loop.js";
import { BaseProvider, ProviderResponse, Usage } from "../src/providers/base.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSessionLike(projectRoot: string): any {
  const s = Object.create(Session.prototype) as any;
  s.primaryAgent = { name: "Primary", modelConfig: { supportsMultimodal: false } };
  s._progress = undefined;
  s._turnCount = 1;
  s._activeAsk = null;
  s._askHistory = [];
  s._pendingTurnState = null;
  s._projectRoot = projectRoot;
  s._createdAt = new Date().toISOString();
  s._compactCount = 0;
  s._usedContextIds = new Set<string>();
  s._hintState = "none";
  s._thinkingLevel = "default";
  s._cacheHitEnabled = true;
  s._currentMasterPlan = undefined;
  s._currentPhasePlan = undefined;
  s._activeAgents = new Map();
  s._log = [];
  s._idAllocator = new LogIdAllocator();
  s._logListeners = new Set();
  s._agentState = "idle";
  s._currentTurnSignal = null;
  s.onSaveRequest = undefined;
  s._ensureMcp = vi.fn(async () => {});
  s._emitAskRequestedProgress = vi.fn();
  s._emitAskResolvedProgress = vi.fn();
  return s;
}

describe("P3 ask behavior", () => {
  it("creates agent_question asks and requires resolveAgentQuestionAsk", () => {
    const root = makeTempDir("longeragent-p3-agent-question-");
    try {
      const s = makeSessionLike(root);
      const execAsk = (Session.prototype as any)._execAsk;

      let thrown: AskPendingError | undefined;
      expect(() => {
        try {
          execAsk.call(s, {
            questions: [
              {
                question: "Pick one",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          });
        } catch (err) {
          thrown = err as AskPendingError;
          throw err;
        }
      }
      ).toThrow(AskPendingError);

      expect(thrown?.ask?.kind).toBe("agent_question");
      expect(s._activeAsk).toBeNull();
      s._activeAsk = thrown!.ask;
      s._activeAsk.payload.toolCallId = "ask-tool-1";
      s._activeAsk.roundIndex = 3;
      s._log.push(createToolCall(
        "tc-ask-001",
        1,
        3,
        "ask",
        { id: "ask-tool-1", name: "ask", arguments: { questions: [] } },
        { toolCallId: "ask-tool-1", toolName: "ask", agentName: "Primary", contextId: "ask-ctx-1" },
      ));

      expect(() =>
        Session.prototype.resolveAsk.call(s, thrown!.askId, "anything"),
      ).toThrow(/resolveAgentQuestionAsk/i);

      Session.prototype.resolveAgentQuestionAsk.call(s, thrown!.askId, {
        answers: [
          {
            questionIndex: 0,
            selectedOptionIndex: 1,
            answerText: "B",
          },
        ],
      });
      expect(s._activeAsk).toBeNull();
      expect(s._pendingTurnState).toEqual({ stage: "activation" });
      const resolution = s._log.find((e: any) => e.type === "ask_resolution");
      const toolResult = s._log.find((e: any) => e.type === "tool_result");
      expect(resolution).toBeTruthy();
      expect(toolResult).toBeTruthy();
      expect(toolResult.roundIndex).toBe(3);
      expect(toolResult.meta.toolCallId).toBe("ask-tool-1");
      expect(toolResult.meta.contextId).toBe("ask-ctx-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates summarize hint state and hint injection even when activation suspends on ask", async () => {
    const root = makeTempDir("longeragent-p3-ask-hint-");
    try {
      const s = makeSessionLike(root);
      s._updateHintStateAfterApiCall = vi.fn();
      s._checkAndInjectHint = vi.fn();
      s._runActivation = vi.fn(async () => ({
        text: "",
        toolHistory: [],
        totalUsage: { inputTokens: 120, outputTokens: 0 },
        intermediateText: [],
        lastInputTokens: 120,
        lastTotalTokens: 120,
        reasoningContent: "",
        reasoningState: null,
        compactNeeded: false,
        textHandledInLog: false,
        reasoningHandledInLog: false,
        suspendedAsk: {
          ask: {
            id: "ask-1",
            kind: "agent_question",
            createdAt: new Date().toISOString(),
            source: { agentId: "Primary" },
            summary: "Ask pending",
            payload: { questions: [], toolCallId: "ask-tool-1" },
            options: [],
          },
          toolCallId: "ask-tool-1",
          roundIndex: 0,
        },
      }));
      s._log.push(createToolCall(
        "tc-ask-001",
        1,
        0,
        "ask",
        { id: "ask-tool-1", name: "ask", arguments: { questions: [] } },
        { toolCallId: "ask-tool-1", toolName: "ask", agentName: "Primary", contextId: "ask-ctx-1" },
      ));

      const out = await (Session.prototype as any)._runTurnActivationLoop.call(
        s,
        undefined,
        { text: "" },
        { text: "" },
      );

      expect(out).toBe("");
      expect(s._lastInputTokens).toBe(120);
      expect(s._lastTotalTokens).toBe(120);
      expect(s._updateHintStateAfterApiCall).toHaveBeenCalledOnce();
      expect(s._checkAndInjectHint).toHaveBeenCalledOnce();
      const askReq = s._log.find((e: any) => e.type === "ask_request");
      expect(askReq.meta.contextId).toBe("ask-ctx-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports explicit external @file attachments without session permission rules", async () => {
    const projectRoot = makeTempDir("longeragent-p3-attach-proj-");
    const externalDir = makeTempDir("longeragent-p3-attach-ext-");
    try {
      const attachedFile = join(externalDir, "attached.txt");
      writeFileSync(attachedFile, "hello from external attachment\n", "utf-8");

      const s = makeSessionLike(projectRoot);
      const processAttach = (Session.prototype as any)._processFileAttachments;
      const out = await processAttach.call(s, `Inspect @${attachedFile}`);

      expect(typeof out).toBe("string");
      expect(String(out)).toContain("hello from external attachment");
      expect((s as any)._sessionPermissionRules).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});

describe("P3 pending turn helpers", () => {
  it("resumes pre_user_input by re-entering turn with saved user input", async () => {
    const root = makeTempDir("longeragent-p3-resume-pre-");
    try {
      const s = makeSessionLike(root);
      s._pendingTurnState = { stage: "pre_user_input", userInput: "hello" };
      s.turn = vi.fn(async () => "ok");
      const out = await (Session.prototype as any).resumePendingTurn.call(s);
      expect(out).toBe("ok");
      expect(s.turn).toHaveBeenCalledWith("hello", undefined);
      expect(s._pendingTurnState).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes activation by calling the activation loop helper", async () => {
    const root = makeTempDir("longeragent-p3-resume-act-");
    try {
      const s = makeSessionLike(root);
      s._pendingTurnState = { stage: "activation" };
      s._runTurnActivationLoop = vi.fn(async () => "continued");
      const out = await (Session.prototype as any).resumePendingTurn.call(s, { signal: undefined });
      expect(out).toBe("continued");
      expect(s._runTurnActivationLoop).toHaveBeenCalled();
      expect(s._pendingTurnState).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P3 tool-loop ask propagation", () => {
  it("propagates AskPendingError from beforeToolExecute instead of converting it to tool error", async () => {
    class FakeProvider extends BaseProvider {
      async sendMessage(): Promise<ProviderResponse> {
        return new ProviderResponse({
          toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }],
          usage: new Usage(1, 1),
        });
      }
    }

    const runtime = createEphemeralLogState([]);
    await expect(asyncRunToolLoop({
      provider: new FakeProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      toolExecutors: { bash: () => "OK" },
      maxRounds: 1,
      beforeToolExecute: () => {
        throw new AskPendingError("ask-1");
      },
    })).rejects.toBeInstanceOf(AskPendingError);
  });
});

describe("P3 log-native session listing", () => {
  it("formats log.json UTC timestamps into local time for session listing", () => {
    const baseDir = makeTempDir("longeragent-p3-store-list-local-");
    const projectPath = makeTempDir("longeragent-p3-project-list-local-");
    try {
      const store = new SessionStore({ baseDir, projectPath });
      const sessionDir = store.createSession();
      saveLog(sessionDir, createLogSessionMeta({
        sessionId: "legacy",
        createdAt: "2026-02-21T16:00:00Z",
        updatedAt: "2026-02-21T16:00:00Z",
        projectPath,
        modelConfigName: "test",
        summary: "legacy",
        turnCount: 1,
      }), []);

      const sessions = store.listSessions();
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].created).not.toBe("2026-02-21T16:00:00Z");
      expect(sessions[0].created).toMatch(/[+-]\d{2}:\d{2}$/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
