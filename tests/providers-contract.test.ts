import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function modelConfig(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    name: "test",
    provider: "openai",
    model: "gpt-5",
    apiKey: "test-key",
    baseUrl: undefined,
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 272_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    extra: {},
    ...overrides,
  };
}

async function* streamOf(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) {
    yield e;
  }
}

describe("provider response contract (streaming vs non-streaming)", () => {
  it("OpenAI Chat preserves citations/reasoning fields in streaming mode", async () => {
    const provider = new OpenAIChatProvider(modelConfig({ model: "gpt-4.1" }));

    const nonStreamingResponse = {
      choices: [{
        message: {
          content: "Hello from stream",
          reasoning_content: "Reasoning chat",
          annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }],
        },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    };

    const streamingChunks = [
      {
        choices: [{
          delta: {
            reasoning_content: "Reasoning chat",
          },
        }],
      },
      {
        choices: [{
          delta: {
            content: "Hello from stream",
            annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }],
          },
        }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ];

    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (params["stream"]) return streamOf(streamingChunks);
      return nonStreamingResponse;
    });

    (provider as any)._client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    const nonStream = await provider.sendMessage([{ role: "user", content: "hi" } as any]);
    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(stream.text).toBe(nonStream.text);
    expect(stream.reasoningContent).toBe(nonStream.reasoningContent);
    expect(stream.reasoningState).toBe(nonStream.reasoningState);
    expect(stream.citations).toEqual(nonStream.citations);
  });

  it("OpenAI Responses preserves reasoning/citations when response.completed is available", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5" }));

    const finalResponse = {
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reasoning responses" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "grep",
          arguments: "{\"pattern\":\"abc\"}",
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Answer responses",
            annotations: [{ type: "url_citation", url: "https://example.net", title: "ExampleNet" }],
          }],
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 1 },
      },
    };

    const streamEvents = [
      { type: "response.reasoning_summary_text.delta", delta: "Reasoning responses" },
      { type: "response.output_text.delta", delta: "Answer responses" },
      { type: "response.completed", response: finalResponse },
    ];

    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (params["stream"]) return streamOf(streamEvents);
      return finalResponse;
    });

    (provider as any)._client = {
      responses: {
        create,
      },
    };

    const nonStream = await provider.sendMessage([{ role: "user", content: "hi" } as any]);
    const stream = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(stream.text).toBe(nonStream.text);
    expect(stream.reasoningContent).toBe(nonStream.reasoningContent);
    expect(stream.reasoningState).toEqual(nonStream.reasoningState);
    expect(stream.citations).toEqual(nonStream.citations);
  });

  it("OpenAI Responses stream fallback still returns reasoningState when final response is absent", async () => {
    const provider = new OpenAIResponsesProvider(modelConfig({ model: "gpt-5" }));

    (provider as any)._client = {
      responses: {
        create: vi.fn(async () =>
          streamOf([
            { type: "response.reasoning_summary_text.delta", delta: "Fallback reasoning" },
            { type: "response.output_text.delta", delta: "Fallback answer" },
          ]),
        ),
      },
    };

    const resp = await provider.sendMessage(
      [{ role: "user", content: "hi" } as any],
      undefined,
      { onTextChunk: () => {}, onReasoningChunk: () => {} },
    );

    expect(resp.reasoningContent).toBe("Fallback reasoning");
    expect(resp.reasoningState).toBe("Fallback reasoning");
    expect(resp.text).toBe("Fallback answer");
  });
});
