import { describe, expect, it } from "bun:test";

import { buildModelOverlay } from "../src/prompt-overlays.js";

describe("buildModelOverlay", () => {
  it("returns no overlay for Anthropic-family models", () => {
    expect(buildModelOverlay("claude-opus-4-8")).toBe("");
    expect(buildModelOverlay("anthropic/claude-sonnet-5")).toBe("");
  });

  it("returns no overlay for OpenAI-family models", () => {
    expect(buildModelOverlay("gpt-5.2")).toBe("");
    expect(buildModelOverlay("o3-mini")).toBe("");
    expect(buildModelOverlay("openai/gpt-5-codex")).toBe("");
  });

  it("returns the open-model guardrails for other families", () => {
    for (const model of [
      "kimi-k2-0905-preview",
      "deepseek-chat",
      "glm-4.7",
      "qwen3-coder-plus",
      "minimax-m2.5",
      "moonshotai/kimi-k2",
    ]) {
      const overlay = buildModelOverlay(model);
      expect(overlay.startsWith("# Model-Specific Guidance"), model).toBe(true);
      expect(overlay).toContain("read_file");
    }
  });

  it("returns no overlay for an empty model id", () => {
    expect(buildModelOverlay("")).toBe("");
  });
});
