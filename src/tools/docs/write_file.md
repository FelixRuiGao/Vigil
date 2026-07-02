<!-- brief -->
Create or overwrite a file with the given content. Parent directories are created automatically. Prefer write_file over edit_file when you intend to replace the entire file — it is fewer tokens than echoing the full existing content into edit_file. Use edit_file for targeted modifications.

<!-- guide -->
`write_file(path, content, expected_mtime_ms?)`

Create or overwrite a file. Parent directories are created automatically.

```
write_file(path="{PROJECT_ROOT}/example.py", content="print('Hello, world!')")
```

Prefer `write_file` over `edit_file` when you intend to replace the **entire** file contents — you skip echoing the existing content into `old_str`, which saves tokens.

Use `expected_mtime_ms` (from a prior `read_file`) to guard against overwriting concurrent external changes.

To append content to an existing file, use `edit_file(path, append_str=...)` instead.
