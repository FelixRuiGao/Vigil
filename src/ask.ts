export type AskKind = "agent_question";

export interface AskSource {
  agentId: string;
  agentName?: string;
  toolName?: string;
  turnId?: string;
}

export interface AskBase {
  id: string;
  kind: AskKind;
  createdAt: string;
  source: AskSource;
  summary: string;
  roundIndex?: number;
}

export type AgentQuestionOptionKind = "normal" | "custom_input" | "discuss_further";

export interface AgentQuestionOption {
  label: string;
  description?: string;
  kind: AgentQuestionOptionKind;
  systemAdded?: boolean;
}

export const ASK_CUSTOM_OPTION_LABEL = "Enter custom answer";
export const ASK_DISCUSS_OPTION_LABEL = "Discuss further";
export const ASK_DISCUSS_FURTHER_GUIDANCE =
  'One or more answers are "Discuss further". Treat those answers as requests to continue the discussion rather than final commitments. Use any other answers normally. Briefly address the discussion points, then wait for the user\'s next message.';

export interface AgentQuestionItem {
  question: string;
  options: AgentQuestionOption[];
}

export interface AgentQuestionAnswer {
  questionIndex: number;
  selectedOptionIndex: number;
  answerText: string;
  /** Optional user note attached to any answer (added via Tab). */
  note?: string;
}

export interface AgentQuestionDecision {
  answers: AgentQuestionAnswer[];
}

export interface AgentQuestion extends AskBase {
  kind: "agent_question";
  payload: { questions: AgentQuestionItem[]; toolCallId: string };
  options: string[];
}

export type AskRequest = AgentQuestion;

export interface PendingAskUi {
  id: string;
  kind: AskKind;
  createdAt: string;
  summary: string;
  source: AskSource;
  payload: Record<string, unknown>;
  options: string[];
}

export interface AskAuditRecord {
  askId: string;
  kind: AskKind;
  summary: string;
  decidedAt: string;
  decision: string;
  source: AskSource;
}

export interface PendingTurnState {
  stage: "pre_user_input" | "activation";
  userInput?: string;
  nextActivationIdx?: number;
  convLenBefore?: number;
  pendingToolResultText?: string;
  pendingToolCallId?: string;
}

export class AskPendingError extends Error {
  askId: string;
  ask?: AskRequest;

  constructor(askOrId: string | AskRequest) {
    const askId = typeof askOrId === "string" ? askOrId : askOrId.id;
    super(`Ask request pending resolution (${askId})`);
    this.name = "AskPendingError";
    this.askId = askId;
    if (typeof askOrId !== "string") {
      this.ask = askOrId;
    }
  }
}

export function isAskPendingError(err: unknown): err is AskPendingError {
  return err instanceof AskPendingError ||
    ((err as any)?.name === "AskPendingError" && typeof (err as any)?.askId === "string");
}

export function toPendingAskUi(ask: AskRequest | null): PendingAskUi | null {
  if (!ask) return null;
  return {
    id: ask.id,
    kind: ask.kind,
    createdAt: ask.createdAt,
    summary: ask.summary,
    source: ask.source,
    payload: ask.payload as Record<string, unknown>,
    options: [...ask.options],
  };
}
