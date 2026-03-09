## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns at most 1000 lines / 50,000 chars per call. Use `start_line` / `end_line` to navigate large files in multiple calls.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input. The image is returned as a visual content block for direct inspection.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.
