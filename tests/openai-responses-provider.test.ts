import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openai-responses-test",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    extra: {},
    ...overrides,
  };
}

async function captureRequestKwargs(model: string): Promise<Record<string, unknown>> {
  const provider = new OpenAIResponsesProvider(modelConfig({ model }));
  const create = vi.fn(async () => ({
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    },
  }));

  (provider as any)._client = {
    responses: {
      create,
    },
  };

  await provider.sendMessage([{ role: "user", content: "hi" } as any]);
  return (create.mock.calls[0]?.[0] as Record<string, unknown>) ?? {};
}

describe("OpenAIResponsesProvider temperature support", () => {
  it.each([
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "openai/gpt-5.4",
  ])("omits temperature for %s", async (model) => {
    const kwargs = await captureRequestKwargs(model);
    expect(kwargs["temperature"]).toBeUndefined();
  });

  it("keeps temperature for non-gpt5 models", async () => {
    const kwargs = await captureRequestKwargs("custom-non-gpt5-model");
    expect(kwargs["temperature"]).toBe(0.7);
  });
});
