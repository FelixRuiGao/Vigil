/**
 * Provider abstraction layer — base types and abstract class.
 *
 * Defines the unified interfaces for tool calls, usage tracking,
 * provider responses, and the abstract BaseProvider contract.
 */

// ------------------------------------------------------------------
// Data interfaces
// ------------------------------------------------------------------

/** An image content block for multimodal messages. */
export interface ImageBlock {
  mediaType: string;   // e.g. "image/png", "image/jpeg"
  data: string;        // base64-encoded image data
}

/** A single tool invocation returned by a model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Normalized web search citation. */
export interface Citation {
  url: string;
  title: string;
  citedText?: string;
}

/** Provider-agnostic tool definition. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the function arguments. */
  parameters: Record<string, unknown>;
  /**
   * Format string for one-line summaries of tool invocations.
   * `{agent}` is always available; other placeholders map to argument keys.
   */
  summaryTemplate?: string;
}

// ------------------------------------------------------------------
// Message type for conversation messages
// ------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool" | "tool_result";

export interface Message {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// ------------------------------------------------------------------
// Options for sendMessage
// ------------------------------------------------------------------

export interface SendMessageOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Unified thinking level string ("off", "low", "medium", "high", "adaptive", etc.) */
  thinkingLevel?: string;
  /** Whether to enable provider-specific prompt caching. */
  cacheEnabled?: boolean;
}

// ------------------------------------------------------------------
// Classes with computed properties
// ------------------------------------------------------------------

/** Token usage tracker. */
export class Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;

  constructor(inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0) {
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cacheCreationTokens = cacheCreationTokens;
    this.cacheReadTokens = cacheReadTokens;
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/** Unified response from any provider. */
export class ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
  reasoningContent: string;
  reasoningState: unknown;
  citations: Citation[];
  extra: Record<string, unknown>;

  constructor(opts: {
    text?: string;
    toolCalls?: ToolCall[];
    usage?: Usage;
    raw?: unknown;
    reasoningContent?: string;
    reasoningState?: unknown;
    citations?: Citation[];
    extra?: Record<string, unknown>;
  } = {}) {
    this.text = opts.text ?? "";
    this.toolCalls = opts.toolCalls ?? [];
    this.usage = opts.usage ?? new Usage();
    this.raw = opts.raw ?? null;
    this.reasoningContent = opts.reasoningContent ?? "";
    this.reasoningState = opts.reasoningState ?? null;
    this.citations = opts.citations ?? [];
    this.extra = opts.extra ?? {};
  }

  get hasToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }
}

/** Extended tool execution result with optional metadata. */
export class ToolResult {
  content: string;
  actionHint?: string;
  tags: string[];
  metadata: Record<string, unknown>;

  constructor(opts: {
    content: string;
    actionHint?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) {
    this.content = opts.content;
    this.actionHint = opts.actionHint;
    this.tags = opts.tags ?? [];
    this.metadata = opts.metadata ?? {};
  }

  toString(): string {
    return this.content;
  }
}

// ------------------------------------------------------------------
// Abstract base provider
// ------------------------------------------------------------------

/**
 * Interface that every provider adapter must implement.
 */
export abstract class BaseProvider {
  /**
   * Whether this provider requires strictly alternating user/assistant roles.
   * When true, the rendering pipeline merges consecutive same-role messages.
   */
  readonly requiresAlternatingRoles: boolean = false;

  /**
   * How to calculate the token budget for compact detection.
   * - "subtract_output": budget = contextLength - maxOutputTokens (default)
   * - "full_context": budget = contextLength, check only inputTokens
   */
  readonly budgetCalcMode: "subtract_output" | "full_context" = "subtract_output";

  /**
   * Send a message to the model and return a unified response.
   */
  abstract sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;

  /**
   * Async send with optional streaming callbacks.
   *
   * Delegates to `sendMessage` with the full options object, including
   * streaming callbacks and abort signal.  Each provider's `sendMessage`
   * checks for `onTextChunk`/`onReasoningChunk` and routes to its
   * streaming implementation when present.
   */
  async asyncSendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this.sendMessage(messages, tools, options);
  }
}
