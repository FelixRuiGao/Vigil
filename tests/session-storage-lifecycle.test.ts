import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Session } from "../src/session.js";
import { SessionStore } from "../src/persistence.js";
import { createLogSessionMeta, loadLog, saveLog } from "../src/persistence.js";
import { projectToApiMessages, projectToTuiEntries } from "../src/log-projection.js";
import {
  LogIdAllocator,
  createAssistantText,
  createReasoning,
  createSummary,
  createSystemPrompt,
  createTokenUpdate,
  createToolCall,
  createUserMessage,
} from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string, store: SessionStore): Session {
  const modelConfig = {
    name: "test-model",
    provider: "openai",
    model: "gpt-5.2",
    maxTokens: 256,
    contextLength: 8192,
    supportsMultimodal: false,
  };

  const primaryAgent = {
    name: "Primary",
    systemPrompt: "ROOT={PROJECT_ROOT}\nART={SESSION_ARTIFACTS}\nSYS={SYSTEM_DATA}",
    tools: [],
    modelConfig,
    _provider: {
      budgetCalcMode: "full_context",
    },
    replaceModelConfig(next: typeof modelConfig) {
      this.modelConfig = next;
    },
  } as any;

  const config = {
    pathOverrides: { projectRoot },
    subAgentModelName: undefined,
    mcpServerConfigs: [],
    getModel: () => modelConfig,
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}

function stubRunActivation(session: Session, text = "ok"): void {
  (session as any)._runActivation = async () => ({
    text,
    lastInputTokens: 1,
    lastTotalTokens: 2,
    totalUsage: {},
    toolHistory: [],
    compactNeeded: false,
  });
}

describe("session storage lifecycle", () => {
  it("round-trips global TUI preferences through SessionStore", () => {
    const baseDir = makeTempDir("longeragent-prefs-base-");
    const projectRoot = makeTempDir("longeragent-prefs-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.saveGlobalPreferences({
        version: 1,
        modelConfigName: "my-openrouter",
        modelProvider: "openrouter",
        modelId: "moonshotai/kimi-k2.5",
        thinkingLevel: "high",
        cacheHitEnabled: false,
      });

      expect(store.loadGlobalPreferences()).toEqual(
        expect.objectContaining({
          modelConfigName: "my-openrouter",
          modelProvider: "openrouter",
          modelId: "moonshotai/kimi-k2.5",
          thinkingLevel: "high",
          cacheHitEnabled: false,
        }),
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("constructs with a store that has no active session directory", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const systemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));

      expect(store.sessionDir).toBeUndefined();
      expect(systemContent).toContain("{SESSION_ARTIFACTS}");
      expect(systemContent).toContain(projectRoot);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates session storage on the first turn and hydrates system paths", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "first-response");

      const result = await session.turn("hello");
      const artifactsDir = store.artifactsDir;
      const systemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));

      expect(result).toBe("first-response");
      expect(store.sessionDir).toBeTruthy();
      expect(artifactsDir).toBeTruthy();
      expect(systemContent).not.toContain("{SESSION_ARTIFACTS}");
      expect(systemContent).toContain(artifactsDir as string);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns /new-style state to unbound storage and recreates on next turn", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "phase-1");

      await session.turn("first");
      const firstSessionDir = store.sessionDir;
      expect(firstSessionDir).toBeTruthy();

      store.clearSession();
      session.resetForNewSession(store);

      const resetSystemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));
      expect(store.sessionDir).toBeUndefined();
      expect(resetSystemContent).toContain("{SESSION_ARTIFACTS}");

      stubRunActivation(session, "phase-2");
      await session.turn("second");

      const secondSessionDir = store.sessionDir;
      const secondArtifactsDir = store.artifactsDir;
      const hydratedSystemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));
      expect(secondSessionDir).toBeTruthy();
      expect(secondSessionDir).not.toBe(firstSessionDir);
      expect(secondArtifactsDir).toBeTruthy();
      expect(hydratedSystemContent).not.toContain("{SESSION_ARTIFACTS}");
      expect(hydratedSystemContent).toContain(secondArtifactsDir as string);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses global preference defaults when resetting for /new", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      session.applyGlobalPreferences({
        version: 1,
        modelConfigName: "test-model",
        modelProvider: "openai",
        modelId: "gpt-5.2",
        thinkingLevel: "high",
        cacheHitEnabled: false,
      });

      session.resetForNewSession(store);

      expect(session.thinkingLevel).toBe("high");
      expect(session.cacheHitEnabled).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores cache-read token counters from log", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const entries = [
        createSystemPrompt("sys-001", "prompt"),
        createTokenUpdate("tok-001", 1, 7171, 6912, 0, 7510),
      ];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      session.restoreFromLog?.(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 1,
          compactCount: 0,
          projectPath: projectRoot,
          modelConfigName: "test-model",
        }),
        entries,
        idAllocator,
      );

      expect(session.lastInputTokens).toBe(7171);
      expect(session.lastTotalTokens).toBe(7510);
      expect((session as any).lastCacheReadTokens).toBe(6912);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores an active plan and re-injects it into provider messages after resume", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;
      const sessionDir = store.createSession();
      const artifactsDir = store.artifactsDir!;
      const planPath = join(artifactsDir, "plan.md");

      writeFileSync(
        planPath,
        [
          "## Checkpoints",
          "- [ ] Explore auth flow",
          "- [ ] Implement fix",
          "",
          "## Implement fix",
          "1. Patch the auth guard",
        ].join("\n"),
        "utf-8",
      );

      const submit = session._execPlan({ action: "submit", file: "plan.md" });
      expect(submit.content).toContain("Plan submitted with 2 checkpoints.");

      const persisted = session.getLogForPersistence();
      saveLog(sessionDir, persisted.meta, [...persisted.entries]);

      const loaded = loadLog(sessionDir);
      expect(loaded.meta.activePlanFile).toBe(planPath);

      const restoredStore = new SessionStore({ baseDir, projectPath: projectRoot });
      restoredStore.sessionDir = sessionDir;
      const restored = makeSession(projectRoot, restoredStore) as any;
      restored.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);

      restored.primaryAgent.asyncRunWithMessages = async (
        getMessages: () => Array<Record<string, unknown>>,
      ) => {
        const messages = getMessages();
        const injected = messages.find((msg) => String(msg.content ?? "").includes("## Active Plan"));
        expect(injected).toBeTruthy();
        expect(String(injected?.content ?? "")).toContain("## Checkpoints");
        expect(String(injected?.content ?? "")).toContain("Explore auth flow");
        return {
          text: "",
          toolHistory: [],
          totalUsage: { inputTokens: 1, outputTokens: 0 },
          intermediateText: [],
          lastInputTokens: 1,
          reasoningContent: "",
          reasoningState: null,
          lastTotalTokens: 1,
          textHandledInLog: false,
          reasoningHandledInLog: false,
        };
      };

      await restored._runActivation();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps the first user message as persisted session summary after summarize", () => {
    const baseDir = makeTempDir("longeragent-summary-base-");
    const projectRoot = makeTempDir("longeragent-summary-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;

      const firstUser = createUserMessage("user-001", 1, "First request", "First request", "c1");
      firstUser.summarized = true;
      firstUser.summarizedBy = "sum-001";

      session._log.push(firstUser);
      session._log.push(
        createSummary("sum-001", 1, "Summary text", "Summary text", "c2", ["user-001"], 1),
      );
      session._log.push(
        createUserMessage("user-002", 2, "Later request", "Later request", "c3"),
      );

      const persisted = session.getLogForPersistence();
      expect(persisted.meta.summary).toBe("First request");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("requestTurnInterrupt captures snapshot, kills active workers, and drops unconsumed state", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const workingAbort = new AbortController();
      const finishedAbort = new AbortController();
      const killShell = vi.fn();
      let woke = false;

      (session as any)._messageQueue = [
        { source: "sub-agent", content: "queued result", timestamp: Date.now() },
      ];
      (session as any)._waitResolver = () => {
        woke = true;
      };
      (session as any)._activeAgents.set("working-agent", {
        promise: new Promise(() => {}),
        abortController: workingAbort,
        numericId: 1,
        template: "explorer",
        startTime: performance.now(),
        status: "working",
        resultText: "",
        elapsed: 0,
        delivered: false,
        phase: "idle",
        recentActivity: [],
        toolCallCount: 0,
      });
      (session as any)._activeAgents.set("finished-agent", {
        promise: Promise.resolve({}),
        abortController: finishedAbort,
        numericId: 2,
        template: "explorer",
        startTime: performance.now(),
        status: "finished",
        resultText: "ready but undelivered",
        elapsed: 1,
        delivered: false,
        phase: "idle",
        recentActivity: [],
        toolCallCount: 3,
      });
      (session as any)._activeShells.set("shell-1", {
        id: "shell-1",
        process: { kill: killShell },
        command: "pnpm dev",
        cwd: projectRoot,
        logPath: join(projectRoot, "shell.log"),
        startTime: performance.now(),
        status: "running",
        exitCode: null,
        signal: null,
        readOffset: 0,
        recentOutput: [],
        explicitKill: false,
      });
      (session as any)._activeAsk = { id: "ask-1", payload: {}, kind: "approval" };
      (session as any)._pendingTurnState = { stage: "pre_user_input" };

      const decision = session.requestTurnInterrupt();

      expect(decision).toEqual({ accepted: true });
      expect(workingAbort.signal.aborted).toBe(true);
      expect(finishedAbort.signal.aborted).toBe(false);
      expect((session as any)._activeAgents.size).toBe(0);
      expect(killShell).toHaveBeenCalledWith("SIGTERM");
      expect((session as any)._activeShells.size).toBe(0);
      expect((session as any)._messageQueue).toEqual([]);
      expect(woke).toBe(true);
      expect((session as any)._waitResolver).toBeNull();
      expect((session as any)._activeAsk).toBeNull();
      expect((session as any)._pendingTurnState).toBeNull();
      expect((session as any)._interruptSnapshot).toMatchObject({
        turnIndex: 0,
        hadActiveAgents: true,
        hadActiveShells: true,
        hadUnconsumed: true,
      });
      expect(String((session as any)._interruptSnapshot.deliveryContent)).toContain("# Sub-Agent");
      expect(String((session as any)._interruptSnapshot.deliveryContent)).toContain("# Shell");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("requestTurnInterrupt rejects interruption during compact phase", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      (session as any)._compactInProgress = true;
      (session as any)._messageQueue = [
        { source: "system", content: "queued", timestamp: Date.now() },
      ];

      const decision = session.requestTurnInterrupt();
      expect(decision).toEqual({ accepted: false, reason: "compact_in_progress" });
      expect((session as any)._messageQueue.length).toBe(1);
      expect((session as any)._interruptSnapshot).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("interruption cleanup drops incomplete reasoning, marks partial text, and closes pending tool calls", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      (session as any)._turnCount = 1;
      (session as any)._interruptSnapshot = {
        turnIndex: 1,
        hadActiveAgents: true,
        hadActiveShells: false,
        hadUnconsumed: true,
        deliveryContent: "# Snapshot\nqueued",
      };
      (session as any)._log = [
        createSystemPrompt("sys-001", "prompt"),
        createToolCall(
          "tc-001",
          1,
          0,
          "edit_file src/a.ts",
          { id: "call-1", name: "edit_file", arguments: { path: "src/a.ts" } },
          { toolCallId: "call-1", toolName: "edit_file", agentName: "Primary", contextId: "ctx-a" },
        ),
        createReasoning("rs-001", 1, 1, "thinking", "thinking", undefined, "ctx-r"),
        createAssistantText("as-001", 1, 1, "partial", "partial", "ctx-r"),
      ];
      const logLenBefore = 1;

      (session as any)._handleInterruption(logLenBefore, "partial", { activationCompleted: false });

      const log = (session as any)._log as any[];
      const interruptedText = log.find((e) => e.id === "as-001");
      expect(interruptedText.display).toContain("[Interrupted here.]");
      expect(interruptedText.content).toContain("[Interrupted here.]");

      const reasoning = log.find((e) => e.id === "rs-001");
      expect(reasoning.discarded).toBe(true);

      const interruptedToolResult = log.find((e) => e.type === "tool_result" && e.meta?.toolCallId === "call-1");
      expect(interruptedToolResult).toBeTruthy();
      expect(interruptedToolResult.content.content).toBe("[Interrupted here.]");

      const interruptionUser = log[log.length - 1];
      expect(interruptionUser.type).toBe("user_message");
      expect(String(interruptionUser.display)).toContain("Last turn was interrupted by the user.");
      expect(String(interruptionUser.display)).toContain("Active sub-agents were killed.");
      expect(String(interruptionUser.display)).toContain("[Snapshot]");
      expect(interruptionUser.tuiVisible).toBe(false);
      expect(interruptionUser.displayKind).toBeNull();

      const tuiEntries = projectToTuiEntries(log);
      expect(tuiEntries.some((entry) => entry.text.includes("Last turn was interrupted by the user."))).toBe(false);
      expect(tuiEntries).toEqual([
        { kind: "tool_call", text: "edit_file src/a.ts", id: "tc-001", startedAt: expect.any(Number), elapsedMs: expect.any(Number) },
        { kind: "assistant", text: "partial", id: "as-001" },
        { kind: "interrupted_marker", text: "[Interrupted here.]", id: "as-001:interrupt" },
      ]);

      const apiMessages = projectToApiMessages(log);
      expect(apiMessages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("Last turn was interrupted by the user."),
      });
      expect((session as any)._interruptSnapshot).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("formats truncated sub-agent output with line-aware resume guidance", async () => {
      const baseDir = makeTempDir("longeragent-lifecycle-base-");
      const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "ok");
      await session.turn("bootstrap");

      const longText = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = (session as any)._formatAgentOutput({
        name: "investigator",
        status: "finished",
        text: longText,
        elapsed: 1.2,
      }) as string;

      expect(rendered).toContain("Output truncated at 12,000 chars");
      const m = rendered.match(/line (\d+)\)/);
      expect(m).toBeTruthy();
      const line = Number(m?.[1] ?? "0");
      expect(line).toBeGreaterThan(1);
      expect(rendered).toContain(`read_file(start_line=${line})`);
      expect(rendered).toContain("do not reread the portion already received");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
