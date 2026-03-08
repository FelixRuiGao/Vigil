/**
 * LongerAgent -- Public barrel re-exports.
 *
 * Provides a single import point for all public APIs:
 *
 *   import { Session, Agent, Config, SessionStore } from "longer-agent";
 *
 * @packageDocumentation
 */

// -- Config ---------------------------------------------------------------
export {
  Config,
  type ModelConfig,
  type MCPServerConfig,
  type ResolvedPaths,
  getContextLength,
  getMultimodalSupport,
  getThinkingSupport,
  getWebSearchSupport,
  resolveConfigPaths,
  LONGERAGENT_HOME_DIR,
} from "./config.js";

// -- Session --------------------------------------------------------------
export { Session } from "./session.js";

// -- Context rendering ----------------------------------------------------
export {
  COMPACT_MARKER_ROLE,
  CONTEXT_ID_KEY,
  isCompactMarker,
  injectContextIdTag,
  mergeConsecutiveSameRole,
  type CompactMarker,
} from "./context-rendering.js";

// -- Agents ---------------------------------------------------------------
export { Agent, type AgentResult, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";

// -- Providers (base types) -----------------------------------------------
export {
  type ImageBlock,
  type ToolDef,
  type ToolCall,
  type Citation,
  ToolResult,
  Usage,
  ProviderResponse,
  BaseProvider,
  type Message,
  type MessageRole,
  type SendMessageOptions,
} from "./providers/base.js";

// -- Primitives -----------------------------------------------------------
export { prompt, context, combine, type MessageBlock } from "./primitives/context.js";

// -- Network retry --------------------------------------------------------
export {
  isRetryableNetworkError,
  computeRetryDelay,
  retrySleep,
  MAX_NETWORK_RETRIES,
} from "./network-retry.js";

// -- Progress -------------------------------------------------------------
export {
  type ProgressLevel,
  type ProgressEvent,
  type ProgressCallback,
  ProgressReporter,
  ConsoleProgress,
} from "./progress.js";

// -- Persistence ----------------------------------------------------------
export {
  SessionStore,
} from "./persistence.js";

// -- Commands -------------------------------------------------------------
export {
  CommandRegistry,
  type SlashCommand,
  type CommandContext,
  type ShowMessageFn,
  buildDefaultRegistry,
  registerSkillCommands,
} from "./commands.js";

// -- Skills ---------------------------------------------------------------
export {
  loadSkills,
  resolveSkillContent,
  type SkillMeta,
} from "./skills/loader.js";

// -- Templates ------------------------------------------------------------
export {
  loadTemplate,
  loadTemplates,
} from "./templates/loader.js";

// -- Tools ----------------------------------------------------------------
export { BASIC_TOOLS, BASIC_TOOLS_MAP, executeTool } from "./tools/basic.js";
export {
  SPAWN_AGENT_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  WAIT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
} from "./tools/comm.js";

// -- Ask protocol ---------------------------------------------------------
export {
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
} from "./ask.js";

// -- File attach ----------------------------------------------------------
export {
  processFileAttachments,
  scanCandidates,
  type FileAttachResult,
  type FileInfo,
} from "./file-attach.js";

// -- TUI ------------------------------------------------------------------
export { launchTui } from "./tui/launch.js";
export type {
  ConversationEntry,
  ConversationEntryKind,
  LaunchOptions,
} from "./tui/types.js";

// -- Version --------------------------------------------------------------
export const VERSION = "0.1.0";
