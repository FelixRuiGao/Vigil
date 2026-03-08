import { describe, expect, it } from "vitest";

import type { ModelConfig } from "../src/config.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openrouter-test",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-6",
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/v1",
    temperature: 0.7,
    maxTokens: 4096,
    contextLength: 200_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

describe("OpenRouter _applyThinkingParams", () => {
  it("sets reasoning.effort in extra_body for default level", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = { temperature: 0.7, max_tokens: 4096 };
    (provider as any)._applyThinkingParams(kwargs, {});

    const extraBody = kwargs["extra_body"] as Record<string, unknown>;
    expect(extraBody).toBeDefined();
    expect(extraBody["reasoning"]).toEqual({ effort: "high" });
  });

  it("maps thinking levels correctly", () => {
    const provider = new OpenRouterProvider(modelConfig());

    const testCases: Array<{ level: string; expected: string }> = [
      { level: "low", expected: "low" },
      { level: "medium", expected: "medium" },
      { level: "high", expected: "high" },
      { level: "xhigh", expected: "xhigh" },
      { level: "max", expected: "xhigh" },
      { level: "minimal", expected: "minimal" },
      { level: "on", expected: "high" },
    ];

    for (const { level, expected } of testCases) {
      const kwargs: Record<string, unknown> = {};
      (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: level });

      const extraBody = kwargs["extra_body"] as Record<string, unknown>;
      expect(extraBody["reasoning"]).toEqual({ effort: expected });
    }
  });

  it("sets effort to 'none' for level 'off'", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = {};
    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "off" });

    const extraBody = kwargs["extra_body"] as Record<string, unknown>;
    expect(extraBody["reasoning"]).toEqual({ effort: "none" });
  });

  it("sets effort to 'none' for level 'none'", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = {};
    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "none" });

    const extraBody = kwargs["extra_body"] as Record<string, unknown>;
    expect(extraBody["reasoning"]).toEqual({ effort: "none" });
  });

  it("uses max_tokens when thinkingBudget is set", () => {
    const provider = new OpenRouterProvider(modelConfig({ thinkingBudget: 8000 }));
    const kwargs: Record<string, unknown> = {};
    (provider as any)._applyThinkingParams(kwargs, {});

    const extraBody = kwargs["extra_body"] as Record<string, unknown>;
    expect(extraBody["reasoning"]).toEqual({ max_tokens: 8000 });
  });

  it("does NOT delete temperature (unlike base class)", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = { temperature: 0.7, max_tokens: 4096 };
    (provider as any)._applyThinkingParams(kwargs, {});

    expect(kwargs["temperature"]).toBe(0.7);
  });

  it("does NOT swap max_tokens to max_completion_tokens (unlike base class)", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = { temperature: 0.7, max_tokens: 4096 };
    (provider as any)._applyThinkingParams(kwargs, {});

    expect(kwargs["max_tokens"]).toBe(4096);
    expect(kwargs["max_completion_tokens"]).toBeUndefined();
  });

  it("does nothing when supportsThinking is false", () => {
    const provider = new OpenRouterProvider(modelConfig({ supportsThinking: false }));
    const kwargs: Record<string, unknown> = { temperature: 0.7 };
    (provider as any)._applyThinkingParams(kwargs, { thinkingLevel: "high" });

    expect(kwargs["extra_body"]).toBeUndefined();
  });

  it("preserves existing extra_body fields", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const kwargs: Record<string, unknown> = {
      extra_body: { some_field: "value" },
    };
    (provider as any)._applyThinkingParams(kwargs, {});

    const extraBody = kwargs["extra_body"] as Record<string, unknown>;
    expect(extraBody["some_field"]).toBe("value");
    expect(extraBody["reasoning"]).toEqual({ effort: "high" });
  });
});

describe("OpenRouter _convertMessages reasoning_details round-trip", () => {
  it("passes reasoning_details from _reasoning_state to converted messages", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const reasoningDetails = [
      { type: "reasoning.text", content: "thinking step 1" },
      { type: "reasoning.text", content: "thinking step 2" },
    ];

    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "response",
        reasoning_content: "thinking",
        _reasoning_state: reasoningDetails,
      },
    ];

    const converted = (provider as any)._convertMessages(messages) as Record<string, unknown>[];

    // Find the assistant message in converted output
    const assistantMsg = converted.find((m) => m["role"] === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!["reasoning_details"]).toEqual(reasoningDetails);
    expect(assistantMsg!["reasoning_content"]).toBe("thinking");
  });

  it("does not set reasoning_details when _reasoning_state is a string", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const messages = [
      {
        role: "assistant",
        content: "response",
        reasoning_content: "thinking text",
        _reasoning_state: "thinking text",
      },
    ];

    const converted = (provider as any)._convertMessages(messages) as Record<string, unknown>[];
    const assistantMsg = converted.find((m) => m["role"] === "assistant");
    expect(assistantMsg!["reasoning_details"]).toBeUndefined();
  });

  it("handles multiple assistant messages correctly", () => {
    const provider = new OpenRouterProvider(modelConfig());
    const details1 = [{ type: "reasoning.text", content: "step 1" }];
    const details2 = [{ type: "reasoning.text", content: "step 2" }];

    const messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "r1", _reasoning_state: details1 },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2", reasoning_content: "r2", _reasoning_state: details2 },
    ];

    const converted = (provider as any)._convertMessages(messages) as Record<string, unknown>[];
    const assistants = converted.filter((m) => m["role"] === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0]["reasoning_details"]).toEqual(details1);
    expect(assistants[1]["reasoning_details"]).toEqual(details2);
  });
});
