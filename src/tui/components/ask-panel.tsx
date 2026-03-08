import React from "react";
import { Box, Text } from "ink";
import type { PendingAskUi } from "../../ask.js";

// ------------------------------------------------------------------
// Cursor rendering (simplified from input-panel.tsx)
// ------------------------------------------------------------------

const ANSI_INVERSE_ON = "\u001B[7m";
const ANSI_INVERSE_OFF = "\u001B[27m";

function renderWithCursor(value: string, cursor: number): string {
  if (value.length === 0) return `${ANSI_INVERSE_ON} ${ANSI_INVERSE_OFF}`;
  const c = Math.max(0, Math.min(cursor, value.length));
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += i === c ? `${ANSI_INVERSE_ON}${value[i]}${ANSI_INVERSE_OFF}` : value[i];
  }
  if (c === value.length) out += `${ANSI_INVERSE_ON} ${ANSI_INVERSE_OFF}`;
  return out;
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface QuestionDef {
  question: string;
  options: Array<{ label: string; description?: string; kind: string; systemAdded?: boolean }>;
}

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface AskPanelProps {
  ask: PendingAskUi;
  error?: string | null;
  selectedIndex?: number;
  currentQuestionIndex?: number;
  totalQuestions?: number;
  questionAnswers?: Map<number, { optionIndex: number; customText?: string }>;
  customInputMode?: boolean;
  noteInputMode?: boolean;
  reviewMode?: boolean;
  inlineEditorValue?: string;
  inlineEditorCursor?: number;
  optionNotes?: Map<string, string>;
}

// ------------------------------------------------------------------
// Review panel (multi-question confirmation)
// ------------------------------------------------------------------

function renderReviewPanel(
  questions: QuestionDef[],
  questionAnswers: Map<number, { optionIndex: number; customText?: string }>,
  optionNotes: Map<string, string> | undefined,
  error: string | null | undefined,
): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
      <Text color="green" bold>Review your answers</Text>
      <Box flexDirection="column" marginTop={1}>
        {questions.map((q, i) => {
          const qa = questionAnswers.get(i);
          const agentOpts = q.options;
          const selected = qa ? agentOpts[qa.optionIndex] : undefined;

          let answerDisplay: string;
          let answerColor: string | undefined = "green";
          if (!qa) {
            answerDisplay = "(unanswered)";
            answerColor = "yellow";
          } else if (selected?.kind === "custom_input") {
            answerDisplay = `✎ ${qa.customText ?? ""}`;
          } else {
            answerDisplay = selected?.label ?? "(unknown)";
            if (selected?.kind === "discuss_further") {
              answerColor = "yellow";
            }
          }

          const noteKey = qa && !selected?.systemAdded ? `${i}-${qa.optionIndex}` : "";
          const note = noteKey ? optionNotes?.get(noteKey) : undefined;

          return (
            <Box key={`review-${i}`} flexDirection="column" marginBottom={1}>
              <Text>
                <Text dimColor>{`${i + 1}. `}</Text>
                <Text>{q.question}</Text>
              </Text>
              <Text color={answerColor as any}>   → {answerDisplay}</Text>
              {note ? <Text color="yellow">     📝 {note}</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>Enter to submit. Esc to go back.</Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

// ------------------------------------------------------------------
// Agent question panel
// ------------------------------------------------------------------

function renderAgentQuestionPanel(
  ask: PendingAskUi,
  error: string | null | undefined,
  selectedIndex: number,
  currentQuestionIndex: number,
  totalQuestions: number,
  questionAnswers: Map<number, { optionIndex: number; customText?: string }> | undefined,
  customInputMode: boolean,
  noteInputMode: boolean,
  reviewMode: boolean,
  editorValue: string,
  editorCursor: number,
  optionNotes: Map<string, string> | undefined,
): React.ReactElement {
  const questions = (ask.payload["questions"] as QuestionDef[]) ?? [];

  // Review mode
  if (reviewMode) {
    return renderReviewPanel(
      questions,
      questionAnswers ?? new Map(),
      optionNotes,
      error,
    );
  }

  const q = questions[currentQuestionIndex];
  if (!q) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text color="red">Error: Question index out of range</Text>
      </Box>
    );
  }

  const agentOptions = q.options;
  const existingAnswer = questionAnswers?.get(currentQuestionIndex);
  const isOnAgentOption = !agentOptions[selectedIndex]?.systemAdded;

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text color="cyan">
        Question {currentQuestionIndex + 1}/{totalQuestions}: {q.question}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {agentOptions.map((opt, i) => {
          const isSelected = i === selectedIndex;
          const isAnswered = existingAnswer?.optionIndex === i;
          const noteKey = `${currentQuestionIndex}-${i}`;
          const note = !opt.systemAdded ? optionNotes?.get(noteKey) : undefined;
          return (
            <Box key={`opt-${i}`} flexDirection="column">
              <Text
                color={isSelected ? "cyan" : isAnswered ? "green" : undefined}
                bold={isSelected}
              >
                {isSelected ? " > " : isAnswered ? " ✓ " : "   "}
                {opt.label}
              </Text>
              {opt.description ? (
                <Text dimColor>     {opt.description}</Text>
              ) : null}
              {note ? (
                <Text color="yellow">     📝 {note}{isSelected ? " (Tab to edit)" : ""}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {noteInputMode ? (
        <Box marginTop={1}>
          <Text color="yellow">Note: </Text>
          <Text>{renderWithCursor(editorValue, editorCursor)}</Text>
          <Text dimColor> (Enter to save, Esc to cancel)</Text>
        </Box>
      ) : null}
      {customInputMode ? (
        <Box marginTop={1}>
          <Text color="cyan">Your answer: </Text>
          <Text>{renderWithCursor(editorValue, editorCursor)}</Text>
          <Text dimColor> (Enter to confirm, Esc to go back)</Text>
        </Box>
      ) : null}
      <Box marginTop={1} justifyContent="flex-end">
        <Text dimColor>← {currentQuestionIndex + 1}/{totalQuestions} →</Text>
      </Box>
      <Text dimColor>
        Use ↑/↓ to select, ←/→ to navigate questions, Enter to confirm.
        {!customInputMode && !noteInputMode && isOnAgentOption ? " Tab to add note." : ""}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

// ------------------------------------------------------------------
// Exported component
// ------------------------------------------------------------------

export function AskPanel({
  ask,
  error,
  selectedIndex = 0,
  currentQuestionIndex = 0,
  totalQuestions = 1,
  questionAnswers,
  customInputMode = false,
  noteInputMode = false,
  reviewMode = false,
  inlineEditorValue = "",
  inlineEditorCursor = 0,
  optionNotes,
}: AskPanelProps): React.ReactElement {
  if (ask.kind === "agent_question") {
    return renderAgentQuestionPanel(
      ask,
      error,
      selectedIndex,
      currentQuestionIndex,
      totalQuestions,
      questionAnswers,
      customInputMode,
      noteInputMode,
      reviewMode,
      inlineEditorValue,
      inlineEditorCursor,
      optionNotes,
    );
  }

  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red">Unsupported ask kind: {ask.kind}</Text>
      <Text>{ask.summary}</Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
