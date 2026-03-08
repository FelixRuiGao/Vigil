/**
 * Shared tool loop logic for Agent.
 *
 * Provides the async LLM <-> tool round-trip cycle. Calls the provider,
 * executes tool calls, appends results via callbacks, and repeats until
 * the model responds without tool calls or max rounds are reached.
 *
 * v2: operates through callbacks (getMessages / appendEntry) instead of
 * directly mutating provider messages. The backing store can be the
 * structured session log (main agent) or an ephemeral structured log
 * (sub-agents / stateless runs).
 */

import type {
  BaseProvider,
  ProviderResponse,
  ToolDef,
  ToolResult,
} from "../providers/base.js";
import { ToolResult as ToolResultClass } from "../providers/base.js";
import {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "../network-retry.js";
import type { LogEntry } from "../log-entry.js";
import {
  createReasoning,
  createAssistantText,
  createToolCall,
  createToolResult as createToolResultEntry,
} from "../log-entry.js";
import type { AskRequest } from "../ask.js";

// ------------------------------------------------------------------
// Tool executor type
// ------------------------------------------------------------------

/**
 * A tool executor receives the arguments dict and returns either
 * a plain string or a ToolResult. May be sync or async.
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
) => ToolResult | string | Promise<ToolResult | string>;

// ------------------------------------------------------------------
// generateToolSummary
// ------------------------------------------------------------------

/** Generate a one-line summary from a ToolDef.summaryTemplate. */
export function generateToolSummary(
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summaryTemplate: string,
): string {
  if (summaryTemplate) {
    try {
      // Replace {agent} and any {argKey} placeholders
      let result = summaryTemplate.replace(/\{agent\}/g, agentName);
      for (const [key, value] of Object.entries(toolArgs)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
      }
      // If any unreplaced placeholders remain, fall through to default
      if (!/\{[^}]+\}/.test(result)) {
        return result;
      }
    } catch {
      // fall through
    }
  }
  return `${agentName} is calling ${toolName}`;
}

function compactDisplayValue(value: unknown, maxLen = 48): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return '""';
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (value && typeof value === "object") {
    return "{...}";
  }
  return "";
}

export function generateToolCallDisplay(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  const path = compactDisplayValue(toolArgs["path"]);
  const file = compactDisplayValue(toolArgs["file"]);
  const pattern = compactDisplayValue(toolArgs["pattern"]);
  const url = compactDisplayValue(toolArgs["url"]);
  const command = compactDisplayValue(toolArgs["command"], 60);
  const name = compactDisplayValue(toolArgs["name"]);
  const id = compactDisplayValue(toolArgs["id"]);
  const shell = compactDisplayValue(toolArgs["shell"]);
  const contextIds = Array.isArray(toolArgs["context_ids"])
    ? `[${(toolArgs["context_ids"] as unknown[]).length} contexts]`
    : "";
  const ids = Array.isArray(toolArgs["ids"])
    ? `[${(toolArgs["ids"] as unknown[]).length} ids]`
    : "";

  switch (toolName) {
    case "read_file":
    case "list_dir":
    case "edit_file":
    case "write_file":
      return path ? `${toolName} ${path}` : toolName;
    case "apply_patch":
      return toolName;
    case "glob":
      return pattern ? `${toolName} ${pattern}` : toolName;
    case "grep":
      return pattern && path ? `${toolName} ${pattern} in ${path}` : pattern ? `${toolName} ${pattern}` : toolName;
    case "diff":
      return compactDisplayValue(toolArgs["file_a"]) ? `${toolName} ${compactDisplayValue(toolArgs["file_a"])}` : toolName;
    case "bash":
    case "test":
      return command ? `${toolName} ${command}` : toolName;
    case "bash_background":
      return command ? `${toolName} ${command}` : toolName;
    case "bash_output":
      return id ? `${toolName} ${id}` : toolName;
    case "kill_shell":
      return ids ? `${toolName} ${ids}` : toolName;
    case "web_fetch":
      return url ? `${toolName} ${url}` : toolName;
    case "web_search":
    case "$web_search":
      return compactDisplayValue(toolArgs["query"]) ? `${toolName} ${compactDisplayValue(toolArgs["query"])}` : toolName;
    case "spawn_agent":
      return file ? `${toolName} ${file}` : toolName;
    case "kill_agent":
      return ids ? `${toolName} ${ids}` : toolName;
    case "wait":
      if (shell) {
        return toolArgs["seconds"] !== undefined
          ? `${toolName} ${shell} ${String(toolArgs["seconds"])}s`
          : `${toolName} ${shell}`;
      }
      return toolArgs["seconds"] !== undefined ? `${toolName} ${String(toolArgs["seconds"])}s` : toolName;
    case "summarize_context":
      return contextIds ? `${toolName} ${contextIds}` : toolName;
    case "skill":
      return name ? `${toolName} ${name}` : toolName;
    default:
      return toolName;
  }
}

