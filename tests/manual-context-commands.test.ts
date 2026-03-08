import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Session } from "../src/session.js";
import { createUserMessage } from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      name: "test-model",
      provider: "test",
      model: "test-model",
      apiKey: "fake",
      temperature: 0,
      maxTokens: 1024,
      contextLength: 8192,
      supportsMultimodal: false,
      supportsThinking: false,
      thinkingBudget: 0,
      supportsWebSearch: false,
      extra: {},
    },
    _provider: {
      budgetCalcMode: "full_context",
      requiresAlternatingRoles: false,
    },
    replaceModelConfig(newConfig: unknown) {
      this.modelConfig = newConfig as typeof this.modelConfig;
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
    getModel: () => primaryAgent.modelConfig,
  } as any;

  return new Session({
    primaryAgent,
    config,
  });
}

describe("manual summarize / compact commands", () => {
  it("runManualSummarize creates a shell user message, arms show_context, and appends user instruction", async () => {
    const projectRoot = makeTempDir("longeragent-manual-summarize-");
    try {
      const session = makeSession(projectRoot) as any;
      session._ensureMcp = vi.fn(async () => {});
      session._runTurnActivationLoop = vi.fn(async () => "ok");
      session._log.push(createUserMessage("user-seed", 0, "seed", "seed", "seed1"));

      const out = await session.runManualSummarize("keep deployment notes");

      expect(out).toBe("ok");
      expect(session._showContextRoundsRemaining).toBe(1);
      expect(session._showContextAnnotations).toBeInstanceOf(Map);
      const injected = session._log.findLast((e: any) => e.type === "user_message");
      expect(injected.display).toBe("[Manual summarize request]");
      expect(String(injected.content)).toContain("Do not continue the main task beyond this summarize request.");
      expect(String(injected.content)).toContain("Additional user instruction for this manual summarize request:");
      expect(String(injected.content)).toContain("keep deployment notes");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("runManualCompact creates a new turn and passes prompt override into compact", async () => {
    const projectRoot = makeTempDir("longeragent-manual-compact-");
    try {
      const session = makeSession(projectRoot) as any;
      session._hintState = "level2_sent";
      session._doAutoCompact = vi.fn(async () => {});

      await session.runManualCompact("preserve open debugging threads");

      expect(session._hintState).toBe("none");
      expect(session._doAutoCompact).toHaveBeenCalledTimes(1);
      const prompt = session._doAutoCompact.mock.calls[0][2] as string;
      expect(prompt).toContain("Additional user instruction for this manual compact request:");
      expect(prompt).toContain("preserve open debugging threads");
      const status = session._log.findLast((e: any) => e.type === "status");
      expect(status.display).toBe("[Manual compact requested]");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks manual commands while a background shell is still running", async () => {
    const projectRoot = makeTempDir("longeragent-manual-blocked-");
    try {
      const session = makeSession(projectRoot) as any;
      session._activeShells.set("dev", {
        id: "dev",
        process: null,
        command: "pnpm dev",
        cwd: projectRoot,
        logPath: join(projectRoot, "dev.log"),
        startTime: 0,
        status: "running",
        exitCode: null,
        signal: null,
        readOffset: 0,
        recentOutput: [],
        explicitKill: false,
      });

      await expect(session.runManualSummarize()).rejects.toThrow("background shells are still running");
      await expect(session.runManualCompact()).rejects.toThrow("background shells are still running");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
