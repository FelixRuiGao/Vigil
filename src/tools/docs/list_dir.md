<!-- brief -->
List files and directories as a tree. Returns names with file sizes for files. Common build / cache directories (node_modules, .git, dist, target, .venv, etc.) are skipped by default; to inspect one, pass it as the `path` argument explicitly. If you are searching for a specific filename, prefer `glob`; for content matches, prefer `grep`.

<!-- guide -->
`list_dir(path?, max_depth?, max_entries?, include_hidden?)`

List files and directories as a tree. Defaults: depth 2, up to 200 entries. File entries include a size suffix (`[12 KB]`). Common build / cache directories (`node_modules`, `.git`, `dist`, `target`, `.venv`, …) are skipped unless you pass them explicitly as `path`. Hidden (dot-prefixed) entries are hidden by default; pass `include_hidden=true` to show them.

If you are looking for a specific filename, prefer `glob`; for content matches, prefer `grep`.
