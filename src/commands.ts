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
import {
  formatDisplayModelName,
  formatScopedModelName,
  getThinkingLevels,
} from "./config.js";
import {
  PROVIDER_PRESETS,
  type ProviderPresetModel,
} from "./provider-presets.js";
import { resolveModelSelection as resolveModelSelectionCore } from "./model-selection.js";
import { resolveSkillContent, type SkillMeta } from "./skills/loader.js";
import { ACCENT_PRESETS, DEFAULT_ACCENT, setAccent, theme } from "./tui/theme.js";
import { hasOAuthTokens } from "./auth/openai-oauth.js";

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
  /** Checked state for checkbox picker mode. */
  checked?: boolean;
}

/** Context available when building dynamic picker options for a slash command. */
export interface CommandOptionsContext {
  session: any;
  store?: SessionStore;
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
   * Receives session/store context so it can compute dynamic picker options.
   */
  options?: (ctx: CommandOptionsContext) => CommandOption[];
  /** When true, TUI uses a checkbox multi-select picker instead of single-select. */
  checkboxMode?: boolean;
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

  /** Remove a command by its exact name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this._commands.delete(name);
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
      const summary = truncateDisplayText(s.summary || "(empty)", 25);
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
}

function buildResumeOptionLabel(
  index: number,
  created: string | undefined,
  turns: number | undefined,
  summary: string | undefined,
): string {
  const date = (created || "").slice(0, 16);
  return `${index + 1}. ${date}  ${turns ?? 0} turns  ${truncateDisplayText(summary || "", 25)}`;
}

function truncateDisplayText(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

function resumeOptions(ctx: CommandOptionsContext): CommandOption[] {
  const store = ctx.store;
  if (!store) return [];
  const sessions = store.listSessions();
  return sessions.map((s, i) => ({
    label: buildResumeOptionLabel(i, s.created, s.turns, s.summary),
    value: String(i + 1),
  }));
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

function currentSessionModelDisplayName(session: any): string {
  return formatDisplayModelName(
    session.primaryAgent?.modelConfig?.provider,
    session.currentModelName ?? session.primaryAgent?.modelConfig?.model,
  );
}

function persistGlobalPreferences(ctx: CommandContext): void {
  if (!ctx.store || typeof ctx.store.saveGlobalPreferences !== "function") return;
  if (typeof ctx.session.getGlobalPreferences !== "function") return;
  try {
    ctx.store.saveGlobalPreferences(ctx.session.getGlobalPreferences());
  } catch {
    // Ignore preference persistence failures during command execution.
  }
}

function thinkingOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
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
  const displayModel = currentSessionModelDisplayName(session);
  const levels = getThinkingLevels(model);
  const trimmed = args.trim().toLowerCase();

  if (!trimmed) {
    // No arg: show info (fallback for non-overlay usage)
    const current = session.thinkingLevel;
    if (!levels.length) {
      ctx.showMessage(`Model '${displayModel}' does not support configurable thinking levels.`);
    } else {
      ctx.showMessage(
        `Thinking level: ${current}\n` +
        `Available levels for ${displayModel}: ${levels.join(", ")}`,
      );
    }
    return;
  }

  if (trimmed === "default") {
    session.thinkingLevel = "default";
    persistGlobalPreferences(ctx);
    ctx.showMessage("Thinking level reset to provider default.");
    return;
  }

  if (levels.length && !levels.includes(trimmed)) {
    ctx.showMessage(
      `Invalid level '${trimmed}' for ${displayModel}.\n` +
      `Available: ${levels.join(", ")}`,
    );
    return;
  }

  session.thinkingLevel = trimmed;
  persistGlobalPreferences(ctx);
  ctx.showMessage(`Thinking level set to: ${trimmed}`);
}

function cacheHitOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
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

  persistGlobalPreferences(ctx);

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
  "openai-codex": "openai-codex", // Separate group — uses OAuth, not shared API key
  "kimi-cn": "kimi",
  "kimi-ai": "kimi",
  "kimi-code": "kimi",
  "glm-intl": "glm",
  "glm-code": "glm",
  "glm-intl-code": "glm",
  "minimax-cn": "minimax",
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

  // OAuth fallback for openai-codex
  if (provider === "openai-codex") {
    try {
      if (hasOAuthTokens()) return "oauth:openai-codex";
    } catch { /* ignore */ }
  }

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

