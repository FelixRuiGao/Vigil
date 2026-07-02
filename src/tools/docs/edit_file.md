<!-- brief -->
Apply a patch to an existing file. Each edit replaces an `old_str` with a `new_str`; by default `old_str` must appear exactly once in the file (or the call fails with the line numbers of all matches so you can disambiguate). Set `replace_all: true` on an edit to replace every occurrence — useful for renames. Multiple edits in one call are applied atomically and must not overlap. Use `append_str` to add content at the end of the file (can be combined with edits — appends run last). Refuses no-op edits where `old_str === new_str`.

<!-- guide -->
`edit_file(path, edits, expected_mtime_ms?)`

Apply a patch by replacing one or more strings. By default each `old_str` must appear **exactly once** in the file — if it isn't unique, the call fails with the line numbers of every match so you can either disambiguate by adding surrounding context or set `replace_all: true` on that edit. `old_str` and `new_str` must differ (no-op edits are rejected).

**Single replacement:**

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "Hello", new_str: "Hi" }
])
```

**Replace every occurrence (e.g. for renames):**

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "OldName", new_str: "NewName", replace_all: true }
])
```

**Multiple replacements in one call:**

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "Hello", new_str: "Hi" },
  { old_str: "World", new_str: "Earth" }
])
```

All edits must not overlap and are applied atomically.

**Append:**

To append content to the end of a file, use `append_str`:

```
edit_file(path="{PROJECT_ROOT}/log.txt", append_str="\nNew entry")
```

`append_str` can be combined with `edits` — all replacements execute first, then append:

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "v1.0", new_str: "v1.1" }
], append_str="\n# Updated to v1.1")
```

Supports `expected_mtime_ms` for concurrency safety. Use `edit_file` for **targeted modifications**; use `write_file` when **replacing the whole file** (fewer tokens than echoing existing content into `old_str`).
