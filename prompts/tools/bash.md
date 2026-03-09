## `bash`

`bash(command, timeout?, cwd?)`

Execute shell commands. Returns stdout, stderr, and exit code.

Use `bash` for: running builds, installing dependencies, git operations, short scripts, checking system state. For file reading, searching, and editing, prefer the dedicated tools — they have proper access controls and structured output.

**Before creating directories or files via bash**, verify the parent directory exists first.

**Timeouts:** Default 60s, max 600s. Long-running commands should specify a timeout.

**Output limit:** ~200KB per stream. Large outputs are truncated.
