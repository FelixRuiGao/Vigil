/**
 * Shared provider/model catalog used by setup and runtime model picker.
 */

export interface ProviderPreset {
  id: string;
  name: string;
  envVar: string;
  models: Array<{ id: string; label: string }>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic", name: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    ],
  },
  {
    id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5.1", label: "GPT-5.1" },
      { id: "gpt-4o", label: "GPT-4o" },
    ],
  },
  {
    id: "kimi-cn", name: "Kimi / Moonshot (China)", envVar: "KIMI_API_KEY",
    models: [
      { id: "kimi-k2.5", label: "Kimi K2.5" },
      { id: "kimi-k2-instruct", label: "Kimi K2 Instruct" },
    ],
  },
  {
    id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY",
    models: [
      { id: "MiniMax-M2.5", label: "MiniMax M2.5" },
      { id: "MiniMax-M2", label: "MiniMax M2" },
    ],
  },
  {
    id: "glm", name: "GLM / Zhipu", envVar: "GLM_API_KEY",
    models: [
      { id: "glm-5", label: "GLM-5" },
      { id: "glm-4.7", label: "GLM-4.7" },
    ],
  },
  {
    id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY",
    models: [
      // Anthropic
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
      // OpenAI
      { id: "openai/gpt-5", label: "GPT-5" },
      { id: "openai/gpt-5.1", label: "GPT-5.1" },
      // Kimi / Moonshot
      { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
      // MiniMax
      { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
      { id: "minimax/minimax-m2", label: "MiniMax M2" },
      // GLM / Zhipu (Z.ai)
      { id: "z-ai/glm-5", label: "GLM-5" },
      { id: "z-ai/glm-4.7", label: "GLM-4.7" },
    ],
  },
];
