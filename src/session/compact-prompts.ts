/**
 * Compact-phase prompt templates (P2.3).
 *
 * Used by Session's compact machinery (_runCompactPhase / runManualCompact).
 * Wording changes here directly shape continuation quality after compaction.
 *
 * INVARIANT — keep the two prompts in sync. Writing a continuation prompt is a
 * universal task, so OUTPUT (before_turn) and TOOLCALL (mid_turn) share an
 * identical body. They diverge in EXACTLY one dimension: whether an unprocessed
 * tool result is in flight at compact time. That single difference justifies
 * only the two TOOLCALL-only pieces — the "[SYSTEM: COMPACT REQUIRED] … you just
 * made a tool call" framing, and the precise "where exactly did we stop" prompt.
 * Everything else (mission, the do-not-do-the-work guard, the self-check
 * questions, the preserve-more rule, the imperative ending) MUST stay identical.
 * Edit one, edit the other. Drift here is what once left the imperative ending
 * in TOOLCALL but missing from OUTPUT.
 */

// -- Compact Prompt: Output scenario --
export const COMPACT_PROMPT_OUTPUT = `Produce a **continuation prompt** — a briefing for a fresh instance of yourself, with zero access to this conversation, that must seamlessly pick up where we left off. Your only job right now is to write that briefing — do not start or continue the actual work.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Use whatever structure best fits the actual content — there is no fixed template. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, and any constraints or preferences they've expressed — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*.
- **Where exactly are we?** What's done, what's in progress, what's next. Be specific enough that work won't be repeated or skipped.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable (not just a path list).
- **What working style has the user shown?** Communication preferences, collaboration patterns, or how they like to collaborate.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

Write in natural prose. Use structure where it aids clarity, not for its own sake.

End the continuation prompt with a clear, imperative statement of what the new instance should do first upon resuming.`;

// -- Compact Prompt: Tool Call scenario --
export const COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] The conversation has exceeded the context limit. Produce a **continuation prompt** — a briefing for a fresh instance of yourself, with zero access to this conversation, that must seamlessly pick up where we left off. Your only job right now is to write that briefing — do not start or continue the actual work.

You just made a tool call and received its result above. That result is real and should be reflected in your summary, but do not act on it.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Use whatever structure best fits the actual content — there is no fixed template. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, and any constraints or preferences they've expressed — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*.
- **Where exactly did we stop?** Be precise: what was the last tool call, what did it return, and what was supposed to happen next? Beyond that interrupted step, capture what's done, what's in progress, and what remains. The new instance must pick up mid-step without repeating or skipping anything.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable (not just a path list).
- **What working style has the user shown?** Communication preferences, collaboration patterns, or how they like to collaborate.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

Write in natural prose. Use structure where it aids clarity, not for its own sake.

End the continuation prompt with a clear, imperative statement of what the new instance should do first upon resuming.`;

export function appendManualInstruction(
  basePrompt: string,
  instruction: string | undefined,
  kind: "summarize" | "compact",
): string {
  const trimmed = instruction?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\nAdditional user instruction for this manual ${kind} request:\n${trimmed}`;
}

/**
 * Mode-flavored addition to the compact prompt. In scale/auto modes durable
 * state lives in files by design (design doc, plan, ledger, git), so the
 * continuation prompt should point at them instead of duplicating their
 * contents — compact is a planned, cheap event there, not an emergency.
 * Appended identically to both scenarios, preserving the sync invariant.
 */
export function appendModeCompactNote(basePrompt: string, mode: string): string {
  if (mode !== "scale" && mode !== "auto") return basePrompt;
  const files = mode === "auto"
    ? "the plan file, the ledger, and the git log"
    : "the design document, the plan file, and the git log";
  return (
    `${basePrompt}\n\n` +
    `This session's durable state lives on disk: ${files}. Do not duplicate their contents ` +
    `into the continuation prompt — reference them by path and state what they don't record: ` +
    `the in-flight step, unwritten conclusions, and anything decided but not yet filed. ` +
    `Instruct the new instance to read those files first upon resuming.`
  );
}