function formatPresetPickerLabel(provider: string, presetModel: ProviderPresetModel): string {
  let label = formatDisplayModelName(provider, presetModel.id);
  if (presetModel.optionNote) {
    label = `${label}  (${presetModel.optionNote})`;
  }
  return label;
}

function formatPresetSelectedHint(provider: string, presetModel: ProviderPresetModel): string {
  let label = formatScopedModelName(provider, presetModel.id);
  if (presetModel.optionNote) {
    label = `${label} (${presetModel.optionNote})`;
  }
  return label;
}

export function resolveModelSelection(
  session: any,
  target: string,
  apiKey?: string,
) {
  return resolveModelSelectionCore(session, target, apiKey);
}

/**
 * Build model children (leaf-level options) for a single provider.
 */
function buildModelChildren(
  provider: string,
  byProvider: Map<string, Map<string, { model: string; label: string }>>,
  providerHasKey: Map<string, boolean>,
  session: any,
  currentProvider: string,
  currentModel: string,
): CommandOption[] {
  const models = Array.from((byProvider.get(provider) ?? new Map()).entries());
  models.sort((a, b) => a[1].label.localeCompare(b[1].label));
  const children: CommandOption[] = [];

  for (const [selectionKey, item] of models) {
    const runtimeSelectionName = runtimeModelName(provider, selectionKey);
    const isCurrent = session.currentModelConfigName === runtimeSelectionName
      || (
        selectionKey === item.model
        && provider === currentProvider
        && item.model === currentModel
      );
    const missingApiKey = !providerHasKey.get(providerKeyGroup(provider));
    const missingHint = provider === "openai-codex"
      ? "not logged in: run longeragent oauth"
      : "key missing: run longeragent init";

    let label = item.label;
    if (isCurrent && missingApiKey) {
      label = `${label}  (current, ${missingHint})`;
    } else if (isCurrent) {
      label = `${label}  (current)`;
    } else if (missingApiKey) {
      label = `${label}  (${missingHint})`;
    }

    children.push({
      label,
      value: `${provider}:${selectionKey}`,
    });
  }

  return children;
}

/** Display names for OpenRouter vendor prefixes. */
const OPENROUTER_VENDOR_NAMES: Record<string, string> = {
  "anthropic": "Anthropic",
  "openai": "OpenAI",
  "moonshotai": "Kimi",
  "minimax": "MiniMax",
  "z-ai": "GLM / Zhipu",
};

/**
 * Build options for /model picker.
 *
 * Supports three structures:
 * - Two-level: provider → model (for ungrouped providers like anthropic, openai)
 * - Three-level via group field: group → sub-provider → model (kimi, glm, minimax)
 * - Three-level via vendor prefix: openrouter → vendor → model
 */
function modelOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const config = session.config;
  if (!config) return [];

  const entries = readModelEntries(config);
  const currentProvider = String(session.primaryAgent?.modelConfig?.provider ?? "");
  const currentModel = String(session.primaryAgent?.modelConfig?.model ?? "");

  // Gather all providers/models:
  // 1) preset catalog
  // 2) user-defined config models (for custom IDs/providers)
  const byProvider = new Map<string, Map<string, { model: string; label: string }>>();
  const providerOrder: string[] = [];
  const addModel = (provider: string, selectionKey: string, model: string, label: string) => {
    if (!provider || !selectionKey || !model) return;
    if (!byProvider.has(provider)) {
      byProvider.set(provider, new Map());
      providerOrder.push(provider);
    }
    if (!byProvider.get(provider)!.has(selectionKey)) {
      byProvider.get(provider)!.set(selectionKey, { model, label });
    }
  };

  for (const preset of PROVIDER_PRESETS) {
    for (const m of preset.models) {
      addModel(preset.id, m.key, m.id, formatPresetPickerLabel(preset.id, m));
    }
  }
  for (const e of entries) {
    addModel(
      e.provider,
      e.model,
      e.model,
      formatDisplayModelName(e.provider, e.model),
    );
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
  // OAuth: check token store for openai-codex (sync, no HTTP)
  try {
    if (hasOAuthTokens()) providerHasKey.set("openai-codex", true);
  } catch { /* auth module not available */ }
  const currentProviderGroup = providerKeyGroup(currentProvider);
  if (session.primaryAgent?.modelConfig?.apiKey) {
    providerHasKey.set(currentProviderGroup, true);
  }

  // Build a lookup from provider id → preset (for group metadata).
  const presetById = new Map<string, (typeof PROVIDER_PRESETS)[number]>();
  for (const p of PROVIDER_PRESETS) {
    presetById.set(p.id, p);
  }

  const options: CommandOption[] = [];
  const processed = new Set<string>();

  for (const provider of providerOrder) {
    if (processed.has(provider)) continue;
    processed.add(provider);

    const preset = presetById.get(provider);

    // ── Three-level: grouped providers (kimi, glm, minimax) ──
    if (preset?.group) {
      // Collect all providers in this group (preserving providerOrder).
      const groupMembers = providerOrder.filter((p) => {
        const pp = presetById.get(p);
        return pp?.group === preset.group;
      });
      for (const gp of groupMembers) processed.add(gp);

      const subOptions: CommandOption[] = [];
      let groupHasCurrent = false;

      for (const gp of groupMembers) {
        const gpPreset = presetById.get(gp);
        const children = buildModelChildren(
          gp, byProvider, providerHasKey, session, currentProvider, currentModel,
        );
        const subHasCurrent = children.some((c) => c.label.includes("(current)"));
        if (subHasCurrent) groupHasCurrent = true;

        const subLabel = gpPreset?.subLabel ?? gp;
        subOptions.push({
          label: subHasCurrent ? `${subLabel}  (current)` : subLabel,
          value: gp,
          children,
        });
      }

      const groupLabel = preset.groupLabel ?? preset.group;
      options.push({
        label: groupHasCurrent ? `${groupLabel}  (current)` : groupLabel,
        value: preset.group,
        children: subOptions,
      });
      continue;
    }

    // ── Three-level: OpenRouter (sub-group by vendor prefix) ──
    if (provider === "openrouter") {
      const children = buildModelChildren(
        provider, byProvider, providerHasKey, session, currentProvider, currentModel,
      );

      // Group children by vendor prefix (e.g. "anthropic/..." → "anthropic").
      const vendorGroups = new Map<string, CommandOption[]>();
      const vendorOrder: string[] = [];
      for (const child of children) {
        const modelKey = child.value.split(":")[1] ?? "";
        const slashIdx = modelKey.indexOf("/");
        const vendor = slashIdx > 0 ? modelKey.slice(0, slashIdx) : "other";
        if (!vendorGroups.has(vendor)) {
          vendorGroups.set(vendor, []);
          vendorOrder.push(vendor);
        }
        vendorGroups.get(vendor)!.push(child);
      }

      const subOptions: CommandOption[] = [];
      let openrouterHasCurrent = false;
      for (const vendor of vendorOrder) {
        const vendorChildren = vendorGroups.get(vendor)!;
        const vendorHasCurrent = vendorChildren.some((c) => c.label.includes("(current)"));
        if (vendorHasCurrent) openrouterHasCurrent = true;
        const displayName = OPENROUTER_VENDOR_NAMES[vendor] ?? vendor;
        subOptions.push({
          label: vendorHasCurrent ? `${displayName}  (current)` : displayName,
          value: `openrouter-${vendor}`,
          children: vendorChildren,
        });
      }

      options.push({
        label: openrouterHasCurrent ? "openrouter  (current)" : "openrouter",
        value: "openrouter",
        children: subOptions,
      });
      continue;
    }

    // ── Two-level: ungrouped providers (anthropic, openai, user-defined) ──
    const children = buildModelChildren(
      provider, byProvider, providerHasKey, session, currentProvider, currentModel,
    );
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
 * The selected value is either a config name or a provider:model target.
 */
async function cmdModel(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim();

  if (!trimmed) {
    const displayCurrent = currentSessionModelDisplayName(session) || "unknown";
    const current = session.currentModelConfigName
      ? `${session.currentModelConfigName} (${displayCurrent})`
      : displayCurrent;
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
    const resolvedSelection = resolveModelSelection(session, target, apiKey);
    const { selectedConfigName, selectedHint } = resolvedSelection;

    // Save current session before switching
    ctx.resetUiState();
    ctx.autoSave();
    if (ctx.store) {
      ctx.store.clearSession();
    }

    // Switch model, then create fresh session
    session.switchModel(selectedConfigName);
    session.setPersistedModelSelection?.({
      modelConfigName: selectedConfigName,
      modelProvider: resolvedSelection.modelProvider,
      modelSelectionKey: resolvedSelection.modelSelectionKey,
      modelId: resolvedSelection.modelId,
    });
    session.resetForNewSession(ctx.store);
    persistGlobalPreferences(ctx);

    const mc = session.primaryAgent?.modelConfig;
    if (mc) {
      ctx.showMessage(
        `--- New session with ${selectedHint} (${formatScopedModelName(mc.provider, mc.model)}) ---\n` +
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
// /theme command
// ------------------------------------------------------------------

function themeOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = theme.accent;
  return ACCENT_PRESETS.map((preset) => {
    const isCurrent = preset.value === current;
    return {
      label: isCurrent ? `${preset.label}  (current)` : preset.label,
      value: preset.value,
    };
  });
}

async function cmdTheme(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();

  if (!trimmed) {
    ctx.showMessage(
      `Current accent: ${theme.accent}\n` +
      "Use /theme to select a new accent color.",
    );
    return;
  }

  // Accept preset label (case-insensitive) or raw hex value
  const preset = ACCENT_PRESETS.find(
    (p) => p.value === trimmed || p.label.toLowerCase() === trimmed.toLowerCase(),
  );
  const color = preset ? preset.value : trimmed;

  // Basic hex validation
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    ctx.showMessage(`Invalid color: "${trimmed}". Use a preset name or a hex color like #3b82f6.`);
    return;
  }

  setAccent(color);
  ctx.session.accentColor = color;
  persistGlobalPreferences(ctx);

  const label = preset ? `${preset.label} (${color})` : color;
  ctx.showMessage(`Accent color set to: ${label}`);
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
  registry.register({ name: "/resume", description: "Resume a previous session", handler: cmdResume, options: resumeOptions });
  registry.register({ name: "/summarize", description: "Manually summarize older context", handler: cmdSummarize });
  registry.register({ name: "/model", description: "Switch model", handler: cmdModel, options: modelOptions });
  registry.register({ name: "/quit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/exit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/thinking", description: "Set thinking level", handler: cmdThinking, options: thinkingOptions });
  registry.register({ name: "/cachehit", description: "Prompt caching", handler: cmdCacheHit, options: cacheHitOptions });
  registry.register({ name: "/theme", description: "Change accent color", handler: cmdTheme, options: themeOptions });
  registry.register({ name: "/skills", description: "Manage installed skills", handler: cmdSkills, options: skillsOptions, checkboxMode: true });
  return registry;
}

// ------------------------------------------------------------------
// /skills command
// ------------------------------------------------------------------

function skillsOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  if (!session?.getAllSkillNames) return [];
  const allSkills = session.getAllSkillNames();
  if (allSkills.length === 0) return [];

  return allSkills.map((s: { name: string; description: string; enabled: boolean }) => ({
    label: `${s.name}  ${s.description.length > 50 ? s.description.slice(0, 47) + "..." : s.description}`,
    value: s.name,
    checked: s.enabled,
  }));
}

async function cmdSkills(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session?.getAllSkillNames) {
    ctx.showMessage("Skills system not available.");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    // No args — show list
    const allSkills = session.getAllSkillNames();
    if (allSkills.length === 0) {
      ctx.showMessage("No skills installed.");
      return;
    }
    const lines = ["Installed skills:"];
    for (const s of allSkills) {
      lines.push(`  ${s.enabled ? "[x]" : "[ ]"} ${s.name} — ${s.description}`);
    }
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Checkbox picker submits comma-separated enabled skill names
  // Parse: all items were submitted, enabled ones are in the args
  const enabledNames = new Set(trimmed.split(",").map((s: string) => s.trim()).filter(Boolean));
  const allSkills = session.getAllSkillNames();
  const oldSkills = session.skills;

  for (const s of allSkills) {
    session.setSkillEnabled(s.name, enabledNames.has(s.name));
  }
  session.reloadSkills();

  // Re-register slash commands
  reRegisterSkillCommands(ctx.commandRegistry, oldSkills, session.skills);

  const enabledCount = enabledNames.size;
  const totalCount = allSkills.length;
  ctx.showMessage(`Skills updated: ${enabledCount}/${totalCount} enabled.`);
  persistGlobalPreferences(ctx);
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

/**
 * Unregister old skill commands, then register new ones.
 * Used after reloadSkills() to keep slash commands in sync.
 */
export function reRegisterSkillCommands(
  registry: CommandRegistry,
  oldSkills: ReadonlyMap<string, SkillMeta>,
  newSkills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of oldSkills.values()) {
    registry.unregister("/" + skill.name);
  }
  registerSkillCommands(registry, newSkills);
}
