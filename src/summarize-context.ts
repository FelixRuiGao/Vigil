/**
 * Log-native summarize_context implementation.
 *
 * The session log is the single source of truth. summarize_context works
 * directly on LogEntry[] and inserts summary entries into the active window.
 */

import { createSummary, type LogEntry } from "./log-entry.js";

export interface SummarizeOperation {
  context_ids: string[];
  summary: string;
  reason?: string;
}

export interface OperationResult {
  success: boolean;
  contextIds: string[];
  newContextId?: string;
  error?: string;
}

interface LogSpatialEntry {
  indices: number[];
}

interface LogValidationResult {
  valid: boolean;
  mergeRange?: [number, number];
  error?: string;
}

export interface LogSummarizeExecutionResult {
  output: string;
  results: OperationResult[];
}

function getLogContextId(entry: LogEntry): string | null {
  if (entry.discarded || entry.summarized) return null;
  const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
  if (ctxId === undefined || ctxId === null) return null;
  return String(ctxId);
}

function isTransparentLogEntry(entry: LogEntry): boolean {
  if (entry.discarded || entry.summarized) return true;
  return getLogContextId(entry) === null;
}

function buildLogSpatialIndex(entries: LogEntry[]): Map<string, LogSpatialEntry> {
  const index = new Map<string, LogSpatialEntry>();
  for (let i = 0; i < entries.length; i++) {
    const ctxId = getLogContextId(entries[i]);
    if (!ctxId) continue;

    registerIndex(index, ctxId, i);

    if (ctxId.includes(".")) {
      registerIndex(index, ctxId.split(".")[0], i);
    }
  }
  return index;
}

function registerIndex(index: Map<string, LogSpatialEntry>, key: string, idx: number): void {
  const entry = index.get(key);
  if (entry) {
    if (!entry.indices.includes(idx)) entry.indices.push(idx);
    return;
  }
  index.set(key, { indices: [idx] });
}

function findLastCompactMarkerEntryIdx(entries: LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) return i;
  }
  return -1;
}

function collectNearbyLogContextIds(entries: LogEntry[], minIdx: number, maxIdx: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const start = Math.max(0, minIdx - 2);
  const end = Math.min(entries.length - 1, maxIdx + 2);

  for (let i = start; i <= end; i++) {
    const ctxId = getLogContextId(entries[i]);
    if (!ctxId || seen.has(ctxId)) continue;
    seen.add(ctxId);
    ids.push(ctxId);
  }

  return ids;
}

function parseOperations(args: Record<string, unknown>): SummarizeOperation[] {
  const operations = (args["operations"] as Array<Record<string, unknown>>) ?? [];
  return operations.map((raw) => ({
    context_ids: ((raw["context_ids"] as string[]) ?? []).map(String),
    summary: typeof raw["summary"] === "string" ? raw["summary"] : "",
    reason: typeof raw["reason"] === "string" && raw["reason"].trim()
      ? raw["reason"]
      : undefined,
  }));
}

function validateLogOperation(
  op: SummarizeOperation,
  spatialIndex: Map<string, LogSpatialEntry>,
  entries: LogEntry[],
  lastCompactMarkerIdx: number,
): LogValidationResult {
  const { context_ids, summary } = op;

  if (!context_ids.length) {
    return { valid: false, error: "Empty context_ids array." };
  }
  if (!summary.trim()) {
    return { valid: false, error: "Empty summary. Provide a non-empty summary string." };
  }

  for (const id of context_ids) {
    if (!spatialIndex.has(id)) {
      return { valid: false, error: `context_id "${id}" not found.` };
    }
  }

  const allIndices = new Set<number>();
  for (const id of context_ids) {
    for (const idx of spatialIndex.get(id)!.indices) {
      allIndices.add(idx);
    }
  }

  const sorted = [...allIndices].sort((a, b) => a - b);
  const minIdx = sorted[0];
  const maxIdx = sorted[sorted.length - 1];

  if (lastCompactMarkerIdx >= 0 && minIdx <= lastCompactMarkerIdx) {
    return {
      valid: false,
      error: "context_id(s) include entries before the last compact marker (not visible to the model).",
    };
  }

  for (let i = minIdx; i <= maxIdx; i++) {
    if (allIndices.has(i)) continue;
    if (isTransparentLogEntry(entries[i])) continue;

    const nearbyIds = collectNearbyLogContextIds(entries, minIdx, maxIdx);
    return {
      valid: false,
      error:
        `Not spatially contiguous. Current spatial order near that region: ` +
        `${nearbyIds.join(", ")} — did you mean [${context_ids.join(", ")}] ` +
        `to include the gaps, or split into separate operations?`,
    };
  }

  return { valid: true, mergeRange: [minIdx, maxIdx] };
}

