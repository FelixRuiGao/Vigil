/**
 * OpenRouter provider adapter.
 *
 * Extends OpenAIChatProvider with:
 * - Automatic base_url defaulting and HTTP-Referer / X-Title headers
 * - OpenRouter-style reasoning params (reasoning: { effort } in extra_body)
 * - reasoning_details extraction from non-streaming responses
 * - reasoning_details round-trip on assistant messages
 */

import OpenAI from "openai";
import type { ModelConfig } from "../config.js";
import {
  ProviderResponse,
  type Message,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Map LongerAgent thinking levels to OpenRouter reasoning effort values. */
const EFFORT_MAP: Record<string, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",    // Anthropic "max" → OpenRouter's highest effort
  on: "high",       // binary on/off models → default to high
};

export class OpenRouterProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    const headerExtra = config.extra ?? {};
    const sanitizedExtra = Object.fromEntries(
      Object.entries(headerExtra).filter(
        ([k]) => k !== "http_referer" && k !== "x_title",
      ),
    );
    super({
      ...config,
      extra: sanitizedExtra,
    });
    // Rebuild client with OpenRouter-specific settings
    const baseUrl = config.baseUrl || OPENROUTER_BASE_URL;
    const headers: Record<string, string> = {};
    if (config.extra?.["http_referer"]) {
      headers["HTTP-Referer"] = config.extra["http_referer"] as string;
    }
    if (config.extra?.["x_title"]) {
      headers["X-Title"] = config.extra["x_title"] as string;
    }
    this._client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: baseUrl,
      defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
    });
  }

  // ------------------------------------------------------------------
  // Thinking / reasoning params — OpenRouter unified format
  // ------------------------------------------------------------------

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;

    const level = options?.thinkingLevel;

    // Explicitly disable reasoning
    if (level === "off" || level === "none") {
      const extraBody = (kwargs["extra_body"] as Record<string, unknown>) || {};
      extraBody["reasoning"] = { effort: "none" };
      kwargs["extra_body"] = extraBody;
      return;
    }

    // Build reasoning config
    const reasoningConfig: Record<string, unknown> = {};

    if (this._config.thinkingBudget > 0) {
      // Use max_tokens for reasoning when thinkingBudget is explicitly set
      reasoningConfig["max_tokens"] = this._config.thinkingBudget;
    } else {
      // Map thinking level to effort
      const effort = (level && level !== "default")
        ? (EFFORT_MAP[level] ?? "high")
        : "high";
      reasoningConfig["effort"] = effort;
    }

    const extraBody = (kwargs["extra_body"] as Record<string, unknown>) || {};
    extraBody["reasoning"] = reasoningConfig;
    kwargs["extra_body"] = extraBody;

    // Do NOT delete temperature or swap max_tokens → max_completion_tokens.
    // OpenRouter normalizes these per-model internally.
  }

  // ------------------------------------------------------------------
  // Response post-processing — extract reasoning_details
  // ------------------------------------------------------------------

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const result = await super.sendMessage(messages, tools, options);

    // Non-streaming: the base class _parseResponse (private) only extracts
    // reasoning_content (string). OpenRouter also returns reasoning_details
    // (structured array) which we want for faithful round-tripping.
    // Streaming already handles reasoning_details via _callStream.
    if (result.raw && (!result.reasoningContent || result.reasoningState === result.reasoningContent)) {
      try {
        const raw = result.raw as Record<string, unknown>;
        const choices = (raw["choices"] as Record<string, unknown>[]) || [];
        if (choices.length > 0) {
          const message = choices[0]["message"] as Record<string, unknown> | undefined;
          if (message) {
            const details = message["reasoning_details"] as unknown[] | undefined;
            if (Array.isArray(details) && details.length > 0) {
              const texts: string[] = [];
              for (const item of details) {
                if (typeof item === "string") {
                  texts.push(item);
                  continue;
                }
                if (item && typeof item === "object") {
                  const obj = item as Record<string, unknown>;
                  const text = (obj["content"] as string)
                    || (obj["text"] as string)
                    || "";
                  if (text) texts.push(text);
                  // Extract from summary arrays
                  if (Array.isArray(obj["summary"])) {
                    for (const s of obj["summary"] as Record<string, unknown>[]) {
                      const st = (s["text"] as string) || "";
                      if (st) texts.push(st);
                    }
                  }
                }
              }
              if (texts.length > 0) {
                result.reasoningContent = texts.join("\n");
                result.reasoningState = details; // Preserve structured data for round-trip
              }
            }
          }
        }
      } catch {
        // Ignore extraction errors — reasoning_content from base class is still usable
      }
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Message conversion — reasoning_details round-trip
  // ------------------------------------------------------------------

  protected override _convertMessages(
    messages: Message[],
  ): Record<string, unknown>[] {
    const converted = super._convertMessages(messages);

    // Enrich assistant messages with reasoning_details from _reasoning_state
    // for faithful round-tripping through OpenRouter.
    // Use simple ordinal mapping: base class preserves assistant message order.
    const originals = messages as unknown as Record<string, unknown>[];
    const origAssistantIndices: number[] = [];
    const convAssistantIndices: number[] = [];

    for (let i = 0; i < originals.length; i++) {
      if (originals[i]["role"] === "assistant") origAssistantIndices.push(i);
    }
    for (let i = 0; i < converted.length; i++) {
      if (converted[i]["role"] === "assistant") convAssistantIndices.push(i);
    }

    const count = Math.min(origAssistantIndices.length, convAssistantIndices.length);
    for (let i = 0; i < count; i++) {
      const orig = originals[origAssistantIndices[i]];
      const conv = converted[convAssistantIndices[i]];
      const state = orig["_reasoning_state"];
      if (state && Array.isArray(state)) {
        conv["reasoning_details"] = state;
      }
    }

    return converted;
  }
}
