import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildDefaultRegistry, type CommandContext } from "../src/commands.js";
import {
  createSystemPrompt,
  createTurnStart,
  createUserMessage,
  createAssistantText,
  LogIdAllocator,
} from "../src/log-entry.js";
import { saveLog, createLogSessionMeta } from "../src/persistence.js";

function makeTempSession(entries: any[], metaOverrides?: Record<string, unknown>) {
  const tmpDir = join(tmpdir(), `la-resume-test-${randomBytes(4).toString("hex")}`);
  const sessionDir = join(tmpDir, "20260301_chat");
  mkdirSync(sessionDir, { recursive: true });

  const meta = createLogSessionMeta({
    createdAt: "2026-03-01T10:00:00Z",
    turnCount: 1,
    compactCount: 0,
    summary: "hello chat",
    ...metaOverrides,
  });
  saveLog(sessionDir, meta, entries);
  return { tmpDir, sessionDir, meta };
}

describe("resume command", () => {
  it("builds picker options from saved sessions", () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/resume");
    expect(resume?.options).toBeTruthy();

    const options = resume!.options!({
      session: {},
      store: {
        listSessions: vi.fn(() => [
          {
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            summary: "hello",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
    });

    expect(options).toEqual([
      expect.objectContaining({
        value: "1",
      }),
    ]);
    expect(options[0]?.label).toContain("1.");
    expect(options[0]?.label).toContain("hello");
  });

  it("truncates /resume summaries to 25 characters in picker labels", () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/resume");
    expect(resume?.options).toBeTruthy();

    const options = resume!.options!({
      session: {},
      store: {
        listSessions: vi.fn(() => [
          {
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            summary: "123456789012345678901234567890",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
    });

    expect(options[0]?.label).toContain("1234567890123456789012345");
    expect(options[0]?.label).not.toContain("12345678901234567890123456");
  });

  it("restores from log.json and rebuilds conversation", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/resume");
    expect(resume).toBeTruthy();

    const entries = [
      createSystemPrompt("sys-001", 0, "You are helpful"),
      createTurnStart("ts-001", 1),
      createUserMessage("user-001", 1, "Hello!", "Hello!", { contextId: "c1" }),
      createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!"),
    ];
    const { tmpDir, sessionDir } = makeTempSession(entries);

    const store = {
      sessionDir: "",
      listSessions: vi.fn(() => [
        { path: sessionDir, created: "2026-03-01 10:00:00", summary: "hello chat", turns: 1 },
      ]),
    };

    const restoreFromLog = vi.fn();
    const setStore = vi.fn();
    const resetUiState = vi.fn();
    const autoSave = vi.fn();
    const showMessage = vi.fn();

    const ctx: CommandContext = {
      session: {
        restoreFromLog,
        setStore,
        lastInputTokens: 0,
      },
      showMessage,
      store: store as unknown as CommandContext["store"],
      autoSave,
      resetUiState,
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(resetUiState).toHaveBeenCalledTimes(1);
    expect(restoreFromLog).toHaveBeenCalledTimes(1);

    // Check restoreFromLog args
    const [resMeta, resEntries, resIdAlloc] = restoreFromLog.mock.calls[0];
    expect(resMeta.turnCount).toBe(1);
    expect(resEntries).toHaveLength(4);
    expect(resIdAlloc).toBeInstanceOf(LogIdAllocator);

    expect(store.sessionDir).toBe(sessionDir);
    expect(setStore).toHaveBeenCalled();

    expect(showMessage).not.toHaveBeenCalledWith("--- Session restored ---");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows error when no log.json exists", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/resume");

    const tmpDir = join(tmpdir(), `la-resume-test-${randomBytes(4).toString("hex")}`);
    const sessionDir = join(tmpDir, "20260301_chat");
    mkdirSync(sessionDir, { recursive: true });
    // No log.json written

    const store = {
      sessionDir: "",
      listSessions: vi.fn(() => [
        { path: sessionDir, created: "2026-03-01 10:00:00", summary: "test", turns: 1 },
      ]),
    };

    const showMessage = vi.fn();
    const ctx: CommandContext = {
      session: {},
      showMessage,
      store: store as unknown as CommandContext["store"],
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "1");

    expect(showMessage).toHaveBeenCalledWith("No log.json found for this session.");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows local timestamps in /resume list output", async () => {
    const registry = buildDefaultRegistry();
    const resume = registry.lookup("/resume");
    expect(resume).toBeTruthy();

    const showMessage = vi.fn();
    const ctx: CommandContext = {
      session: {},
      showMessage,
      store: {
        listSessions: vi.fn(() => [
          {
            path: "/tmp/s1",
            created: "2026-02-21T08:00:00.000-08:00",
            summary: "123456789012345678901234567890",
            turns: 1,
          },
        ]),
      } as unknown as CommandContext["store"],
      autoSave: vi.fn(),
      resetUiState: vi.fn(),
      commandRegistry: registry,
    };

    await resume!.handler(ctx, "");

    const output = showMessage.mock.calls[0][0] as string;
    expect(output).toContain("2026-02-21 08:00:00");
    expect(output).not.toContain("Z");
    expect(output).toContain("1234567890123456789012345");
    expect(output).not.toContain("12345678901234567890123456");
  });
});
