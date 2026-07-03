import { describe, expect, it } from "bun:test";

import {
  AGENT_MODES,
  MODE_DESCRIPTIONS,
  buildModeSection,
  buildModeTransitionNotice,
  coerceAgentMode,
  isAgentMode,
  modeStance,
  nextAgentMode,
} from "../src/modes/index.js";
import { buildContextGuidance } from "../src/modes/context-guidance.js";
import { Config, resolveGuidanceTier } from "../src/config.js";
import { appendModeCompactNote } from "../src/session/compact-prompts.js";
import { ContextManager } from "../src/session/context-manager.js";
import type { AgentMode } from "../src/modes/index.js";

describe("mode registry", () => {
  it("cycles through all four modes in both directions", () => {
    expect(AGENT_MODES).toEqual(["default", "vibe", "scale", "auto"]);
    let m: AgentMode = "default";
    const forward: AgentMode[] = [];
    for (let i = 0; i < 4; i++) {
      m = nextAgentMode(m, 1);
      forward.push(m);
    }
    expect(forward).toEqual(["vibe", "scale", "auto", "default"]);
    expect(nextAgentMode("default", -1)).toBe("auto");
    expect(nextAgentMode("vibe", -1)).toBe("default");
  });

  it("validates and coerces mode values", () => {
    expect(isAgentMode("scale")).toBe(true);
    expect(isAgentMode("plan")).toBe(false);
    expect(coerceAgentMode("auto")).toBe("auto");
    expect(coerceAgentMode("nonsense")).toBe("default");
    expect(coerceAgentMode(undefined)).toBe("default");
  });

  it("every mode has a non-empty stance and description", () => {
    for (const mode of AGENT_MODES) {
      expect(modeStance(mode).length).toBeGreaterThan(100);
      expect(modeStance(mode)).toContain(`**${mode} mode**`);
      expect(MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(0);
    }
  });
});

describe("mode prompt rendering", () => {
  it("baked section wraps the stance under a # Mode heading", () => {
    const section = buildModeSection("vibe");
    expect(section.startsWith("# Mode\n\n")).toBe(true);
    expect(section).toContain(modeStance("vibe"));
  });

  it("transition to a non-baked mode carries the full stance and supersedes priors", () => {
    const notice = buildModeTransitionNotice("scale", "default");
    expect(notice).toContain(modeStance("scale"));
    expect(notice).toContain("replaces");
    expect(notice).toContain("don't retrofit");
  });

  it("transition back to the baked mode is a short pointer, not a full stance", () => {
    const notice = buildModeTransitionNotice("default", "default");
    expect(notice).toContain('"# Mode" section of your system prompt');
    expect(notice.length).toBeLessThan(600);
    expect(notice).not.toContain(modeStance("default"));
  });
});

describe("context guidance tiers", () => {
  it("standard tier adds nothing; detailed tier adds the recipe section", () => {
    expect(buildContextGuidance("standard")).toBe("");
    const detailed = buildContextGuidance("detailed");
    expect(detailed).toContain("# Context Management — Recipes");
    expect(detailed).toContain("show_context");
    expect(detailed).toContain("summarize_context");
  });
});

describe("guidance tier resolution", () => {
  it("family heuristic: Claude/GPT standard, everything else detailed", () => {
    expect(resolveGuidanceTier("claude-opus-4-6")).toBe("standard");
    expect(resolveGuidanceTier("gpt-5.5")).toBe("standard");
    expect(resolveGuidanceTier("o3")).toBe("standard");
    expect(resolveGuidanceTier("kimi-k2.5")).toBe("detailed");
    expect(resolveGuidanceTier("qwen3.5-9b")).toBe("detailed");
  });

  it("custom provider models can override guidance via settings", () => {
    const cfg = new Config({
      localProviders: {
        "my-llm": {
          baseUrl: "http://localhost:9999/v1",
          models: [
            { id: "strong-model", contextLength: 128_000, guidance: "standard" },
            { id: "plain-model", contextLength: 128_000 },
          ],
        },
      },
    });
    expect(cfg.getModel("my-llm:strong-model").guidance).toBe("standard");
    expect(cfg.getModel("my-llm:plain-model").guidance).toBe("detailed");
  });
});

describe("mode-aware compact note", () => {
  it("appends the files-first note only for scale and auto", () => {
    expect(appendModeCompactNote("BASE", "default")).toBe("BASE");
    expect(appendModeCompactNote("BASE", "vibe")).toBe("BASE");
    expect(appendModeCompactNote("BASE", "auto")).toContain("ledger");
    expect(appendModeCompactNote("BASE", "scale")).toContain("design document");
    expect(appendModeCompactNote("BASE", "auto").startsWith("BASE\n\n")).toBe(true);
  });
});

describe("mode-aware hint thresholds", () => {
  function makeManager(mode: AgentMode, guidance: "standard" | "detailed" = "standard") {
    const notices: string[] = [];
    let inputTokens = 0;
    const manager = new ContextManager({
      getModelConfig: () => ({
        contextLength: 1000,
        maxTokens: 0,
        guidance,
      } as never),
      getBudgetCalcMode: () => "full_context",
      isCompactInProgress: () => false,
      canAutoCompact: () => true,
      getLastInputTokens: () => inputTokens,
      deliverSystemNotice: (content) => notices.push(content),
      getMode: () => mode,
    });
    return { manager, notices, setTokens: (n: number) => { inputTokens = n; } };
  }

  it("getSummarizeHintConfig reports base configuration, never mode-effective levels", () => {
    // Persisting effective levels (scale's 40/65) as if the user chose them
    // was a real bug: a plain /summarize_hint toggle would bake them into
    // settings.json. Config reads must stay mode-independent.
    const scale = makeManager("scale");
    expect(scale.manager.getSummarizeHintConfig().level1).toBe(50);
    expect(scale.manager.getSummarizeHintConfig().level2).toBe(75);
    expect(scale.manager.getSummarizeHintConfig().userConfigured).toBe(false);
    const dflt = makeManager("default");
    expect(dflt.manager.getSummarizeHintConfig().level1).toBe(50);
  });

  it("an enabled-only toggle does not count as explicit level configuration", () => {
    const { manager, notices, setTokens } = makeManager("scale");
    manager.setSummarizeHintConfig({ enabled: false });
    manager.setSummarizeHintConfig({ enabled: true });
    expect(manager.getSummarizeHintConfig().userConfigured).toBe(false);
    // Mode defaults still fire: 45% is above scale's 40, below base 50.
    setTokens(450);
    manager.checkAndInjectHint();
    expect(notices.length).toBe(1);
  });

  it("fires the level-1 hint at the mode default threshold", () => {
    const { manager, notices, setTokens } = makeManager("auto");
    setTokens(450); // 45% — above auto's 40, below default's 50
    manager.checkAndInjectHint();
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("ledger");
  });

  it("explicit user configuration overrides mode defaults", () => {
    const { manager, notices, setTokens } = makeManager("auto");
    manager.setSummarizeHintConfig({ level1: 60, level2: 80 });
    expect(manager.getSummarizeHintConfig().level1).toBe(60);
    expect(manager.getSummarizeHintConfig().userConfigured).toBe(true);
    setTokens(450);
    manager.checkAndInjectHint();
    expect(notices.length).toBe(0);
    setTokens(650);
    manager.checkAndInjectHint();
    expect(notices.length).toBe(1);
  });

  it("detailed-tier models get the recipe pointer in hint text", () => {
    const { manager, notices, setTokens } = makeManager("default", "detailed");
    setTokens(550);
    manager.checkAndInjectHint();
    expect(notices[0]).toContain("Context Management — Recipes");
    const std = makeManager("default", "standard");
    std.setTokens(550);
    std.manager.checkAndInjectHint();
    expect(std.notices[0]).not.toContain("Context Management — Recipes");
  });
});