function extractToolPreview(metadata: Record<string, unknown>): { text: string } | null {
  const preview = metadata["tui_preview"];
  if (!preview || typeof preview !== "object") return null;
  const text = (preview as Record<string, unknown>)["text"];
  if (typeof text !== "string" || !text.trim()) return null;
  return { text };
}

// ------------------------------------------------------------------
// ToolLoopResult
// ------------------------------------------------------------------

export interface ToolLoopResult {
  text: string;
  toolHistory: Array<Record<string, unknown>>;
  totalUsage: { inputTokens: number; outputTokens: number };
  intermediateText: string[];
  lastInputTokens: number;
  reasoningContent: string;
  reasoningState: unknown;
  /** Flat context_id of the last tool-call round (undefined if no tool calls). */
  lastRoundId?: string;
  /** Whether the tool loop detected that compact is needed. */
  compactNeeded?: boolean;
  /** Which scenario triggered compact: "output" (no tool calls) or "toolcall" (after tool execution). */
  compactScenario?: "output" | "toolcall";
  /** Total tokens (input + output) from the last provider call. */
  lastTotalTokens?: number;
  /** Whether the final assistant text was already materialized by stream callbacks. */
  textHandledInLog?: boolean;
  /** Whether the final reasoning content was already materialized by stream callbacks. */
  reasoningHandledInLog?: boolean;
  /** Suspended on an ask tool call that requires user input. */
  suspendedAsk?: {
    ask: AskRequest;
    toolCallId: string;
    roundIndex: number;
  };
}

// ------------------------------------------------------------------
// OnToolCall callback type
// ------------------------------------------------------------------

export type OnToolCallCallback = (
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summary: string,
) => void;

export interface ToolPreflightContext {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  summary: string;
}

export type ToolPreflightDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string };

export type BeforeToolExecuteCallback = (
  ctx: ToolPreflightContext,
) => ToolPreflightDecision | void | Promise<ToolPreflightDecision | void>;

// ------------------------------------------------------------------
// asyncRunToolLoop
// ------------------------------------------------------------------

export interface ToolLoopOptions {
  provider: BaseProvider;
  /**
   * Returns the current API message sequence for the provider.
   * Called before each provider call.
   * Main agent: projects from _log; sub-agents: returns local array.
   */
  getMessages: () => Array<Record<string, unknown>>;
  /**
   * Append a LogEntry to the backing store.
   * Main agent: appends to _log; sub-agents: converts to raw msg and pushes.
   */
  appendEntry: (entry: LogEntry) => void;
  /** Allocate the next entry ID. */
  allocId: (type: LogEntry["type"]) => string;
  /** Current turn index (for entry creation). */
  turnIndex: number;
  /** Base round index for this activation within the current turn. */
  baseRoundIndex?: number;
  tools?: ToolDef[];
  toolExecutors: Record<string, ToolExecutor>;
  maxRounds: number;
  agentName?: string;
  onToolCall?: OnToolCallCallback;
  toolsMap?: Record<string, ToolDef>;
  onTextChunk?: (roundIndex: number, chunk: string) => boolean | void;
  onReasoningChunk?: (roundIndex: number, chunk: string) => boolean | void;
  /** Fallback executor for tools not found in toolExecutors. */
  builtinExecutor?: (name: string, args: Record<string, unknown>) => Promise<ToolResult | string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Allocator that returns the round's context_id. Provided by Session for context ID tracking. */
  contextIdAllocator?: (roundIndex: number) => string;
  /** Called after each provider response with the latest input token count and full Usage. */
  onTokenUpdate?: (inputTokens: number, usage?: import("../providers/base.js").Usage) => void;
  /**
   * Callback to check whether compact is needed after each provider call.
   * Returns { compactNeeded, scenario } or null to skip.
   * When undefined, no compact checking is performed (e.g. sub-agents).
   */
  compactCheck?: (
    inputTokens: number,
    outputTokens: number,
    hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "output" | "toolcall" } | null;
  /** Unified thinking level override (passed to provider). */
  thinkingLevel?: string;
  /** Whether to enable provider-specific prompt caching. */
  cacheEnabled?: boolean;
  /** Called after each tool_result is appended, for incremental persistence. */
  onSaveCheckpoint?: () => void;
  /** Optional preflight gate before executing a tool call (may ask/pause/deny). */
  beforeToolExecute?: BeforeToolExecuteCallback;
  /** Returns a notification string to append to tool_result content, or null if none. */
  getNotification?: () => string | null;
  /** When true, streamed text/reasoning callbacks own the corresponding log entries. */
  streamCallbacksOwnEntries?: boolean;
  /** Called when a network error is detected and a retry is being attempted. */
  onRetryAttempt?: (attempt: number, maxRetries: number, delaySec: number, errMsg: string) => void;
  /** Called when a retried network call succeeds. */
  onRetrySuccess?: (attempt: number) => void;
  /** Called when all network retries have been exhausted. */
  onRetryExhausted?: (maxRetries: number, errMsg: string) => void;
}

