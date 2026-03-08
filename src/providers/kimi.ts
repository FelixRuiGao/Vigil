/**
 * Kimi (Moonshot) provider adapter.
 *
 * Extends OpenAIChatProvider with:
 * - builtin_function.$web_search tool conversion (echo handled by tool loop)
 * - Forced temperature=1 for thinking mode
 * - reasoning_content enforcement on all assistant messages
 */

import type { ModelConfig } from "../config.js";
import type { Message, ToolDef } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class KimiProvider extends OpenAIChatProvider {
  private _thinkingEnabledForRequest = true;

  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "Kimi provider requires a base_url. " +
          "Use provider 'kimi-cn' or 'kimi-ai', or set base_url explicitly.",
      );
    }
    super(config);
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: import("./base.js").SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;
    const level = options?.thinkingLevel;
    if (level === "off" || level === "none") return;
    // Kimi K2.5 thinking requires temperature=1
    kwargs["temperature"] = 1;
  }

  protected override _convertMessages(
    messages: Message[],
  ): Record<string, unknown>[] {
    const converted = super._convertMessages(messages);
    if (!this._thinkingEnabledForRequest) {
      for (const msg of converted) {
        if (msg["role"] === "assistant") {
          delete msg["reasoning_content"];
        }
      }
      return converted;
    }
    // Kimi requires reasoning_content on ALL assistant messages when
    // thinking is active. Ensure a non-empty fallback.
    for (const msg of converted) {
      if (msg["role"] !== "assistant") continue;

      const rc = msg["reasoning_content"];
      if (typeof rc === "string" && rc.trim()) continue;

      const content = msg["content"];
      if (typeof content === "string" && content.trim()) {
        msg["reasoning_content"] = content;
      } else {
        msg["reasoning_content"] = "[assistant tool call]";
      }
    }
    return converted;
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: import("./base.js").SendMessageOptions,
  ): Promise<import("./base.js").ProviderResponse> {
    this._thinkingEnabledForRequest = !(
      options?.thinkingLevel === "off" || options?.thinkingLevel === "none"
    );
    try {
      return await super.sendMessage(messages, tools, options);
    } finally {
      this._thinkingEnabledForRequest = true;
    }
  }

  protected override _convertTools(
    tools: ToolDef[],
  ): { toolsList: Record<string, unknown>[]; hasNativeWebSearch: boolean } {
    const result: Record<string, unknown>[] = [];
    for (const t of tools) {
      if (t.name === "web_search") {
        if (this._config.supportsWebSearch) {
          result.push({
            type: "builtin_function",
            function: { name: "$web_search" },
          });
        }
        continue;
      }
      result.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
    return { toolsList: result, hasNativeWebSearch: false };
  }
}
