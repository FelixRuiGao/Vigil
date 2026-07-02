<!-- brief -->
Fetch content from a URL and return it as readable text. Uses a high-quality remote extractor first, then falls back to local extraction if needed. HTML pages are converted to markdown-like text.

<!-- guide -->
`web_fetch(url, prompt?)`

Fetch content from a URL and return it as readable text. Uses Jina Reader first, then falls back to local extraction; successful fetches return page content in readable markdown-like form.

- Only http/https URLs. Localhost, private IPs, embedded credentials, and local hostnames are rejected.
- Use `web_search` to discover URLs; use `web_fetch` to read specific pages.
- Results may be truncated for very large pages (~100K char limit).
