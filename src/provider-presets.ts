/**
 * Shared provider/model catalog used by setup and runtime model picker.
 */

export interface ProviderPresetModel {
  /** Stable selector used by `/model` and init choices. */
  key: string;
  /** Actual API model ID sent to the provider. */
  id: string;
  /** Human-friendly label used in docs and init. */
  label: string;
  /** Optional note appended in `/model` picker labels. */
  optionNote?: string;
  /** Backward-compatible selector aliases. */
  aliases?: string[];
  /** Raw config overrides merged into generated/runtime model configs. */
  config?: Record<string, unknown>;
}

export interface ProviderPreset {
  id: string;
  name: string;
  envVar: string;
  models: ProviderPresetModel[];
}

const KIMI_MODELS = [
  { key: "kimi-k2.5", id: "kimi-k2.5", label: "Kimi K2.5" },
  { key: "kimi-k2-instruct", id: "kimi-k2-instruct", label: "Kimi K2 Instruct" },
] satisfies ProviderPresetModel[];

const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic", name: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY",
    models: [
      { key: "claude-haiku-4-5", id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { key: "claude-sonnet-4-6", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      {
        key: "claude-sonnet-4-6-1m",
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6 (1M context beta)",
        optionNote: "1M context beta",
        config: {
          context_length: 1_000_000,
          betas: [ANTHROPIC_CONTEXT_1M_BETA],
        },
      },
      { key: "claude-opus-4-6", id: "claude-opus-4-6", label: "Claude Opus 4.6" },
      {
        key: "claude-opus-4-6-1m",
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6 (1M context beta)",
        optionNote: "1M context beta",
        config: {
          context_length: 1_000_000,
          betas: [ANTHROPIC_CONTEXT_1M_BETA],
        },
      },
    ],
  },
  {
    id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY",
    models: [
      { key: "gpt-5.2", id: "gpt-5.2", label: "GPT-5.2" },
      { key: "gpt-5.2-codex", id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { key: "gpt-5.3-codex", id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { key: "gpt-5.4", id: "gpt-5.4", label: "GPT-5.4" },
    ],
  },
  {
    id: "kimi-cn", name: "Kimi / Moonshot (China)", envVar: "KIMI_API_KEY",
    models: KIMI_MODELS,
  },
  {
    id: "kimi", name: "Kimi / Moonshot (Global)", envVar: "KIMI_API_KEY",
    models: KIMI_MODELS,
  },
  {
    id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY",
    models: [
      { key: "MiniMax-M2.1", id: "MiniMax-M2.1", label: "MiniMax M2.1" },
      { key: "MiniMax-M2.5", id: "MiniMax-M2.5", label: "MiniMax M2.5" },
    ],
  },
  {
    id: "glm", name: "GLM / Zhipu", envVar: "GLM_API_KEY",
    models: [
      { key: "glm-5", id: "glm-5", label: "GLM-5" },
      { key: "glm-4.7", id: "glm-4.7", label: "GLM-4.7" },
    ],
  },
  {
    id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY",
    models: [
      // Anthropic
      {
        key: "anthropic/claude-haiku-4.5",
        id: "anthropic/claude-haiku-4.5",
        label: "Claude Haiku 4.5",
        aliases: ["anthropic/claude-haiku-4-5"],
      },
      {
        key: "anthropic/claude-sonnet-4.6",
        id: "anthropic/claude-sonnet-4.6",
        label: "Claude Sonnet 4.6",
        optionNote: "1M context",
        aliases: ["anthropic/claude-sonnet-4-6"],
        config: { context_length: 1_000_000 },
      },
      {
        key: "anthropic/claude-opus-4.6",
        id: "anthropic/claude-opus-4.6",
        label: "Claude Opus 4.6",
        optionNote: "1M context",
        aliases: ["anthropic/claude-opus-4-6"],
        config: { context_length: 1_000_000 },
      },
      // OpenAI
      { key: "openai/gpt-5.2", id: "openai/gpt-5.2", label: "GPT-5.2" },
      { key: "openai/gpt-5.2-codex", id: "openai/gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { key: "openai/gpt-5.3-codex", id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { key: "openai/gpt-5.4", id: "openai/gpt-5.4", label: "GPT-5.4" },
      // Kimi / Moonshot
      { key: "moonshotai/kimi-k2.5", id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
      // MiniMax
      { key: "minimax/minimax-m2.1", id: "minimax/minimax-m2.1", label: "MiniMax M2.1" },
      { key: "minimax/minimax-m2.5", id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
      // GLM / Zhipu (Z.ai)
      { key: "z-ai/glm-5", id: "z-ai/glm-5", label: "GLM-5" },
      { key: "z-ai/glm-4.7", id: "z-ai/glm-4.7", label: "GLM-4.7" },
    ],
  },
];

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}

export function findProviderPresetModel(
  providerId: string,
  selection: string,
): ProviderPresetModel | undefined {
  const preset = findProviderPreset(providerId);
  if (!preset) return undefined;
  return preset.models.find((model) =>
    model.key === selection
      || model.id === selection
      || Boolean(model.aliases?.includes(selection))
  );
}

export function buildProviderPresetRawConfig(
  providerId: string,
  model: ProviderPresetModel,
  apiKey: string,
): Record<string, unknown> {
  return {
    provider: providerId,
    model: model.id,
    api_key: apiKey,
    ...(model.config ?? {}),
  };
}
