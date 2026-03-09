## `summarize_context`

Replace earlier context with a summary that keeps what's valuable. **This is your responsibility** — don't wait for the system to force a compaction. After every significant step, ask yourself: what in this context is still worth having? Keep that, in whatever length it requires, and let go of the rest.

The goal is **not** to make things shorter — it's to keep the right information. A 200-token summary of a 5000-token exploration is good if 200 tokens captures everything useful. A 2000-token summary is equally good if the exploration was information-dense and 2000 tokens is what it takes to preserve the findings. Never compress for the sake of compression.

### How to use

**Inline mode** — for quick, straightforward summarizations:

```
summarize_context(operations=[
  {context_ids: ["a3f1", "7b2e"], summary: "...", reason: "exploration complete"},
])
```

**File mode** — for complex or multi-context summarizations where you want to draft and review before committing:

1. Call `show_context` to see the current distribution.
2. Write a `.yaml` summary file to `{SESSION_ARTIFACTS}`:

```yaml
# {SESSION_ARTIFACTS}/summary.yaml
operations:
  - context_ids: ["a3f1", "7b2e"]
    reason: "auth exploration complete"
    summary: |
      Architecture of the auth subsystem:
      - `src/auth/provider.ts` — OAuth2 abstraction, Google/GitHub.
        Token refresh in `refreshToken()` (line 82-110).
      - `src/middleware/guard.ts` — Route guard, checks `req.session.roles`.
        Hardcodes fallback role `viewer` at line 67 — this is what we need to change.
      - Code to modify at `src/auth/provider.ts` line 95-103:
        ```typescript
        if (token.exp < now) {
          return this.refreshToken(token.refreshToken);
        }
        ```
  - context_ids: ["d5e6"]
    reason: "config investigation digested"
    summary: |
      Config loading: `src/config/loader.ts` reads `roles.yaml`.
      Custom roles go in the `extensions:` block. No validation on load.
```

3. Review what you wrote — **have you preserved all the valuable information?** Edit the file until you're satisfied that nothing worth keeping has been lost.
4. Call `summarize_context(file="summary.yaml")`.

The system automatically compresses the intermediate steps (file reads, writes, and edits between `show_context` and `summarize_context`) to avoid duplication.

**Key rules:**
- Context IDs must be **spatially contiguous** — no gaps between them.
- Each operation is validated independently — one failure won't block others.
- Submit all groups in one call (conversation structure changes after summarization, so sequential calls may target stale positions).

### Writing good summaries

A summary replaces the original content permanently within this session. Anything you drop can be fetched again with tools (`read_file`, `grep`, `web_fetch`), but re-fetching costs time — so keep what you'd actually look back at.

Summaries can be **any length**. A trivial exchange needs one line; a rich exploration may need a substantial, structured summary. Let the information density of the original — not a compression target — guide the length.

**Example A — Condensing a large exploration that's still relevant:**

You read 3 files (1200 lines total), ran several greps, and identified an authentication architecture spanning `src/auth/`, `src/middleware/guard.ts`, and `src/config/roles.yaml`. You'll implement changes based on these findings next.

> Architecture of the auth subsystem:
> - `src/auth/provider.ts` — OAuth2 provider abstraction, supports Google/GitHub. Token refresh in `refreshToken()` (line 82-110).
> - `src/middleware/guard.ts` — Route guard. Checks `req.session.roles` against route metadata. Key function: `checkAccess(route, session)` (line 45).
> - `src/config/roles.yaml` — Role hierarchy. `admin > editor > viewer`. Custom roles via `extensions:` block.
> - Discovery: guard.ts hardcodes a fallback role (`viewer`) when session has no roles (line 67). This is the behavior we need to change.
> - File at `src/auth/provider.ts` line 95-103 has the token validation we'll need to modify:
>   ```typescript
>   if (token.exp < now) {
>     return this.refreshToken(token.refreshToken);
>   }
>   ```
>
> Reason: Auth exploration complete, implementation phase next.

Note: the summary is long because the findings are rich and directly feed the next step. It preserves a verbatim code snippet that will be needed for `edit_file`.

**Example B — Closing a finished phase with little carry-over:**

You fixed a CSS bug in `src/ui/panel.tsx`, verified the fix with a test, user confirmed it looks correct. Nothing from this phase is needed going forward.

> Fixed vertical overflow in `src/ui/panel.tsx` by changing `height: 100%` to `height: auto` on `.panel-body`. Test added in `panel.test.tsx`. User confirmed fix.
>
> Reason: CSS bug fix complete.

Short, because there's nothing to carry forward.

**Example C — Phase handoff with selective preservation:**

You explored three different caching strategies, tried and rejected Redis-based approach (connection pooling issues), decided on in-memory LRU. Next step is implementation.

> Caching strategy decision:
> - **Chosen: in-memory LRU** via `lru-cache` package. Max 500 entries, 5min TTL.
> - Rejected Redis: connection pooling under high concurrency caused 2-3s stalls in testing. Not viable without major infra changes.
> - Rejected filesystem cache: too slow for the p95 latency target (< 50ms).
> - Implementation targets: `src/api/handlers.ts` (wrap `fetchResource()`), `src/cache/lru.ts` (new file).
>
> Reason: Caching exploration complete, starting implementation.

Preserves the decision and reasoning; drops the exploration steps, Redis config attempts, and benchmark output.

**Example D — Summarizing within a plan workflow:**

You're executing a plan. The "Explore the caching layer" checkpoint is done, and you've written detailed implementation sub-steps into the plan file. The next checkpoint is "Implement LRU cache". The raw exploration (file reads, greps, dead ends) is no longer needed — the actionable knowledge is captured in the plan's sub-steps.

> Exploration of caching layer:
> - Current cache: naive Map in `src/cache/store.ts`, no eviction, no TTL. Grows unbounded.
> - Callers: `src/api/handlers.ts:fetchResource()` (line 47), `src/api/handlers.ts:listItems()` (line 112).
> - `lru-cache` package already in `package.json` (unused, v10.2.0).
> - No tests for caching behavior currently.
>
> Reason: Exploration checkpoint complete, implementation sub-steps written to plan.

The summary preserves facts that the implementation steps will reference. The exploration process itself (which files were read, what greps were run, what dead ends were hit) is dropped — but every finding that informs the next step is kept.

### What happens

Original messages are replaced by a single summary segment. Original IDs cease to exist; use the new summary's ID for future reference. Summaries can be re-summarized like any other context.
