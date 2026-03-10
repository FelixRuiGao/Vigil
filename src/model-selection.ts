import { hasOAuthTokens } from "./auth/openai-oauth.js";
import { formatScopedModelName } from "./config.js";
import {
  PROVIDER_PRESETS,
  buildProviderPresetRawConfig,
  findProviderPreset,
  findProviderPresetModel,
} from "./provider-presets.js";

type ModelEntryLike = {
  name: string;
  provider: string;
  model: string;
  apiKeyRaw: string;
  hasResolvedApiKey: boolean;
};

export interface PersistedModelSelection {
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
}

export interface ResolvedModelSelection {
  selectedConfigName: string;
  selectedHint: string;
  modelProvider: string;
  modelSelectionKey: string;
  modelId: string;
}

function readModelEntries(config: any): ModelEntryLike[] {
  if (typeof config?.listModelEntries === "function") {
    try {
      const entries = config.listModelEntries();
      if (Array.isArray(entries)) return entries as ModelEntryLike[];
    } catch {
      // Fall through to compatibility mode.
    }
  }

  const out: ModelEntryLike[] = [];
  for (const name of (config?.modelNames as string[]) ?? []) {
    try {
      const mc = config.getModel(name);
      out.push({
        name,
        provider: String(mc.provider ?? ""),
        model: String(mc.model ?? ""),
        apiKeyRaw: String(mc.apiKey ?? ""),
        hasResolvedApiKey: Boolean(mc.apiKey),
      });
    } catch {
      // Ignore invalid entries.
    }
  }
  return out;
}

function hasEnvApiKey(envVar: string | undefined): boolean {
  if (!envVar) return false;
  const raw = process.env[envVar];
  return typeof raw === "string" && raw.trim() !== "";
}

function getProviderKeySource(
  entries: ModelEntryLike[],
  provider: string,
): string | undefined {
  // Exact provider match in existing config entries.
  const fromConfig = entries.find((entry) =>
    entry.provider === provider
      && entry.hasResolvedApiKey
      && entry.apiKeyRaw.trim() !== "",
  );
  if (fromConfig) return fromConfig.apiKeyRaw;

  // Provider-specific env var — no cross-site fallback.
  const preset = findProviderPreset(provider);
  if (preset && hasEnvApiKey(preset.envVar)) return `\${${preset.envVar}}`;

  if (provider === "openai-codex") {
    try {
      if (hasOAuthTokens()) return "oauth:openai-codex";
    } catch {
      // Ignore auth lookup failures here.
    }
  }

  return undefined;
}

function parseProviderModelTarget(target: string): { provider: string; model: string } | null {
  const idx = target.indexOf(":");
  if (idx <= 0 || idx >= target.length - 1) return null;
  return {
    provider: target.slice(0, idx),
    model: target.slice(idx + 1),
  };
}

function runtimeModelName(provider: string, model: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `runtime-${slug(provider)}-${slug(model)}`;
}

export function resolveModelSelection(
  session: any,
  target: string,
  apiKey?: string,
): ResolvedModelSelection {
  const config = session.config;
  let selectedConfigName = target;

  const knownNames = new Set<string>((config?.modelNames as string[]) ?? []);
  if (knownNames.has(selectedConfigName)) {
    const existing = config.getModel(selectedConfigName);
    return {
      selectedConfigName,
      selectedHint: formatScopedModelName(existing.provider, existing.model),
      modelProvider: existing.provider,
      modelSelectionKey: existing.model,
      modelId: existing.model,
    };
  }

  const parsed = parseProviderModelTarget(target);
  if (!parsed) {
    throw new Error(
      "Invalid model target. Use config name or provider:model (e.g. openai:gpt-5.4).",
    );
  }

  const presetModel = findProviderPresetModel(parsed.provider, parsed.model);
  const resolvedModel = presetModel?.id ?? parsed.model;
  const selectionKey = presetModel?.key ?? parsed.model;
  const presetRequiresDedicatedConfig = Boolean(
    presetModel && (
      presetModel.key !== presetModel.id
      || presetModel.optionNote
      || presetModel.config
      || (presetModel.aliases && presetModel.aliases.length > 0)
    ),
  );

  const entries = readModelEntries(config);
  const exactEntries = entries.filter((entry) =>
    entry.provider === parsed.provider && entry.model === resolvedModel,
  );
  const exactWithKey = exactEntries.find((entry) => entry.hasResolvedApiKey);

  if (exactWithKey && !apiKey && !presetRequiresDedicatedConfig) {
    selectedConfigName = exactWithKey.name;
  } else {
    const keySource = (apiKey && apiKey.trim() !== "")
      ? apiKey
      : getProviderKeySource(entries, parsed.provider)
        ?? (session.primaryAgent?.modelConfig?.provider === parsed.provider
          && session.primaryAgent?.modelConfig?.apiKey
          ? session.primaryAgent.modelConfig.apiKey
          : undefined);

    if (!keySource) {
      if (parsed.provider === "openai-codex") {
        throw new Error(
          "Not logged in to OpenAI (ChatGPT).\n" +
          "Run 'longeragent oauth' to log in with your ChatGPT account.",
        );
      }
      const preset = findProviderPreset(parsed.provider);
      const envHint = preset
        ? `\nSet the environment variable:\n\n  export ${preset.envVar}=YOUR_API_KEY\n`
        : "";
      throw new Error(
        `Missing API key for provider '${parsed.provider}'${preset ? ` (${preset.name})` : ""}.` +
        envHint +
        `\nOr run 'longeragent init' to configure.` +
        `\nTip: /model ${parsed.provider}:${parsed.model} key=YOUR_API_KEY (current session only)`,
      );
    }

    if (typeof config?.upsertModelRaw !== "function") {
      throw new Error("Runtime model creation is not supported by this config object.");
    }

    const runtimeName = runtimeModelName(parsed.provider, selectionKey);
    config.upsertModelRaw(
      runtimeName,
      presetModel
        ? buildProviderPresetRawConfig(parsed.provider, presetModel, keySource)
        : {
            provider: parsed.provider,
            model: resolvedModel,
            api_key: keySource,
          },
    );
    selectedConfigName = runtimeName;
  }

  return {
    selectedConfigName,
    selectedHint: formatScopedModelName(parsed.provider, resolvedModel),
    modelProvider: parsed.provider,
    modelSelectionKey: selectionKey,
    modelId: resolvedModel,
  };
}

export function resolvePersistedModelSelection(
  session: any,
  selection: PersistedModelSelection,
): ResolvedModelSelection {
  const configName = selection.modelConfigName?.trim();
  let configResolutionError: unknown;

  if (configName) {
    try {
      const existing = session.config.getModel(configName);
      return {
        selectedConfigName: configName,
        selectedHint: formatScopedModelName(existing.provider, existing.model),
        modelProvider: existing.provider,
        modelSelectionKey: selection.modelSelectionKey?.trim() || existing.model,
        modelId: existing.model,
      };
    } catch (err) {
      configResolutionError = err;
    }
  }

  const provider = selection.modelProvider?.trim();
  const selectionKey = selection.modelSelectionKey?.trim() || selection.modelId?.trim();
  if (provider && selectionKey) {
    return resolveModelSelection(session, `${provider}:${selectionKey}`);
  }

  if (configResolutionError) {
    throw configResolutionError instanceof Error
      ? configResolutionError
      : new Error(String(configResolutionError));
  }

  throw new Error("Saved session is missing persisted model identity.");
}
