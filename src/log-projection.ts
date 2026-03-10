/**
 * Log projection functions — derive TUI entries and API messages from the log.
 *
 * Both real-time conversation and resume use the same projection logic,
 * guaranteeing 100% consistency.
 */

import type { LogEntry, TuiDisplayKind } from "./log-entry.js";
import type { ConversationEntry, ConversationEntryKind } from "./tui/types.js";
import { mergeConsecutiveSameRole } from "./context-rendering.js";
import { truncateSummaryText } from "./summarize-context.js";

// ------------------------------------------------------------------
// TuiDisplayKind → ConversationEntryKind mapping
// ------------------------------------------------------------------

const DISPLAY_KIND_TO_ENTRY_KIND: Record<TuiDisplayKind, ConversationEntryKind> = {
  user: "user",
  assistant: "assistant",
  reasoning: "reasoning",
  progress: "progress",
  tool_call: "tool_call",
  status: "status",
  error: "error",
  compact_mark: "compact_mark",
  tool_result: "tool_result",
};

// ------------------------------------------------------------------
// TUI Projection
// ------------------------------------------------------------------

export interface TuiProjectionOptions {
  /** Override the compact fold threshold (default: 3). */
  compactFoldThreshold?: number;
}

const INTERRUPTED_MARKER_TEXT = "[Interrupted here.]";
const INTERRUPTED_MARKER_SUFFIX = ` ${INTERRUPTED_MARKER_TEXT}`;

const PRIMARY_ROUND_ENTRY_TYPES = new Set<LogEntry["type"]>([
  "assistant_text",
  "reasoning",
  "tool_call",
  "tool_result",
]);

function isHiddenSubAgentLifecycle(entry: LogEntry): boolean {
  return entry.type === "sub_agent_start";
}

function isProjectableTuiEntry(entry: LogEntry): boolean {
  if (entry.discarded) return false;
  if (!entry.tuiVisible) return false;
  if (entry.type === "summary") return false;
  if (isHiddenSubAgentLifecycle(entry)) return false;
  return true;
}

function toConversationEntry(
  entry: LogEntry,
  toolElapsedMap?: Map<string, number>,
): ConversationEntry {
  if (entry.type === "sub_agent_end") {
    const subAgentId = entry.meta["subAgentId"];
    const subAgentName = entry.meta["subAgentName"];
    const elapsed = entry.meta["elapsed"];
    const label = [
      typeof subAgentId === "number" ? `#${subAgentId}` : "#?",
      typeof subAgentName === "string" ? subAgentName : "sub-agent",
    ].join(" ");
    const elapsedStr = typeof elapsed === "number" ? elapsed.toFixed(1) : "?";
    return {
      kind: "sub_agent_done",
      text: `[${label}] [done] (${elapsedStr}s)`,
      id: entry.id,
    };
  }

  const kind = entry.displayKind
    ? DISPLAY_KIND_TO_ENTRY_KIND[entry.displayKind]
    : "status";

  const ce: ConversationEntry = {
    kind,
    text: entry.display,
    id: entry.id,
  };
  if (entry.meta["tuiDim"]) ce.dim = true;

  // Attach timing info for tool_call entries
  if (entry.type === "tool_call") {
    ce.startedAt = entry.timestamp;
    const toolCallId = entry.meta["toolCallId"];
    if (typeof toolCallId === "string" && toolElapsedMap?.has(toolCallId)) {
      ce.elapsedMs = toolElapsedMap.get(toolCallId);
    }
  }

  return ce;
}

function toConversationEntries(
  entry: LogEntry,
  toolElapsedMap?: Map<string, number>,
): ConversationEntry[] {
  const ce = toConversationEntry(entry, toolElapsedMap);

  if (ce.kind !== "assistant") {
    return [ce];
  }

  if (ce.text === INTERRUPTED_MARKER_TEXT) {
    return [
      {
        kind: "interrupted_marker",
        text: INTERRUPTED_MARKER_TEXT,
        id: ce.id,
      },
    ];
  }

  if (!ce.text.endsWith(INTERRUPTED_MARKER_SUFFIX)) {
    return [ce];
  }

  const assistantText = ce.text.slice(0, -INTERRUPTED_MARKER_SUFFIX.length);
  const entries: ConversationEntry[] = [];

  if (assistantText.trim().length > 0) {
    entries.push({
      ...ce,
      text: assistantText,
    });
  }

  entries.push({
    kind: "interrupted_marker",
    text: INTERRUPTED_MARKER_TEXT,
    id: ce.id ? `${ce.id}:interrupt` : undefined,
  });

  return entries;
}

