<!-- brief -->
Terminate one or more tracked background shells. The signal is sent to the entire process group so children (npm → vite, etc.) are killed in full. After kill the shell entry stays so you can read its final log via bash_output, but the process is gone — killed shells do not auto-restart, and HMR / file-watching stops. You can reuse the same id in a new bash_background once the prior shell has stopped.

<!-- guide -->
`kill_shell(ids, signal?)`

Terminate one or more tracked background shells. Default signal is `TERM`. The signal is sent to the **entire process group** so that `npm run dev`, `cargo watch`, `vite`, and similar tools that fork child processes are killed in full (not just the outer shell).

**Lifecycle after kill — important:**

- The shell entry stays in tracking after `kill_shell`, so you can still read its final log via `bash_output(id=...)`. But **the process is gone**: HMR, file-watching, the dev server, and any work that process was doing all stop. A killed shell does **not** auto-restart and does **not** resume via HMR.
- `check_status` separates running vs terminated shells under different headings — a terminated entry is informational only, not a sign that anything is still working.
- You can reuse the same `id` in a new `bash_background` call once the prior shell at that id has stopped running (killed, exited, or failed). The previous log file is renamed with a timestamp suffix and the new shell writes to a fresh log; the success message includes both paths.
