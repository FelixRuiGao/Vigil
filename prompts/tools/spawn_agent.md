## `spawn_agent`

Launch sub-agents for bounded, parallel subtasks.

### Two-Step Flow

**Step 1.** Write a YAML call file to `{SESSION_ARTIFACTS}`:

```
write_file(path="{SESSION_ARTIFACTS}/spawn-task.yaml", content=...)
```

Call file format:

```yaml
tasks:
  - id: explorer-1
    template: explorer
    task: |
      Explore the providers/ directory at {PROJECT_ROOT}/src/providers/ ...
```

**Step 2.** Call `spawn_agent(file="spawn-task.yaml")`.

The `file` parameter is resolved relative to `{SESSION_ARTIFACTS}` automatically.

**Before calling**, re-read your call file — is the task description clear and complete? Does it include enough context, precise scope, and explicit deliverables? A minute spent refining the prompt saves far more time than re-spawning after a poor result.

### Available Pre-defined Templates

#### `explorer`

Read-only investigation agent. Tools: `read_file`, `list_dir`, `grep`, `glob`, `web_search`, `web_fetch`.

Behavioral profile:
- Focuses on the assigned task, delivers structured findings
- Uses list_dir for structure, read_file for content, grep/glob for search, web tools for external info
- Leads with direct answers, includes file paths and code references
- Understands that only its final text output is visible to you — intermediate tool calls are hidden
- Has access to the important log for background context

Best for: codebase exploration, dependency tracing, pattern searches, code analysis, information gathering. **This is your primary delegation tool — use it liberally.**

#### `executor`

Task execution agent with file and shell access. Tools: all basic I/O tools (`read_file`, `write_file`, `edit_file`, `apply_patch`, `list_dir`, `glob`, `grep`, `diff`, `bash`, `bash_background`, `bash_output`, `kill_shell`, `test`, `web_search`, `web_fetch`). Does NOT have orchestration tools (cannot spawn sub-agents, manage context, or ask the user).

Behavioral profile:
- Executes bounded tasks with side effects: running tests, making edits, installing dependencies, generating files
- Examines relevant code before acting, verifies changes when appropriate
- Reports what was done, what succeeded, and any issues encountered
- Same output protocol as explorer — final text is the only visible result
- Has access to the important log for background context

Best for: running test suites, applying known edits across files, installing dependencies, generating files, any bounded task requiring bash or file writes.

#### Choosing a Template

| Need | Template |
|---|---|
| Read, search, analyze — no modifications | `explorer` |
| Run commands, edit files, generate output | `executor` |
| Neither fits | Create a custom template (rare) |

**Strongly prefer `explorer` and `executor` over custom templates.** Only create custom templates when neither predefined template fits your needs.

### Creating Reusable Custom Templates

Create a custom template in `{SESSION_ARTIFACTS}`:

**Step 1.** Create a template directory with two files:

```
write_file(path="{SESSION_ARTIFACTS}/my-template/agent.yaml", content=...)
write_file(path="{SESSION_ARTIFACTS}/my-template/system_prompt.md", content=...)
```

`agent.yaml` structure:
```yaml
type: agent
name: my-template
description: "Brief description of the agent's role."
system_prompt_file: system_prompt.md
max_tool_rounds: 100
```

`max_tool_rounds` is required and must be **>= 100**. Tool set defaults to the same as `executor` when omitted.

`system_prompt.md`: Write a focused prompt for the sub-agent's role — include its specific task type, output format expectations, and constraints.

**Step 2.** Reference it with `template_path:` in call files:

```yaml
tasks:
  - id: analyst-1
    template_path: my-template
    task: |
      Analyze the database schema at ...
```

The template persists in `{SESSION_ARTIFACTS}` for the entire session — you can reuse it across multiple `spawn_agent` calls without recreating it.

### Writing Effective Sub-Agent Prompts

The quality of sub-agent results depends almost entirely on your prompt. A well-written task description eliminates the need for you to redo the sub-agent's work.

**Structure every task description with these elements:**