function isPrimaryRoundEntry(entry: LogEntry): boolean {
  return (
    isProjectableTuiEntry(entry) &&
    entry.roundIndex !== undefined &&
    PRIMARY_ROUND_ENTRY_TYPES.has(entry.type)
  );
}

function buildSubAgentRollup(entries: LogEntry[]): ConversationEntry | null {
  if (entries.length === 0) return null;
  const lastFive = entries.slice(-5);
  const omitted = entries.length - lastFive.length;
  const noun = lastFive.length === 1 ? "tool call" : "tool calls";
  const header = omitted > 0
    ? `${omitted} earlier ${noun} omitted, last ${lastFive.length}:`
    : `Last ${lastFive.length} sub-agent ${noun}:`;
  return {
    kind: "sub_agent_rollup",
    id: `subrollup-${entries[0].id}`,
    text: [header, ...lastFive.map((entry) => entry.display)].join("\n"),
  };
}

/**
 * Build a map of toolCallId → elapsed time (ms) by pairing
 * tool_call and tool_result entries.
 */
function buildToolElapsedMap(entries: LogEntry[]): Map<string, number> {
  const callTimestamps = new Map<string, number>();
  const elapsed = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      const id = entry.meta["toolCallId"];
      if (typeof id === "string") {
        callTimestamps.set(id, entry.timestamp);
      }
    } else if (entry.type === "tool_result") {
      const id = entry.meta["toolCallId"];
      if (typeof id === "string" && callTimestamps.has(id)) {
        elapsed.set(id, entry.timestamp - callTimestamps.get(id)!);
      }
    }
  }

  return elapsed;
}

function projectTuiWindow(entries: LogEntry[]): ConversationEntry[] {
  const result: ConversationEntry[] = [];
  const pendingSubAgentCalls: LogEntry[] = [];
  const toolElapsedMap = buildToolElapsedMap(entries);

  const flushPendingSubAgentCalls = (): void => {
    const rollup = buildSubAgentRollup(pendingSubAgentCalls);
    pendingSubAgentCalls.length = 0;
    if (rollup) result.push(rollup);
  };

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (!isProjectableTuiEntry(entry)) {
      i++;
      continue;
    }

    if (entry.type === "sub_agent_tool_call") {
      pendingSubAgentCalls.push(entry);
      i++;
      continue;
    }

    if (isPrimaryRoundEntry(entry)) {
      if (pendingSubAgentCalls.length > 0) {
        flushPendingSubAgentCalls();
      }

      const turnIndex = entry.turnIndex;
      const roundIndex = entry.roundIndex;

      while (i < entries.length) {
        const candidate = entries[i];

        if (!isProjectableTuiEntry(candidate)) {
          i++;
          continue;
        }

        if (candidate.type === "sub_agent_tool_call") {
          pendingSubAgentCalls.push(candidate);
          i++;
          continue;
        }

        if (
          candidate.turnIndex === turnIndex &&
          candidate.roundIndex === roundIndex &&
          PRIMARY_ROUND_ENTRY_TYPES.has(candidate.type)
        ) {
          result.push(...toConversationEntries(candidate, toolElapsedMap));
          i++;
          continue;
        }

        break;
      }

      if (pendingSubAgentCalls.length > 0) {
        flushPendingSubAgentCalls();
      }
      continue;
    }

    if (pendingSubAgentCalls.length > 0) {
      flushPendingSubAgentCalls();
    }

    result.push(...toConversationEntries(entry, toolElapsedMap));
    i++;
  }

  if (pendingSubAgentCalls.length > 0) {
    flushPendingSubAgentCalls();
  }

  return result;
}

