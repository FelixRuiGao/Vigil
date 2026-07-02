<!-- brief -->
Read output from a tracked background shell. By default, returns unread output since the last bash_output call for that shell. Use tail_lines to inspect recent output without advancing the unread cursor.

<!-- guide -->
`bash_output(id, tail_lines?, max_chars?)`

Read output from a tracked background shell.

- Without `tail_lines`, returns unread output since the last `bash_output` call for that shell.
- With `tail_lines`, returns the recent tail without advancing the unread cursor.
- `max_chars` defaults to 30000 (cap 80000). If output is truncated, prefer searching the full log file first and then reading the relevant region — the log path is included in every response.
