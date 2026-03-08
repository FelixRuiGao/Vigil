import { afterEach, describe, expect, it, vi } from "vitest";

import { toolWebFetch } from "../src/tools/web-fetch.js";

describe("toolWebFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Jina Reader output when available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://r.jina.ai/https://example.com/");
      return new Response("# Extracted\n\nHello from Jina", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await toolWebFetch("https://example.com");

    expect(result).toContain("Backend: jina");
    expect(result).toContain("Hello from Jina");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to local extraction when Jina is rate limited", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://r.jina.ai/https://example.com/") {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      if (url === "https://example.com/") {
        return new Response("<html><body><h1>Title</h1><p>Hello local</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await toolWebFetch("https://example.com", "docs");

    expect(result).toContain("Backend: local");
    expect(result).toContain("Looking for: docs");
    expect(result).toContain("# Title");
    expect(result).toContain("Hello local");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