/**
 * Async tool loop: call LLM, execute tools, repeat until done.
 *
 * Tool executors are called with their arguments dict and may be
 * sync or async. Exceptions are caught and returned as error
 * ToolResult content.
 */
export async function asyncRunToolLoop(
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    provider,
    getMessages,
    appendEntry,
    allocId,
    turnIndex,
    baseRoundIndex = 0,
    tools,
    toolExecutors,
    maxRounds,
    agentName = "",
    onToolCall,
    onTextChunk,
    onReasoningChunk,
    builtinExecutor,
    signal,
    contextIdAllocator,
    onTokenUpdate,
    compactCheck,
    thinkingLevel,
    cacheEnabled,
    onSaveCheckpoint,
    beforeToolExecute,
    getNotification,
    streamCallbacksOwnEntries = false,
    onRetryAttempt,
    onRetrySuccess,
    onRetryExhausted,
  } = opts;

  let toolsMap = opts.toolsMap;
  if (!toolsMap && tools) {
    toolsMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  const toolHistory: Array<Record<string, unknown>> = [];
  const intermediateText: string[] = [];
  let hadStreamedText = false;
  let totalInput = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let lastReasoningContent = "";
  let lastReasoningState: unknown = null;

  // Flat context ID per tool-call round
  let lastRoundId: string | undefined;

  // Network retry counter (consecutive failures across rounds)
  let networkRetryCount = 0;

  for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
    const roundIndex = baseRoundIndex + roundIdx;
    // Check abort before each provider call
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Track whether the provider called onTextChunk (streaming).
    let providerStreamedText = false;
    let providerStreamedReasoning = false;
    let textHandledViaCallback = false;
    let reasoningHandledViaCallback = false;
    let wrappedChunk: ((chunk: string) => void) | undefined;
    if (onTextChunk) {
      wrappedChunk = (chunk: string) => {
        providerStreamedText = true;
        textHandledViaCallback = onTextChunk(roundIndex, chunk) === true || textHandledViaCallback;
      };
    }
    let wrappedReasoningChunk: ((chunk: string) => void) | undefined;
    if (onReasoningChunk) {
      wrappedReasoningChunk = (chunk: string) => {
        providerStreamedReasoning = true;
        reasoningHandledViaCallback = onReasoningChunk(roundIndex, chunk) === true || reasoningHandledViaCallback;
      };
    }

    let resp: ProviderResponse;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        resp = await provider.asyncSendMessage(
          getMessages() as any,
          tools?.length ? tools : undefined,
          {
            onTextChunk: wrappedChunk,
            onReasoningChunk: wrappedReasoningChunk,
            signal,
            thinkingLevel,
            cacheEnabled,
          },
        );
        if (networkRetryCount > 0) {
          onRetrySuccess?.(networkRetryCount);
          networkRetryCount = 0;
        }
        break;
      } catch (netErr) {
        if (!isRetryableNetworkError(netErr) || networkRetryCount >= MAX_NETWORK_RETRIES) {
          if (isRetryableNetworkError(netErr)) {
            const errMsg = netErr instanceof Error ? netErr.message : String(netErr);
            onRetryExhausted?.(MAX_NETWORK_RETRIES, errMsg);
          }
          throw netErr;
        }
        networkRetryCount++;
        const errMsg = netErr instanceof Error ? netErr.message : String(netErr);
        const delay = computeRetryDelay(networkRetryCount - 1);
        const delaySec = Math.round(delay / 1000);
        onRetryAttempt?.(networkRetryCount, MAX_NETWORK_RETRIES, delaySec, errMsg);
        await retrySleep(delay, signal);
      }
    }

    lastInput = resp.usage.inputTokens;
    totalInput += resp.usage.inputTokens;
    totalOutput += resp.usage.outputTokens;

    if (onTokenUpdate) {
      onTokenUpdate(lastInput, resp.usage);
    }

    // Compact check after each provider call
    let compactTriggered = false;
    let compactScenario: "output" | "toolcall" | undefined;

    if (compactCheck) {
      const check = compactCheck(resp.usage.inputTokens, resp.usage.outputTokens, resp.hasToolCalls);
      if (check?.compactNeeded) {
        compactTriggered = true;
        compactScenario = check.scenario;
      }
    }

    // Fallback: emit text as single chunk if provider didn't stream
    if (resp.text && onTextChunk && !providerStreamedText) {
      textHandledViaCallback = onTextChunk(roundIndex, resp.text) === true || textHandledViaCallback;
    }

    if (resp.reasoningContent && onReasoningChunk && !providerStreamedReasoning) {
      reasoningHandledViaCallback =
        onReasoningChunk(roundIndex, resp.reasoningContent) === true || reasoningHandledViaCallback;
    }

    if (resp.text) {
      hadStreamedText = true;
    }

    if (!resp.hasToolCalls) {
      // No tool calls — return final result.
      // The caller (Session) is responsible for creating the final
      // assistant_text / reasoning / no_reply entries.
      return {
        text: resp.text,
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: resp.reasoningContent,
        reasoningState: resp.reasoningState,
        lastRoundId: lastRoundId,
        compactNeeded: compactTriggered,
        compactScenario: compactTriggered ? "output" : undefined,
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
      };
    }

    // Track reasoning from each round (used in max-rounds fallback)
    lastReasoningContent = resp.reasoningContent;
    lastReasoningState = resp.reasoningState;

    // Context ID: allocate a flat ID per round
    if (contextIdAllocator) {
      lastRoundId = contextIdAllocator(roundIndex);
    }

    // --- Create entries for this round ---

    // Reasoning entry
    if (resp.reasoningContent && !(streamCallbacksOwnEntries && reasoningHandledViaCallback)) {
      appendEntry(createReasoning(
        allocId("reasoning"),
        turnIndex,
        roundIndex,
        resp.reasoningContent,
        resp.reasoningContent,
        resp.reasoningState,
        lastRoundId,
      ));
    }

    // Intermediate assistant text entry (text alongside tool_calls)
    if (resp.text && !(streamCallbacksOwnEntries && textHandledViaCallback)) {
      intermediateText.push(resp.text);
      appendEntry(createAssistantText(
        allocId("assistant_text"),
        turnIndex,
        roundIndex,
        resp.text,
        resp.text,
        lastRoundId,
      ));
    }

    // Pre-compute summaries, emit progress, and run preflight checks
    const toolSummaries = new Map<string, string>();
    const preflightDecisions = new Map<string, ToolPreflightDecision>();
    for (const tc of resp.toolCalls) {
      const toolDef = toolsMap?.[tc.name];
      const summary = generateToolSummary(
        agentName,
        tc.name,
        tc.arguments,
        toolDef?.summaryTemplate ?? "",
      );
      toolSummaries.set(tc.id, summary);

      if (onToolCall) {
        onToolCall(agentName, tc.name, tc.arguments, summary);
      }

      if (beforeToolExecute) {
        const decision = await beforeToolExecute({
          agentName,
          toolName: tc.name,
          toolArgs: tc.arguments,
          toolCallId: tc.id,
          summary,
        });
        if (decision) {
          preflightDecisions.set(tc.id, decision);
        }
      }
    }

    // Tool call entries
    for (const tc of resp.toolCalls) {
      const summary = toolSummaries.get(tc.id) ?? "";
      const display = generateToolCallDisplay(tc.name, tc.arguments);
      appendEntry(createToolCall(
        allocId("tool_call"),
        turnIndex,
        roundIndex,
        display,
        { id: tc.id, name: tc.name, arguments: tc.arguments },
        { toolCallId: tc.id, toolName: tc.name, agentName, contextId: lastRoundId },
      ));
    }

    // Execute each tool call
    for (const tc of resp.toolCalls) {
      // Check abort before each tool execution
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const summary = toolSummaries.get(tc.id) ?? "";

      // Execute tool with exception safety
      let toolOutput: ToolResult | string;

      // Check for JSON parse errors from provider (arguments couldn't be parsed)
      if (tc.arguments["_parseError"]) {
        const parseError = tc.arguments["_parseError"] as string;
        toolOutput = new ToolResultClass({
          content: `ERROR: ${parseError}`,
        });
        // Clean up internal marker from arguments before storing in history
        const cleanArgs = { ...tc.arguments };
        delete cleanArgs["_parseError"];
        tc.arguments = cleanArgs;
      } else try {
        const preflight = preflightDecisions.get(tc.id);
        if (preflight?.kind === "deny") {
          toolOutput = new ToolResultClass({
            content: `ERROR: ${preflight.message}`,
          });
        } else if (tc.name in toolExecutors) {
          toolOutput = await toolExecutors[tc.name](tc.arguments);
        } else if (builtinExecutor) {
          toolOutput = await builtinExecutor(tc.name, tc.arguments);
        } else {
          toolOutput = new ToolResultClass({
            content: `ERROR: No executor found for tool '${tc.name}'`,
          });
        }
      } catch (e) {
        if ((e as any)?.name === "AskPendingError") {
          const ask = (e as { ask?: AskRequest }).ask;
          if (ask) {
            ask.payload.toolCallId = tc.id;
            ask.roundIndex = roundIndex;
          }
          return {
            text: resp.text || "",
            toolHistory,
            totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
            intermediateText,
            lastInputTokens: lastInput,
            reasoningContent: resp.reasoningContent,
            reasoningState: resp.reasoningState,
            lastRoundId: lastRoundId,
            compactNeeded: false,
            lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
            textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
            reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
            suspendedAsk: ask ? { ask, toolCallId: tc.id, roundIndex } : undefined,
          };
        }
        if ((e as any)?.name === "AbortError" || signal?.aborted) {
          throw e;
        }
        console.error(`[${agentName}] tool '${tc.name}' raised:`, e);
        toolOutput = new ToolResultClass({
          content: `ERROR: Tool execution failed — ${e}`,
        });
      }

      // Normalize to ToolResult
      const resolved: ToolResultClass =
        typeof toolOutput === "string"
          ? new ToolResultClass({ content: toolOutput })
          : toolOutput instanceof ToolResultClass
            ? toolOutput
            : new ToolResultClass({ content: String(toolOutput) });

      // Append notification if queued messages are pending
      let resultStr = resolved.content;
      if (getNotification) {
        const note = getNotification();
        if (note) resultStr += note;
      }

      const toolEntry: Record<string, unknown> = {
        tool: tc.name,
        arguments: tc.arguments,
        result: resultStr,
      };
      if (resolved.actionHint) {
        toolEntry["action_hint"] = resolved.actionHint;
      }
      if (resolved.tags.length > 0) {
        toolEntry["tags"] = resolved.tags;
      }
      if (Object.keys(resolved.metadata).length > 0) {
        toolEntry["tool_metadata"] = resolved.metadata;
      }
      toolHistory.push(toolEntry);

      // Assign contextId to ALL tool_results in the round (metadata only, no visible §{id}§ tag)
      const finalContent = resultStr;
      const toolResultContextId =
        contextIdAllocator && lastRoundId !== undefined
          ? lastRoundId
          : undefined;

      // Create tool_result entry
      const preview = extractToolPreview(resolved.metadata);
      appendEntry(createToolResultEntry(
        allocId("tool_result"),
        turnIndex,
        roundIndex,
        {
          toolCallId: tc.id,
          toolName: tc.name,
          content: finalContent,
          toolSummary: summary,
        },
        {
          isError: resolved.content.startsWith("ERROR:"),
          contextId: toolResultContextId,
          toolMetadata: resolved.metadata,
          previewText: preview?.text,
        },
      ));
      if (onSaveCheckpoint) onSaveCheckpoint();
    }

    // After all tool calls executed: if compact was triggered, return early
    if (compactTriggered) {
      return {
        text: resp.text || "",
        toolHistory,
        totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
        intermediateText,
        lastInputTokens: lastInput,
        reasoningContent: lastReasoningContent,
        reasoningState: lastReasoningState,
        lastRoundId: lastRoundId,
        compactNeeded: true,
        compactScenario: "toolcall",
        lastTotalTokens: resp.usage.inputTokens + resp.usage.outputTokens,
        textHandledInLog: streamCallbacksOwnEntries && textHandledViaCallback,
        reasoningHandledInLog: streamCallbacksOwnEntries && reasoningHandledViaCallback,
      };
    }
  }

  console.warn(`[${agentName}] hit max tool rounds (${maxRounds})`);
  return {
    text: "(Agent reached maximum tool call rounds without completing.)",
    toolHistory,
    totalUsage: { inputTokens: totalInput, outputTokens: totalOutput },
    intermediateText,
    lastInputTokens: lastInput,
    reasoningContent: lastReasoningContent,
    reasoningState: lastReasoningState,
    lastRoundId: lastRoundId,
    lastTotalTokens: totalInput + totalOutput,
    textHandledInLog: false,
    reasoningHandledInLog: false,
  };
}
