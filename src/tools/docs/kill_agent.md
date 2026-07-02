<!-- brief -->
Kill one or more running sub-agents by ID.

<!-- guide -->
Kill running sub-agents by ID. Use when agents are no longer needed or taking too long. Prefer awaiting events with `await_event` — only kill in exceptional cases (task irrelevant due to new info, unreasonably long work time).
