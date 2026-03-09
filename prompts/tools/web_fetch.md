## `web_fetch`

`web_fetch(url, prompt?)`

Fetch content from a URL and return it as readable text. HTML pages are converted to markdown-like format.

- Only http/https URLs.
- Use `web_search` to discover URLs; use `web_fetch` to read specific pages.
- Results may be truncated for very large pages (~100K char limit).
