/**
 * Session-level integration tests for the mode switching state machine and
 * the /goal continuation loop, on the scripted-provider harness.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { makeScriptedSession } from "./helpers/session-harness.js";
import { modeStance } from "../src/modes/index.js";

function systemPromptSeenBy(calls: Array<Array<Record<string, unknown>>>, callIdx: number): string {
  const call = calls[callIdx] ?? [];
  for (const message of call) {
    if (message["role"] === "system") {
      const content = message["content"];
      if (typeof content === "string") return content;
    }
  }
  return "";
}

/** Give the harness session a real prompt recipe so the mode section bakes. */
function attachRecipe(internals: any): () => void {
  const dir = mkdtempSync(join(tmpdir(), "fermi-mode-template-"));
  writeFileSync(join(dir, "agent.yaml"), [
    "type: agent",
    "name: main-test",
    "system_prompt_file: system_prompt.md",
    "tool_tier: read_only",
    "max_tool_rounds: 100",
    "",
  ].join("\n"), "utf-8");
  writeFileSync(join(dir, "system_prompt.md"), "You are the test main agent.", "utf-8");
  internals.primaryAgent.promptRecipe = {
    templateDir: dir,
    spec: {
      type: "agent",
      name: "main-test",
      system_prompt_file: "system_prompt.md",
      tool_tier: "read_only",
      max_tool_rounds: 100,
    },
    promptsDirs: [],
  };
  internals._reloadPromptAndTools();
  return () => rmSync(dir, { recursive: true, force: true });
}

describe("mode switching state machine", () => {
  it("a pre-first-message switch bakes the mode instead of injecting", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "ok" }] });
    const cleanup = attachRecipe(h.internals);
    try {
      h.session.setMode("vibe");
      await h.session.turn("hello");

      const sys = systemPromptSeenBy(h.provider.calls, 0);
      expect(sys).toContain("# Mode");
      expect(sys).toContain("**vibe mode**");
      expect(h.provider.sawUserText("switched the working mode")).toBe(false);
      expect(h.internals._bakedMode).toBe("vibe");
      expect(h.internals._activeMode).toBe("vibe");
    } finally {
      cleanup();
      h.dispose();
    }
  });

  it("a mid-session switch injects one full-stance transition notice before the user message", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "one" }, { text: "two" }] });
    const cleanup = attachRecipe(h.internals);
    try {
      await h.session.turn("first");
      h.session.setMode("scale");
      await h.session.turn("second");

      expect(h.provider.sawUserText("switched the working mode to **scale**")).toBe(true);
      // Full stance travels with the notice (scale is not the baked mode).
      expect(h.provider.sawUserText("**scale mode**")).toBe(true);
      expect(h.internals._bakedMode).toBe("default");
      expect(h.internals._activeMode).toBe("scale");

      // Display split: the notice entry is TUI-invisible (never a user
      // bubble); the user sees a dim status line instead.
      const transition = [...h.internals._log].find((e: any) => e.meta?.modeTransition);
      expect(transition.tuiVisible).toBe(false);
      const statusLine = [...h.internals._log].find(
        (e: any) => e.type === "status" && String(e.display).includes("Mode switched to scale"),
      );
      expect(statusLine).toBeDefined();

      // The notice precedes the user message in the second call's payload.
      const userTexts: string[] = [];
      for (const message of h.provider.calls[1]) {
        if (message["role"] !== "user") continue;
        const content = message["content"];
        if (typeof content === "string") userTexts.push(content);
      }
      const noticeIdx = userTexts.findIndex((t) => t.includes("switched the working mode"));
      const inputIdx = userTexts.findIndex((t) => t.includes("second"));
      expect(noticeIdx).toBeGreaterThanOrEqual(0);
      expect(inputIdx).toBeGreaterThan(noticeIdx);
    } finally {
      cleanup();
      h.dispose();
    }
  });

  it("toggling away and back between sends injects nothing", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "one" }, { text: "two" }] });
    const cleanup = attachRecipe(h.internals);
    try {
      await h.session.turn("first");
      h.session.setMode("auto");
      h.session.setMode("scale");
      h.session.setMode("default");
      await h.session.turn("second");

      expect(h.provider.sawUserText("switched the working mode")).toBe(false);
      expect(h.internals._activeMode).toBe("default");
    } finally {
      cleanup();
      h.dispose();
    }
  });

  it("switching back to the baked mode injects the short pointer, not the stance", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    const cleanup = attachRecipe(h.internals);
    try {
      await h.session.turn("first");
      h.session.setMode("vibe");
      await h.session.turn("second");
      h.session.setMode("default");
      await h.session.turn("third");

      expect(h.provider.sawUserText("switched the working mode back to **default**")).toBe(true);
      // The default stance text never travels in a notice (pointer only).
      const stanceMarker = modeStance("default").slice(0, 60);
      let stanceInUserMessage = false;
      for (const call of h.provider.calls) {
        for (const message of call) {
          if (message["role"] === "user" && typeof message["content"] === "string" &&
              (message["content"] as string).includes(stanceMarker)) {
            stanceInUserMessage = true;
          }
        }
      }
      expect(stanceInUserMessage).toBe(false);
    } finally {
      cleanup();
      h.dispose();
    }
  });

  it("agent-initiated summarize cannot cover the active mode-transition notice", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "one" }, { text: "two" }] });
    const cleanup = attachRecipe(h.internals);
    try {
      await h.session.turn("first");
      h.session.setMode("auto");
      await h.session.turn("second");

      const transitionEntry = [...h.internals._log].reverse().find(
        (e: any) => e.meta?.modeTransition,
      );
      expect(transitionEntry).toBeDefined();
      const ctxId = transitionEntry.meta.contextId as string;

      const result = h.internals._execSummarizeContextTool({
        operations: [{ from: ctxId, to: ctxId, content: "gone", reason: "test" }],
      });
      expect(String(result.content)).toContain("active mode stance");
      expect(transitionEntry.discarded ?? false).toBe(false);
    } finally {
      cleanup();
      h.dispose();
    }
  });
});

