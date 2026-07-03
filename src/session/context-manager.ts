/**
 * ContextManager — context-pressure state and decisions (P2.3).
 *
 * Owns the configurable thresholds, the two-tier hint state machine with
 * hysteresis, the context budget arithmetic, and the mid-turn compact
 * trigger. Pure decision logic: message delivery, compact execution, and
 * token accounting stay with Session and arrive through the deps interface.
 */

import type { GuidanceTier, ModelConfig } from "../config.js";
import type { AgentMode } from "../modes/index.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
} from "../settings.js";

export type HintState = "none" | "level1_sent" | "level2_sent";

// -- Hint prompt generators (two-tier, mode- and guidance-aware) --

/**
 * One mode-flavored sentence appended to hint notices. Empty for the modes
 * whose stance says nothing special about cadence.
 */
function modeHintFlavor(mode: AgentMode): string {
  switch (mode) {
    case "scale":
      return " Fully completed checkpoints are the best targets — the design doc on disk keeps their details recoverable.";
    case "auto":
      return " Completed loop units are the best targets — the ledger keeps their details.";
    default:
      return "";
  }
}

/** Extra pointer for detailed-tier models: the recipe is in the system prompt. */
function guidanceHintFlavor(tier: GuidanceTier): string {
  return tier === "detailed"
    ? " Follow the steps in the Context Management — Recipes section of your system prompt."
    : "";
}

function HINT_LEVEL1_PROMPT(pct: string, level2Pct: string, mode: AgentMode, tier: GuidanceTier): string {
  return `[SYSTEM: Context usage has reached ${pct}. This is the first-level reminder — a second will arrive at ${level2Pct}. No immediate action is required:
- If the task is mostly done, you may simply ignore this notice.
- Otherwise, if you've reached a natural breakpoint, this is a good moment to summarize older context with \`summarize_context\` — fold already-consumed tool outputs and finished exploration into shorter summaries, keeping anything later steps may need.${modeHintFlavor(mode)} The user's own messages are never the target, and any summarization preference the user has stated still applies.${guidanceHintFlavor(tier)}
After handling this notice, continue your work.]`;
}

function HINT_LEVEL2_PROMPT(pct: string, mode: AgentMode, tier: GuidanceTier): string {
  return `[SYSTEM: Context usage has reached ${pct} — second-level reminder. When the window fills up, auto-compact will rewrite the whole conversation into a single summary, which is far more lossy than targeted summarization.
- If the remaining work is small, just finish it.
- If substantial work remains, act at the next natural breakpoint (don't interrupt an edit mid-flight): inspect with \`show_context\`, then \`summarize_context\` consumed tool results, finished exploration, and completed subtasks.${modeHintFlavor(mode)} Preserve anything later steps may reference — don't gut tool results. The user's own messages are off-limits, and any summarization preference the user has stated still applies.${guidanceHintFlavor(tier)}]`;
}

/**
 * Mode-default hint thresholds, applied only when the user has not
 * configured levels explicitly (settings.json summarize_hint or the
 * /summarize_hint command — explicit user config always wins).
 * Scale/auto sessions run long by design, so they nudge earlier.
 */
const MODE_HINT_LEVELS: Partial<Record<AgentMode, { level1: number; level2: number }>> = {
  scale: { level1: 40, level2: 65 },
  auto: { level1: 40, level2: 65 },
};

export interface ContextManagerDeps {
  getModelConfig(): ModelConfig;
  getBudgetCalcMode(): string | undefined;
  isCompactInProgress(): boolean;
  /** Root sessions auto-compact; children only get the 90% wrap-up warning. */
  canAutoCompact(): boolean;
  getLastInputTokens(): number;
  /** Queue a system notice for the model (hint prompts, child warning). */
  deliverSystemNotice(content: string): void;
  /** Current agent mode — flavors hint text and default thresholds. */
  getMode(): AgentMode;
}

export class ContextManager {
  private _thresholds: ContextThresholds = { ...DEFAULT_THRESHOLDS };
  private _summarizeHintEnabled = true;
  /** True once the user set hint levels explicitly — mode defaults then never apply. */
  private _userConfiguredHintLevels = false;
  private _budgetPercent = 100;
  private _hintState: HintState = "none";

  constructor(private readonly deps: ContextManagerDeps) {}

  get hintState(): HintState {
    return this._hintState;
  }

  set hintState(value: HintState) {
    this._hintState = value;
  }

  /** Live threshold object — summarize-hint config mutates it in place. */
  get thresholds(): ContextThresholds {
    return this._thresholds;
  }

  get budgetPercent(): number {
    return this._budgetPercent;
  }

  setBudgetPercent(value: number): void {
    this._budgetPercent = Math.max(1, Math.min(100, value));
  }

  /** Effective context length for a ModelConfig, scaled by budget percent. */
  effectiveContextLength(mc: ModelConfig): number {
    return Math.round(mc.contextLength * this._budgetPercent / 100);
  }

  /**
   * Context budget for pressure decisions (hints, compact triggers,
   * show_context), per the provider's accounting mode: fullContext budgets
   * the whole window and checks input tokens only; otherwise output headroom
   * is reserved out of the window.
   */
  budgetInfo(): { budget: number; fullContext: boolean } {
    const mc = this.deps.getModelConfig();
    const fullContext = this.deps.getBudgetCalcMode() === "full_context";
    const effective = this.effectiveContextLength(mc);
    return { budget: fullContext ? effective : effective - mc.maxTokens, fullContext };
  }

