/**
 * show_context tool implementation.
 *
 * Generates two outputs:
 * 1. Context Map — compact index for the tool_result (all groups, total tokens, types)
 * 2. Injection annotations — detailed per-entry descriptions for each §{id}§ injection point
 *
 * Uses a shared GPT tokenizer estimator for relative size hints.
 */

import { encode as gptEncode } from "gpt-tokenizer/model/gpt-5";
import type { LogEntry } from "./log-entry.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ContextGroup {
  contextId: string;
  entries: Array<{ entry: LogEntry; index: number }>;
  totalTokens: number;
  /** Per-entry token estimates. */
  entryTokens: number[];
}

export interface ShowContextResult {
  /** Compact context map for the tool_result. */
  contextMap: string;
  /** Map from contextId → annotation text to inject at §{id}§ locations. */
  annotations: Map<string, string>;
}

// ------------------------------------------------------------------
// Token display helpers
// ------------------------------------------------------------------

function formatTokens(tokens: number): string {
  if (tokens < 1000) return "<1k";
  return `${Math.round(tokens / 1000)}k`;
}

// ------------------------------------------------------------------
// Entry content serialization for token estimation
// ------------------------------------------------------------------

function estimateEntryTokens(entry: LogEntry): number {
  let text: string;
  switch (entry.type) {
    case "user_message":
    case "assistant_text":
    case "no_reply":
    case "compact_context":
    case "summary":
      text = serializeContent(entry.content);
      break;
    case "reasoning":
      text = serializeContent(entry.content);
      break;
    case "tool_call":
      text = JSON.stringify(entry.content ?? {});
      break;
    case "tool_result": {
      const rc = entry.content as { content?: string } | null;
      text = rc?.content ?? JSON.stringify(entry.content ?? {});
      break;
    }
    default:
      text = serializeContent(entry.content);
      break;
  }
  return gptEncode(text).length;
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "image" || block?.type === "image_ref") return "[image]";
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

// ------------------------------------------------------------------
// Entry description generation
// ------------------------------------------------------------------

function truncateText(text: string, maxLen = 50): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= maxLen) return `"${clean}"`;
  return `"${clean.slice(0, maxLen)}..."`;
}

