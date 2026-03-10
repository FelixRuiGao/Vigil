## `plan`

Use a tracked plan for non-trivial work.

A plan is a live execution guide. You do not need to fully design the whole task up front. Instead, first identify the overall route, then refine and execute one checkpoint at a time.

### When to use a plan

Use `plan` when the task is more than a quick obvious change.

Typical cases:

- The task spans multiple files, modules, or phases
- The implementation path is not fully obvious yet
- You should first find existing patterns or reusable code
- The work benefits from staged validation
- The task may benefit from `explorer` sub-agents
- The task has roughly 3 or more meaningful checkpoints

Skip the plan only for small, local, low-uncertainty tasks that can be completed quickly.

### Core workflow

Follow this workflow:

1. Do a light initial exploration
2. Write a high-level plan
3. Then repeat for each checkpoint:
   - Explore the checkpoint if needed
   - Update its sub-steps if the route is clearer
   - Execute and validate it
   - Call `show_context`, then either dismiss annotations or summarize completed context
   - Mark the checkpoint complete and move on

This is a rolling planning workflow.

Do **not** fully audit the codebase before starting.
Do **not** try to write a detailed implementation spec for every checkpoint up front.

Instead:

- Explore the whole task just enough to identify the likely route
- Explore each checkpoint more deeply only when you are about to do it

### Initial exploration

Your first exploration pass should be light.

Its purpose is to answer:

- What is the likely implementation route?
- Which files or modules are likely to matter?
- What existing code should probably be reused or mirrored?
- How will the result be validated?

Once those answers are mostly clear, write the plan and begin.

Do not stay in exploration mode longer than necessary.

### Checkpoint-level exploration

Before starting a checkpoint, explore that checkpoint's implementation path if it is not already clear.

This exploration should be narrow and practical.

Examples:

- Read the exact files you expect to change
- Find similar implementations to copy or adapt
- Trace the local call flow for this checkpoint
- Check how nearby tests are written
- Confirm what validation command applies to this checkpoint

If the checkpoint is already clear, skip extra exploration and execute it directly.

### Using explorers

Use `explorer` sub-agents when they help you understand the code faster.

Good uses:

- The task touches multiple code areas
- You want to find similar implementations in parallel
- You want one agent to inspect implementation patterns and another to inspect tests
- You want to narrow down the right integration point before editing

Guidelines:

- Prefer the fewest explorers necessary
- 1 explorer is usually enough
- Use 2-3 only when the task naturally splits into distinct areas
- Give each explorer a specific search goal
- Do not use explorers for trivial lookups in known files

Use explorers to support the current checkpoint, not to perform a full codebase audit.

### Creating a plan

Write a `.md` plan file in `{SESSION_ARTIFACTS}`.

The file must begin with a `## Checkpoints` section.

The checkpoints under that header must use Markdown task checkboxes in this exact structure:

- Incomplete checkpoint: `- [ ] ...`
- Completed checkpoint: `- [x] ...`

Do not use numbered lists for checkpoints. Do not replace the checkboxes with another format. The progress panel reads this checkbox structure directly.

Recommended structure:

```markdown
## Checkpoints
- [ ] Explore the auth flow and define the implementation route
- [ ] Implement refresh-token expiration handling
- [ ] Add tests and validate behavior

## Context
We need to handle expired refresh tokens without falling back to the hardcoded viewer role.
Expected outcome: expired refresh tokens trigger the existing re-auth path and preserve other auth behavior.

## Key Files
- `src/auth/provider.ts`
- `src/auth/errors.ts`
- `src/auth/guard.ts`
- `tests/auth-provider.test.ts`

## Explore the auth flow and define the implementation route
1. Read `src/auth/provider.ts` and trace refresh token failure handling
2. Inspect `src/auth/guard.ts` to find current fallback behavior
3. Find an existing auth error propagation pattern to reuse
4. Update the next checkpoint with concrete implementation steps

## Implement refresh-token expiration handling
1. Confirm where the expiration error is detected
2. Add or reuse a specific error type if needed
3. Route expired refresh token failures into the existing re-auth flow
4. Verify no unrelated auth failures change behavior

## Add tests and validate behavior
1. Add focused test coverage for expired refresh tokens
2. Update nearby guard tests if behavior changed
3. Run focused auth tests
4. Do a manual smoke test if applicable

## Validation
- Run focused auth tests
- Verify expired refresh tokens trigger re-auth
- Verify other auth failures behave as before
```

### Checkpoint quality

Checkpoints should represent meaningful outcomes.

Good checkpoints:

- Explore the request pipeline and identify the integration point
- Implement retry behavior for failed uploads
- Add regression tests and validate the flow

Weak checkpoints:

- Read code
- Think
- Edit file
- Run command

Each checkpoint should produce a visible result or verified milestone.

### Context handling after each checkpoint

After each meaningful checkpoint, call `show_context`.

Use it to inspect the current active window's context distribution before deciding what to do next.

Then choose one of these paths:

#### Path A: keep the current context as-is

Use this when:

- The context is not too large
- The material is still highly valuable in raw form
- You expect to refer back to the exact details in the next checkpoint

In this case:

- Call `show_context(dismiss=true)` to hide the inline annotations
- Continue to the next checkpoint

#### Path B: summarize completed context

Use this when:

- A checkpoint is complete and its raw exploration or tool output is no longer needed in full
- The important conclusions are stable
- A compact summary can preserve what matters better than keeping all raw detail

In this case:

1. Use the `show_context` output to identify the relevant context groups
2. Write a summary that preserves what future checkpoints will actually need
3. Call `summarize_context`
4. Continue to the next checkpoint

Do **not** try to guess context pressure abstractly. Use `show_context` to make the decision based on the actual context map.

### Summarizing well

The goal of summarization is not to make things shorter. The goal is to preserve the right information and let go of raw detail that has served its purpose.

A good summary usually keeps:

- Architectural findings that later checkpoints depend on
- Decisions and why they were made
- Relevant file paths and functions
- Important edge cases
- Exact snippets only when they will be needed again

A good summary usually drops:

- Search process
- Dead ends that no longer matter
- Redundant tool output
- Raw logs whose conclusions are already understood

### Updating the plan

The plan is live. Update it when reality changes.

Revise it when:

- Exploration changes your implementation route
- You find a better reuse point
- A checkpoint needs to be split or reordered
- Validation reveals missing follow-up work
- The scope changes materially

Do not keep following an outdated plan.

### Asking the user

Use `ask` only when a concrete user decision is needed and cannot be discovered from the codebase or request. Good cases include choosing between a small number of real implementation options, confirming a product behavior tradeoff, or resolving ambiguity that materially changes the plan. Do not ask the user questions you can answer through exploration.

### Submitting and executing

- `plan(action="submit", file="plan.md")` - Activates the plan. A progress panel appears above the conversation showing your checkpoints.
- `plan(action="check", item=0)` - Marks checkpoint 0 as done (0-based index). The system updates the checkbox in the file and refreshes the panel.
- `plan(action="finish")` - Dismisses the panel when all work is complete.

The plan file is injected into your context every round. Keep it current. You can edit it freely at any time with `edit_file`.
