<!-- brief -->
Start a background shell command tracked by the Session. Use for dev servers, watchers, and long-running commands whose output you want to inspect later.

Don't leave zombie shells behind: when a background shell is no longer needed for your work AND has no value to the user, remember to kill_shell it. The exception is processes the user benefits from directly — a dev server they are clicking around in (`npm run dev`, `vite`) should keep running unless they say otherwise.

<!-- guide -->
`bash_background(command, cwd?, id?)`

Start a tracked background shell command. Use this for long-running processes like dev servers and watchers.

- Returns a shell ID and a stable log file path.
- Use `bash_output` to inspect logs later.
- Use `await_event(seconds=60)` if you want to await the process exit event.
- **Don't leave zombie shells behind.** When a shell is no longer needed for your work and has no value to the user, remember to `kill_shell` it. The exception is processes the user benefits from directly — a dev server they are clicking around in (`npm run dev`, `vite`) should keep running unless they say otherwise. The user can also see and stop shells themselves from the Shells panel (`/shells`).
