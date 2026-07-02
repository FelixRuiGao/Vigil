<!-- brief -->
View sub-agent status and background shell status. Returns agent reports (working, completed, errored) and tracked shell summaries.

<!-- guide -->
View detailed sub-session status and background shell status. Non-blocking. Returns the current child snapshots, recent events, and tracked shell summaries. Every incoming message already includes a compact `Sub-Session Brief`; use `check_status` only when you need the detailed version.
