<!-- brief -->
Mark the active session goal `complete` or `blocked` — the only two transitions, and the only way the goal loop ends from your side. `complete` requires verification evidence in `evidence` (cite the actual check output). `blocked` requires that the same blocker has stopped progress for at least 3 consecutive turns despite different attempts.

<!-- guide -->
`update_goal(status, evidence)`

Ends goal-driven continuation. Two transitions, both deliberate:

- **`complete`** — the goal's condition holds, and you verified it this session. `evidence` must cite the actual verification: the command you ran and its result ("`bun test`: 412 pass, 0 fail"), the state that proves the end condition ("ledger.md: 30/30 items done"). Never mark complete from memory or expectation — run the check first. Misreporting completion is the one unforgivable failure of goal work.
- **`blocked`** — the same blocker has stopped progress for **at least 3 consecutive turns**, across genuinely different attempts. `evidence` states the blocker precisely, what you tried, and what you would try next if it were lifted. Being stuck once is not blocked; needing information only the user has IS blocked.

Cannot pause, resume, or edit the goal — only these two terminal transitions. If the user's intent changed, tell them to use `/goal` instead.
