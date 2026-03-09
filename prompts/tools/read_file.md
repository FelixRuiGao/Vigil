## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns at most 1000 lines / 50,000 chars per call. Use `start_line` / `end_line` to navigate large files in multiple calls.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.
