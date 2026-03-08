/**
 * Extensible slash-command system.
 *
 * Usage:
 *
 *   const registry = buildDefaultRegistry();
 *   const cmd = registry.lookup("/help");
 *   if (cmd) {
 *     await cmd.handler(ctx, "");
 *   }
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "./persistence.js";
import { loadLog, validateAndRepairLog } from "./persistence.js";
import { getThinkingLevels } from "./config.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";
import { resolveSkillContent, type SkillMeta } from "./skills/loader.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/**
 * Callback used by command handlers to display a message to the user.
 * The TUI layer supplies the concrete implementation.
 */
export type ShowMessageFn = (text: string) => void;

/**
 * Context passed to every command handler.
 *
 * Uses a generic interface so command handlers don't need direct TUI imports.
 */
export interface CommandContext {
  /** The active Session instance (typed as `any` to avoid circular deps). */
  session: any;

  /** Display a message in the conversation area. */
  showMessage: ShowMessageFn;

  /** The SessionStore for persistence (may be undefined). */
  store?: SessionStore;

  /** Auto-save the current session (TUI provides the implementation). */
  autoSave: () => void;

  /** Reset TUI state (cancel workers, clear spinners, etc.). */
  resetUiState: () => void;

  /** The command registry itself, so /help can enumerate commands. */
  commandRegistry: CommandRegistry;

  /** Request TUI-layer graceful exit. */
  exit?: () => Promise<void> | void;

  /** Inject content as a user message and trigger a new turn. */
  onTurnRequested?: (content: string) => void;

  /** Trigger a manual summarize request through the TUI turn pipeline. */
  onManualSummarizeRequested?: (instruction: string) => void;

  /** Trigger a manual compact request through the TUI execution pipeline. */
  onManualCompactRequested?: (instruction: string) => void;
}

/**
 * An option entry for command overlays.
 */
export interface CommandOption {
  /** Display label shown in the overlay. */
  label: string;
  /** Value submitted as the command argument when selected. */
  value: string;
  /** Child options for hierarchical selection (e.g., provider → model). */
  children?: CommandOption[];
}

/**
 * A single slash command.
 */
export interface SlashCommand {
  /** The command name, e.g. "/resume". */
  name: string;
  /** Short description shown in /help output. */
  description: string;
  /** Async handler invoked when the command is executed. */
  handler: (ctx: CommandContext, args: string) => Promise<void>;
  /**
   * Optional callback that returns dynamic overlay options for this command.
   * When present, typing the command shows an option picker overlay.
   * Receives the session so it can compute model-specific options.
   */
  options?: (session: any) => CommandOption[];
}

export class CommandExitSignal extends Error {
  code: number;

  constructor(code = 0) {
    super(`Command requested exit (${code})`);
    this.name = "CommandExitSignal";
    this.code = code;
  }
}

export function isCommandExitSignal(err: unknown): err is CommandExitSignal {
  return err instanceof CommandExitSignal ||
    ((err as { name?: unknown; code?: unknown } | null | undefined)?.name === "CommandExitSignal" &&
      typeof (err as { code?: unknown } | null | undefined)?.code === "number");
}

// ------------------------------------------------------------------
// CommandRegistry
// ------------------------------------------------------------------

export class CommandRegistry {
  private _commands = new Map<string, SlashCommand>();

  /** Register a command. Overwrites any existing command with the same name. */
  register(cmd: SlashCommand): void {
    this._commands.set(cmd.name, cmd);
  }

  /** Look up a command by its exact name. */
  lookup(name: string): SlashCommand | undefined {
    return this._commands.get(name);
  }

