## `write_file`

`write_file(path, content, expected_mtime_ms?)`

Create or overwrite a file. Parent directories are created automatically.

```
write_file(path="{PROJECT_ROOT}/example.py", content="print('Hello, world!')")
```

Use `expected_mtime_ms` (from a prior `read_file`) to guard against overwriting concurrent external changes.