/**
 * Project log entries into ConversationEntry[] for TUI rendering.
 *
 * Rules:
 *  1. Determine fold boundary based on compact markers
 *  2. Skip: folded entries, tuiVisible===false, discarded, summary entries
 *  3. Map (displayKind, display) → ConversationEntry
 */
export function projectToTuiEntries(
  entries: LogEntry[],
  options?: TuiProjectionOptions,
): ConversationEntry[] {
  const threshold = options?.compactFoldThreshold ?? 3;

  // Find all compact_marker indices
  const compactMarkerIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      compactMarkerIndices.push(i);
    }
  }

  // Determine fold boundary: if N >= threshold, fold entries before the (N - threshold + 1)th marker
  let foldEndIdx = -1; // entries at index <= foldEndIdx are folded
  let foldedCount = 0;
  let foldedCompactCount = 0;
  if (compactMarkerIndices.length >= threshold) {
    const foldUpToMarker = compactMarkerIndices[compactMarkerIndices.length - threshold];
    foldEndIdx = foldUpToMarker;
    foldedCount = projectTuiWindow(entries.slice(0, foldEndIdx + 1)).length;
    foldedCompactCount = compactMarkerIndices.length - threshold + 1;
  }

  const result: ConversationEntry[] = [];

  // Add fold placeholder if needed
  if (foldEndIdx >= 0 && foldedCount > 0) {
    result.push({
      kind: "status",
      text: `\u25b8 ${foldedCount} earlier entries (${foldedCompactCount} compacts)`,
    });
  }

  result.push(...projectTuiWindow(entries.slice(foldEndIdx + 1)));

  return result;
}

// ------------------------------------------------------------------
// API Projection
// ------------------------------------------------------------------

/**
 * Internal message format consumed by provider adapters.
 * This is the output of the API projection layer.
 */
export type InternalMessage = Record<string, unknown>;

export interface ApiProjectionOptions {
  /**
   * Fresh system prompt to use (re-rendered, not from log).
   * If not provided, the system_prompt entry's content is used.
   */
  systemPrompt?: string;
  /**
   * Important log content to inject after system prompt.
   * If not empty, merged into first user message or inserted as standalone.
   */
  importantLog?: string;
  /**
   * AGENTS.md content (global + project) to inject after system prompt.
   * If not empty, injected similarly to importantLog.
   */
  agentsMd?: string;
  /**
   * Resolve an image_ref path to base64 data for API consumption.
   * If not provided, image_ref blocks are passed through as-is.
   */
  resolveImageRef?: (refPath: string) => { data: string; media_type: string } | null;
  /** Merge consecutive same-role messages for providers that require alternation. */
  requiresAlternatingRoles?: boolean;
  /** Truncate summarize_context tool-call summaries before provider submission. */
  truncateSummarizeToolArgs?: boolean;
  /**
   * show_context annotations: Map from contextId → annotation text.
   * When provided, §{id}§ + annotation is prepended to user message and
   * first tool_result content for each context group.
   */
  showContextAnnotations?: Map<string, string>;
}

/**
 * Project log entries into InternalMessage[] for provider consumption.
 *
 * Algorithm:
 *  1. Re-render system prompt (or use log's)
 *  2. Find last compact_marker → API window start
 *  3. Insert compact_context if present
 *  4. Iterate entries, skip: apiRole===null, summarized, discarded, archived with null content
 *  5. Group by roundIndex to build assistant messages
 */
