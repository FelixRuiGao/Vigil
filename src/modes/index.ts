/**
 * Agent modes — switchable working stances for the main agent.
 *
 * A mode is a prompt-level posture (plus a few light runtime parameters like
 * summarize-hint thresholds); it is fully orthogonal to the permission system
 * and to the /goal continuation primitive. Sub-agents are mode-unaware.
 *
 * Each mode has one markdown stance file in ./docs/, embedded at build time
 * via Bun text imports (same pattern as src/tools/docs/). The same content is
 * rendered in two places:
 *
 *   - baked:    the "# Mode" section of the system prompt, inserted right
 *               after the role body at conversation start (and re-baked at
 *               compact/clear boundaries)
 *   - injected: a mode-transition notice appended to the conversation when
 *               the user switches modes mid-session
 *
 * Stance files must therefore be written to stand alone — no wording that
 * depends on surrounding sections.
 *
 * Switching state machine (owned by Session):
 *   selectedMode — what the user has picked (UI state, changes freely)
 *   bakedMode    — what the cached system prompt was assembled with; changes
 *                  only at conversation boundaries (first message, compact)
 *   activeMode   — what the conversation currently reflects; updated when a
 *                  transition notice is injected
 * A switch is settled lazily at message-send time: only when selectedMode
 * differs from activeMode is a notice injected, so toggling back and forth
 * between sends nets out to nothing.
 */

import autoDoc from "./docs/auto.md" with { type: "text" };
import defaultDoc from "./docs/default.md" with { type: "text" };
import scaleDoc from "./docs/scale.md" with { type: "text" };
import vibeDoc from "./docs/vibe.md" with { type: "text" };

export type AgentMode = "default" | "vibe" | "scale" | "auto";

/** Canonical order — also the Tab-cycle order in the TUI. */
export const AGENT_MODES: readonly AgentMode[] = ["default", "vibe", "scale", "auto"];

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}

/** Coerce a persisted/user value to a mode, falling back to "default". */
export function coerceAgentMode(value: unknown): AgentMode {
  return isAgentMode(value) ? value : "default";
}

export function nextAgentMode(mode: AgentMode, direction: 1 | -1 = 1): AgentMode {
  const idx = AGENT_MODES.indexOf(mode);
  const len = AGENT_MODES.length;
  return AGENT_MODES[(idx + direction + len) % len];
}

/** One-line description per mode — shown in the /mode picker. */
export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  default: "Balanced everyday collaboration",
  vibe: "You steer by outcomes; the agent owns the implementation",
  scale: "Large multi-part work: design first, delegate reading, checkpoint discipline",
  auto: "Long-running self-directed loops: ledger, verify-then-advance, keep going",
};

const MODE_DOCS: Record<AgentMode, string> = {
  default: defaultDoc.trim(),
  vibe: vibeDoc.trim(),
  scale: scaleDoc.trim(),
  auto: autoDoc.trim(),
};

/** The stance text for a mode (no heading wrapper). */
export function modeStance(mode: AgentMode): string {
  return MODE_DOCS[mode];
}

/**
 * The "# Mode" system-prompt section for a mode — inserted right after the
 * role body by the template loader (main agent only).
 */
export function buildModeSection(mode: AgentMode): string {
  return `# Mode\n\n${MODE_DOCS[mode]}`;
}

/**
 * The transition notice injected when the user switches modes mid-session.
 *
 * Switching back to the mode the system prompt was baked with uses a short
 * pointer — the full stance is guaranteed present in the system prompt.
 * Switching to any other mode carries the full stance: an earlier notice for
 * the same mode may have been summarized away, so pointing back at it is not
 * safe. Either form explicitly supersedes all prior mode stances.
 */
export function buildModeTransitionNotice(to: AgentMode, bakedMode: AgentMode): string {
  if (to === bakedMode) {
    return (
      `The user switched the working mode back to **${to}**. ` +
      `The stance in the "# Mode" section of your system prompt applies again, ` +
      `effective immediately. It replaces any mode stance stated after it in this conversation. ` +
      `Apply it to the work from this point on — don't retrofit process to work already completed.`
    );
  }
  return (
    `The user switched the working mode to **${to}**, effective immediately. ` +
    `The following stance replaces the "# Mode" section of your system prompt and any ` +
    `mode stance stated earlier in this conversation. Apply it to the work from this ` +
    `point on — don't retrofit process to work already completed.\n\n` +
    MODE_DOCS[to]
  );
}
