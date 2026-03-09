/**
 * Root TUI application component.
 *
 * Manages conversation state, session turn execution with streaming,
 * Ctrl+C handling, and delegates rendering to child components.
 *
 * Layout: pure vertical — LogoPanel → ConversationPanel → InputPanel → StatusBar.
 * Activity state (thinking / tool calling / waiting) is shown in the
 * StatusBar alongside model name and context token count.
 *
 * Within a single turn, reasoning and text segments are tracked
 * independently so they interleave in chronological order (not pinned
 * to the top). Sub-agent tool activity is folded into compact rollup
 * blocks in the conversation flow.
 *
 * Key bindings:
 *   Enter         Send message
 *   Ctrl+N        Insert newline
 *   Ctrl+G        Toggle markdown rendered/raw mode
 *   Ctrl+C        Cancel current turn (first press) / exit (second press)
 *   Ctrl+L        Clear progress lines
 *   Ctrl+Y        Copy last assistant reply to clipboard
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { execSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { LogoPanel } from "./components/logo-panel.js";
import { StatusBar, type ActivityPhase } from "./components/status-bar.js";
import { ConversationPanel } from "./components/conversation-panel.js";
import { AskPanel } from "./components/ask-panel.js";
import { PlanPanel, type PlanCheckpointUi } from "./components/plan-panel.js";
import { InputPanel, type InputPanelHandle } from "./components/input-panel.js";
import { InputProtocolParser } from "./input/protocol.js";
import { mapInputEventToCommand } from "./input/keymap.js";
import type { EditorState } from "./input/editor-state.js";
import {
  withValueAndCursor,
  insertText,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  moveHome,
  moveEnd,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  deleteToLineStart,
  deleteToLineEnd,
} from "./input/editor-state.js";
import type {
  CommandRegistry,
  CommandContext,
  ConversationEntry,
  Session,
} from "./types.js";
import type { ProgressEvent, ProgressCallback } from "../progress.js";
import { saveLog } from "../persistence.js";
import type { SessionStore } from "../persistence.js";
import { isCommandExitSignal } from "../commands.js";
import { formatDisplayModelName } from "../config.js";
import { projectToTuiEntries } from "../log-projection.js";
import type {
  PendingAskUi,
  AgentQuestionAnswer,
  AgentQuestionDecision,
  AgentQuestionItem,
} from "../ask.js";

// ------------------------------------------------------------------
// Goodbye messages
// ------------------------------------------------------------------

const GOODBYE_MESSAGES = [
  "Bye!", "Goodbye!", "See you later!", "Until next time!",
  "Take care!", "Happy coding!", "Catch you later!",
  "Peace out!", "So long!", "Off I go!", "Later, gator!",
];

const CUSTOM_EMPTY_HINT =
  'Custom answer is empty. Please enter an answer first, or choose "Discuss further" instead.';

// ------------------------------------------------------------------
// Clipboard helper
// ------------------------------------------------------------------

function copyToClipboard(text: string): boolean {
  try {
    execSync("pbcopy", { input: text, timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Inline editor helper (reuses pure functions from editor-state.ts)
// ------------------------------------------------------------------

function applyInlineEdit(
  value: string,
  cursor: number,
  event: { type: string; key?: string; text?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; super?: boolean },
): EditorState | null {
  if (event.type === "insert" && typeof event.text === "string") {
    return insertText(withValueAndCursor(value, cursor, null), event.text);
  }
  if (event.type !== "key") return null;

  const cmd = mapInputEventToCommand(event as any);
  if (!cmd) return null;

  const state = withValueAndCursor(value, cursor, null);
  switch (cmd) {
    case "move_left": return moveLeft(state);
    case "move_right": return moveRight(state);
    case "move_word_left": return moveWordLeft(state);
    case "move_word_right": return moveWordRight(state);
    case "move_home": return moveHome(state);
    case "move_end": return moveEnd(state);
    case "delete_backward": return deleteBackward(state);
    case "delete_forward": return deleteForward(state);
    case "delete_word_backward": return deleteWordBackward(state);
    case "delete_word_forward": return deleteWordForward(state);
    case "delete_to_line_start": return deleteToLineStart(state);
    case "delete_to_line_end": return deleteToLineEnd(state);
    default: return null;
  }
}

// ------------------------------------------------------------------
// App component
// ------------------------------------------------------------------

export interface AppProps {
  session: Session;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  onProgressCallback: (cb: ProgressCallback) => void;
}

export function App({
  session,
  commandRegistry,
  store,
  onProgressCallback,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const [entries, setEntries] = useState<ConversationEntry[]>(
    projectToTuiEntries([...(session.log ?? [])] as any[]),
  );
  const [processing, setProcessing] = useState(false);
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "raw">("rendered");
  const [hideProgress, setHideProgress] = useState(false);

  // ---- Status bar state ----
  const [activityPhase, setActivityPhase] = useState<ActivityPhase>("idle");
  const [activityToolName, setActivityToolName] = useState<string | undefined>();
  const [statusError, setStatusError] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<PendingAskUi | null>(
    typeof session.getPendingAsk === "function" ? session.getPendingAsk() : null,
  );
  const [askError, setAskError] = useState<string | null>(null);
  const [askSelectionIndex, setAskSelectionIndex] = useState(0);
  // Agent question state
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<Map<number, { optionIndex: number; customText?: string }>>(new Map());
  const [customInputMode, setCustomInputMode] = useState(false);
  const [noteInputMode, setNoteInputMode] = useState(false);
  // Shared inline editor for custom input and note input (mutually exclusive)
  const [inlineEditor, setInlineEditor] = useState({ value: "", cursor: 0 });
  // Per-option note drafts, keyed by "questionIndex-optionIndex"
  const [optionNotes, setOptionNotes] = useState<Map<string, string>>(new Map());
  // Review mode: show summary of all answers before submitting (multi-question only)
  const [reviewMode, setReviewMode] = useState(false);
  // Plan panel state
  const [planCheckpoints, setPlanCheckpoints] = useState<PlanCheckpointUi[] | null>(null);

  const cancelledRef = useRef(false);
  const lastCtrlCRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const inputPanelRef = useRef<InputPanelHandle>(null);
  const shortcutParserRef = useRef(new InputProtocolParser());
  const shortcutDecoderRef = useRef(new StringDecoder("utf8"));
  const inputHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdownModeInitializedRef = useRef(false);
  const runTurnRef = useRef<((input: string) => void) | null>(null);
  const runManualSummarizeRef = useRef<((instruction: string) => void) | null>(null);
  const runManualCompactRef = useRef<((instruction: string) => void) | null>(null);

  // Raw mode
  useEffect(() => {
    if (!isRawModeSupported) return;
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [isRawModeSupported, setRawMode]);


  useEffect(() => {
    const syncFromLog = () => {
      const projected = projectToTuiEntries([...(session.log ?? [])] as any[]);
      setEntries(
        hideProgress
          ? projected.filter(
            (e) =>
              e.kind !== "progress" &&
              e.kind !== "sub_agent_rollup" &&
              e.kind !== "sub_agent_done",
          )
          : projected,
      );
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
    };

    syncFromLog();
    if (typeof session.subscribeLog !== "function") return;

    // Throttle log listener to limit TUI refresh rate (min 200ms between renders)
    let lastCallTime = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const throttledSync = () => {
      const now = Date.now();
      const elapsed = now - lastCallTime;
      if (elapsed >= 200) {
        lastCallTime = now;
        syncFromLog();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          lastCallTime = Date.now();
          syncFromLog();
        }, 200 - elapsed);
      }
    };

    const unsub = session.subscribeLog(throttledSync);
    return () => {
      unsub();
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, [session, hideProgress]);

  // ------------------------------------------------------------------
  // Input hint management
  // ------------------------------------------------------------------

  const clearInputHint = useCallback(() => {
    if (inputHintTimerRef.current) {
      clearTimeout(inputHintTimerRef.current);
      inputHintTimerRef.current = null;
    }
    setInputHint(null);
  }, []);

  const showInputHint = useCallback((message: string, durationMs = 2000) => {
    if (inputHintTimerRef.current) {
      clearTimeout(inputHintTimerRef.current);
      inputHintTimerRef.current = null;
    }
    setInputHint(message);
    inputHintTimerRef.current = setTimeout(() => {
      inputHintTimerRef.current = null;
      setInputHint(null);
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (inputHintTimerRef.current) {
        clearTimeout(inputHintTimerRef.current);
        inputHintTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!markdownModeInitializedRef.current) {
      markdownModeInitializedRef.current = true;
      return;
    }
    showInputHint(markdownMode === "raw" ? "Markdown raw: ON" : "Markdown raw: OFF");
  }, [markdownMode, showInputHint]);

  useEffect(() => {
    setAskSelectionIndex(0);
    setCurrentQuestionIndex(0);
    setQuestionAnswers(new Map());
    setCustomInputMode(false);
    setNoteInputMode(false);
    setInlineEditor({ value: "", cursor: 0 });
    setOptionNotes(new Map());
    setReviewMode(false);
  }, [pendingAsk?.id]);

  // ------------------------------------------------------------------
  // Auto-save
  // ------------------------------------------------------------------

  const autoSave = useCallback(() => {
    if (!store) return;
    try {
      if (typeof session.getLogForPersistence === "function" && store.sessionDir) {
        const { meta, entries } = session.getLogForPersistence();
        if (meta.turnCount === 0) return; // Don't save empty sessions
        saveLog(store.sessionDir, meta, entries as any[]);
      }
    } catch {
      // Auto-save failed silently
    }
  }, [session, store]);

  const runPendingTurn = useCallback(
    async () => {
      if (typeof session.resumePendingTurn !== "function") {
        setAskError("Current session does not support resuming pending asks.");
        return;
      }
      cancelledRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      setProcessing(true);
      setActivityPhase("working");
      setActivityToolName(undefined);
      setStatusError(false);

      try {
        await session.resumePendingTurn({ signal: controller.signal });
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        setActivityPhase("idle");
        setActivityToolName(undefined);
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(session.getPendingAsk?.() ?? null);
        autoSave();
      } catch (err) {
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(msg, "resume_pending_turn");
        setStatusError(true);
      } finally {
        abortControllerRef.current = null;
        inputPanelRef.current?.resetTurnPasteCounter();
        if (!cancelledRef.current) {
          setProcessing(false);
        }
      }
    },
    [session, autoSave],
  );

  // Wire incremental save callback into Session
  useEffect(() => {
    session.onSaveRequest = autoSave;
    return () => { session.onSaveRequest = undefined; };
  }, [session, autoSave]);

  const performExit = useCallback(async () => {
    clearInputHint();
    autoSave();
    try {
      await session.close();
    } catch {
      // ignore close failures during shutdown
    }
    const msg = GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)];
    if (isRawModeSupported) {
      setRawMode(false);
    }
    try {
      process.stdout.write(`\n${msg}\n`);
    } catch {
      console.log(msg);
    }
    exit();
  }, [clearInputHint, autoSave, session, isRawModeSupported, setRawMode, exit]);

  // ------------------------------------------------------------------
  // Command context builder
  // ------------------------------------------------------------------

  const buildCommandContext = useCallback((): CommandContext => {
    return {
      session,
      store: store ?? undefined,
      commandRegistry,
      showMessage: (msg: string) => {
        if (typeof session.appendStatusMessage === "function") {
          session.appendStatusMessage(msg);
        } else {
          showInputHint(msg, 2500);
        }
      },
      autoSave,
      resetUiState: () => {
        cancelledRef.current = false;
        setProcessing(false);
        // Reset token count on /new
        setContextTokens(0);
        setCacheReadTokens(0);
        setActivityPhase("idle");
        setActivityToolName(undefined);
        setStatusError(false);
        setPendingAsk(null);
        setAskError(null);
        setHideProgress(false);
      },
      exit: performExit,
      onTurnRequested: (content: string) => {
        runTurnRef.current?.(content);
      },
      onManualSummarizeRequested: (instruction: string) => {
        runManualSummarizeRef.current?.(instruction);
      },
      onManualCompactRequested: (instruction: string) => {
        runManualCompactRef.current?.(instruction);
      },
    };
  }, [session, store, commandRegistry, autoSave, performExit, showInputHint]);

  // ------------------------------------------------------------------
  // Progress callback (streaming)
  // ------------------------------------------------------------------

  const handleProgress = useCallback(
    (event: ProgressEvent) => {
      if (cancelledRef.current) return;

      const hasSubAgentId = event.extra?.["sub_agent_id"] !== undefined;

      // ---- Status bar activity updates (primary agent only) ----
      if (!hasSubAgentId) {
        switch (event.action) {
          case "reasoning_chunk":
            setActivityPhase("thinking");
            setActivityToolName(undefined);
            break;
          case "text_chunk":
            setActivityPhase("generating");
            setActivityToolName(undefined);
            break;
          case "tool_call":
            setActivityPhase("tool_calling");
            setActivityToolName(event.extra?.["tool"] as string ?? undefined);
            break;
          case "agent_no_reply":
            setActivityPhase("waiting");
            setActivityToolName(undefined);
            break;
          case "agent_end":
            setContextTokens(session.lastInputTokens);
            setCacheReadTokens(session.lastCacheReadTokens ?? 0);
            break;
          case "token_update":
            // Real-time token count update after each provider call
            setContextTokens(event.extra?.["input_tokens"] as number ?? session.lastInputTokens);
            setCacheReadTokens(event.extra?.["cache_read_tokens"] as number ?? 0);
            break;
        }
      }

      // ---- Conversation entry routing ----
      if (event.action === "ask_requested") {
        const ask = (event.extra?.["ask"] as PendingAskUi | undefined) ?? session.getPendingAsk?.() ?? null;
        setPendingAsk(ask);
        setAskError(null);
        setActivityPhase("waiting");
        setActivityToolName(undefined);
        return;
      }
      if (event.action === "ask_resolved") {
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        return;
      }

      // ---- Plan panel events ----
      if (event.action === "plan_submit" || event.action === "plan_update") {
        const cps = event.extra?.["checkpoints"] as PlanCheckpointUi[] | undefined;
        if (cps) setPlanCheckpoints(cps);
        return;
      }
      if (event.action === "plan_finish") {
        setPlanCheckpoints(null);
        return;
      }
    },
    [session],
  );

  // Register progress callback on mount
  useEffect(() => {
    onProgressCallback(handleProgress);
  }, [handleProgress, onProgressCallback]);

  // ------------------------------------------------------------------
  // Turn execution
  // ------------------------------------------------------------------

  const runTurn = useCallback(
    async (userInput: string) => {
      cancelledRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setProcessing(true);
      setActivityPhase("working");
      setActivityToolName(undefined);
      setStatusError(false);

      try {
        await session.turn(userInput, { signal: controller.signal });

        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }

        setActivityPhase("idle");
        setActivityToolName(undefined);
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(session.getPendingAsk?.() ?? null);
        autoSave();
      } catch (err) {
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(msg, "turn");
        setStatusError(true);
        setPendingAsk(session.getPendingAsk?.() ?? null);
      } finally {
        abortControllerRef.current = null;
        inputPanelRef.current?.resetTurnPasteCounter();
        if (!cancelledRef.current) {
          setProcessing(false);
        }
      }
    },
    [session, autoSave],
  );
  runTurnRef.current = runTurn;

  const runManualSummarize = useCallback(
    async (instruction: string) => {
      if (typeof session.runManualSummarize !== "function") {
        session.appendErrorMessage?.("Current session does not support /summarize.", "command");
        return;
      }
      cancelledRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      setProcessing(true);
      setActivityPhase("working");
      setActivityToolName(undefined);
      setStatusError(false);

      try {
        await session.runManualSummarize(instruction, { signal: controller.signal });
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        setActivityPhase("idle");
        setActivityToolName(undefined);
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(session.getPendingAsk?.() ?? null);
        autoSave();
      } catch (err) {
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(msg, "manual_summarize");
        setStatusError(true);
      } finally {
        abortControllerRef.current = null;
        inputPanelRef.current?.resetTurnPasteCounter();
        if (!cancelledRef.current) {
          setProcessing(false);
        }
      }
    },
    [session, autoSave],
  );
  runManualSummarizeRef.current = runManualSummarize;

  const runManualCompact = useCallback(
    async (instruction: string) => {
      if (typeof session.runManualCompact !== "function") {
        session.appendErrorMessage?.("Current session does not support /compact.", "command");
        return;
      }
      cancelledRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      setProcessing(true);
      setActivityPhase("working");
      setActivityToolName(undefined);
      setStatusError(false);

      try {
        await session.runManualCompact(instruction, { signal: controller.signal });
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        setActivityPhase("idle");
        setActivityToolName(undefined);
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(session.getPendingAsk?.() ?? null);
        autoSave();
      } catch (err) {
        if (cancelledRef.current || controller.signal.aborted) {
          autoSave();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(msg, "manual_compact");
        setStatusError(true);
      } finally {
        abortControllerRef.current = null;
        inputPanelRef.current?.resetTurnPasteCounter();
        if (!cancelledRef.current) {
          setProcessing(false);
        }
      }
    },
    [session, autoSave],
  );
  runManualCompactRef.current = runManualCompact;

  const resolveAgentQuestion = useCallback((
    answersOverride?: Map<number, { optionIndex: number; customText?: string }>,
    notesOverride?: Map<string, string>,
  ) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const effectiveAnswers = answersOverride ?? questionAnswers;
    const effectiveNotes = notesOverride ?? optionNotes;

    for (let i = 0; i < questions.length; i++) {
      if (!effectiveAnswers.has(i)) {
        setReviewMode(false);
        setCurrentQuestionIndex(i);
        setAskSelectionIndex(0);
        setAskError("Please answer all questions before continuing.");
        return;
      }
    }

    const answers: AgentQuestionAnswer[] = [];

    for (let i = 0; i < questions.length; i++) {
      const qa = effectiveAnswers.get(i)!;
      const agentOptions = questions[i].options;
      const selectedOption = agentOptions[qa.optionIndex];
      if (!selectedOption) {
        setReviewMode(false);
        setCurrentQuestionIndex(i);
        setAskSelectionIndex(0);
        setAskError("Selected answer is out of range.");
        return;
      }
      // Look up note for this question's selected option
      const note = effectiveNotes.get(`${i}-${qa.optionIndex}`) || undefined;
      answers.push({
        questionIndex: i,
        selectedOptionIndex: qa.optionIndex,
        answerText: selectedOption.kind === "custom_input"
          ? (qa.customText ?? "")
          : selectedOption.label,
        note,
      });
    }

    const decision: AgentQuestionDecision = { answers };

    try {
      if (typeof session.resolveAgentQuestionAsk === "function") {
        session.resolveAgentQuestionAsk(pendingAsk.id, decision);
      }
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setAskError(null);
      autoSave();
      if (session.hasPendingTurnToResume?.()) {
        void runPendingTurn();
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }, [pendingAsk, questionAnswers, optionNotes, session, autoSave, runPendingTurn]);

  // Helper: confirm current question's highlighted option into questionAnswers.
  // Returns the updated map (avoids stale-closure from async setState).
  const confirmCurrentQuestion = useCallback((
    sel: number,
    extra?: { customText?: string },
  ) => {
    const next = new Map(questionAnswers);
    next.set(currentQuestionIndex, { optionIndex: sel, ...extra });
    setQuestionAnswers(next);
    return next;
  }, [questionAnswers, currentQuestionIndex]);

  // Helper: submit or enter review mode
  const submitOrReview = useCallback((
    updated: Map<number, { optionIndex: number; customText?: string }>,
  ) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const firstMissing = questions.findIndex((_, idx) => !updated.has(idx));
    if (firstMissing !== -1) {
      setReviewMode(false);
      setCurrentQuestionIndex(firstMissing);
      setAskSelectionIndex(0);
      setAskError("Please answer all questions before reviewing.");
      return;
    }
    if (questions.length > 1) {
      // Multi-question: enter review mode
      setAskError(null);
      setReviewMode(true);
    } else {
      // Single question: submit directly
      resolveAgentQuestion(updated, optionNotes);
    }
  }, [pendingAsk, optionNotes, resolveAgentQuestion]);

  const resolveSelectedPendingAsk = useCallback(() => {
    if (!pendingAsk) return;

    // Handle agent_question: confirm current question option
    if (pendingAsk.kind === "agent_question") {
      const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
      const q = questions[currentQuestionIndex];
      if (!q) return;

      const selectedOption = q.options[askSelectionIndex];
      if (!selectedOption) return;

      if (selectedOption.kind === "custom_input") {
        if (customInputMode) {
          const customText = inlineEditor.value.trim();
          if (!customText) {
            showInputHint(CUSTOM_EMPTY_HINT, 5000);
            return;
          }
          // Confirm custom input
          const updated = confirmCurrentQuestion(askSelectionIndex, { customText });
          setCustomInputMode(false);
          setInlineEditor({ value: "", cursor: 0 });
          if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex((prev) => prev + 1);
            setAskSelectionIndex(0);
          } else {
            submitOrReview(updated);
          }
        } else {
          const existing = questionAnswers.get(currentQuestionIndex);
          setCustomInputMode(true);
          setInlineEditor({
            value: existing?.optionIndex === askSelectionIndex ? (existing.customText ?? "") : "",
            cursor: existing?.optionIndex === askSelectionIndex ? (existing.customText ?? "").length : 0,
          });
        }
        return;
      }

      // Normal option selected (including "Discuss further")
      const updated = confirmCurrentQuestion(askSelectionIndex);

      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex((prev) => prev + 1);
        setAskSelectionIndex(0);
      } else {
        submitOrReview(updated);
      }
      return;
    }
    setAskError(`Unsupported ask kind: ${pendingAsk.kind}`);
  }, [pendingAsk, askSelectionIndex, currentQuestionIndex, customInputMode, inlineEditor, confirmCurrentQuestion, optionNotes, resolveAgentQuestion, submitOrReview]);

  // ------------------------------------------------------------------
  // Input handling
  // ------------------------------------------------------------------

  const handleSubmit = useCallback(
    (input: string): boolean => {
      clearInputHint();

      if (pendingAsk) {
        if (pendingAsk.kind === "agent_question") {
          showInputHint("Use ↑/↓ to select options, ←/→ to navigate questions, Enter to confirm.", 2500);
          return false;
        }
        showInputHint(`Unsupported ask kind: ${pendingAsk.kind}`, 2500);
        return true;
      }

      if (processing) {
        if (!input.trim()) return false;
        // Enqueue message for delivery via check_status
        if (typeof session.deliverMessage === "function") {
          session.deliverMessage("user", input);
          session.appendStatusMessage?.(`[Queued user message]\n${input}`, "queued_user_message");
          showInputHint("Message queued for delivery.");
          return true;
        }
        showInputHint("Assistant is replying. Enter is temporarily disabled.");
        return false;
      }

      // Slash command handling
      if (input.startsWith("/")) {
        const parts = input.split(/\s+/, 2);
        const cmdName = parts[0];
        const cmdArgs = input.slice(cmdName.length).trim();
        const cmd = commandRegistry.lookup(cmdName);
        if (cmd) {
          const ctx = buildCommandContext();
          cmd.handler(ctx, cmdArgs).then(() => {
            setPendingAsk(session.getPendingAsk?.() ?? null);
            setAskError(null);
          }).catch((err) => {
            if (isCommandExitSignal(err)) {
              void performExit();
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            session.appendErrorMessage?.(`Command failed (${cmdName}): ${message}`, "command");
          });
        } else {
          session.appendErrorMessage?.(
            `Unknown command: ${cmdName}. Type /help for available commands.`,
            "command",
          );
        }
        return true;
      }

      runTurn(input);
      return true;
    },
    [
      processing,
      pendingAsk,
      commandRegistry,
      runTurn,
      runPendingTurn,
      buildCommandContext,
      clearInputHint,
      showInputHint,
      performExit,
      session,
    ],
  );

  // ------------------------------------------------------------------
  // Ctrl+C / Ctrl+L / Ctrl+Y handling
  // ------------------------------------------------------------------

  const handleCtrlC = useCallback(() => {
    if (inputPanelRef.current?.dismissOverlay()) {
      clearInputHint();
      return;
    }

    const now = Date.now();

    if (now - lastCtrlCRef.current < 2000) {
      if (processing) {
        const decision = session.requestTurnInterrupt
          ? session.requestTurnInterrupt()
          : (session.cancelCurrentTurn?.(), { accepted: true as const });
        if (decision.accepted) {
          cancelledRef.current = true;
          abortControllerRef.current?.abort();
        }
      }
      void performExit();
      return;
    }

    lastCtrlCRef.current = now;

    if (!processing && inputPanelRef.current?.getValue()?.trim()) {
      clearInputHint();
      inputPanelRef.current.clear();
      return;
    }

    if (processing) {
      const decision = session.requestTurnInterrupt
        ? session.requestTurnInterrupt()
        : (session.cancelCurrentTurn?.(), { accepted: true as const });
      if (!decision.accepted) {
        if (decision.reason === "compact_in_progress") {
          showInputHint("Interrupt is disabled during compact phase");
        }
        return;
      }

      cancelledRef.current = true;
      abortControllerRef.current?.abort();
      setProcessing(false);
      setActivityPhase("idle");
      setActivityToolName(undefined);
      clearInputHint();
    } else {
      showInputHint("Press Ctrl+C again to exit");
    }
  }, [
    processing,
    clearInputHint,
    showInputHint,
    performExit,
  ]);

  const handleCtrlL = useCallback(() => {
    setHideProgress((prev) => {
      const next = !prev;
      showInputHint(next ? "Progress lines hidden" : "Progress lines shown");
      return next;
    });
  }, [showInputHint]);

  const handleCtrlY = useCallback(() => {
    const lastReply = [...entries]
      .reverse()
      .find((e) => e.kind === "assistant");
    if (lastReply) {
      if (copyToClipboard(lastReply.text)) {
        showInputHint("Copied last reply!");
      } else {
        showInputHint("Copy failed");
      }
    } else {
      showInputHint("No reply to copy");
    }
  }, [entries, showInputHint]);

  const handleCtrlG = useCallback(() => {
    setMarkdownMode((prev) => (prev === "rendered" ? "raw" : "rendered"));
  }, []);

  useEffect(() => {
    if (!stdin) return;

    const onData = (data: string | Buffer) => {
      const chunk = typeof data === "string" ? data : shortcutDecoderRef.current.write(data);
      const events = shortcutParserRef.current.push(chunk);
      for (const event of events) {
        // --- Review mode for multi-question ask ---
        if (pendingAsk?.kind === "agent_question" && reviewMode) {
          if (event.type !== "key") continue;
          if (event.key === "enter") {
            // Confirm and submit
            resolveAgentQuestion(questionAnswers, optionNotes);
            continue;
          }
          if (event.key === "escape") {
            // Go back to last question
            setReviewMode(false);
            continue;
          }
          // Number keys 1-9: jump to that question for editing
          const numMatch = /^[1-9]$/.exec(event.key);
          if (numMatch) {
            const qNum = parseInt(numMatch[0], 10) - 1;
            const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
            if (qNum < questions.length) {
              setReviewMode(false);
              setCurrentQuestionIndex(qNum);
              const existing = questionAnswers.get(qNum);
              setAskSelectionIndex(existing?.optionIndex ?? 0);
            }
          }
          continue;
        }
        // --- Inline editor input (custom input / note input) ---
        if (pendingAsk?.kind === "agent_question" && (customInputMode || noteInputMode)) {
          // Enter = confirm, Escape = cancel — handle before editor
          if (event.type === "key" && event.key === "enter") {
            if (noteInputMode) {
              // Save note + auto-confirm the highlighted option (Bug 1 fix)
              const noteText = inlineEditor.value.trim();
              const noteKey = `${currentQuestionIndex}-${askSelectionIndex}`;
              setOptionNotes((prev) => {
                const next = new Map(prev);
                if (noteText) { next.set(noteKey, noteText); } else { next.delete(noteKey); }
                return next;
              });
              // Also confirm the option that the note was added to
              confirmCurrentQuestion(askSelectionIndex);
              setNoteInputMode(false);
              setInlineEditor({ value: "", cursor: 0 });
            } else {
              // customInputMode — confirm via resolveSelectedPendingAsk
              resolveSelectedPendingAsk();
            }
            continue;
          }
          if (event.type === "key" && event.key === "escape") {
            if (noteInputMode) { setNoteInputMode(false); }
            if (customInputMode) { setCustomInputMode(false); }
            setInlineEditor({ value: "", cursor: 0 });
            continue;
          }
          // Delegate to inline editor (movement, deletion, insertion)
          const result = applyInlineEdit(inlineEditor.value, inlineEditor.cursor, event);
          if (result) setInlineEditor({ value: result.value, cursor: result.cursor });
          continue;
        }
        if (event.type !== "key") continue;
        if (pendingAsk) {
          if (pendingAsk.kind === "agent_question") {
            const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
            const q = questions[currentQuestionIndex];
            const totalOpts = q?.options?.length ?? 0;
            const agentOptionCount = q?.options?.filter((opt) => !opt.systemAdded).length ?? 0;

            // --- Tab to add/edit note (only on agent options) ---
            if (event.key === "tab" && askSelectionIndex < agentOptionCount) {
              const noteKey = `${currentQuestionIndex}-${askSelectionIndex}`;
              const existing = optionNotes.get(noteKey) ?? "";
              setInlineEditor({ value: existing, cursor: existing.length });
              setNoteInputMode(true);
              continue;
            }

            if (event.key === "up" && totalOpts > 0) {
              setAskSelectionIndex((prev) => (prev - 1 + totalOpts) % totalOpts);
              continue;
            }
            if (event.key === "down" && totalOpts > 0) {
              setAskSelectionIndex((prev) => (prev + 1) % totalOpts);
              continue;
            }
            if (event.key === "left" && questions.length > 1) {
              setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
              setAskSelectionIndex(0);
              setCustomInputMode(false);
              setNoteInputMode(false);
              continue;
            }
            if (event.key === "right" && questions.length > 1) {
              // Auto-confirm any non-custom option before advancing.
              if (q?.options?.[askSelectionIndex]?.kind !== "custom_input") {
                confirmCurrentQuestion(askSelectionIndex);
              }
              setCurrentQuestionIndex((prev) => Math.min(questions.length - 1, prev + 1));
              setAskSelectionIndex(0);
              setCustomInputMode(false);
              setNoteInputMode(false);
              continue;
            }
            if (event.key === "enter") {
              resolveSelectedPendingAsk();
              continue;
            }
            continue;
          }

          const optionsLen = pendingAsk.options?.length ?? 0;
          if (event.key === "up" && optionsLen > 0) {
            setAskSelectionIndex((prev) => (prev - 1 + optionsLen) % optionsLen);
            continue;
          }
          if (event.key === "down" && optionsLen > 0) {
            setAskSelectionIndex((prev) => (prev + 1) % optionsLen);
            continue;
          }
          if (event.key === "enter") {
            resolveSelectedPendingAsk();
            continue;
          }
        }
        if (event.key === "ctrl_c") {
          handleCtrlC();
          continue;
        }
        if (event.key === "ctrl_l") {
          handleCtrlL();
          continue;
        }
        if (event.key === "ctrl_y") {
          handleCtrlY();
          continue;
        }
        if (event.key === "ctrl_g") {
          handleCtrlG();
          continue;
        }
      }
    };

    stdin.on("data", onData);
    return () => {
      const tail = shortcutDecoderRef.current.end();
      if (tail.length > 0) {
        const events = shortcutParserRef.current.push(tail);
        for (const event of events) {
          if (event.type !== "key") continue;
          if (event.key === "ctrl_c") handleCtrlC();
          if (event.key === "ctrl_l") handleCtrlL();
          if (event.key === "ctrl_y") handleCtrlY();
          if (event.key === "ctrl_g") handleCtrlG();
        }
      }
      stdin.off("data", onData);
    };
  }, [
    stdin,
    pendingAsk,
    resolveSelectedPendingAsk,
    resolveAgentQuestion,
    confirmCurrentQuestion,
    handleCtrlC,
    handleCtrlL,
    handleCtrlY,
    handleCtrlG,
    currentQuestionIndex,
    customInputMode,
    noteInputMode,
    reviewMode,
    inlineEditor,
    askSelectionIndex,
    questionAnswers,
    optionNotes,
  ]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <Box flexDirection="column" height="100%">
      {/* Two one-line buffers absorb terminal resize artifacts before they reach the logo. */}
      <Box flexShrink={0}>
        <Text>{" "}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Text>{" "}</Text>
        <LogoPanel cwd={process.cwd()} />
      </Box>
      <ConversationPanel
        entries={entries}
        markdownMode={markdownMode}
        streamingAssistantEntryId={null}
      />
      {planCheckpoints ? <PlanPanel checkpoints={planCheckpoints} /> : null}
      {pendingAsk ? (
        <AskPanel
          ask={pendingAsk}
          error={askError}
          selectedIndex={askSelectionIndex}
          currentQuestionIndex={currentQuestionIndex}
          totalQuestions={
            pendingAsk.kind === "agent_question"
              ? ((pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? []).length
              : 1
          }
          questionAnswers={questionAnswers}
          customInputMode={customInputMode}
          noteInputMode={noteInputMode}
          reviewMode={reviewMode}
          inlineEditorValue={inlineEditor.value}
          inlineEditorCursor={inlineEditor.cursor}
          optionNotes={optionNotes}
        />
      ) : null}
      <InputPanel
        ref={inputPanelRef}
        onSubmit={handleSubmit}
        disabled={!!pendingAsk}
        commandRegistry={commandRegistry}
        store={store}
        hint={inputHint}
        onHintRequested={showInputHint}
        session={session}
      />
      <StatusBar
        phase={activityPhase}
        toolName={activityToolName}
        error={statusError}
        modelName={formatDisplayModelName(
          session.primaryAgent.modelConfig?.provider,
          session.primaryAgent.modelConfig?.model,
        )}
        contextTokens={contextTokens}
        contextLimit={session.primaryAgent.modelConfig?.contextLength}
        cacheReadTokens={cacheReadTokens}
      />
    </Box>
  );
}
