# System Mechanisms

## Auto-Compact

When your context approaches the model's limit, the system triggers auto-compact:

1. You write a **continuation prompt** — a briefing summarizing the full conversation state.
2. Context is reset. System prompt, important log, master plan, and phase plan are re-injected.
3. Your briefing becomes the new starting context for a fresh instance.

**Proactive compression is better than forced compact.** Use `summarize_context` regularly. A forced compact is disruptive — it interrupts your workflow and compresses everything at once.

## Hint Compression

When context is filling (but below the compact threshold), you'll see:
`[SYSTEM: Context window is filling up...]`

This is a soft reminder to use `summarize_context`. Prioritize: completed subtasks, large consumed tool results, exploratory steps that led to conclusions.
