<!-- brief -->
Search file contents by regex. Pattern can be a single string OR an array of strings (matches lines that contain ANY of the patterns — useful for snake_case/camelCase/PascalCase variants in one call). Smart case: an all-lowercase pattern is matched case-insensitively unless `-i` is set explicitly. Defaults: returns up to 100 results overall and 15 matching lines per file in content mode; individual lines longer than 2000 chars are truncated. Skips common build / cache directories (node_modules, .git, dist, target, .venv, etc.).

<!-- guide -->
`grep(pattern, path?, output_mode?, glob?, type?, -A?, -B?, -C?, -i?, head_limit?, limit_per_file?)`

Search file contents by regex. `pattern` accepts a single string **or an array of strings** — multiple patterns are combined with OR logic, which is the right call when looking for snake_case / PascalCase / camelCase variants of the same name in one shot.

```
grep(pattern=["loadUser", "load_user", "LoadUser"], path="src", output_mode="content")
```

Smart case: an all-lowercase pattern is matched case-insensitively automatically. Pass `-i: true` (or `-i: false`) to override.

Defaults: returns up to 100 entries overall, 15 matching lines per file, with each line capped at 2000 chars. Tune with `head_limit` and `limit_per_file`. Skips common build / cache directories (`node_modules`, `.git`, `dist`, `target`, `.venv`, …) — pass them explicitly as `path` to scan inside.

Key parameters:
- `output_mode`: `"files_with_matches"` (default, paths only), `"content"` (matching lines), `"count"` (match counts).
- `glob`: Filter files by name pattern (e.g. `"*.ts"`, `"*.{ts,tsx}"`).
- `type`: Filter by file extension (e.g. `"js"`, `"py"`).
- `-A`, `-B`, `-C`: Context lines after/before/around each match (content mode only).
- `-i`: Force case-insensitive search (overrides smart case).
- `head_limit`: Cap overall results to N entries (default 100).
- `limit_per_file`: Cap matches per file in content mode (default 15).

Recommended workflow for large files and logs:

- Start with `grep` to find the relevant area.
- Then use `read_file(start_line, end_line)` to inspect the matching region.
- Prefer this over reading a very large file from the top unless you genuinely need the overall structure.
- When output says "truncated", search the full log file or source file for specific keywords rather than re-requesting full content.
