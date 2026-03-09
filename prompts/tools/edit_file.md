## `edit_file`

`edit_file(path, old_str, new_str, expected_mtime_ms?)`

Apply a minimal patch by replacing a unique string. `old_str` must appear **exactly once** in the file — if it's not unique, provide more surrounding context to make it unique.

```
edit_file(path="{PROJECT_ROOT}/example.py", old_str="Hello", new_str="Hi")
```

Supports `expected_mtime_ms` for concurrency safety. Prefer `edit_file` over `write_file` for modifications — it's smaller and safer.