function describeEntry(entry: LogEntry): { label: string; description: string } {
  switch (entry.type) {
    case "user_message": {
      const text = serializeContent(entry.content);
      const hasImage = Array.isArray(entry.content) &&
        (entry.content as Array<Record<string, unknown>>).some(
          (b) => b?.type === "image" || b?.type === "image_ref",
        );
      const prefix = hasImage ? "[image] " : "";
      return { label: "user", description: `${prefix}${truncateText(text)}` };
    }
    case "assistant_text":
      return { label: "assistant", description: truncateText(String(entry.content ?? "")) };
    case "reasoning":
      return { label: "thinking", description: "[internal reasoning]" };
    case "tool_call": {
      const tc = entry.content as { name?: string; arguments?: Record<string, unknown> } | null;
      const name = tc?.name ?? (entry.meta as Record<string, unknown>)["toolName"] ?? "unknown";
      const args = tc?.arguments ?? {};
      const brief = formatToolCallArgs(String(name), args);
      return { label: "call", description: `${name}(${brief})` };
    }
    case "tool_result": {
      const toolName = String((entry.meta as Record<string, unknown>)["toolName"] ?? "unknown");
      const isError = (entry.meta as Record<string, unknown>)["isError"] === true;
      const rc = entry.content as { content?: string } | null;
      const resultStr = rc?.content ?? "";
      const brief = isError
        ? `ERROR: ${resultStr.slice(0, 60).replace(/\n/g, " ")}`
        : formatToolResultBrief(toolName, resultStr, entry.meta as Record<string, unknown>);
      return { label: "result", description: `${toolName} → ${brief}` };
    }
    case "no_reply":
      return { label: "no-reply", description: "" };
    case "summary": {
      const depth = (entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1;
      return { label: "summary", description: `(depth ${depth}) ${truncateText(String(entry.content ?? ""))}` };
    }
    case "compact_context":
      return { label: "compact", description: "Auto-compact summary" };
    default:
      return { label: entry.type, description: truncateText(serializeContent(entry.content)) };
  }
}

function formatToolCallArgs(toolName: string, args: Record<string, unknown>): string {
  // Known tools: show the most important arg
  switch (toolName) {
    case "read_file": {
      const path = String(args["path"] ?? args["file"] ?? "");
      const parts = [path ? `"${path}"` : ""];
      if (args["start_line"] !== undefined) parts.push(`${args["start_line"]}–${args["end_line"] ?? "end"}`);
      return parts.filter(Boolean).join(", ");
    }
    case "edit_file":
    case "write_file":
      return `"${String(args["path"] ?? args["file"] ?? "")}", ...`;
    case "bash":
    case "bash_background":
      return truncateText(String(args["command"] ?? ""), 40).slice(1, -1); // remove quotes from truncateText
    case "grep":
      return `"${String(args["pattern"] ?? "")}", path="${String(args["path"] ?? "")}"`;
    case "glob":
      return `"${String(args["pattern"] ?? "")}"`;
    case "spawn_agent":
      return `"${String(args["file"] ?? "")}"`;
    case "ask": {
      const qs = args["questions"] as Array<Record<string, unknown>> | undefined;
      if (qs?.length) return truncateText(String(qs[0]?.question ?? ""), 30).slice(1, -1);
      return "...";
    }
    case "summarize_context": {
      const ops = args["operations"] as unknown[] | undefined;
      return `${ops?.length ?? 0} operations`;
    }
    default:
      // Generic fallback
      if (Object.keys(args).length === 0) return "";
      return "...";
  }
}

function formatToolResultBrief(
  toolName: string,
  resultStr: string,
  meta: Record<string, unknown>,
): string {
  switch (toolName) {
    case "read_file":
      return `${resultStr.length} chars`;
    case "edit_file":
      return resultStr.includes("applied") || resultStr.includes("OK") ? "applied" : `${resultStr.length} chars`;
    case "write_file":
      return "created";
    case "bash":
    case "bash_background": {
      // Try to extract exit code
      const exitMatch = resultStr.match(/exit (?:code |status )?(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : null;
      const size = formatTokens(gptEncode(resultStr).length);
      return exitCode !== null ? `exit ${exitCode}, ${size} output` : `${size} output`;
    }
    case "grep": {
      const lineCount = resultStr.split("\n").filter(Boolean).length;
      return `${lineCount} matches`;
    }
    case "ask": {
      const brief = resultStr.replace(/\n/g, " ").trim();
      return brief.length > 40 ? `${brief.slice(0, 40)}...` : brief;
    }
    default:
      // Generic fallback
      return `${formatTokens(gptEncode(resultStr).length)} output`;
  }
}

// ------------------------------------------------------------------
// Context group builder
// ------------------------------------------------------------------

function getLogContextId(entry: LogEntry): string | null {
  if (entry.discarded || entry.summarized) return null;
  if (entry.type === "compact_context") {
    const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
    return ctxId ? String(ctxId) : null;
  }
  const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
  if (ctxId === undefined || ctxId === null) return null;
  return String(ctxId);
}

/**
 * Build context groups from log entries in the active window.
 * Returns groups in spatial (appearance) order.
 */
export function buildContextGroups(entries: LogEntry[]): ContextGroup[] {
  // Find active window start (after last compact_marker)
  let windowStartIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      windowStartIdx = i + 1;
      break;
    }
  }

  // Build ordered groups
  const groupMap = new Map<string, ContextGroup>();
  const groupOrder: string[] = [];

  for (let i = windowStartIdx; i < entries.length; i++) {
    const entry = entries[i];
    const ctxId = getLogContextId(entry);
    if (!ctxId) continue;

    let group = groupMap.get(ctxId);
    if (!group) {
      group = { contextId: ctxId, entries: [], totalTokens: 0, entryTokens: [] };
      groupMap.set(ctxId, group);
      groupOrder.push(ctxId);
    }
    const tokens = estimateEntryTokens(entry);
    group.entries.push({ entry, index: i });
    group.entryTokens.push(tokens);
    group.totalTokens += tokens;
  }

  return groupOrder.map((id) => groupMap.get(id)!);
}

// ------------------------------------------------------------------
// Context Map generation (compact, for tool_result)
// ------------------------------------------------------------------

function entryTypeLabel(entry: LogEntry): string {
  switch (entry.type) {
    case "user_message": return "user";
    case "assistant_text": return "assistant";
    case "reasoning": return "thinking";
    case "tool_call": return "call";
    case "tool_result": return "result";
    case "no_reply": return "no-reply";
    case "summary": return "summary";
    case "compact_context": return "compact";
    default: return entry.type;
  }
}

function buildTypeList(group: ContextGroup): string {
  const counts = new Map<string, number>();
  for (const { entry } of group.entries) {
    const label = entryTypeLabel(entry);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [label, count] of counts) {
    parts.push(count > 1 ? `${count}× ${label}` : label);
  }
  return parts.join(", ");
}

function groupHeaderAnnotation(group: ContextGroup): string {
  const isSummary = group.entries.some((e) => e.entry.type === "summary");
  const isCompact = group.entries.some((e) => e.entry.type === "compact_context");
  if (isSummary) {
    const depth = group.entries
      .filter((e) => e.entry.type === "summary")
      .map((e) => (e.entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1)[0];
    return ` — summary, depth ${depth}`;
  }
  if (isCompact) return " — auto-compact";
  return "";
}

export function generateContextMap(
  groups: ContextGroup[],
  lastInputTokens: number,
  budget: number,
): string {
  const lines: string[] = [];
  lines.push(`Context Map (${groups.length} groups)`);
  lines.push(`Total: ${formatTokens(lastInputTokens)} | Budget: ${formatTokens(budget)}`);
  lines.push("");

  for (const group of groups) {
    const tokStr = formatTokens(group.totalTokens).padStart(4);
    const types = buildTypeList(group);
    const annotation = groupHeaderAnnotation(group);
    lines.push(`[${group.contextId}] ${tokStr}  ${types}${annotation}`);
  }

  return lines.join("\n");
}

// ------------------------------------------------------------------
// Injection annotation generation (detailed, for §{id}§ locations)
// ------------------------------------------------------------------

export function generateAnnotations(groups: ContextGroup[]): Map<string, string> {
  const annotations = new Map<string, string>();

  for (const group of groups) {
    const lines: string[] = [];
    const header = `§{${group.contextId}}§ ${formatTokens(group.totalTokens)}${groupHeaderAnnotation(group)}`;
    lines.push(header);

    for (let j = 0; j < group.entries.length; j++) {
      const { entry } = group.entries[j];
      const tokens = group.entryTokens[j];
      const { label, description } = describeEntry(entry);
      const tokStr = formatTokens(tokens).padStart(4);
      const paddedLabel = label.padEnd(10);
      lines.push(`  ${paddedLabel} ${description.padEnd(50)} ${tokStr}`);
    }

    annotations.set(group.contextId, lines.join("\n"));
  }

  return annotations;
}

// ------------------------------------------------------------------
// Combined entry point
// ------------------------------------------------------------------

export function generateShowContext(
  entries: LogEntry[],
  lastInputTokens: number,
  budget: number,
): ShowContextResult {
  const groups = buildContextGroups(entries);
  return {
    contextMap: generateContextMap(groups, lastInputTokens, budget),
    annotations: generateAnnotations(groups),
  };
}
