<!-- brief -->
Find files by name/path pattern. Returns matching absolute paths sorted by modification time (most recently modified first). Patterns without `/` are auto-prefixed with `**/` so `*.ts` matches every `.ts` file in the tree. Common build / cache directories (node_modules, .git, dist, target, .venv, etc.) are skipped. Supports `**`, `*`, `?`, `[abc]`, and `{a,b}` brace expansion.

<!-- guide -->
`glob(pattern, path?, limit?)`

Find files by name pattern. Returns matching absolute paths sorted by modification time (newest first). Default limit 200 (cap 1000).

Patterns without a slash are auto-prefixed with `**/`, so `*.ts` matches every `.ts` file in the tree. Supports `**`, `*`, `?`, `[abc]`, and brace expansion (`*.{ts,tsx}`).

```
glob(pattern="*.ts")                       # all .ts files anywhere
glob(pattern="src/**/*.test.tsx")          # tests under src/
glob(pattern="**/*.{md,mdx}", path="docs") # docs only
```
