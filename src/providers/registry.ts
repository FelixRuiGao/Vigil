/**
 * Provider factory — maps provider identifiers to concrete provider classes.
 */

import type { ModelConfig } from "../config.js";
import type { BaseProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { OpenAIChatProvider } from "./openai-chat.js";
import { KimiProvider } from "./kimi.js";
import { GLMProvider } from "./glm.js";
import { MiniMaxProvider } from "./minimax.js";
import { OpenRouterProvider } from "./openrouter.js";

export function createProvider(config: ModelConfig): BaseProvider {
  const provider = config.provider.toLowerCase();

  if (provider === "anthropic") {
    return new AnthropicProvider(config);
  }

  if (provider === "openai" || provider === "openai-codex") {
    return new OpenAIResponsesProvider(config);
  }

  if (provider === "openai-chat") {
    return new OpenAIChatProvider(config);
  }

  if (provider === "kimi-cn" || provider === "kimi-ai" || provider === "kimi" || provider === "kimi-code") {
    return new KimiProvider(config);
  }

  if (provider === "glm" || provider === "glm-intl" || provider === "glm-code" || provider === "glm-intl-code") {
    return new GLMProvider(config);
  }

  if (provider === "minimax" || provider === "minimax-cn") {
    return new MiniMaxProvider(config);
  }

  if (provider === "openrouter") {
    return new OpenRouterProvider(config);
  }

  throw new Error(
    `Unknown provider '${config.provider}'. ` +
      "Supported: anthropic, openai, openai-codex, openai-chat, kimi, kimi-cn, kimi-ai, kimi-code, " +
      "glm, glm-intl, glm-code, glm-intl-code, minimax, minimax-cn, openrouter",
  );
}
