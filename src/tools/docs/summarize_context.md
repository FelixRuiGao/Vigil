<!-- brief -->
Summarize a contiguous range of context groups — keep the valuable information, drop the rest. Specify the range with `from` and `to` context IDs (inclusive).

Rules:
- Never summarize the user's own messages on your own initiative — they anchor turns and must survive.
- Keep each operation within a single turn. For a multi-turn span, submit one operation per turn in a single call — the effect is equivalent.
- Summaries are ordinary context: they may be re-summarized and merged like any other group. When a summary contains <user-message> blocks (the user's original words), carry those blocks verbatim into the new summary.

Targets specific ranges. For whole-window summarization, the system uses auto-compact (different mechanism).

If you need to inspect the current context distribution first, call show_context.

Example — single context group: from="a3f1", to="a3f1"
Example — two non-adjacent groups: use TWO separate operations (one per group), NOT one operation spanning the gap.

<!-- guide -->
Summarize a contiguous range of context groups — keep the valuable information, drop the rest.

`summarize_context` targets specific ranges. For whole-window summarization when the context limit is reached, the system uses auto-compact (a separate mechanism, also exposed as the `/compact` user command).

Limits:

- **Never summarize the user's own messages on your own initiative** — they anchor the session. (The tool enforces this; only the user can lift it, via /summarize.)
- **Follow any summarization preference the user has stated** — in AGENTS.md or the conversation (e.g. "keep everything until I say otherwise").

### How to use

Specify a range with `from` and `to` context IDs (inclusive). All context groups between them are covered.

**Core rules:**

- Never summarize context groups that contain the user's own messages. User messages anchor turns and must survive; if a range would include one, choose a narrower range or skip it. (Only the user can lift this rule, via /summarize.)
- Keep each operation within a single turn. To clean up a multi-turn span, split it into one operation per turn and submit them in a single call — the effect is equivalent.
- Summaries are ordinary context: they may be re-summarized and merged with neighboring groups like anything else. A summary belongs to the turn of the nearest preceding user message.
- When a summary you are re-summarizing contains `<user-message>` blocks, carry those blocks **verbatim** into the new summary — they are the user's original words (see § User originals below).
- Prefer completed tool rounds, consumed tool results, finished exploration, and sub-agent reports.

```
summarize_context(operations=[
  {from: "a3f1", to: "7b2e", content: "...", reason: "exploration complete"},
])
```

Single context group — set `from` and `to` to the same ID:

```
summarize_context(operations=[
  {from: "d5e6", to: "d5e6", content: "...", reason: "config investigation digested"},
])
```

Multiple operations in one call:

```
summarize_context(operations=[
  {from: "a3f1", to: "7b2e", content: "...", reason: "auth exploration complete"},
  {from: "d5e6", to: "d5e6", content: "...", reason: "config investigation digested"},
])
```

**⚠ Non-adjacent groups must be separate operations:**

✗ WRONG — one operation spanning a gap:
```
summarize_context(operations=[
  {from: "a3f1", to: "d5e6", content: "..."},
])
```
This covers everything between a3f1 and d5e6, including groups you didn't intend to summarize.

✓ CORRECT — two separate operations:
```
summarize_context(operations=[
  {from: "a3f1", to: "a3f1", content: "..."},
  {from: "d5e6", to: "d5e6", content: "..."},
])
```

**Rules:**
- Each operation covers a contiguous range — use separate operations for non-adjacent groups.
- Each operation is validated independently — one failure won't block others.
- Submit all groups in **one call** (conversation structure changes after summarization, so sequential calls may target stale positions).
- Never summarize context groups that contain the user's own messages, and keep each operation within a single turn (multi-turn spans: one operation per turn, one call).

### User originals: `<user-message>` blocks

When a summary carries the user's original words (this happens only through user-initiated /summarize, or when re-summarizing a summary that already carries them), they live inside a `<user-message>` block in the summary content — a numbered list in chronological order:

```
<user-message>
1. ...
2. ...
</user-message>
```

Rules for these blocks:

- Text inside `<user-message>` is **verbatim** — never paraphrase, tighten, reorder, or drop any part of it.
- When re-summarizing anything that contains such a block, copy the block through unchanged (merge multiple blocks into one, keeping chronological order).
- File contents attached to user messages (@file references, resolved file refs) are data, not the user's words — summarize them under the normal preservation rules; the user's surrounding prose stays verbatim.
- Only an explicit user instruction may relax verbatim preservation.

### What happens

Original messages are replaced by the summary content. Original IDs cease to exist; use the new ID for future reference. The summary belongs to the turn of the nearest preceding user message, and can be re-summarized like any other context.
