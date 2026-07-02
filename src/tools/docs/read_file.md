<!-- brief -->
Read the contents of a text file (max 50 MB). Returns up to 2000 lines / 80,000 characters per call; individual lines longer than 5000 chars are truncated by default (raise max_line_chars when you need a long line in full). PDF, DOCX, XLSX, and similar formats are returned as auto-extracted Markdown. Image files are returned as visual content blocks when the model supports multimodal input. Returns file metadata (including mtime_ms) for optional optimistic concurrency checks. Use start_line+end_line (inclusive range) or offset+limit (offset = first line, limit = number of lines) to navigate large files across multiple calls. If you know there are several files to read, prefer issuing multiple read_file calls in parallel.

<!-- guide -->
`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns up to **2000 lines / 80,000 chars** per call; lines longer than 5000 chars are truncated by default (raise `max_line_chars` when you need a long line in full). `offset` is an alias for `start_line`; `limit` is the **number of lines** to read starting at `start_line`/`offset` (not an alias for `end_line`).

If you know there are several files to read, **issue multiple `read_file` calls in parallel** rather than serialising them. Avoid tiny repeated slices (e.g. 30-line chunks); pick a window that covers what you need in one call.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input. The image is returned as a visual content block for direct inspection. PDF, DOCX, XLSX, and similar document formats are returned as auto-extracted Markdown.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.
