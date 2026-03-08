/**
 * Anthropic Claude provider adapter.
 *
 * Uses `@anthropic-ai/sdk` for both streaming and non-streaming calls.
 * Handles extended thinking with signature preservation, native web search,
 * and multimodal content blocks.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelConfig } from "../config.js";
import {
  BaseProvider,
  Citation,
  ProviderResponse,
  ToolCall,
  Usage,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";

export class AnthropicProvider extends BaseProvider {
  override readonly requiresAlternatingRoles = true;

  private _config: ModelConfig;
  private _client: Anthropic;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
    const opts: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: config.apiKey,
    };
    if (config.baseUrl) {
      opts.baseURL = config.baseUrl;
    }
    this._client = new Anthropic(opts);
  }

  // ------------------------------------------------------------------
  // Tool conversion
  // ------------------------------------------------------------------

  private _convertTools(tools: ToolDef[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          result.push({
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 20,
          });
        }
        continue;
      }
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      });
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Message conversion
  // ------------------------------------------------------------------

  private _convertMessages(
    messages: Message[],
  ): { system: string | null; converted: Record<string, unknown>[] } {
    let system: string | null = null;
    const converted: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content as string;
      } else if ((msg as Record<string, unknown>)["role"] === "tool_result") {
        const m = msg as Record<string, unknown>;
        converted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m["tool_call_id"],
              content: m["content"],
            },
          ],
        });
      } else if (
        msg.role === "assistant" &&
        (msg as Record<string, unknown>)["tool_calls"]
      ) {
        const m = msg as Record<string, unknown>;
        const content: Record<string, unknown>[] = [];
        // Inject thinking blocks first (API requires thinking before text/tool_use)
        const reasoningBlocks = m["_reasoning_state"];
        if (reasoningBlocks && Array.isArray(reasoningBlocks)) {
          for (const rb of reasoningBlocks) {
            content.push(rb as Record<string, unknown>);
          }
        }
        const text = (m["text"] as string) || (m["content"] as string) || "";
        if (text) {
          content.push({ type: "text", text });
        }
        const toolCalls = m["tool_calls"] as Record<string, unknown>[];
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc["id"],
            name: tc["name"],
            input: tc["arguments"],
          });
        }
        converted.push({ role: "assistant", content });
      } else if (msg.role === "assistant") {
        const m = msg as Record<string, unknown>;
        const content: Record<string, unknown>[] = [];
        const reasoningBlocks = m["_reasoning_state"];
        if (reasoningBlocks && Array.isArray(reasoningBlocks)) {
          for (const rb of reasoningBlocks) {
            content.push(rb as Record<string, unknown>);
          }
        }
        const text =
          (m["content"] as string) || (m["text"] as string) || "";
        if (text) {
          content.push({ type: "text", text });
        }
        if (content.length > 0) {
          converted.push({ role: "assistant", content });
        }
      } else {
        const rawContent = msg.content;
        if (Array.isArray(rawContent)) {
          const parts: Record<string, unknown>[] = [];
          for (const block of rawContent) {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text") {
              parts.push({ type: "text", text: b["text"] });
            } else if (b["type"] === "image") {
              parts.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: b["media_type"],
                  data: b["data"],
                },
              });
            }
          }
          converted.push({ role: msg.role, content: parts });
        } else {
          converted.push({ role: msg.role, content: rawContent });
        }
      }
    }

    return { system, converted };
  }

  // ------------------------------------------------------------------
  // Thinking params
  // ------------------------------------------------------------------

  /**
   * Claude 4.6 models use the new Adaptive Thinking system:
   *   thinking: { type: "adaptive" }
   *   output_config: { effort: "low" | "medium" | "high" | "max" }
   *
   * Claude 4.5 and earlier use Manual Extended Thinking:
   *   thinking: { type: "enabled", budget_tokens: N }
   */
  private static readonly _ADAPTIVE_MODELS = new Set([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ]);

  private _applyThinkingParams(kwargs: Record<string, unknown>, options?: SendMessageOptions): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;

    // "off" disables thinking entirely (both systems)
    if (level === "off" || level === "none") {
      kwargs["thinking"] = { type: "disabled" };
      return;
    }

    const model = this._config.model;
    if (AnthropicProvider._ADAPTIVE_MODELS.has(model)) {
      // --- Adaptive Thinking (Claude 4.6) ---
      kwargs["thinking"] = { type: "adaptive" };

      // Map level to effort; default is "high"
      let effort: string;
      if (level && ["low", "medium", "high", "max"].includes(level)) {
        effort = level;
      } else {
        effort = "high";
      }
      kwargs["output_config"] = { effort };
    } else {
      // --- Manual Extended Thinking (Claude 4.5 and earlier) ---
      let budget: number;
      if (level === "low") {
        budget = 2048;
      } else if (level === "medium") {
        budget = 5000;
      } else if (level === "high") {
        budget = 10_000;
      } else {
        // default: use config budget
        budget = this._config.thinkingBudget || 10_000;
      }
      budget = Math.max(budget, 1024);
      const currentMax = (kwargs["max_tokens"] as number) || this._config.maxTokens;
      if (currentMax <= budget) {
        kwargs["max_tokens"] = budget + currentMax;
      }
      kwargs["thinking"] = { type: "enabled", budget_tokens: budget };
    }
    kwargs["temperature"] = 1; // Anthropic requires temperature=1 with thinking
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  private _parseResponse(resp: Anthropic.Message): ProviderResponse {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const reasoningBlocks: Record<string, unknown>[] = [];
    const toolCalls: ToolCall[] = [];
    const citations: Citation[] = [];

    for (const block of resp.content) {
      if (block.type === "text") {
        textParts.push(block.text);
        const blockAny = block as unknown as Record<string, unknown>;
        if (blockAny["citations"] && Array.isArray(blockAny["citations"])) {
          for (const c of blockAny["citations"] as Record<string, unknown>[]) {
            citations.push({
              url: (c["url"] as string) || "",
              title: (c["title"] as string) || "",
              citedText: (c["cited_text"] as string) || "",
            });
          }
        }
      } else if (block.type === "thinking") {
        thinkingParts.push(block.thinking);
        reasoningBlocks.push({
          type: "thinking",
          thinking: block.thinking,
          signature: (block as unknown as Record<string, unknown>)["signature"] || "",
        });
      } else if (block.type === "redacted_thinking") {
        reasoningBlocks.push({
          type: "redacted_thinking",
          data: (block as unknown as Record<string, unknown>)["data"] || "",
        });
      } else if (block.type === "tool_use") {
        const input = block.input;
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments:
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : JSON.parse(input as string),
        });
      }
      // server_tool_use, web_search_tool_result — handled transparently
    }

    const respUsage = resp.usage as unknown as Record<string, number> | undefined;
    const cacheCreation = respUsage?.["cache_creation_input_tokens"] ?? 0;
    const cacheRead = respUsage?.["cache_read_input_tokens"] ?? 0;
    const usage = new Usage(
      (resp.usage?.input_tokens ?? 0) + cacheCreation + cacheRead,
      resp.usage?.output_tokens ?? 0,
      cacheCreation,
      cacheRead,
    );

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls,
      usage,
      raw: resp,
      reasoningContent: thinkingParts.length > 0 ? thinkingParts.join("") : "",
      reasoningState: reasoningBlocks.length > 0 ? reasoningBlocks : null,
      citations,
    });
  }

  private _applyCacheBreakpoint(kwargs: Record<string, unknown>): void {
    const marker = { type: "ephemeral" };

    const markLastBlock = (value: unknown): boolean => {
      if (Array.isArray(value) && value.length > 0) {
        const last = value[value.length - 1];
        if (last && typeof last === "object") {
          (last as Record<string, unknown>)["cache_control"] = marker;
          return true;
        }
      }
      if (typeof value === "string" && value.length > 0) {
        return false;
      }
      return false;
    };

    const system = kwargs["system"];
    if (typeof system === "string" && system.length > 0) {
      kwargs["system"] = [{
        type: "text",
        text: system,
        cache_control: marker,
      }];
      return;
    }
    if (markLastBlock(system)) return;

    const messages = kwargs["messages"] as Record<string, unknown>[] | undefined;
    if (!Array.isArray(messages)) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = msg?.["content"];
      if (typeof content === "string" && content.length > 0) {
        msg["content"] = [{
          type: "text",
          text: content,
          cache_control: marker,
        }];
        return;
      }
      if (markLastBlock(content)) return;
    }
  }

  // ------------------------------------------------------------------
  // Core API call
  // ------------------------------------------------------------------

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { system, converted } = this._convertMessages(messages);

    const kwargs: Record<string, unknown> = {
      model: this._config.model,
      messages: converted,
      max_tokens: options?.maxTokens || this._config.maxTokens,
      temperature:
        options?.temperature !== undefined
          ? options.temperature
          : this._config.temperature,
    };
    if (system) {
      kwargs["system"] = system;
    }
    if (tools && tools.length > 0) {
      kwargs["tools"] = this._convertTools(tools);
    }
    if (this._config.extra) {
      Object.assign(kwargs, this._config.extra);
    }
    this._applyThinkingParams(kwargs, options);

    // Prompt caching
    if (options?.cacheEnabled !== false) {
      this._applyCacheBreakpoint(kwargs);
    }

    if (options?.onTextChunk || options?.onReasoningChunk) {
      return this._callStream(kwargs, options.onTextChunk, options.onReasoningChunk, options?.signal);
    }

    const resp = await this._client.messages.create(
      kwargs as unknown as Anthropic.MessageCreateParamsNonStreaming,
      options?.signal ? { signal: options.signal } : undefined,
    );
    return this._parseResponse(resp);
  }

  // ------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------

  private async _callStream(
    kwargs: Record<string, unknown>,
    onTextChunk?: (chunk: string) => void,
    onReasoningChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const reasoningBlocks: Record<string, unknown>[] = [];
    const toolCalls: ToolCall[] = [];
    const citations: Citation[] = [];

    let currentThinking: Record<string, string> | null = null;

    const stream = this._client.messages.stream(
      kwargs as unknown as Anthropic.MessageCreateParamsStreaming,
      signal ? { signal } : undefined,
    );

    for await (const event of stream) {
      const eventType = (event as unknown as Record<string, unknown>)["type"] as string;

      if (eventType === "content_block_start") {
        const block = (event as unknown as Record<string, unknown>)[
          "content_block"
        ] as Record<string, unknown> | undefined;
        if (block?.["type"] === "thinking") {
          currentThinking = { type: "thinking", thinking: "", signature: "" };
        } else if (block?.["type"] === "redacted_thinking") {
          reasoningBlocks.push({
            type: "redacted_thinking",
            data: (block["data"] as string) || "",
          });
        }
      } else if (eventType === "content_block_delta") {
        const delta = (event as unknown as Record<string, unknown>)["delta"] as
          | Record<string, unknown>
          | undefined;
        if (!delta) continue;
        const deltaType = delta["type"] as string;
        if (deltaType === "thinking_delta") {
          const text = (delta["thinking"] as string) || "";
          if (text) {
            thinkingParts.push(text);
            if (currentThinking) currentThinking["thinking"] += text;
            if (onReasoningChunk) onReasoningChunk(text);
          }
        } else if (deltaType === "text_delta") {
          const text = (delta["text"] as string) || "";
          if (text) {
            textParts.push(text);
            if (onTextChunk) onTextChunk(text);
          }
        } else if (deltaType === "signature_delta") {
          const sig = (delta["signature"] as string) || "";
          if (sig && currentThinking) currentThinking["signature"] += sig;
        }
      } else if (eventType === "content_block_stop") {
        if (currentThinking) {
          reasoningBlocks.push(currentThinking);
          currentThinking = null;
        }
      }
    }

    // Get the final message for tool_calls, usage, citations
    const response = await stream.finalMessage();

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const input = block.input;
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments:
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : JSON.parse(input as string),
        });
      } else if (block.type === "text") {
        const blockAny = block as unknown as Record<string, unknown>;
        if (blockAny["citations"] && Array.isArray(blockAny["citations"])) {
          for (const c of blockAny["citations"] as Record<string, unknown>[]) {
            citations.push({
              url: (c["url"] as string) || "",
              title: (c["title"] as string) || "",
              citedText: (c["cited_text"] as string) || "",
            });
          }
        }
      }
      // server_tool_use, web_search_tool_result — skip
    }

    const streamUsage = response.usage as unknown as Record<string, number> | undefined;
    const streamCacheCreation = streamUsage?.["cache_creation_input_tokens"] ?? 0;
    const streamCacheRead = streamUsage?.["cache_read_input_tokens"] ?? 0;
    const usage = new Usage(
      (response.usage?.input_tokens ?? 0) + streamCacheCreation + streamCacheRead,
      response.usage?.output_tokens ?? 0,
      streamCacheCreation,
      streamCacheRead,
    );

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls,
      usage,
      raw: response,
      reasoningContent: thinkingParts.length > 0 ? thinkingParts.join("") : "",
      reasoningState: reasoningBlocks.length > 0 ? reasoningBlocks : null,
      citations,
    });
  }
}
