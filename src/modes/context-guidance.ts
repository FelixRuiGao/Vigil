/**
 * Guidance-tier context-management pedagogy.
 *
 * The universal craft of writing good summaries lives in the main template's
 * policy.md (Summarization Policy), and each mode's stance carries its own
 * cadence (when / how aggressively). This module adds the third layer: for
 * "detailed"-tier models (see ModelConfig.guidance), an explicit step-by-step
 * recipe section — frontier models act well on the principles alone; weaker
 * models need the moves spelled out.
 *
 * Appended after the template policy file by assembleSystemPrompt via
 * opts.contextGuidance; rebuilt on model switch with the rest of the prompt.
 */

import type { GuidanceTier } from "../config.js";

const DETAILED_CONTEXT_GUIDANCE = `# Context Management — Recipes

Follow these steps literally; they implement the Summarization Policy above for this model family.

**When a context reminder arrives** (a \`[SYSTEM: Context usage ...]\` notice), act at the next natural breakpoint — after finishing the current tool round or subtask, never in the middle of an edit:

1. Call \`show_context\` and read the Context Map.
2. Pick target groups in this order: (a) large tool results you have already acted on (file reads, grep output, logs), (b) finished exploration that led to a conclusion, (c) sub-agent reports you have already digested. Skip anything later steps will need verbatim.
3. Never include the user's own messages in a range, and never include the group carrying the active mode stance.
4. Keep each operation inside one turn. For groups spanning several turns, write one operation per turn and submit them all in ONE \`summarize_context\` call.
5. Write each summary against this checklist: file paths and line numbers kept · decisions kept together with their why · verified results kept · error messages kept verbatim · only narrative scaffolding and duplication dropped.

**After finishing a distinct unit of work** (a subtask, an experiment, an investigation), summarize its tool rounds even without a reminder — small, frequent summaries beat one big forced compact.

**Before running a command with large output** (builds, test suites, long logs), redirect to a file and read back only what you need: \`cmd > out.log 2>&1\`, then grep out.log.

**When unsure whether to keep something: keep it.** An oversized summary costs a little; a lost detail costs a re-investigation.`;

/** The context-pedagogy section for a guidance tier ("" when none applies). */
export function buildContextGuidance(tier: GuidanceTier): string {
  return tier === "detailed" ? DETAILED_CONTEXT_GUIDANCE : "";
}
