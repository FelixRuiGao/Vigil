<!-- brief -->
Pause this turn until a runtime event arrives or the timeout expires. Runtime events include sub-agent completion, incoming messages, and tracked background shell exit. Preferred over check_status when you have nothing else to do.

<!-- guide -->
Pause this turn until a runtime event arrives or the timeout expires. Runtime events include sub-agent completion, incoming messages, and tracked background shell exit. **Always prefer this when you have delegated work or a background process running and the next useful step depends on runtime events.**

- `seconds` (required, minimum 10): Wall-clock timeout in seconds. Size it to what you're waiting for — short for a quick background command, generous (60–120s) for sub-agents that take minutes.
- **When a background shell or a sub-agent is running and you have nothing else to do, `await_event` it — don't keep polling its status.** Repeatedly calling `bash_output` (for a shell) or `check_status` (for a sub-agent) just to see whether it's done re-pulls their state into context every time and fills the window for nothing; `await_event` sleeps until it actually finishes, at no context cost. Use `bash_output` / `check_status` only when you genuinely need to *inspect* intermediate state, not to detect completion. Call `await_event` again if it returns with work still running.
- Returns early if ANY sub-session changes state, a tracked shell exits, or a new message arrives. Ordinary shell output does **not** wake it.
- Returns delivery content with any new messages, a `Sub-Session Brief`, and shell status.

> Spawned explorers to understand module structure. **`await_event(seconds=60)`** — you need their results before acting.