describe("goal continuation loop", () => {
  it("re-activates after a goal-less final text until update_goal completes", async () => {
    const h = makeScriptedSession({
      rounds: [
        { text: "made some progress" }, // ends without tool calls → continuation
        {
          text: "",
          toolCalls: [{
            id: "t1",
            name: "update_goal",
            arguments: { status: "complete", evidence: "bun test: 10 pass, 0 fail" },
          }],
        },
        { text: "goal done, wrapping up" },
      ],
    });
    try {
      h.session.setGoal("all tests pass: `bun test` exits 0");
      const result = await h.session.turn("go");

      expect(h.provider.sawUserText("Goal continuation")).toBe(true);
      expect(h.session.goal).toBeNull();
      expect(result).toContain("wrapping up");
      expect(h.provider.callCount).toBe(3);

      // Continuation notices are model-only; the user gets a status line.
      const continuation = [...h.internals._log].find((e: any) => e.meta?.goalContinuation);
      expect(continuation.tuiVisible).toBe(false);
      const statusLine = [...h.internals._log].find(
        (e: any) => e.type === "status" && String(e.display).includes("Goal continues"),
      );
      expect(statusLine).toBeDefined();
    } finally {
      h.dispose();
    }
  });

  it("update_goal(blocked) also ends the loop", async () => {
    const h = makeScriptedSession({
      rounds: [
        {
          text: "",
          toolCalls: [{
            id: "t1",
            name: "update_goal",
            arguments: { status: "blocked", evidence: "needs credentials only the user has; tried A/B/C over 3 turns" },
          }],
        },
        { text: "blocked, reporting" },
      ],
    });
    try {
      h.session.setGoal("deploy succeeds");
      const result = await h.session.turn("go");
      expect(h.session.goal).toBeNull();
      expect(result).toContain("reporting");
      expect(h.provider.callCount).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it("setGoal rejects an empty condition (guards the RPC path)", () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      expect(() => h.session.setGoal("")).toThrow("cannot be empty");
      expect(() => h.session.setGoal("   ")).toThrow("cannot be empty");
      expect(h.session.goal).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it("a mode switch during a goal run settles at the next continuation boundary", async () => {
    const h = makeScriptedSession({
      rounds: [
        {
          text: "progress",
          // User presses Tab mid-activation: only selectedMode changes here.
          onCall: () => { h.session.setMode("auto"); },
        },
        {
          text: "",
          toolCalls: [{
            id: "t1",
            name: "update_goal",
            arguments: { status: "complete", evidence: "check passed" },
          }],
        },
        { text: "done" },
      ],
    });
    try {
      h.session.setGoal("finish it");
      await h.session.turn("go");

      // The stance landed before the second provider call, not after the run.
      expect(h.provider.sawUserText("switched the working mode to **auto**")).toBe(true);
      expect(h.internals._activeMode).toBe("auto");
      const call2Texts: string[] = [];
      for (const message of h.provider.calls[1] ?? []) {
        if (message["role"] === "user" && typeof message["content"] === "string") {
          call2Texts.push(message["content"] as string);
        }
      }
      const stanceIdx = call2Texts.findIndex((t) => t.includes("switched the working mode"));
      const contIdx = call2Texts.findIndex((t) => t.includes("Goal continuation"));
      expect(stanceIdx).toBeGreaterThanOrEqual(0);
      expect(contIdx).toBeGreaterThan(stanceIdx);
    } finally {
      h.dispose();
    }
  });

  it("create_goal replaces the active goal; update without a goal errors", async () => {
    const h = makeScriptedSession({ rounds: [] });
    try {
      const created = h.internals._execCreateGoal({ condition: "backlog empty" });
      expect(String(created.content)).toContain("Goal created");
      const replaced = h.internals._execCreateGoal({ condition: "backlog fully empty" });
      expect(String(replaced.content)).toContain("Replaced");
      expect(h.session.goal?.condition).toBe("backlog fully empty");

      h.session.clearGoal();
      const orphan = h.internals._execUpdateGoal({ status: "complete", evidence: "x" });
      expect(String(orphan.content)).toContain("no active goal");
    } finally {
      h.dispose();
    }
  });

  it("no goal → a final text ends the turn normally", async () => {
    const h = makeScriptedSession({ rounds: [{ text: "done" }] });
    try {
      const result = await h.session.turn("hi");
      expect(result).toBe("done");
      expect(h.provider.callCount).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