  /**
   * Current two-tier summarize hint CONFIGURATION — the base thresholds, not
   * the mode-adjusted effective levels. Consumers persisting or displaying
   * config must see what was configured; returning effective values here once
   * let a plain on/off toggle bake scale/auto's 40/65 into settings.json as
   * if the user had chosen them. `userConfigured` says whether the levels
   * were set explicitly (mode defaults then never apply).
   */
  getSummarizeHintConfig(): { enabled: boolean; level1: number; level2: number; userConfigured: boolean } {
    return {
      enabled: this._summarizeHintEnabled,
      level1: this._thresholds.context_hint_level1,
      level2: this._thresholds.context_hint_level2,
      userConfigured: this._userConfiguredHintLevels,
    };
  }

  /**
   * Update the two-tier summarize hint configuration (takes effect live).
   * Levels must be pre-validated by the caller (validateSummarizeHintLevels).
   * Setting levels marks them user-configured, which disables the earlier
   * mode-default thresholds for scale/auto.
   */
  setSummarizeHintConfig(config: { enabled?: boolean; level1?: number; level2?: number }): void {
    if (config.enabled !== undefined) this._summarizeHintEnabled = config.enabled;
    if (config.level1 !== undefined) this._thresholds.context_hint_level1 = config.level1;
    if (config.level2 !== undefined) this._thresholds.context_hint_level2 = config.level2;
    if (config.level1 !== undefined || config.level2 !== undefined) {
      this._userConfiguredHintLevels = true;
    }
  }

  /**
   * Hint levels in effect: the user's explicit configuration when present,
   * otherwise the current mode's defaults (scale/auto nudge earlier),
   * otherwise the base thresholds.
   */
  private _effectiveHintLevels(): { level1: number; level2: number } {
    if (!this._userConfiguredHintLevels) {
      const modeLevels = MODE_HINT_LEVELS[this.deps.getMode()];
      if (modeLevels) return modeLevels;
    }
    return {
      level1: this._thresholds.context_hint_level1,
      level2: this._thresholds.context_hint_level2,
    };
  }

  /**
   * Check and inject summarize-hint prompts if thresholds are met.
   * Two-tier: level 1 and level 2, configurable via settings.json
   * (`summarize_hint`) and the /summarize_hint command.
   */
  checkAndInjectHint(): void {
    if (this.deps.isCompactInProgress()) return;

    const { budget } = this.budgetInfo();
    if (budget <= 0) return;

    const ratio = this.deps.getLastInputTokens() / budget;
    const pct = `${Math.round(ratio * 100)}%`;

    // Child sessions: single warning at 90%, no summarize_context guidance
    if (!this.deps.canAutoCompact()) {
      if (ratio >= 0.90 && this._hintState === "none") {
        this.deps.deliverSystemNotice(
          `[SYSTEM: Context usage has reached ${pct}. You are approaching the context limit and do NOT have context management tools. Finish your current work as quickly as possible — avoid reading large files, reduce tool calls, and focus only on producing your final output. If work progress is not promising, stop now and output what you have so far.]`,
        );
        this._hintState = "level2_sent";
      }
      return;
    }

    if (!this._summarizeHintEnabled) return;

    const levels = this._effectiveHintLevels();
    const level2Ratio = levels.level2 / 100;
    const level1Ratio = levels.level1 / 100;
    const mode = this.deps.getMode();
    const tier = this.deps.getModelConfig().guidance;

    if (ratio >= level2Ratio && this._hintState !== "level2_sent") {
      this.deps.deliverSystemNotice(HINT_LEVEL2_PROMPT(pct, mode, tier));
      this._hintState = "level2_sent";
    } else if (ratio >= level1Ratio && this._hintState === "none") {
      const level2Pct = `${Math.round(levels.level2)}%`;
      this.deps.deliverSystemNotice(HINT_LEVEL1_PROMPT(pct, level2Pct, mode, tier));
      this._hintState = "level1_sent";
    }
  }

  /**
   * Update hint state based on actual inputTokens from the latest API call.
   * Implements hysteresis to prevent oscillation.
   * Reset thresholds are auto-derived from trigger thresholds.
   */
  updateHintStateAfterApiCall(): void {
    const { budget } = this.budgetInfo();
    if (budget <= 0) return;

    const ratio = this.deps.getLastInputTokens() / budget;

    // Derive hysteresis from the effective levels so mode defaults and user
    // config reset consistently with whatever triggered the hints.
    const levels = this._effectiveHintLevels();
    const hysteresis = computeHysteresisThresholds({
      ...this._thresholds,
      context_hint_level1: levels.level1,
      context_hint_level2: levels.level2,
    });

    if (ratio < hysteresis.hintResetNone / 100) {
      this._hintState = "none";
    } else if (ratio < hysteresis.hintResetLevel1 / 100) {
      this._hintState = "level1_sent";
    }
    // ratio >= hintResetLevel1: keep current state (don't downgrade)
  }

  /**
   * Build the mid-turn compact trigger for the tool loop, or undefined when
   * compact checking is off (compact already running, or a child session).
   */
  buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "mid_turn" } | null) | undefined {
    if (this.deps.isCompactInProgress()) return undefined;

    // Child sessions do not auto-compact; they receive a 90% warning instead
    // (see checkAndInjectHint) and are expected to finish or stop.
    if (!this.deps.canAutoCompact()) return undefined;

    const { budget, fullContext } = this.budgetInfo();

    if (budget <= 0) return undefined;

    const midTurnRatio = this._thresholds.compact_mid_turn / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      // Only trigger mid-turn compact on tool-call path. Text-only responses
      // mean the turn is ending; compact at the start of the NEXT turn instead.
      if (!hasToolCalls) return { compactNeeded: false };

      const tokensToCheck = fullContext
        ? inputTokens
        : inputTokens + outputTokens;

      if (tokensToCheck > midTurnRatio * budget) {
        return { compactNeeded: true, scenario: "mid_turn" };
      }
      return { compactNeeded: false };
    };
  }
}
