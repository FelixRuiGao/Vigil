/**
 * TUI-specific type definitions.
 *
 * Defines interfaces for Session, CommandRegistry, and other types
 * that the TUI layer depends on.  These act as the contract boundary
 * between the TUI and the core runtime.
 */

import type { ProgressReporter } from "../progress.js";
import type { SessionStore, LogSessionMeta } from "../persistence.js";
import type {
  PendingAskUi,
  AgentQuestionDecision,
} from "../ask.js";
import type { LogEntry, LogIdAllocator } from "../log-entry.js";
import type {
  CommandRegistry as ActualCommandRegistry,
  CommandContext,
  SlashCommand as ActualSlashCommand,
  CommandOption as ActualCommandOption,
} from "../commands.js";

// ------------------------------------------------------------------
// Re-export command types for convenience
// ------------------------------------------------------------------

export type CommandRegistry = ActualCommandRegistry;
export type SlashCommand = ActualSlashCommand;
export type CommandOption = ActualCommandOption;
export type { CommandContext };

// ------------------------------------------------------------------
// Session interface (contract with core runtime)
// ------------------------------------------------------------------

export interface Session {
  turn(userInput: string, options?: { signal?: AbortSignal }): Promise<string>;
  close(): Promise<void>;
  requestTurnInterrupt?(): { accepted: boolean; reason?: "compact_in_progress" };
  cancelCurrentTurn?(): void;
  primaryAgent: {
    name: string;
    modelConfig?: {
      name?: string;
      provider?: string;
      model?: string;
      contextLength?: number;
    };
  };
  _progress?: ProgressReporter;
  _turnCount: number;
  _compactCount: number;
  _createdAt?: string;
  /** Input tokens from the most recent provider response. */
  lastInputTokens: number;
  /** Total tokens from the most recent provider response. */
  lastTotalTokens: number;
  /** Cache-read tokens from the most recent provider response. */
  lastCacheReadTokens?: number;
  /** Callback for incremental persistence — called at save-worthy checkpoints. */
  onSaveRequest?: () => void;
  setStore(store: SessionStore | null): void;
  getPendingAsk(): PendingAskUi | null;
  resolveAgentQuestionAsk?(askId: string, decision: AgentQuestionDecision): void;
  resumePendingTurn?(options?: { signal?: AbortSignal }): Promise<string>;
  hasPendingTurnToResume?(): boolean;
  runManualSummarize?(instruction?: string, options?: { signal?: AbortSignal }): Promise<string>;
  runManualCompact?(instruction?: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** The config name for the current model (e.g., "my-claude"). */
  currentModelConfigName?: string;
  /** Switch to a different configured model by config name. */
  switchModel?(modelConfigName: string): void;
  /** Access to Config for model enumeration. */
  config?: { modelNames: string[]; getModel(name: string): { provider: string; model: string; contextLength: number; supportsThinking: boolean; supportsMultimodal: boolean } };
  _resetTransientState(): void;
  _initConversation(): void;
  /** Deliver a message to the agent (routes based on agent state). */
  deliverMessage?(source: "user" | "system" | "sub-agent", content: string): void;
  /** Read-only structured log snapshot. */
  log?: readonly LogEntry[];
  /** Subscribe to log changes. Returns unsubscribe function. */
  subscribeLog?(listener: () => void): () => void;
  /** Restore session from loaded log data. */
  restoreFromLog?(meta: LogSessionMeta, entries: LogEntry[], idAllocator: LogIdAllocator): void;
  /** Get log data for persistence (meta + entries). */
  getLogForPersistence?(): { meta: LogSessionMeta; entries: readonly LogEntry[] };
  /** Reset session for /new. */
  resetForNewSession?(newStore?: any): void;
  /** Append a persisted status line to the log. */
  appendStatusMessage?(text: string, statusType?: string): void;
  /** Append a persisted error line to the log. */
  appendErrorMessage?(text: string, errorType?: string): void;
  /** Return all skills (enabled + disabled) for UI display. */
  getAllSkillNames?(): { name: string; description: string; enabled: boolean }[];
  /** Enable or disable a skill by name. */
  setSkillEnabled?(name: string, enabled: boolean): void;
  /** Rescan disk and rebuild skill state. */
  reloadSkills?(): { added: string[]; removed: string[]; total: number };
  /** Read-only access to loaded skills. */
  skills?: ReadonlyMap<string, unknown>;
}

// ------------------------------------------------------------------
// Conversation model
// ------------------------------------------------------------------

export type ConversationEntryKind =
  | "user"
  | "assistant"
  | "interrupted_marker"
  | "progress"
  | "sub_agent_rollup"
  | "sub_agent_done"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "status"
  | "error"
  | "compact_mark";

export interface ConversationEntry {
  kind: ConversationEntryKind;
  text: string;
  /** Timestamp when this entry was created (Unix ms). Used for tool call timing. */
  startedAt?: number;
  /** Elapsed time in ms (set when the matching tool_result is found). */
  elapsedMs?: number;
  id?: string;
  /** Whether this user message is queued for delivery (agent is working). */
  queued?: boolean;
  /** When true, TUI renders this entry in dim/gray style. */
  dim?: boolean;
}

// ------------------------------------------------------------------
// Launch options
// ------------------------------------------------------------------

export interface LaunchOptions {
  session: Session;
  commandRegistry?: CommandRegistry;
  sessionStore?: SessionStore | null;
  config?: { defaultModel?: string };
}
