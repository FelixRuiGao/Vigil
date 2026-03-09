/**
 * User settings — loaded from ~/.longeragent/settings.json.
 *
 * Separate from config.yaml which defines resources (models, providers, MCP).
 * Settings define runtime behavior tuning (thresholds, output limits).
 * This file is manually edited by the user; no TUI/CLI commands modify it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LONGERAGENT_HOME_DIR } from "./config.js";
import { homedir } from "node:os";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ContextThresholds {
  /** Summarize hint level 1 trigger (percentage 20-95 of effective context window). */
  summarize_hint_level1: number;
  /** Summarize hint level 2 trigger (percentage 20-95, must be >= level1). */
  summarize_hint_level2: number;
  /** Auto-compact trigger on normal output (percentage 20-95). */
  compact_output: number;
  /** Auto-compact trigger when tool calls present (percentage 20-95, must be >= compact_output). */
  compact_toolcall: number;
}

export interface UserSettings {
  /** Global max output tokens override. Clamped to [4096, model_max]. */
  max_output_tokens?: number;
  /** Context management thresholds. */
  context?: Partial<ContextThresholds>;
}

/** Resolved settings with defaults applied and validation complete. */
export interface ResolvedSettings {
  maxOutputTokens: number | undefined;
  thresholds: ContextThresholds;
  warnings: string[];
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

export const DEFAULT_THRESHOLDS: ContextThresholds = {
  summarize_hint_level1: 60,
  summarize_hint_level2: 80,
  compact_output: 85,
  compact_toolcall: 90,
};

// ------------------------------------------------------------------
// Loading
// ------------------------------------------------------------------

const SETTINGS_FILE = "settings.json";

export function loadSettingsFile(homeDir?: string): UserSettings | null {
  const home = homeDir ?? join(homedir(), LONGERAGENT_HOME_DIR);
  const settingsPath = join(home, SETTINGS_FILE);
  if (!existsSync(settingsPath)) return null;

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw) as UserSettings;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

function isValidThreshold(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 20 && v <= 95;
}

/**
 * Validate and resolve user settings.
 * Returns resolved settings with defaults applied and a list of warnings
 * for any invalid values.
 */
export function resolveSettings(raw: UserSettings | null): ResolvedSettings {
  const warnings: string[] = [];

  if (!raw) {
    return {
      maxOutputTokens: undefined,
      thresholds: { ...DEFAULT_THRESHOLDS },
      warnings,
    };
  }

  // -- max_output_tokens --
  let maxOutputTokens: number | undefined;
  if (raw.max_output_tokens !== undefined) {
    if (typeof raw.max_output_tokens === "number" && Number.isFinite(raw.max_output_tokens)) {
      if (raw.max_output_tokens < 4096) {
        maxOutputTokens = 4096;
        warnings.push(
          `max_output_tokens (${raw.max_output_tokens}) 低于最小值 4096，已调整为 4096`,
        );
      } else {
        maxOutputTokens = raw.max_output_tokens;
      }
    } else {
      warnings.push(`max_output_tokens 必须是数字，已忽略`);
    }
  }

  // -- context thresholds --
  const ctx = raw.context;
  const thresholds = { ...DEFAULT_THRESHOLDS };

  if (ctx) {
    // Validate summarize pair independently
    const s1 = ctx.summarize_hint_level1;
    const s2 = ctx.summarize_hint_level2;
    const hasS1 = s1 !== undefined;
    const hasS2 = s2 !== undefined;

    if (hasS1 || hasS2) {
      const v1 = hasS1 ? s1 : DEFAULT_THRESHOLDS.summarize_hint_level1;
      const v2 = hasS2 ? s2 : DEFAULT_THRESHOLDS.summarize_hint_level2;

      if (!isValidThreshold(v1) || !isValidThreshold(v2)) {
        const invalid = !isValidThreshold(v1) ? `summarize_hint_level1=${v1}` : `summarize_hint_level2=${v2}`;
        warnings.push(`Summarize 阈值无效（${invalid} 不在 20-95 范围内），已使用默认值 ${DEFAULT_THRESHOLDS.summarize_hint_level1}/${DEFAULT_THRESHOLDS.summarize_hint_level2}`);
      } else if (v2 < v1) {
        warnings.push(`Summarize 阈值无效（level2=${v2} < level1=${v1}），已使用默认值 ${DEFAULT_THRESHOLDS.summarize_hint_level1}/${DEFAULT_THRESHOLDS.summarize_hint_level2}`);
      } else {
        thresholds.summarize_hint_level1 = v1;
        thresholds.summarize_hint_level2 = v2;
      }
    }

    // Validate compact pair independently
    const cOut = ctx.compact_output;
    const cTool = ctx.compact_toolcall;
    const hasCOut = cOut !== undefined;
    const hasCTool = cTool !== undefined;

    if (hasCOut || hasCTool) {
      const vOut = hasCOut ? cOut : DEFAULT_THRESHOLDS.compact_output;
      const vTool = hasCTool ? cTool : DEFAULT_THRESHOLDS.compact_toolcall;

      if (!isValidThreshold(vOut) || !isValidThreshold(vTool)) {
        const invalid = !isValidThreshold(vOut) ? `compact_output=${vOut}` : `compact_toolcall=${vTool}`;
        warnings.push(`Compact 阈值无效（${invalid} 不在 20-95 范围内），已使用默认值 ${DEFAULT_THRESHOLDS.compact_output}/${DEFAULT_THRESHOLDS.compact_toolcall}`);
      } else if (vTool < vOut) {
        warnings.push(`Compact 阈值无效（compact_toolcall=${vTool} < compact_output=${vOut}），已使用默认值 ${DEFAULT_THRESHOLDS.compact_output}/${DEFAULT_THRESHOLDS.compact_toolcall}`);
      } else {
        thresholds.compact_output = vOut;
        thresholds.compact_toolcall = vTool;
      }
    }
  }

  return { maxOutputTokens, thresholds, warnings };
}

// ------------------------------------------------------------------
// Derived hysteresis thresholds
// ------------------------------------------------------------------

/**
 * Compute hysteresis reset thresholds from trigger thresholds.
 * These are not user-configurable; they are auto-derived.
 */
export function computeHysteresisThresholds(t: ContextThresholds): {
  hintResetNone: number;
  hintResetLevel1: number;
} {
  return {
    hintResetNone: t.summarize_hint_level1 - 20,
    hintResetLevel1: (t.summarize_hint_level1 + t.summarize_hint_level2) / 2,
  };
}
