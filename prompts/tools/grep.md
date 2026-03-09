## `grep`

`grep(pattern, path?, output_mode?, glob?, type?, -A?, -B?, -C?, -i?, head_limit?)`

Search file contents using regex. Supports glob filtering, file type filtering, context lines, and multiple output modes.

Key parameters:
- `output_mode`: `"files_with_matches"` (default, paths only), `"content"` (matching lines), `"count"` (match counts).
- `glob`: Filter files by pattern (e.g. `"*.ts"`, `"*.{ts,tsx}"`).
- `type`: Filter by file type (e.g. `"js"`, `"py"`).
- `-A`, `-B`, `-C`: Context lines after/before/around each match (content mode only).
- `-i`: Case insensitive.
- `head_limit`: Limit number of results.

Recommended workflow for large files and logs:

- Start with `grep` to find the relevant area.
- Then use `read_file(start_line, end_line)` to inspect the matching region.
- Prefer this over reading a very large file from the top unless you genuinely need the overall structure.
- When output says "truncated", search the full log file or source file for specific keywords rather than re-requesting full content.
