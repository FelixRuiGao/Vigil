<!-- brief -->
Return the current local time of the runtime environment, including timezone and UTC offset.

<!-- guide -->
Use `time` when a task depends on the current date/time or timezone.

- Call with `{}`.
- Prefer reporting absolute timestamps (not only relative words like "today"/"now").