function executeLogOperation(
  op: SummarizeOperation,
  entries: LogEntry[],
  allocateContextId: () => string,
  allocateLogId: () => string,
  turnIndex: number,
  validation: LogValidationResult,
): OperationResult {
  const [startIdx, endIdx] = validation.mergeRange!;
  const newContextId = allocateContextId();
  const summaryEntryId = allocateLogId();

  let summaryDepth = 1;
  const summarizedContextIds: string[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const entry = entries[i];
    if (entry.type === "summary") {
      const depth = Number((entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1);
      summaryDepth = Math.max(summaryDepth, depth + 1);
    }
    const ctxId = getLogContextId(entry);
    if (ctxId && !summarizedContextIds.includes(ctxId)) {
      summarizedContextIds.push(ctxId);
    }
  }

  let display = `[Summary of ${op.context_ids.join(", ")} ]\n`;
  display = display.replace(" )", ")");
  if (op.reason) {
    display += `Reason: ${op.reason}\n`;
  }
  const content = `${display}Summary: ${op.summary}`;
  display += `Summary: ${op.summary}`;

  const summaryEntry = createSummary(
    summaryEntryId,
    turnIndex,
    display,
    content,
    newContextId,
    summarizedContextIds,
    summaryDepth,
  );

  for (let i = startIdx; i <= endIdx; i++) {
    if (entries[i].discarded) continue;
    entries[i].summarized = true;
    entries[i].summarizedBy = summaryEntryId;
  }

  entries.splice(startIdx, 0, summaryEntry);

  return {
    success: true,
    contextIds: op.context_ids,
    newContextId,
  };
}

function formatExecutionOutput(ops: SummarizeOperation[], results: OperationResult[]): string {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const lines: string[] = [];
  lines.push(`Operations: ${ops.length} submitted, ${succeeded} succeeded, ${failed} failed.`);
  lines.push("");
  for (const result of results) {
    const idsLabel = result.contextIds.join(", ");
    if (result.success) {
      lines.push(`\u2713 [context_ids: ${idsLabel}] \u2192 Replaced with context_id ${String(result.newContextId)}.`);
    } else {
      lines.push(`\u2717 [context_ids: ${idsLabel}] \u2192 Error: ${result.error}`);
    }
  }
  return lines.join("\n");
}

/**
 * Truncate long summary text in projected tool arguments.
 * The tool result still keeps the full summary; this only shrinks provider input.
 */
export function truncateSummaryText(summary: string, newContextId?: string | number): string {
  if (summary.length <= 100) return summary;

  let cutPoint = 100;
  const spaceIdx = summary.indexOf(" ", 100);
  if (spaceIdx >= 0 && spaceIdx <= 150) {
    cutPoint = spaceIdx;
  } else {
    cutPoint = Math.min(summary.length, 150);
  }

  const kept = summary.slice(0, cutPoint);
  const ctxRef = newContextId !== undefined ? ` in context_id ${String(newContextId)}` : "";
  return `${kept}...{Truncated, first ${cutPoint} chars kept, full version${ctxRef}}`;
}

export function execSummarizeContextOnLog(
  args: Record<string, unknown>,
  entries: LogEntry[],
  contextIdAllocator: () => string,
  logIdAllocator: () => string,
  turnIndex: number,
): LogSummarizeExecutionResult {
  const ops = parseOperations(args);
  if (!ops.length) {
    const results: OperationResult[] = [{
      success: false,
      contextIds: [],
      error: "Error: no operations provided.",
    }];
    return {
      output: "Error: no operations provided.",
      results,
    };
  }

  const spatialIndex = buildLogSpatialIndex(entries);
  const lastCompactMarkerIdx = findLastCompactMarkerEntryIdx(entries);
  const validations: Array<{ op: SummarizeOperation; validation: LogValidationResult; opIndex: number }> = [];
  const orderedResults: Array<OperationResult | undefined> = new Array(ops.length);
  const claimedIds = new Set<string>();

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];
    const duplicates = op.context_ids.filter((id) => claimedIds.has(id));
    if (duplicates.length > 0) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: `context_id(s) ${duplicates.map((d) => `"${d}"`).join(", ")} already referenced by another operation in this call.`,
      };
      continue;
    }

    const validation = validateLogOperation(op, spatialIndex, entries, lastCompactMarkerIdx);
    if (!validation.valid) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: validation.error,
      };
      continue;
    }

    validations.push({ op, validation, opIndex });
    for (const id of op.context_ids) claimedIds.add(id);
  }

  validations.sort((a, b) => b.validation.mergeRange![0] - a.validation.mergeRange![0]);
  for (const { op, validation, opIndex } of validations) {
    orderedResults[opIndex] = executeLogOperation(
      op,
      entries,
      contextIdAllocator,
      logIdAllocator,
      turnIndex,
      validation,
    );
  }

  const finalizedResults = orderedResults.map((result, idx) => result ?? ({
    success: false,
    contextIds: ops[idx].context_ids,
    error: "Internal error: missing operation result.",
  }));

  return {
    output: formatExecutionOutput(ops, finalizedResults),
    results: finalizedResults,
  };
}
