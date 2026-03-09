## `plan`

Structure your work with a tracked plan. For any task that involves 3 or more steps, write a plan before you start — only skip this for simple tasks that need almost no exploration and can be completed quickly.

### Creating a plan

Write a `.md` plan file in `{SESSION_ARTIFACTS}` with a `## Checkpoints` section at the top, followed by sections for each checkpoint's sub-steps:

```markdown
## Checkpoints
- [ ] Explore the auth module and its callers
- [ ] Implement token refresh error handling
- [ ] Update guard.ts fallback behavior
- [ ] Write and run tests

## Implement token refresh error handling
1. Add `RefreshExpiredError` to `src/auth/errors.ts`
2. In `src/auth/provider.ts`, catch expired refresh tokens in `refreshToken()` and throw `RefreshExpiredError`
3. Add re-authentication fallback in the catch block

## Update guard.ts fallback behavior
1. Remove hardcoded `viewer` fallback at line 67
2. Read default role from `roles.yaml` via `configLoader.getDefaultRole()`
```

Sub-step sections can be empty at first — fill them in as you learn more (e.g. after exploration).

### Submitting and executing

- `plan(action="submit", file="plan.md")` — Activates the plan. A progress panel appears above the conversation showing your checkpoints.
- `plan(action="check", item=0)` — Marks checkpoint 0 as done (0-based index). The system updates the checkbox in the file and refreshes the panel.
- `plan(action="finish")` — Dismisses the panel when all work is complete.

The plan file is injected into your context every round — you always see your current plan. You can edit the file freely at any time with `edit_file` (add sub-steps, reorder checkpoints, adjust scope). Changes take effect on the next round.

### Plan structure tips

**Fill in sub-steps after exploration.** A common pattern:

1. Start with a high-level plan (checkpoints only, sub-steps TBD)
2. Complete the exploration checkpoint
3. Write concrete sub-steps into the plan based on what you found
4. Summarize the raw exploration context — the actionable knowledge is now in the plan
5. Execute the remaining checkpoints

**Include summarize steps between phases.** When you finish a phase (exploration, implementation, testing), the raw tool output from that phase is typically no longer needed at full size. Add a summarize step to preserve the valuable findings and free up context for the next phase. Don't mechanically add one after every single checkpoint — use your judgment about when the accumulated context is worth condensing.

Example:

```markdown
## Checkpoints
- [x] Explore the caching layer and its callers
- [x] Write implementation sub-steps and summarize exploration context
- [ ] Implement LRU cache in src/cache/
- [ ] Write tests and summarize implementation context
- [ ] Final integration test
```
