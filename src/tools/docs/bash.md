<!-- brief -->
Execute a synchronous shell command and return stdout, stderr, and exit code.

TIMEOUT is REQUIRED — it is the synchronous wait budget, not a kill switch. If the command finishes in time you get its full output as usual. If the timeout elapses, the command is NOT killed: it keeps running and is moved to a tracked background shell. The tool returns the output captured so far plus the shell id — poll it with `bash_output`, wait with `await_event`, or stop it with `kill_shell`. Never re-run a command just because it timed out: its side effects are still in progress — poll the shell instead.

Choose the timeout to match how long you are willing to block on the result. Known long-running jobs are better started with bash_background directly (clearer intent, cleaner logs). Persistent processes that never exit on their own — dev servers, file watchers, daemons, `npm run dev`, `vite`, `next dev`, `cargo watch`, `tail -f` — should ALWAYS use bash_background.

After a timeout hand-off, look at the partial output: if the command appears stuck or was waiting for interactive input, remember to kill_shell it rather than leaving a zombie shell behind.

<!-- guide -->
`bash(command, timeout, cwd?)`

Execute shell commands. Returns stdout, stderr, and exit code.

{SHELL_NOTES}

**Use `bash` for:** running builds, installing dependencies, running tests, git operations, short one-off scripts, checking system state, and operations that genuinely have no dedicated tool.

### Do NOT use `bash` to substitute for dedicated tools

These are hard rules, not preferences. If you catch yourself reaching for one of these patterns, stop and use the right tool.

| ❌ Do not do this via the bash tool | ✅ Use this instead |
|---|---|
| Shell file-write commands (echo/printf/tee/Set-Content/Out-File to file) | **`write_file`** |
| Shell in-place edits (sed -i / stream edits) | **`edit_file`** |
| Shell file reads (cat/head/tail/Get-Content) | **`read_file`** |
| Shell search (grep -r/rg/ag/Select-String) | the dedicated **`grep`** tool |
| Shell file listing (find/ls -R/tree/Get-ChildItem) | **`glob`** or **`list_dir`** |

**Why these restrictions exist:**
- The dedicated tools apply access controls and safety checks that the bash path bypasses.
- They return structured output the system can track, show in the UI, and include in file-change summaries. Shell redirection is invisible to these systems — the user's interface cannot display a file change that was made through shell commands.
- They respect mtime validation and atomic-write guarantees that `edit_file` / `write_file` provide. Shell-based edits lose all of this.

There are **no exceptions**. Even for "just a one-liner" or "it's faster this way" — use the right tool.

### Allowed bash patterns for filesystem work

Some filesystem operations have no dedicated tool; these are fine via bash:
- Creating directories (`mkdir -p` / `New-Item -ItemType Directory`).
- Deleting, moving, copying files (`rm`/`mv`/`cp` / `Remove-Item`/`Move-Item`/`Copy-Item`).
- Permissions and links (`chmod`, `chown`, `ln`).
- `git` operations on files (`git add`, `git mv`, `git rm`, etc.).

**Before creating a file or directory via bash**, verify the parent directory exists first (via `list_dir` or a separate mkdir).

### Other notes

- **Timeout (required, max {BASH_MAX_TIMEOUT}s):** the synchronous wait budget, not a kill switch. A command still running when the timeout elapses is **not killed** — it moves to a tracked background shell and keeps running; the result includes the output so far and the shell id. Poll with `bash_output`, wait with `await_event`, or `kill_shell` it. Never re-run a command just because it timed out — its side effects are still in progress. If the partial output suggests it was stuck or waiting for input, remember to `kill_shell` it.
- **Output limit:** ~200KB per stream. When a stream exceeds the cap the head and tail are kept and the middle is dropped; the **full untruncated output is also written to a temp file** and the path is included in the result, so you can `read_file` or `grep` the complete log if needed.
- **Working directory:** Use the `cwd` parameter for one-off directory changes rather than changing directories inside the command.