export function projectToApiMessages(
  entries: LogEntry[],
  options?: ApiProjectionOptions,
): InternalMessage[] {
  // Step 1: Find system prompt
  let systemPromptContent: unknown = "";
  for (const e of entries) {
    if (e.type === "system_prompt" && !e.discarded) {
      systemPromptContent = options?.systemPrompt ?? e.content;
      break;
    }
  }

  // Step 2: Find last compact_marker → window start
  let windowStartIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) {
      windowStartIdx = i + 1;
      break;
    }
  }

  // Step 3: Find compact_context for the current window
  let compactContextContent: unknown = null;
  let compactContextId: string | undefined;
  for (let i = windowStartIdx; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "compact_context" && !e.discarded && !e.summarized) {
      compactContextContent = e.content;
      const ctxId = (e.meta as Record<string, unknown>)["contextId"];
      compactContextId = ctxId !== undefined && ctxId !== null ? String(ctxId) : undefined;
      break;
    }
  }
  // Also check just before the window start (compact_context may be right after compact_marker)
  if (!compactContextContent && windowStartIdx > 0) {
    for (let i = windowStartIdx; i < entries.length && i < windowStartIdx + 5; i++) {
      const e = entries[i];
      if (e.type === "compact_context" && !e.discarded && !e.summarized) {
        compactContextContent = e.content;
        const ctxId = (e.meta as Record<string, unknown>)["contextId"];
        compactContextId = ctxId !== undefined && ctxId !== null ? String(ctxId) : undefined;
        break;
      }
    }
  }

  // Copy annotations map so we can delete entries after first injection per group
  const annotations = options?.showContextAnnotations
    ? new Map(options.showContextAnnotations)
    : null;

  // Build messages
  const messages: InternalMessage[] = [];

  // System prompt
  if (systemPromptContent) {
    messages.push({ role: "system", content: systemPromptContent });
  }

  // Compact context (as user message)
  if (compactContextContent) {
    let content = compactContextContent as string | Array<Record<string, unknown>>;
    if (compactContextId !== undefined && annotations?.has(compactContextId)) {
      content = prependAnnotation(
        content,
        annotations.get(compactContextId)!,
      ) as string | Array<Record<string, unknown>>;
      annotations.delete(compactContextId);
    }
    const compactMsg: InternalMessage = { role: "user", content };
    if (compactContextId !== undefined) compactMsg["_context_id"] = compactContextId;
    messages.push(compactMsg);
  }

  // Step 4-5: Collect window entries and group by round
  const windowEntries = entries.slice(windowStartIdx).filter((e) => {
    if (e.summarized) return false;
    if (e.discarded) return false;
    if (e.archived && e.content === null) return false;
    if (e.type === "system_prompt") return false; // already handled
    if (e.type === "compact_context") return false; // already handled
    // reasoning has apiRole=null but is grouped with assistant entries
    if (e.type === "reasoning") return true;
    if (e.apiRole === null) return false;
    return true;
  });

  // Group assistant-related entries (assistant_text, reasoning, tool_call, no_reply)
  // by (turnIndex, roundIndex), then emit them as single assistant messages.
  // Non-assistant entries are emitted directly.

  let i = 0;
  while (i < windowEntries.length) {
    const entry = windowEntries[i];

    if (
      (entry.apiRole === "assistant" || entry.type === "reasoning") &&
      entry.roundIndex !== undefined
    ) {
      // Collect all entries in this round
      const roundIdx = entry.roundIndex;
      const turnIdx = entry.turnIndex;
      const roundEntries: LogEntry[] = [];

      while (
        i < windowEntries.length &&
        windowEntries[i].turnIndex === turnIdx &&
        windowEntries[i].roundIndex === roundIdx &&
        (windowEntries[i].apiRole === "assistant" ||
          windowEntries[i].type === "reasoning")
      ) {
        roundEntries.push(windowEntries[i]);
        i++;
      }

      messages.push(buildAssistantMessage(roundEntries, entries));
    } else if (entry.apiRole === "user") {
      let content = resolveImageRefs(entry.content, options?.resolveImageRef);
      // Preserve _context_id for spatial index (summarize_context)
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      // Inject show_context annotation if active
      if (ctxId !== undefined && annotations?.has(String(ctxId))) {
        content = prependAnnotation(content, annotations.get(String(ctxId))!);
      }
      const userMsg: InternalMessage = { role: "user", content };
      if (ctxId !== undefined) userMsg["_context_id"] = ctxId;
      // Preserve summary metadata
      if (entry.type === "summary") {
        userMsg["_is_summary"] = true;
        userMsg["_summary_depth"] = (entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1;
        userMsg["_summarized_ids"] = (entry.meta as Record<string, unknown>)["summarizedEntryIds"] ?? [];
      }
      messages.push(userMsg);
      i++;
    } else if (entry.apiRole === "tool_result") {
      const resultContent = entry.content as {
        toolCallId: string;
        toolName: string;
        content: string;
        toolSummary: string;
      };
      let trContent = resultContent.content;
      // Preserve _context_id for spatial index
      const trCtxId = (entry.meta as Record<string, unknown>)["contextId"];
      // Inject show_context annotation into first tool_result per context group
      if (trCtxId !== undefined && annotations?.has(String(trCtxId))) {
        trContent = `${annotations.get(String(trCtxId))!}\n\n${trContent}`;
        // Remove from annotations so only the first tool_result per group gets it
        annotations.delete(String(trCtxId));
      }
      // Check for multimodal content blocks in metadata
      const toolMeta = (entry.meta as Record<string, unknown>)["toolMetadata"] as Record<string, unknown> | undefined;
      const contentBlocks = toolMeta?.["_contentBlocks"] as Array<Record<string, unknown>> | undefined;

      const trMsg: InternalMessage = {
        role: "tool_result",
        tool_call_id: entry.meta.toolCallId,
        tool_name: entry.meta.toolName,
        content: contentBlocks ?? trContent,
        tool_summary: resultContent.toolSummary,
      };
      if (trCtxId !== undefined) trMsg["_context_id"] = trCtxId;
      messages.push(trMsg);
      i++;
    } else {
      // Fallback
      messages.push({ role: entry.apiRole, content: entry.content });
      i++;
    }
  }

  // Inject important log if provided
  if (options?.importantLog?.trim()) {
    injectImportantLog(messages, options.importantLog);
  }

  // Inject AGENTS.md content if provided
  if (options?.agentsMd?.trim()) {
    injectAgentsMd(messages, options.agentsMd);
  }

  let projected = options?.truncateSummarizeToolArgs === false
    ? messages
    : truncateSummarizeToolArgs(messages);

  if (options?.requiresAlternatingRoles) {
    projected = mergeConsecutiveSameRole(projected);
  }

  return projected;
}

