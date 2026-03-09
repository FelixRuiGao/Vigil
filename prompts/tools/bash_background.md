## `bash_background`

`bash_background(command, cwd?, id?)`

Start a tracked background shell command. Use this for long-running processes like dev servers and watchers.

- Returns a shell ID and a stable log file path.
- Use `bash_output` to inspect logs later.
- Use `wait(shell="...", seconds=60)` if you want to wait for the process to exit.
