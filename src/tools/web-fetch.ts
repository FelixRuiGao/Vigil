/**
 * Web fetch tool — fetch URL content and convert HTML to readable text.
 *
 * Default path:
 *  1. Try Jina Reader for higher-quality extraction
 *  2. Fall back to the local fetch/extract path on rate-limit or network failure
 */

import type { ToolDef } from "../providers/base.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB raw HTML
const OUTPUT_MAX_CHARS = 100_000;
const JINA_READER_PREFIX = "https://r.jina.ai/";

// ------------------------------------------------------------------
// Tool definition
// ------------------------------------------------------------------

export const WEB_FETCH: ToolDef = {
  name: "web_fetch",
  description:
    "Fetch content from a URL and return it as readable text. " +
    "Uses a high-quality remote extractor first, then falls back to local extraction if needed. " +
    "HTML pages are converted to markdown-like text.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must be http or https)",
      },
      prompt: {
        type: "string",
        description:
          "Optional description of what information to look for " +
          "(included as a hint in the output header)",
      },
    },
    required: ["url"],
  },
  summaryTemplate: "{agent} is fetching {url}",
};

// ------------------------------------------------------------------
// HTML to readable text converter
// ------------------------------------------------------------------

/**
 * Convert HTML to a readable markdown-like text format.
 * Handles common elements: headings, paragraphs, links, lists, code blocks.
 * Strips scripts, styles, and remaining tags.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script, style, and noscript blocks
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Convert headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert links: <a href="url">text</a> → [text](url)
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Convert code blocks: <pre><code> → ```
  text = text.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

  // Convert inline code
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Convert bold and italic
  text = text.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Convert list items
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Convert paragraphs and divs to double newlines
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");           // collapse horizontal whitespace
  text = text.replace(/\n[ \t]+/g, "\n");         // trim leading whitespace on lines
  text = text.replace(/[ \t]+\n/g, "\n");         // trim trailing whitespace on lines
  text = text.replace(/\n{3,}/g, "\n\n");         // collapse excessive newlines
  text = text.trim();

  return text;
}

// ------------------------------------------------------------------
// Executor
// ------------------------------------------------------------------

export async function toolWebFetch(
  url: string,
  prompt?: string,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `ERROR: Invalid URL: ${url}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `ERROR: Only http and https URLs are supported. Got: ${parsed.protocol}`;
  }

  // Reject embedded credentials
  if (parsed.username || parsed.password) {
    return "ERROR: URLs with embedded credentials (user:pass@host) are not allowed.";
  }

  const normalizedUrl = parsed.toString();

  try {
    const jinaOutput = await fetchViaJina(normalizedUrl, prompt);
    if (jinaOutput) return jinaOutput;
  } catch {
    // Fall through to local extraction.
  }

  return fetchLocally(normalizedUrl, prompt);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildOutput(
  url: string,
  contentType: string,
  backend: "jina" | "local",
  prompt: string | undefined,
  body: string,
): string {
  const header = [
    `URL: ${url}`,
    `Content-Type: ${contentType || "unknown"}`,
    `Backend: ${backend}`,
  ];
  if (prompt) {
    header.push(`Looking for: ${prompt}`);
  }
  header.push("");
  return header.join("\n") + body;
}

function normalizeOutput(output: string): string {
  let normalized = output.trim();
  if (normalized.length > OUTPUT_MAX_CHARS) {
    normalized = normalized.slice(0, OUTPUT_MAX_CHARS) + "\n\n... (truncated)";
  }
  return normalized;
}

async function fetchViaJina(
  url: string,
  prompt?: string,
): Promise<string | null> {
  const response = await fetchWithTimeout(JINA_READER_PREFIX + url, {
    headers: {
      "User-Agent": "LongerAgent/1.0 (web_fetch tool)",
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    if (
      response.status === 403 ||
      response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return null;
    }
    return `ERROR: HTTP ${response.status} ${response.statusText} for ${url}`;
  }

  const body = normalizeOutput(await response.text());
  if (!body) {
    return null;
  }

  return buildOutput(
    url,
    response.headers.get("content-type") ?? "text/plain",
    "jina",
    prompt,
    body,
  );
}

async function fetchLocally(
  url: string,
  prompt?: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "LongerAgent/1.0 (web_fetch tool)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return `ERROR: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`;
    }
    return `ERROR: Fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!response.ok) {
    return `ERROR: HTTP ${response.status} ${response.statusText} for ${url}`;
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > FETCH_MAX_CONTENT_LENGTH) {
    return `ERROR: Response too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)} MB, limit ${FETCH_MAX_CONTENT_LENGTH / 1024 / 1024} MB).`;
  }

  let body: string;
  try {
    body = await response.text();
  } catch (e) {
    return `ERROR: Failed to read response body: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (body.length > FETCH_MAX_CONTENT_LENGTH) {
    body = body.slice(0, FETCH_MAX_CONTENT_LENGTH);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHTML = contentType.includes("text/html");
  const isJSON = contentType.includes("application/json");

  let output: string;
  if (isHTML) {
    output = htmlToText(body);
  } else if (isJSON) {
    try {
      output = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      output = body;
    }
  } else {
    output = body;
  }

  return buildOutput(url, contentType, "local", prompt, normalizeOutput(output));
}