// ------------------------------------------------------------------
// show_context annotation injection
// ------------------------------------------------------------------

/**
 * Prepend a show_context annotation to message content.
 * Handles both string content and array content blocks.
 */
function prependAnnotation(content: unknown, annotation: string): unknown {
  if (typeof content === "string") {
    return `${annotation}\n\n${content}`;
  }
  if (Array.isArray(content)) {
    const copy = (content as Array<Record<string, unknown>>).map((b) => ({ ...b }));
    // Prepend annotation as a text block
    copy.unshift({ type: "text", text: `${annotation}\n\n` });
    return copy;
  }
  return content;
}

// ------------------------------------------------------------------
// Image ref resolution
// ------------------------------------------------------------------

/**
 * Resolve image_ref blocks in content to inline base64 for API consumption.
 * If content is a string or resolver is not provided, returns as-is.
 */
function resolveImageRefs(
  content: unknown,
  resolver?: (refPath: string) => { data: string; media_type: string } | null,
): unknown {
  if (!resolver || !Array.isArray(content)) return content;
  let hasRef = false;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "image_ref"
    ) {
      hasRef = true;
      break;
    }
  }
  if (!hasRef) return content;

  return (content as Array<Record<string, unknown>>).map((block) => {
    if (block["type"] !== "image_ref") return block;
    const resolved = resolver(block["path"] as string);
    if (!resolved) return block; // fallback: pass through
    return {
      type: "image",
      data: resolved.data,
      media_type: resolved.media_type,
    };
  });
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Build a single assistant API message from grouped round entries.
 */
function buildAssistantMessage(
  roundEntries: LogEntry[],
  _allEntries: LogEntry[],
): InternalMessage {
  const msg: InternalMessage = { role: "assistant" };

  // Extract reasoning
  const reasoning = roundEntries.find((e) => e.type === "reasoning");
  if (reasoning) {
    msg.reasoning_content = reasoning.content;
    if (reasoning.meta.reasoningState !== undefined) {
      msg._reasoning_state = reasoning.meta.reasoningState;
    }
  }

  // Extract assistant_text
  const text = roundEntries.find((e) => e.type === "assistant_text");

  // Extract tool_calls
  const toolCalls = roundEntries
    .filter((e) => e.type === "tool_call")
    .map((e) => e.content);

  // Extract no_reply
  const noReply = roundEntries.find((e) => e.type === "no_reply");

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
    if (text) {
      msg.text = text.content;
    }
  } else if (noReply) {
    msg.content = noReply.content;
  } else if (text) {
    msg.content = text.content;
  }

  // Preserve _context_id from the first entry with one
  for (const e of roundEntries) {
    const ctxId = (e.meta as Record<string, unknown>)["contextId"];
    if (ctxId !== undefined) {
      msg["_context_id"] = ctxId;
      break;
    }
  }

  return msg;
}