  /** Return all registered commands sorted alphabetically by name. */
  getAll(): SlashCommand[] {
    return Array.from(this._commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Return command names that start with the given prefix (for completion). */
  getCompletions(prefix: string): string[] {
    const results: string[] = [];
    for (const name of Array.from(this._commands.keys())) {
      if (name.startsWith(prefix)) {
        results.push(name);
      }
    }
    return results.sort();
  }
}

// ------------------------------------------------------------------
// Built-in command handlers
// ------------------------------------------------------------------

async function cmdHelp(ctx: CommandContext, _args: string): Promise<void> {
  const lines: string[] = ["Commands:"];
  for (const cmd of ctx.commandRegistry.getAll()) {
    lines.push(`  ${cmd.name}  ${cmd.description}`);
  }

  lines.push("");
  lines.push("Shortcuts:");
  lines.push("  Enter        Send message");
  lines.push("  Option+Enter Insert newline");
  lines.push("  Ctrl+N       Insert newline");
  lines.push("  Ctrl+G       Toggle markdown raw view");
  lines.push("  Cmd+Delete   Delete to line start (Ghostty/kitty protocol)");
  lines.push("  Alt+Backspace/Ctrl+W Delete previous word");
  lines.push("  Ctrl+C       Cancel / Exit");
  lines.push("  @filename    Attach file");

  ctx.showMessage(lines.join("\n"));
}

async function cmdNew(ctx: CommandContext, _args: string): Promise<void> {
  ctx.resetUiState();
  ctx.autoSave();

  // Clear session dir — a new directory will be created lazily on first save.
  // This avoids creating an empty session file when the user doesn't send any messages.
  if (ctx.store) {
    ctx.store.clearSession();
  }

  // Full session reset — store is updated, then conversation re-initialized
  // with correct paths. Equivalent to constructing a fresh Session.
  ctx.session.resetForNewSession(ctx.store);

  ctx.showMessage("--- New session started ---");
}

async function cmdSummarize(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualSummarizeRequested) {
    ctx.showMessage("Manual summarize is not available in this UI.");
    return;
  }
  ctx.onManualSummarizeRequested(args.trim());
}

async function cmdCompact(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualCompactRequested) {
    ctx.showMessage("Manual compact is not available in this UI.");
    return;
  }
  ctx.onManualCompactRequested(args.trim());
}

async function cmdResume(ctx: CommandContext, args: string): Promise<void> {
  const store = ctx.store;
  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  const sessions = store.listSessions();
  if (sessions.length === 0) {
    ctx.showMessage("No saved sessions found.");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    // List sessions
    const lines: string[] = ["Recent Sessions:"];
    const shown = sessions.slice(0, 10);
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i];
      const created = s.created
        ? s.created.slice(0, 19).replace("T", " ")
        : "?";
      const summary = (s.summary || "(empty)").slice(0, 60);
      lines.push(`  ${i + 1}  ${created}  ${s.turns}t  ${summary}`);
    }
    lines.push("");
    lines.push("Use /resume <number> to load a session.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Load specific session
  const idx = parseInt(trimmed, 10) - 1;
  if (isNaN(idx)) {
    ctx.showMessage(`Invalid session number: ${trimmed}`);
    return;
  }
  if (idx < 0 || idx >= sessions.length) {
    ctx.showMessage(`Session number out of range (1-${sessions.length}).`);
    return;
  }

  // Auto-save current first
  ctx.autoSave();

  const target = sessions[idx];
  const session = ctx.session;
  const logJsonPath = join(target.path, "log.json");
  const hasLogJson = existsSync(logJsonPath);

  if (!hasLogJson) {
    ctx.showMessage("No log.json found for this session.");
    return;
  }

  let logData;
  try {
    logData = loadLog(target.path);
  } catch (e) {
    ctx.showMessage(
      `Failed to load log: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Validate and repair
  const { entries: repairedEntries, repaired, warnings } = validateAndRepairLog(logData.entries);
  if (repaired) {
    for (const w of warnings) {
      ctx.showMessage(`[repair] ${w}`);
    }
  }

  ctx.resetUiState();

  try {
    session.restoreFromLog(logData.meta, repairedEntries, logData.idAllocator);
  } catch (e) {
    ctx.showMessage(
      `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Point store at the loaded session
  store.sessionDir = target.path;
  if (typeof session.setStore === "function") {
    session.setStore(store);
  }
  ctx.showMessage("--- Session restored ---");

}

async function cmdQuit(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.exit) {
    await ctx.exit();
    return;
  }

  ctx.autoSave();
  try {
    if (typeof ctx.session.close === "function") {
      await ctx.session.close();
    }
  } catch {
    // ignore
  }
  // Non-TUI callers decide how to handle shutdown.
  throw new CommandExitSignal(0);
}

function thinkingOptions(session: any): CommandOption[] {
  const model = session.currentModelName ?? "";
  const levels = getThinkingLevels(model);
  const current = session.thinkingLevel ?? "default";

  const opts: CommandOption[] = [];
  // "default" is always available as reset option
  opts.push({
    label: current === "default" ? "default  (current)" : "default",
    value: "default",
  });
  for (const level of levels) {
    const isCurrent = current === level;
    opts.push({
      label: isCurrent ? `${level}  (current)` : level,
      value: level,
    });
  }
  return opts;
}

async function cmdThinking(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const model = session.currentModelName;
  const levels = getThinkingLevels(model);
  const trimmed = args.trim().toLowerCase();

  if (!trimmed) {
    // No arg: show info (fallback for non-overlay usage)
    const current = session.thinkingLevel;
    if (!levels.length) {
      ctx.showMessage(`Model '${model}' does not support configurable thinking levels.`);
    } else {
      ctx.showMessage(
        `Thinking level: ${current}\n` +
        `Available levels for ${model}: ${levels.join(", ")}`,
      );
    }
    return;
  }

  if (trimmed === "default") {
    session.thinkingLevel = "default";
    ctx.showMessage("Thinking level reset to provider default.");
    return;
  }

  if (levels.length && !levels.includes(trimmed)) {
    ctx.showMessage(
      `Invalid level '${trimmed}' for ${model}.\n` +
      `Available: ${levels.join(", ")}`,
    );
    return;
  }

  session.thinkingLevel = trimmed;
  ctx.showMessage(`Thinking level set to: ${trimmed}`);
}

function cacheHitOptions(session: any): CommandOption[] {
  const enabled = session.cacheHitEnabled ?? true;
  return [
    { label: enabled ? "ON  (current)" : "ON", value: "on" },
    { label: enabled ? "OFF" : "OFF  (current)", value: "off" },
  ];
}

async function cmdCacheHit(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "on") {
    session.cacheHitEnabled = true;
  } else if (trimmed === "off") {
    session.cacheHitEnabled = false;
  } else {
    // No argument toggles the current setting.
    session.cacheHitEnabled = !session.cacheHitEnabled;
  }

  const state = session.cacheHitEnabled ? "ON" : "OFF";
  const provider = session.primaryAgent?.modelConfig?.provider ?? "";
  let note = "";
  if (provider === "anthropic") {
    note = session.cacheHitEnabled
      ? " (cache_control markers will be sent)"
      : " (cache_control markers disabled)";
  } else if (provider === "openrouter") {
    note = " (Cache is automatic via OpenRouter for supported models)";
  } else {
    note = " (Cache is automatic for this provider)";
  }

  ctx.showMessage(`Prompt caching: ${state}${note}`);
}

