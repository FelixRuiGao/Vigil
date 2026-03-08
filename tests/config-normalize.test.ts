import { describe, expect, it } from "vitest";

import {
  normalizeModelId,
  getContextLength,
  getMultimodalSupport,
  getThinkingSupport,
  getWebSearchSupport,
  getThinkingLevels,
} from "../src/config.js";

describe("normalizeModelId", () => {
  it("strips vendor prefix from OpenRouter-style model IDs", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("openai/gpt-5")).toBe("gpt-5");
    expect(normalizeModelId("moonshotai/kimi-k2.5")).toBe("kimi-k2.5");
    expect(normalizeModelId("minimax/minimax-m2.5")).toBe("minimax-m2.5");
  });

  it("returns the model ID unchanged when there is no slash", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("gpt-5")).toBe("gpt-5");
  });

  it("handles multiple slashes by stripping at the last one", () => {
    expect(normalizeModelId("perplexity/llama-3.1-sonar-small-128k-online"))
      .toBe("llama-3.1-sonar-small-128k-online");
  });
});

describe("getContextLength with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs via normalization", () => {
    expect(getContextLength("anthropic/claude-sonnet-4-6")).toBe(200_000);
    expect(getContextLength("openai/gpt-5")).toBe(272_000);
    expect(getContextLength("moonshotai/kimi-k2.5")).toBe(256_000);
    expect(getContextLength("minimax/minimax-m2.5")).toBe(204_800);
  });

  it("still works with exact model IDs (no prefix)", () => {
    expect(getContextLength("claude-sonnet-4-6")).toBe(200_000);
    expect(getContextLength("gpt-5")).toBe(272_000);
  });

  it("returns 0 for unknown models", () => {
    expect(getContextLength("unknown/unknown-model")).toBe(0);
  });

  it("respects explicit context length over lookup", () => {
    expect(getContextLength("anthropic/claude-sonnet-4-6", 100_000)).toBe(100_000);
  });
});

describe("getMultimodalSupport with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getMultimodalSupport("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(getMultimodalSupport("openai/gpt-5")).toBe(true);
    expect(getMultimodalSupport("moonshotai/kimi-k2.5")).toBe(true);
  });

  it("returns false for non-multimodal models", () => {
    expect(getMultimodalSupport("moonshotai/kimi-k2-instruct")).toBe(false);
  });

  it("respects explicit override", () => {
    expect(getMultimodalSupport("moonshotai/kimi-k2-instruct", true)).toBe(true);
    expect(getMultimodalSupport("anthropic/claude-sonnet-4-6", false)).toBe(false);
  });
});

describe("getThinkingSupport with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getThinkingSupport("anthropic/claude-opus-4-6")).toBe(true);
    expect(getThinkingSupport("openai/gpt-5")).toBe(true);
    expect(getThinkingSupport("moonshotai/kimi-k2.5")).toBe(true);
    expect(getThinkingSupport("z-ai/glm-5")).toBe(true);
  });

  it("returns false for non-thinking models", () => {
    expect(getThinkingSupport("moonshotai/kimi-k2-instruct")).toBe(false);
  });
});

describe("getWebSearchSupport with OpenRouter", () => {
  it("defaults to false for OpenRouter provider (paid add-on)", () => {
    expect(getWebSearchSupport("anthropic/claude-sonnet-4-6", undefined, "openrouter")).toBe(false);
  });

  it("respects explicit override for OpenRouter", () => {
    expect(getWebSearchSupport("anthropic/claude-sonnet-4-6", true, "openrouter")).toBe(true);
    expect(getWebSearchSupport("anthropic/claude-sonnet-4-6", false, "openrouter")).toBe(false);
  });

  it("still detects blacklisted models for non-OpenRouter providers via normalization", () => {
    // MiniMax-M1 series is in the blacklist
    expect(getWebSearchSupport("minimax/MiniMax-M1-40k")).toBe(false);
    expect(getWebSearchSupport("minimax/MiniMax-M1-80k")).toBe(false);
  });
});

describe("getThinkingLevels with OpenRouter model IDs", () => {
  it("recognizes OpenRouter model IDs", () => {
    expect(getThinkingLevels("anthropic/claude-opus-4-6")).toEqual(
      ["off", "low", "medium", "high", "max"],
    );
    expect(getThinkingLevels("openai/gpt-5")).toEqual(
      ["off", "minimal", "low", "medium", "high"],
    );
    expect(getThinkingLevels("moonshotai/kimi-k2.5")).toEqual(
      ["off", "on"],
    );
  });

  it("returns empty array for unknown models", () => {
    expect(getThinkingLevels("unknown/unknown-model")).toEqual([]);
  });

  it("still works with exact model IDs", () => {
    expect(getThinkingLevels("claude-opus-4-6")).toEqual(
      ["off", "low", "medium", "high", "max"],
    );
  });
});