/**
 * Inject important log content after the system prompt.
 * Merges into the first user message if possible.
 */
function injectImportantLog(
  messages: InternalMessage[],
  logContent: string,
): void {
  const header =
    "[IMPORTANT LOG]\n" +
    "The following is your persistent engineering notebook:\n\n";
  const fullContent = header + logContent;

  // Find position after system prompt(s)
  let insertIdx = 0;
  while (insertIdx < messages.length && messages[insertIdx].role === "system") {
    insertIdx++;
  }

  if (insertIdx < messages.length && messages[insertIdx].role === "user") {
    // Merge into first user message
    const first = messages[insertIdx];
    messages[insertIdx] = {
      ...first,
      content: mergeMessageContent(fullContent, first.content),
    };
  } else {
    // Insert standalone user message
    messages.splice(insertIdx, 0, { role: "user", content: fullContent });
  }
}

/**
 * Inject AGENTS.md content after the system prompt (and after important log).
 * Merges into the first user message if possible.
 */
function injectAgentsMd(
  messages: InternalMessage[],
  agentsMdContent: string,
): void {
  const header =
    "[AGENTS.MD — PERSISTENT MEMORY]\n" +
    "The following is your persistent memory across sessions:\n\n";
  const fullContent = header + agentsMdContent;

  // Find position after system prompt(s)
  let insertIdx = 0;
  while (insertIdx < messages.length && messages[insertIdx].role === "system") {
    insertIdx++;
  }

  if (insertIdx < messages.length && messages[insertIdx].role === "user") {
    // Merge into first user message (important log may already be merged there)
    const first = messages[insertIdx];
    messages[insertIdx] = {
      ...first,
      content: mergeMessageContent(fullContent, first.content),
    };
  } else {
    // Insert standalone user message
    messages.splice(insertIdx, 0, { role: "user", content: fullContent });
  }
}

function truncateSummarizeToolArgs(
  messages: InternalMessage[],
): InternalMessage[] {
  return messages.map((msg) => {
    const toolCalls = msg["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (!toolCalls?.length) return msg;

    let modified = false;
    const nextToolCalls = toolCalls.map((tc) => {
      if ((tc["name"] as string) !== "summarize_context") return tc;

      const args = tc["arguments"] as Record<string, unknown> | undefined;
      const operations = args?.["operations"] as Array<Record<string, unknown>> | undefined;
      if (!args || !operations?.length) return tc;

      let opsModified = false;
      const nextOperations = operations.map((op) => {
        const summary = op["summary"] as string | undefined;
        const resultCtxId = op["_result_context_id"] as string | number | undefined;
        if (!summary || summary.length <= 100) {
          if (resultCtxId === undefined) return op;
          opsModified = true;
          const { _result_context_id: _removed, ...rest } = op;
          return rest;
        }

        opsModified = true;
        const { _result_context_id: _removed, ...rest } = op;
        return {
          ...rest,
          summary: truncateSummaryText(summary, resultCtxId),
        };
      });

      if (!opsModified) return tc;
      modified = true;
      return {
        ...tc,
        arguments: {
          ...args,
          operations: nextOperations,
        },
      };
    });

    if (!modified) return msg;
    return { ...msg, tool_calls: nextToolCalls };
  });
}

function mergeMessageContent(
  prefix: string,
  existing: unknown,
): string | Array<Record<string, unknown>> {
  if (typeof existing === "string") {
    return `${prefix}\n\n${existing}`;
  }
  if (Array.isArray(existing)) {
    return [
      { type: "text", text: prefix },
      ...existing as Array<Record<string, unknown>>,
    ];
  }
  return `${prefix}\n\n${String(existing ?? "")}`;
}