1. **Context** — What the sub-agent needs to know: project background, current task, decisions already made. Sub-agents cannot see your conversation.
2. **Scope** — Exact files, directories, or code areas to examine. Use full absolute paths. Be explicit about boundaries ("only look at `src/providers/`, do not examine `src/tui/`").
3. **Deliverables** — Exactly what format and content you expect back.
4. **Constraints** — What to skip, what to prioritize, output length expectations.

**Bad prompt vs good prompt:**

> `Explore the auth system and tell me what you find.`
> Produces unfocused noise. You'll waste context reading it and probably re-investigate yourself.

> ```
> Analyze the authentication middleware at {PROJECT_ROOT}/src/middleware/auth/.
>
> Context: We're refactoring to support OAuth2 PKCE. Current system uses a strategy pattern.
>
> Deliverables:
> 1. List all strategy classes with file paths and the interface they implement.
> 2. Identify where the strategy is selected (factory/config).
> 3. Note existing OAuth support and its limitations.
> 4. List files that import from the auth module (dependents).
>
> Keep response under 500 words. Lead with the strategy interface definition.
> ```

**Share background via important log.** If multiple sub-agents need the same context (project structure, key decisions), write it to your important log first — it's automatically shared with all sub-agents.

### When to Delegate vs Do It Yourself

| Delegate | Do it yourself |
|---|---|
| Codebase exploration and investigation (explorer) | Sequential edits with dependencies between steps |
| Understanding code structure, dependencies, patterns (explorer) | Quick single-file lookups at known paths |
| Reading and analyzing multiple files (explorer) | Iterative back-and-forth with user |
| Running isolated test suites or builds (executor) | Work that requires ongoing conversation context |
| Applying well-defined edits across files (executor) | |
| Generating files from known specifications (executor) | |

**Default to delegation.** If a task involves reading or searching more than 1-2 files, spawn a sub-agent. Your job is to orchestrate and execute — not to manually read through codebases.

> Need to understand a module? **Spawn an explorer.** Even for seemingly simple questions — the explorer works in its own context and doesn't cost you tokens.

> Three independent areas to understand? **Spawn 3 explorers in parallel.** Write one call file with all tasks.

> Need one function signature in a file you already know? **Use `read_file` directly.**

### Output Protocol (after spawning sub-agents)

**Default behavior: wait.** After spawning sub-agents, you should almost always use `wait`. Do NOT continue working unless you have a genuinely independent task that doesn't depend on the sub-agent results.

| Action | When to use |
|--------|-------------|
| **`wait`** | **Default.** Your work depends on results, or you have nothing else to do |
| **Continue working** | **Rare.** Only when you have a truly independent task |
| **Progress text** | User benefits from an update |

> Spawned explorers to understand module structure. **`wait(seconds=60)`** — you need their results before acting.

> Spawned auth explorers AND you have a completely unrelated config typo to fix. **Fix the typo** (short, independent), then wait.

> Own work done, explorers still running. **Use `wait(seconds=60)`**.

### Processing Sub-Agent Results

After receiving results, extract key findings, then compress:

> Note the 3-5 key findings, record cross-phase insights in your important log, then `summarize_context` the raw report.

> Finished a subtask? Compress its investigation history. Preserve: what was done, key approach, cross-file dependencies still relevant.

### Rules

- Wait for all sub-agents before final answer — or kill those you no longer need.
- Keep concurrent sub-agents to 3-4.

### Anti-patterns

- Don't create custom templates when `explorer` or `executor` covers the task — they almost always do.
- Don't continue working after spawning unless you have a truly independent task.
- Don't act on assumptions while waiting — if your next step depends on results, wait.
- Don't over-parallelize — each result needs attention to digest and compress.
- Don't call `check_status` in a loop — use `wait` instead.

### Patience with Sub-Agents

- Sub-agent tasks typically take several minutes. This is normal — don't assume something is wrong after 1 or 2 minutes.
- Use `wait` with generous timeouts (60-120s). If it times out with agents still working, wait again.
- Only kill agents when: (a) the task is no longer relevant, or (b) the agent has been doing work for an unreasonably long time with no progress (do NOT kill any agent which works for less than 10 minutes).
