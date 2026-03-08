/**
 * OpenAI Responses API provider adapter.
 *
 * Uses `client.responses.create()` for o1/o3 and GPT-5 models.
 * Supports native reasoning items and web_search_preview.
 */

import OpenAI from "openai";
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

// o-series models that don't support temperature
const O_SERIES_RE = /^o\d/;

export class OpenAIResponsesProvider extends BaseProvider {
  /**
   * GPT-5 series uses independent input/output limits (input ≤272K, output ≤128K).
   * The contextLength stores the input limit; compact check should compare against
   * it directly without subtracting maxOutputTokens.
   */
  override readonly budgetCalcMode = "full_context" as const;

  private _config: ModelConfig;
  private _client: OpenAI;

  constructor(config: ModelConfig) {
    super();
    this._config = config;
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: config.apiKey,
    };
    if (config.baseUrl) {
      opts.baseURL = config.baseUrl;
    }
    this._client = new OpenAI(opts);
  }

  // ------------------------------------------------------------------
  // Tool conversion
  // ------------------------------------------------------------------

  private _convertTools(
    tools: ToolDef[],
  ): { toolsList: Record<string, unknown>[]; hasNativeWebSearch: boolean } {
    const result: Record<string, unknown>[] = [];
    let hasWebSearch = false;
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          hasWebSearch = true;
        }
        continue;
      }
      result.push({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
    }
    return { toolsList: result, hasNativeWebSearch: hasWebSearch };
  }

  // ------------------------------------------------------------------
  // Input conversion
  // ------------------------------------------------------------------

  private _buildInput(messages: Message[]): Record<string, unknown>[] {
    const items: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      const role = m["role"] as string;

      if (role === "system") {
        items.push({ role: "developer", content: m["content"] });
      } else if (role === "user") {
        const content = m["content"];
        if (Array.isArray(content)) {
          const parts: Record<string, unknown>[] = [];
          for (const block of content as Record<string, unknown>[]) {
            if (block["type"] === "text") {
              parts.push({ type: "input_text", text: block["text"] });
            } else if (block["type"] === "image") {
              const dataUri = `data:${block["media_type"]};base64,${block["data"]}`;
              parts.push({ type: "input_image", image_url: dataUri });
            }
          }
          items.push({ role: "user", content: parts });
        } else {
          items.push({ role: "user", content });
        }
      } else if (role === "assistant") {
        const reasoningBlocks = m["_reasoning_state"];

        if (reasoningBlocks && Array.isArray(reasoningBlocks)) {
          // Saved output items -- re-inject directly
          items.push(...(reasoningBlocks as Record<string, unknown>[]));
          const text = (m["content"] as string) || (m["text"] as string) || "";
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
        } else if (m["tool_calls"]) {
          const text = (m["content"] as string) || (m["text"] as string) || "";
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
          for (const tc of m["tool_calls"] as Record<string, unknown>[]) {
            const args = tc["arguments"];
            items.push({
              type: "function_call",
              call_id: tc["id"],
              name: tc["name"],
              arguments:
                typeof args === "object" && args !== null
                  ? JSON.stringify(args)
                  : args,
            });
          }
        } else {
          const text = (m["content"] as string) || (m["text"] as string) || "";
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
        }
      } else if (role === "tool_result") {
        items.push({
          type: "function_call_output",
          call_id: m["tool_call_id"],
          output: m["content"],
        });
      }
    }

    return items;
  }

  // ------------------------------------------------------------------
  // Response parsing
  // ------------------------------------------------------------------

  private _parseResponse(response: Record<string, unknown>): ProviderResponse {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const reasoningTextParts: string[] = [];
    const reasoningItems: unknown[] = [];
    const citations: Citation[] = [];

    const output = (response["output"] as Record<string, unknown>[]) || [];
    for (const item of output) {
      const itemType = item["type"] as string;

      if (itemType === "reasoning") {
        reasoningItems.push(item);
        const summary = item["summary"] as Record<string, unknown>[] | undefined;
        if (summary) {
          for (const s of summary) {
            const text = (s["text"] as string) || "";
            if (text) reasoningTextParts.push(text);
          }
        }
      } else if (itemType === "message") {
        const content =
          (item["content"] as Record<string, unknown>[]) || [];
        for (const part of content) {
          const partType = part["type"] as string;
          if (partType === "output_text") {
            textParts.push((part["text"] as string) || "");
            const annotations = part["annotations"] as Record<string, unknown>[] | undefined;
            if (annotations) {
              for (const ann of annotations) {
                if ((ann["type"] as string) === "url_citation") {
                  citations.push({
                    url: (ann["url"] as string) || "",
                    title: (ann["title"] as string) || "",
                    citedText: (ann["cited_text"] as string) || "",
                  });
                } else {
                  const nested = ann["url_citation"] as Record<string, unknown> | undefined;
                  if (nested) {
                    citations.push({
                      url: (nested["url"] as string) || "",
                      title: (nested["title"] as string) || "",
                      citedText: (nested["cited_text"] as string) || "",
                    });
                  }
                }
              }
            }
          } else if (partType === "refusal") {
            textParts.push(`[Refusal: ${(part["refusal"] as string) || ""}]`);
          }
        }
      } else if (itemType === "function_call") {
        const callId = (item["call_id"] as string) || "";
        const name = (item["name"] as string) || "";
        const argsStr = (item["arguments"] as string) || "{}";
        let args: Record<string, unknown>;
        try {
          args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
        } catch {
          args = {};
        }
        toolCalls.push({ id: callId, name, arguments: args });
      }
    }

    // Usage
    let usage = new Usage();
    const respUsage = response["usage"] as Record<string, unknown> | undefined;
    if (respUsage) {
      const inputDetails = respUsage["input_tokens_details"] as Record<string, number> | undefined;
      usage = new Usage(
        (respUsage["input_tokens"] as number) || 0,
        (respUsage["output_tokens"] as number) || 0,
        0, // no cache creation for OpenAI
        inputDetails?.["cached_tokens"] ?? 0,
      );
    }

    const reasoningContent = reasoningTextParts.length > 0
      ? reasoningTextParts.join("\n")
      : "";

    let reasoningState: unknown = null;
    if (reasoningItems.length > 0) {
      const outputItemsForRoundtrip: unknown[] = [];
      for (const item of output) {
        const itemType = (item as Record<string, unknown>)["type"] as string;
        if (itemType === "reasoning" || itemType === "function_call") {
          outputItemsForRoundtrip.push(item);
        }
      }
      if (outputItemsForRoundtrip.length > 0) {
        reasoningState = outputItemsForRoundtrip;
      }
    }

    return new ProviderResponse({
      text: textParts.join("\n"),
      toolCalls,
      usage,
      raw: response,
      reasoningContent,
      reasoningState,
      citations,
    });
  }

  // ------------------------------------------------------------------
  // Thinking / reasoning params
  // ------------------------------------------------------------------

  private _applyThinkingParams(kwargs: Record<string, unknown>, options?: SendMessageOptions): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;

    if (level === "off" || level === "none") {
      kwargs["reasoning"] = { effort: "none", summary: "auto" };
      return;
    }

    let effort: string;
    if (level && ["minimal", "low", "medium", "high", "xhigh"].includes(level)) {
      effort = level;
    } else {
      // default: derive from budget
      const budget = this._config.thinkingBudget;
      if (budget > 0 && budget < 5_000) {
        effort = "low";
      } else if (budget >= 5_000 && budget < 10_000) {
        effort = "medium";
      } else {
        effort = "high";
      }
    }
    kwargs["reasoning"] = { effort, summary: "auto" };
  }

  // ------------------------------------------------------------------
  // Core API call
  // ------------------------------------------------------------------

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const inputItems = this._buildInput(messages);

    const kwargs: Record<string, unknown> = {
      model: this._config.model,
      input: inputItems,
    };

    // Temperature (skip for o-series)
    if (!O_SERIES_RE.test(this._config.model)) {
      const temp =
        options?.temperature !== undefined
          ? options.temperature
          : this._config.temperature;
      if (temp !== undefined) {
        kwargs["temperature"] = temp;
      }
    }

    if (options?.maxTokens || this._config.maxTokens) {
      kwargs["max_output_tokens"] = options?.maxTokens || this._config.maxTokens;
    }

    if (tools && tools.length > 0) {
      const { toolsList, hasNativeWebSearch } = this._convertTools(tools);
      if (hasNativeWebSearch) {
        toolsList.push({ type: "web_search_preview" });
      }
      if (toolsList.length > 0) {
        kwargs["tools"] = toolsList;
      }
    }

    if (this._config.extra) {
      Object.assign(kwargs, this._config.extra);
    }
    this._applyThinkingParams(kwargs, options);

    if (options?.onTextChunk || options?.onReasoningChunk) {
      return this._callStream(kwargs, options.onTextChunk, options.onReasoningChunk, options?.signal);
    }

    const response = await (this._client as unknown as { responses: { create: (params: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Record<string, unknown>> } }).responses.create(kwargs, options?.signal ? { signal: options.signal } : undefined);
    return this._parseResponse(response);
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
    kwargs["stream"] = true;

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolAcc: Map<
      string,
      { name: string; argChunks: string[] }
    > = new Map();
    let finalResponse: Record<string, unknown> | null = null;

    const responseStream = await (this._client as unknown as { responses: { create: (params: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>> } }).responses.create(kwargs, signal ? { signal } : undefined);

    for await (const event of responseStream) {
      const eventType = event["type"] as string;

      if (eventType === "response.output_text.delta") {
        const delta = (event["delta"] as string) || "";
        if (delta) {
          textParts.push(delta);
          if (onTextChunk) onTextChunk(delta);
        }
      } else if (eventType === "response.reasoning_summary_text.delta") {
        const delta = (event["delta"] as string) || "";
        if (delta) {
          reasoningParts.push(delta);
          if (onReasoningChunk) onReasoningChunk(delta);
        }
      } else if (eventType === "response.function_call_arguments.delta") {
        const callId =
          (event["call_id"] as string) || (event["item_id"] as string) || "";
        const delta = (event["delta"] as string) || "";
        if (!toolAcc.has(callId)) {
          toolAcc.set(callId, { name: "", argChunks: [] });
        }
        if (delta) {
          toolAcc.get(callId)!.argChunks.push(delta);
        }
      } else if (eventType === "response.output_item.added") {
        const item = event["item"] as Record<string, unknown> | undefined;
        if (item && item["type"] === "function_call") {
          const callId = (item["call_id"] as string) || "";
          const name = (item["name"] as string) || "";
          if (callId) {
            if (!toolAcc.has(callId)) {
              toolAcc.set(callId, { name, argChunks: [] });
            } else {
              toolAcc.get(callId)!.name = name;
            }
          }
        }
      } else if (eventType === "response.completed") {
        finalResponse = (event["response"] as Record<string, unknown>) || null;
      }
    }

    // If we got a final response, use the full parse
    if (finalResponse) {
      const result = this._parseResponse(finalResponse);
      if (reasoningParts.length > 0 && !result.reasoningContent) {
        result.reasoningContent = reasoningParts.join("");
      }
      return result;
    }

    // Fallback: build from accumulated stream data
    const toolCalls: ToolCall[] = [];
    for (const [callId, acc] of toolAcc) {
      const argsStr = acc.argChunks.join("");
      let args: Record<string, unknown>;
      try {
        args = argsStr ? JSON.parse(argsStr) : {};
      } catch {
        args = {};
      }
      toolCalls.push({ id: callId, name: acc.name, arguments: args });
    }

    const reasoningText = reasoningParts.join("");

    return new ProviderResponse({
      text: textParts.join(""),
      toolCalls,
      usage: new Usage(),
      raw: null,
      reasoningContent: reasoningText,
      reasoningState: reasoningText || null,
    });
  }
}
