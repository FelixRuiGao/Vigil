<!-- brief -->
Spawn a single sub-agent with inline parameters. Check pre-defined templates (e.g. 'explorer', 'reviewer') before creating custom ones. See system prompt for available templates and their capabilities.

<!-- guide -->
Launch a sub-session for a bounded subtask.

```
spawn(
  id="explorer-1",
  template="explorer",
  mode="oneshot",
  task="Explore the providers/ directory at {PROJECT_ROOT}/src/providers/ ..."
)
```

Required parameters: `id`, `template` (or `template_path`), `task`, `mode`.

To run multiple agents in parallel, issue several `spawn(...)` calls in the same response.

### Available Pre-defined Templates

#### `explorer`

Read-only investigation agent (read / search / web tools; no edits). **Your primary delegation tool — use it liberally.** It handles exploration-type work: mapping an unfamiliar codebase, deep research, tracing dependencies, analyzing a bug's chain of causes. And when *you* are stuck — a bug you can't locate, an approach that keeps failing — spawning a fresh explorer is itself a way forward: hand it the symptom and let its clean context find what yours no longer can.

Delegate by default when the investigation spans many files or a codebase you haven't seen, and spawn several explorers in one response for independent areas. For a single fact in a file you can already name, just `read_file` it yourself — explorer's value is navigating complexity you can't shortcut.

#### `worker`

General-purpose agent with full file, shell, and web tools. Best for isolated, self-contained tasks that don't need your conversation context — e.g. "summarize this article with the following requirements: …". For investigation use `explorer`; for code review use `reviewer`.

#### `reviewer`

Fresh-eyes code review agent (read + `bash` for tests / lint / build / diff; **no write/edit — it reports, it doesn't fix**). Its whole value is a clean context with no assumptions from the work-in-progress, so it sees what the implementing agent's context no longer can. It returns severity-tagged findings (P0–P3) that the main agent can prioritize and act on. Reach for it on substantial or completed changes, not trivial edits, and never have an agent review its own work. (How to brief a reviewer well — see *Writing Effective Sub-Agent Prompts* below.)

**Strongly prefer the predefined templates over custom ones.** Only create a custom template when none of `explorer`, `worker`, or `reviewer` fits the task — for how, see the `custom-template` skill.

### Child Session Modes

Every spawn must set `mode`:

- `mode: oneshot` — runs one turn, returns its result, then goes read-only.
- `mode: persistent` — returns to idle after each turn and can receive later messages via `send`.

```
spawn(id="auth-inspector", template="explorer", mode="persistent", task="...")
```

### Rules

- **After spawning, default to `await_event`** (generous 60–120s; call it again if it returns with agents still running). Continue working only if you have a genuinely independent task; otherwise await. Await *all* sub-agents — or kill the ones you no longer need — before your final answer.
- **Don't over-parallelize.** Each result needs your attention to digest — spawn only as many as you can meaningfully process at once.
- **Be patient.** Tasks usually take minutes — don't assume failure after 1–2. Only kill an agent when its task is no longer relevant or it has run unreasonably long with no progress (never one under 10 minutes).
- **If a sub-agent blocks on user approval** and nothing else is active, stop the turn and return a concise final message — the runtime resumes the next turn once the approval resolves. Don't fill the wait with unrelated work, and don't take over the delegated task yourself.
