import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config.js";
import { OpenAIChatProvider } from "../src/providers/openai-chat.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openai-chat-test",
    provider: "openai",
    model: "gpt-5",
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 272_000,
    supportsMultimodal: false,
    supportsThinking: false,
    thinkingBudget: 0,
    supportsWebSearch: false,
    extra: {},
    ...overrides,
  };
}

function streamFrom(chunks: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function buildToolCallChunks(argChunks: string[]): Array<Record<string, unknown>> {
  return argChunks.map((arg, i) => {
    const tc = i === 0
      ? {
          index: 0,
          id: "call_1",
          function: {
            name: "write_file",
            arguments: arg,
          },
        }
      : {
          index: 0,
          function: {
            arguments: arg,
          },
        };
    return {
      choices: [
        {
          delta: {
            tool_calls: [tc],
          },
        },
      ],
    };
  });
}

async function runStreamToolCall(
  argChunks: string[],
  mode?: "legacy" | "auto",
): Promise<Record<string, unknown>> {
  const prev = process.env["LONGERAGENT_TOOL_ARGS_MODE"];
  if (mode) {
    process.env["LONGERAGENT_TOOL_ARGS_MODE"] = mode;
  } else {
    delete process.env["LONGERAGENT_TOOL_ARGS_MODE"];
  }

  try {
    const provider = new OpenAIChatProvider(modelConfig());
    const create = vi.fn(async (kwargs: Record<string, unknown>) => {
      if (kwargs["stream"] === true) {
        return streamFrom(buildToolCallChunks(argChunks));
      }
      return {
        choices: [{ message: { content: "", tool_calls: [] } }],
      };
    });

    (provider as unknown as { _client: unknown })._client = {
      chat: { completions: { create } },
    };

    const response = await provider.sendMessage(
      [{ role: "user", content: "hello" }],
      undefined,
      { onTextChunk: () => {} },
    );

    return response.toolCalls[0]?.arguments ?? {};
  } finally {
    if (prev === undefined) {
      delete process.env["LONGERAGENT_TOOL_ARGS_MODE"];
    } else {
      process.env["LONGERAGENT_TOOL_ARGS_MODE"] = prev;
    }
  }
}

describe("OpenAIChatProvider streamed tool arguments", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses incremental tool argument chunks", async () => {
    const args = await runStreamToolCall([
      "{\"path\":\"report.md\",",
      "\"content\":\"hello\"}",
    ]);

    expect(args).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("parses cumulative tool argument chunks in auto mode", async () => {
    const args = await runStreamToolCall([
      "{\"path\":\"report.md\"",
      "{\"path\":\"report.md\",\"content\":\"hello\"}",
    ]);

    expect(args).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("parses mixed incremental + cumulative chunks in auto mode", async () => {
    const args = await runStreamToolCall([
      "{\"path\":\"report.md\",",
      "\"content\":\"he\"",
      "{\"path\":\"report.md\",\"content\":\"hello\"}",
    ]);

    expect(args).toEqual({
      path: "report.md",
      content: "hello",
    });
  });

  it("returns _parseError for invalid JSON instead of silent empty object", async () => {
    const args = await runStreamToolCall([
      "{\"path\":\"report.md\"",
    ]);

    expect(args["_parseError"]).toBeDefined();
    expect(args["_parseError"]).toContain("Failed to parse");
  });

  it("returns _parseError in legacy mode when cumulative chunks are unparsable", async () => {
    const args = await runStreamToolCall(
      [
        "{\"path\":\"report.md\"",
        "{\"path\":\"report.md\",\"content\":\"hello\"}",
      ],
      "legacy",
    );

    expect(args["_parseError"]).toBeDefined();
    expect(args["_parseError"]).toContain("Failed to parse");
  });

  it("supports explicit auto mode for cumulative chunks", async () => {
    const args = await runStreamToolCall(
      [
        "{\"path\":\"report.md\"",
        "{\"path\":\"report.md\",\"content\":\"hello\"}",
      ],
      "auto",
    );

    expect(args).toEqual({
      path: "report.md",
      content: "hello",
    });
  });
});
