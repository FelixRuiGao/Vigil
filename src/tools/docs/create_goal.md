<!-- brief -->
Create a session goal: a completion condition the session keeps working toward across turns (the system re-activates you after each turn until the goal is complete or blocked). Use ONLY when the user explicitly asks for goal-driven, keep-going-until-done work — never infer a goal from an ordinary task. Creating a goal replaces any existing one.

<!-- guide -->
`create_goal(condition)`

Start goal-driven continuation: while a goal is active, the system re-activates you after each turn instead of returning control to the user, until you mark the goal `complete` or `blocked` via `update_goal` (or the user clears it with /goal).

**Only on explicit request.** The user must have asked for this — "keep going until it's done", "work through the backlog overnight", "don't stop until tests pass", or an explicit /goal-style instruction. An ordinary task, however large, is not a goal; never create one on your own initiative. (The user can also set a goal directly with the `/goal` command — you don't need to mirror it with this tool.)

**Write a verifiable condition.** The condition should be judged from evidence your own output can show:

- One measurable end state: a test result, a build exit code, an empty backlog, a metric threshold.
- The check that proves it: "`bun test` exits 0", "every item in ledger.md is marked done".
- Constraints that must hold on the way: "without modifying files outside src/".

Vague conditions ("make it better", "work on the app") make the loop unbounded — push back and ask the user to concretize before creating one.