// ------------------------------------------------------------------
// /model command
// ------------------------------------------------------------------

interface ModelEntryLike {
  name: string;
  provider: string;
  model: string;
  apiKeyRaw: string;
  hasResolvedApiKey: boolean;
}

const PROVIDER_KEY_GROUP_ALIASES: Record<string, string> = {
  "openai-chat": "openai",
  "openai-responses": "openai",
  "kimi-cn": "kimi",
  "kimi-ai": "kimi",
  "glm-intl": "glm",
};

function providerKeyGroup(provider: string): string {
  return PROVIDER_KEY_GROUP_ALIASES[provider] ?? provider;
}

const PROVIDER_ENV_VARS = (() => {
  const map = new Map<string, string>();
  for (const p of PROVIDER_PRESETS) {
    const group = providerKeyGroup(p.id);
    if (!map.has(group)) map.set(group, p.envVar);
  }
  return map;
})();

function readModelEntries(config: any): ModelEntryLike[] {
  if (typeof config?.listModelEntries === "function") {
    try {
      const entries = config.listModelEntries();
      if (Array.isArray(entries)) return entries as ModelEntryLike[];
    } catch {
      // Fall through to compatibility mode.
    }
  }

  // Compatibility for old/partial config stubs (best-effort only).
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

function parseModelArgs(args: string): { target: string; apiKey?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const target = tokens[0] ?? "";
  const rest = tokens.slice(1);
  let apiKey: string | undefined;
  for (const t of rest) {
    if (t.startsWith("key=")) {
      apiKey = t.slice("key=".length);
      break;
    }
    if (t.startsWith("api_key=")) {
      apiKey = t.slice("api_key=".length);
      break;
    }
  }
  if (!apiKey && rest.length === 1) {
    apiKey = rest[0];
  }
  return { target, apiKey };
}

function parseProviderModelTarget(target: string): { provider: string; model: string } | null {
  const idx = target.indexOf(":");
  if (idx <= 0 || idx >= target.length - 1) return null;
  return {
    provider: target.slice(0, idx),
    model: target.slice(idx + 1),
  };
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
  const group = providerKeyGroup(provider);
  const fromConfig = entries.find((e) =>
    providerKeyGroup(e.provider) === group && e.hasResolvedApiKey && e.apiKeyRaw.trim() !== ""
  );
  if (fromConfig) return fromConfig.apiKeyRaw;

  const envVar = PROVIDER_ENV_VARS.get(group);
  if (hasEnvApiKey(envVar)) return `\${${envVar}}`;
  return undefined;
}

function runtimeModelName(provider: string, model: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `runtime-${slug(provider)}-${slug(model)}`;
}

/**
 * Build two-level options for /model: provider → model.
 * Each provider is a parent option with model children.
 */
function modelOptions(session: any): CommandOption[] {
  const config = session.config;
  if (!config) return [];

  const entries = readModelEntries(config);
  const currentProvider = String(session.primaryAgent?.modelConfig?.provider ?? "");
  const currentModel = String(session.primaryAgent?.modelConfig?.model ?? "");

  // Gather all providers/models:
  // 1) preset catalog
  // 2) user-defined config models (for custom IDs/providers)
  const byProvider = new Map<string, Set<string>>();
  const providerOrder: string[] = [];
  const addModel = (provider: string, model: string) => {
    if (!provider || !model) return;
    if (!byProvider.has(provider)) {
      byProvider.set(provider, new Set());
      providerOrder.push(provider);
    }
    byProvider.get(provider)!.add(model);
  };

  for (const preset of PROVIDER_PRESETS) {
    for (const m of preset.models) {
      addModel(preset.id, m.id);
    }
  }
  for (const e of entries) {
    addModel(e.provider, e.model);
  }

  // Provider-level key status from config/env/current model.
  const providerHasKey = new Map<string, boolean>();
  for (const e of entries) {
    if (e.hasResolvedApiKey) {
      providerHasKey.set(providerKeyGroup(e.provider), true);
    }
  }
  for (const [group, envVar] of PROVIDER_ENV_VARS) {
    if (hasEnvApiKey(envVar)) providerHasKey.set(group, true);
  }
  const currentProviderGroup = providerKeyGroup(currentProvider);
  if (session.primaryAgent?.modelConfig?.apiKey) {
    providerHasKey.set(currentProviderGroup, true);
  }

  const options: CommandOption[] = [];
  for (const provider of providerOrder) {
    const models = Array.from(byProvider.get(provider) ?? []);
    models.sort((a, b) => a.localeCompare(b));
    const children: CommandOption[] = [];

    for (const model of models) {
      const isCurrent = provider === currentProvider && model === currentModel;
      const missingApiKey = !providerHasKey.get(providerKeyGroup(provider));

      let label = model;
      if (isCurrent && missingApiKey) {
        label = `${label}  (current, key missing: run longeragent init)`;
      } else if (isCurrent) {
        label = `${label}  (current)`;
      } else if (missingApiKey) {
        label = `${label}  (key missing: run longeragent init)`;
      }

      children.push({
        label,
        value: `${provider}:${model}`,
      });
    }

    const hasCurrent = children.some((c) => c.label.includes("(current)"));
    options.push({
      label: hasCurrent ? `${provider}  (current)` : provider,
      value: provider,
      children,
    });
  }

  return options;
}

/**
 * /model command: switch model by creating a new session.
 *
 * The selected value is the model config name (from the children level).
 */
async function cmdModel(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim();
  const config = session.config;

  if (!trimmed) {
    const current = session.currentModelConfigName ?? session.currentModelName ?? "unknown";
    ctx.showMessage(
      `Current model: ${current}\n` +
      "Use /model to select a new model.\n" +
      "For models marked 'key missing', run 'longeragent init' (or use /model provider:model key=YOUR_API_KEY).",
    );
    return;
  }

  if (!session.switchModel) {
    ctx.showMessage("Model switching is not supported in this session.");
    return;
  }

  try {
    const { target, apiKey } = parseModelArgs(trimmed);
    let selectedConfigName = target;
    let selectedHint = target;

    // First try the configured model name.
    const knownNames = new Set<string>((config?.modelNames as string[]) ?? []);
    if (!knownNames.has(selectedConfigName)) {
      const parsed = parseProviderModelTarget(target);
      if (!parsed) {
        throw new Error(
          "Invalid model target. Use config name or provider:model (e.g. openai:gpt-5).",
        );
      }

      const entries = readModelEntries(config);
      const exactEntries = entries.filter((e) =>
        e.provider === parsed.provider && e.model === parsed.model
      );
      const exactWithKey = exactEntries.find((e) => e.hasResolvedApiKey);

      if (exactWithKey && !apiKey) {
        selectedConfigName = exactWithKey.name;
      } else {
        const keySource = (apiKey && apiKey.trim() !== "")
          ? apiKey
          : getProviderKeySource(entries, parsed.provider);

        if (!keySource) {
          const envVar = PROVIDER_ENV_VARS.get(providerKeyGroup(parsed.provider));
          const envHint = envVar
            ? ` or export ${envVar}`
            : "";
          ctx.showMessage(
            `Missing API key for provider '${parsed.provider}'.\n` +
            `Run 'longeragent init' to set keys, or use: /model ${parsed.provider}:${parsed.model} key=YOUR_API_KEY${envHint}`,
          );
          return;
        }

        if (typeof config?.upsertModelRaw !== "function") {
          throw new Error("Runtime model creation is not supported by this config object.");
        }

        const runtimeName = runtimeModelName(parsed.provider, parsed.model);
        config.upsertModelRaw(runtimeName, {
          provider: parsed.provider,
          model: parsed.model,
          api_key: keySource,
        });
        selectedConfigName = runtimeName;
      }
      selectedHint = `${parsed.provider}/${parsed.model}`;
    }

    // Save current session before switching
    ctx.resetUiState();
    ctx.autoSave();
    if (ctx.store) {
      ctx.store.clearSession();
    }

    // Switch model, then create fresh session
    session.switchModel(selectedConfigName);
    session.resetForNewSession(ctx.store);

    const mc = session.primaryAgent?.modelConfig;
    if (mc) {
      ctx.showMessage(
        `--- New session with ${selectedHint} (${mc.provider}/${mc.model}) ---\n` +
        `  Context: ${(mc.contextLength ?? 0).toLocaleString()} tokens`
      );
    } else {
      ctx.showMessage(`--- New session with ${selectedHint} ---`);
    }
  } catch (e) {
    ctx.showMessage(`Failed to switch model: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ------------------------------------------------------------------
// Registry builder
// ------------------------------------------------------------------

/**
 * Build the default command registry with all built-in commands.
 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({ name: "/help", description: "Show commands and shortcuts", handler: cmdHelp });
  registry.register({ name: "/compact", description: "Manually compact the active context", handler: cmdCompact });
  registry.register({ name: "/new", description: "Start a new session", handler: cmdNew });
  registry.register({ name: "/resume", description: "Resume a previous session", handler: cmdResume });
  registry.register({ name: "/summarize", description: "Manually summarize older context", handler: cmdSummarize });
  registry.register({ name: "/model", description: "Switch model", handler: cmdModel, options: modelOptions });
  registry.register({ name: "/quit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/exit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/thinking", description: "Set thinking level", handler: cmdThinking, options: thinkingOptions });
  registry.register({ name: "/cachehit", description: "Prompt caching", handler: cmdCacheHit, options: cacheHitOptions });
  return registry;
}

// ------------------------------------------------------------------
// Skill command registration
// ------------------------------------------------------------------

/**
 * Register slash commands for user-invocable skills.
 *
 * Each skill with `userInvocable === true` gets a `/skill-name` command.
 * When invoked, the skill content is injected and a turn is triggered.
 */
export function registerSkillCommands(
  registry: CommandRegistry,
  skills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of skills.values()) {
    if (!skill.userInvocable) continue;

    const captured = skill; // capture for closure
    const desc =
      captured.description.length > 60
        ? captured.description.slice(0, 57) + "..."
        : captured.description;

    registry.register({
      name: "/" + captured.name,
      description: desc,
      handler: async (ctx: CommandContext, args: string) => {
        const content = resolveSkillContent(captured, args);
        const tagged = `[SKILL: ${captured.name}]\n\n${content}`;
        ctx.showMessage(`Loaded skill: ${captured.name}`);
        if (ctx.onTurnRequested) {
          ctx.onTurnRequested(tagged);
        }
      },
    });
  }
}
