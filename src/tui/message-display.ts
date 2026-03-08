/**
 * Helpers for converting structured message content into readable TUI text.
 *
 * Used by `/resume` conversation rebuild to avoid dumping raw JSON for
 * multimodal or provider-specific content block arrays.
 */

const MAX_FALLBACK_JSON_CHARS = 600;

function truncateForDisplay(text: string, max = MAX_FALLBACK_JSON_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function fallbackJson(value: unknown): string {
  try {
    return truncateForDisplay(JSON.stringify(value));
  } catch {
    return truncateForDisplay(String(value));
  }
}

function imagePlaceholder(block: Record<string, unknown>): string {
  const mediaType = typeof block["media_type"] === "string"
    ? block["media_type"]
    : typeof block["mime_type"] === "string"
    ? block["mime_type"]
    : undefined;
  return mediaType ? `[image: ${mediaType}]` : "[image]";
}

function blockToDisplayText(block: unknown): string {
  if (block == null) return "";
  if (typeof block === "string") return block;
  if (typeof block === "number" || typeof block === "boolean") return String(block);

  if (Array.isArray(block)) {
    return block
      .map((b) => blockToDisplayText(b))
      .filter((s) => s.length > 0)
      .join("\n");
  }

  if (typeof block !== "object") {
    return String(block);
  }

  const rec = block as Record<string, unknown>;
  const type = typeof rec["type"] === "string" ? rec["type"] : undefined;

  if (typeof rec["text"] === "string" && (type === "text" || type === undefined)) {
    return rec["text"];
  }

  if (type === "image" || type === "input_image" || type === "image_url") {
    return imagePlaceholder(rec);
  }

  if (Array.isArray(rec["content"])) {
    const nested = blockToDisplayText(rec["content"]);
    if (nested) return nested;
  }

  if (type) {
    return `[${type}]`;
  }

  return fallbackJson(rec);
}

export function extractDisplayText(content: unknown): string {
  const text = blockToDisplayText(content);
  return text || fallbackJson(content);
}

