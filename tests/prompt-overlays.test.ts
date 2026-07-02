import { describe, expect, it } from "bun:test";

import {
  buildModelOverlay,
  overlayMatches,
  OPEN_MODEL_GUARDRAILS,
} from "../src/prompt-overlays.js";

describe("buildModelOverlay (live table)", () => {
  it("returns no overlay for Anthropic-family models", () => {
    expect(buildModelOverlay("anthropic", "claude-opus-4-8")).toBe("");
    expect(buildModelOverlay("openrouter", "anthropic/claude-sonnet-5")).toBe("");
  });

  it("returns no overlay for OpenAI-family models", () => {
    expect(buildModelOverlay("openai", "gpt-5.2")).toBe("");
    expect(buildModelOverlay("openai", "o3-mini")).toBe("");
    expect(buildModelOverlay("copilot", "gpt-5-codex")).toBe("");
  });

  it("returns the open-model guardrails for other families", () => {
    for (const [provider, model] of [
      ["kimi", "kimi-k2-0905-preview"],
      ["deepseek", "deepseek-chat"],
      ["glm", "glm-4.7"],
      ["qwen", "qwen3-coder-plus"],
      ["minimax", "minimax-m2.5"],
      ["openrouter", "moonshotai/kimi-k2"],
    ] as const) {
      const overlay = buildModelOverlay(provider, model);
      expect(overlay.startsWith("# Model-Specific Guidance"), model).toBe(true);
      expect(overlay).toContain(OPEN_MODEL_GUARDRAILS);
    }
  });

  it("returns no overlay for an empty model id", () => {
    expect(buildModelOverlay("kimi", "")).toBe("");
  });
});

describe("overlayMatches", () => {
  it("openModel excludes Claude/GPT families", () => {
    expect(overlayMatches({ openModel: true }, "kimi", "kimi-k2")).toBe(true);
    expect(overlayMatches({ openModel: true }, "anthropic", "claude-opus-4-8")).toBe(false);
    expect(overlayMatches({ openModel: true }, "openai", "o3-mini")).toBe(false);
  });

  it("family matches vendor-prefix-stripped id prefix or exact", () => {
    expect(overlayMatches({ family: "glm" }, "glm", "glm-4.7")).toBe(true);
    expect(overlayMatches({ family: "glm" }, "openrouter", "z-ai/glm-4.7")).toBe(true);
    expect(overlayMatches({ family: "glm" }, "kimi", "kimi-k2")).toBe(false);
    // No accidental prefix bleed: "glm" must be followed by "-" or end.
    expect(overlayMatches({ family: "glm" }, "x", "glmx-1")).toBe(false);
  });

  it("provider matches exactly and is orthogonal to model", () => {
    expect(overlayMatches({ provider: "copilot" }, "copilot", "claude-sonnet-5")).toBe(true);
    expect(overlayMatches({ provider: "copilot" }, "anthropic", "claude-sonnet-5")).toBe(false);
  });

  it("model matches exact string (case-insensitive, vendor prefix stripped) or RegExp", () => {
    expect(overlayMatches({ model: "kimi-k2.5" }, "kimi", "kimi-k2.5")).toBe(true);
    expect(overlayMatches({ model: "kimi-k2.5" }, "openrouter", "moonshotai/Kimi-K2.5")).toBe(true);
    expect(overlayMatches({ model: "kimi-k2.5" }, "kimi", "kimi-k2")).toBe(false);
    expect(overlayMatches({ model: /^deepseek-r\d/ }, "deepseek", "deepseek-r2")).toBe(true);
    expect(overlayMatches({ model: /^deepseek-r\d/ }, "deepseek", "deepseek-chat")).toBe(false);
  });

  it("multiple fields AND together", () => {
    const m = { openModel: true as const, provider: "openrouter", family: "kimi" };
    expect(overlayMatches(m, "openrouter", "moonshotai/kimi-k2")).toBe(true);
    expect(overlayMatches(m, "kimi", "kimi-k2")).toBe(false);
  });
});
