/**
 * Chat input area with @filename and /command autocomplete overlays.
 *
 * Uses a custom multi-line editor with raw-stdin protocol parsing for
 * better terminal compatibility (Ghostty/macOS Terminal/iTerm/Warp/etc).
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useStdin } from "ink";
import { StringDecoder } from "node:string_decoder";
import { scanCandidates } from "../../file-attach.js";
import type { CommandRegistry } from "../types.js";
import type { SessionStore } from "../../persistence.js";
import { InputProtocolParser } from "../input/protocol.js";
import { mapInputEventToCommand } from "../input/keymap.js";
import {
  withValueAndCursor,
  insertText,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  deleteToLineStart,
  deleteToLineEnd,
} from "../input/editor-state.js";
import { TurnPasteCounter, classifyPastedText } from "../input/paste.js";
import { TurnPasteSlotStore } from "../input/paste-slots.js";
import { sanitizeInputText, sanitizeSubmitText } from "../input/sanitize.js";
import type { EditorCommand, InputEvent } from "../input/types.js";
import { theme } from "../theme.js";

// ------------------------------------------------------------------
// Overlay
// ------------------------------------------------------------------

interface OverlayState {
  visible: boolean;
  mode: "" | "file" | "command" | "resume" | "command_options";
  items: string[];
  values: string[];
  selected: number;
  /** The command name that triggered this option overlay (e.g. "/thinking"). */
  optionCommand?: string;
  /** Map from value → child options for hierarchical selection (e.g., provider → model). */
  childrenMap?: Record<string, { items: string[]; values: string[] }>;
  /** Parent label shown as breadcrumb when drilled into children. */
  parentLabel?: string;
}

const EMPTY_OVERLAY: OverlayState = {
  visible: false,
  mode: "",
  items: [],
  values: [],
  selected: 0,
};

const ANSI_INVERSE_ON = "\u001B[7m";
const ANSI_INVERSE_OFF = "\u001B[27m";
const PROMPT = "❯ ";
const PROMPT_INDENT = " ".repeat(PROMPT.length);
const INPUT_VIEWPORT_MAX_LINES = 100;

function inverse(text: string): string {
  return `${ANSI_INVERSE_ON}${text}${ANSI_INVERSE_OFF}`;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAtCursor(starts: number[], cursor: number, textLength: number): number {
  for (let i = 0; i < starts.length; i++) {
    const nextStart = i + 1 < starts.length ? starts[i + 1] : textLength + 1;
    if (cursor < nextStart) return i;
  }
  return starts.length - 1;
}

function sliceInputViewport(
  value: string,
  cursor: number,
  maxLines: number,
): { text: string; cursor: number } {
  const safeCursor = clamp(cursor, 0, value.length);
  if (maxLines <= 0) return { text: value, cursor: safeCursor };

  const starts = lineStartOffsets(value);
  if (starts.length <= maxLines) return { text: value, cursor: safeCursor };

  const cursorLine = lineAtCursor(starts, safeCursor, value.length);
  let startLine = Math.max(0, cursorLine - maxLines + 1);
  let endLine = Math.min(starts.length, startLine + maxLines);

  if (cursorLine >= endLine) {
    endLine = cursorLine + 1;
    startLine = Math.max(0, endLine - maxLines);
  }

  const startOffset = starts[startLine];
  const endOffset = endLine < starts.length ? starts[endLine] - 1 : value.length;
  const text = value.slice(startOffset, Math.max(startOffset, endOffset));
  const viewportCursor = clamp(safeCursor - startOffset, 0, text.length);
  return { text, cursor: viewportCursor };
}

function renderValueWithCursor(
  value: string,
  cursor: number,
  showCursor: boolean,
  pasteSlots: TurnPasteSlotStore,
): string {
  if (!showCursor) return value;
  const safeCursor = clamp(cursor, 0, value.length);
  if (value.length === 0) return inverse(" ");

  let rendered = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const display = pasteSlots.labelFor(ch) ?? ch;
    if (i === safeCursor) {
      if (display === "\n") {
        rendered += `${inverse(" ")}\n`;
      } else {
        rendered += inverse(display);
      }
    } else {
      rendered += display;
    }
  }
  if (safeCursor === value.length) rendered += inverse(" ");
  return rendered;
}

function OverlayView({ state }: { state: OverlayState }): React.ReactElement | null {
  if (!state.visible || state.items.length === 0) return null;

  const maxVisible = state.mode === "resume" ? 10 : state.items.length;
  const start =
    state.mode === "resume" && state.items.length > maxVisible
      ? clamp(state.selected - Math.floor(maxVisible / 2), 0, state.items.length - maxVisible)
      : 0;
  const end = Math.min(state.items.length, start + maxVisible);
  const visibleItems = state.items.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1}>
      {state.parentLabel && (
        <Text color="gray" dimColor>{"   ← "}{state.parentLabel}</Text>
      )}
      {visibleItems.map((item, i) => {
        const actualIndex = start + i;
        return (
          <Text
            key={`overlay-${actualIndex}`}
            color={actualIndex === state.selected ? theme.accent : "gray"}
            bold={actualIndex === state.selected}
          >
            {actualIndex === state.selected ? " > " : "   "}
            {item}
          </Text>
        );
      })}
    </Box>
  );
}

// ------------------------------------------------------------------
// InputPanel
// ------------------------------------------------------------------

export interface InputPanelProps {
  onSubmit: (value: string) => boolean;
  disabled: boolean;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  hint?: string | null;
  /** Session reference for computing dynamic command options. */
  session?: any;
}

export interface InputPanelHandle {
  clear: () => void;
  getValue: () => string;
  resetTurnPasteCounter: () => void;
  dismissOverlay: () => boolean;
}

export const InputPanel = React.forwardRef<InputPanelHandle, InputPanelProps>(
  function InputPanel({ onSubmit, disabled, commandRegistry, store, hint = null, session: sessionProp }, ref) {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);
    const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);

    const valueRef = useRef("");
    const cursorRef = useRef(0);
    const preferredColumnRef = useRef<number | null>(null);
    const parserRef = useRef(new InputProtocolParser());
    const decoderRef = useRef(new StringDecoder("utf8"));
    const turnPasteCounterRef = useRef(new TurnPasteCounter());
    const turnPasteSlotsRef = useRef(new TurnPasteSlotStore());

    const { stdin } = useStdin();

    valueRef.current = value;
    cursorRef.current = cursor;

    const hideOverlay = useCallback(() => {
      setOverlay(EMPTY_OVERLAY);
    }, []);

    // ----- Build overlay items for /command prefix ----- //
    const showCommandOverlay = useCallback(
      (prefix: string) => {
        const commands = commandRegistry.getAll();
        const items: string[] = [];
        const values: string[] = [];
        for (const cmd of commands) {
          if (cmd.name.slice(1).startsWith(prefix)) {
            items.push(`${cmd.name}  ${cmd.description}`);
            values.push(cmd.name);
          }
        }
        if (items.length > 0) {
          setOverlay({ visible: true, mode: "command", items, values, selected: 0 });
        } else {
          hideOverlay();
        }
      },
      [commandRegistry, hideOverlay],
    );

    // ----- Build overlay items for /resume session list ----- //
    const showResumeOverlay = useCallback(() => {
      if (!store) {
        hideOverlay();
        return;
      }
      const sessions = store.listSessions();
      if (sessions.length === 0) {
        hideOverlay();
        return;
      }
      const items: string[] = [];
      const values: string[] = [];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const date = (s.created || "").slice(0, 16);
        items.push(`${i + 1}. ${date}  ${s.turns} turns  ${(s.summary || "").slice(0, 40)}`);
        values.push(String(i + 1));
      }
      setOverlay({ visible: true, mode: "resume", items, values, selected: 0 });
    }, [store, hideOverlay]);

    // ----- Build overlay items for command options (dynamic) ----- //
    const showCommandOptionsOverlay = useCallback(
      (cmdName: string) => {
        const cmd = commandRegistry.lookup(cmdName);
        if (!cmd?.options || !sessionProp) {
          hideOverlay();
          return;
        }
        const opts = cmd.options(sessionProp);
        if (opts.length === 0) {
          hideOverlay();
          return;
        }
        // Build childrenMap for options that have children (hierarchical)
        let childrenMap: Record<string, { items: string[]; values: string[] }> | undefined;
        for (const o of opts) {
          if (o.children && o.children.length > 0) {
            if (!childrenMap) childrenMap = {};
            childrenMap[o.value] = {
              items: o.children.map((c) => c.label),
              values: o.children.map((c) => c.value),
            };
          }
        }
        setOverlay({
          visible: true,
          mode: "command_options",
          items: opts.map((o) => o.label),
          values: opts.map((o) => o.value),
          selected: 0,
          optionCommand: cmdName,
          childrenMap,
        });
      },
      [commandRegistry, sessionProp, hideOverlay],
    );

    // ----- Build overlay items for @file prefix ----- //
    const showFileOverlay = useCallback(
      (prefix: string) => {
        const candidates = scanCandidates(prefix);
        if (candidates.length > 0) {
          setOverlay({
            visible: true,
            mode: "file",
            items: candidates,
            values: candidates,
            selected: 0,
          });
        } else {
          hideOverlay();
        }
      },
      [hideOverlay],
    );

    const updateOverlayForInput = useCallback(
      (nextValue: string, nextCursor: number) => {
        const beforeCursor = nextValue.slice(0, nextCursor);

        // Check / command prefix first
        if (beforeCursor.startsWith("/") && !beforeCursor.includes("\n")) {
          // Check for /resume session list
          if (beforeCursor.startsWith("/resume ") && beforeCursor.length >= 8) {
            showResumeOverlay();
            return;
          }

          // Check for commands with dynamic options (e.g. "/thinking ", "/cachehit ")
          const spaceIdx = beforeCursor.indexOf(" ");
          if (spaceIdx > 0) {
            const cmdName = beforeCursor.slice(0, spaceIdx);
            const cmd = commandRegistry.lookup(cmdName);
            if (cmd?.options) {
              showCommandOptionsOverlay(cmdName);
              return;
            }
          }

          const prefix = beforeCursor.slice(1);
          if (!prefix.includes(" ")) {
            showCommandOverlay(prefix);
            return;
          }
        }

        // Check @ file reference before cursor
        const atIdx = beforeCursor.lastIndexOf("@");
        if (atIdx >= 0) {
          const before = atIdx === 0 ? "" : beforeCursor[atIdx - 1];
          if (atIdx === 0 || before === " " || before === "\t" || before === "\n") {
            const prefix = beforeCursor.slice(atIdx + 1);
            if (!/\s/.test(prefix)) {
              showFileOverlay(prefix);
              return;
            }
          }
        }

        hideOverlay();
      },
      [showCommandOverlay, showResumeOverlay, showCommandOptionsOverlay, showFileOverlay, commandRegistry, hideOverlay],
    );

    const commitEditorState = useCallback(
      (nextValue: string, nextCursor: number, preferredColumn: number | null) => {
        const safeCursor = clamp(nextCursor, 0, nextValue.length);
        turnPasteSlotsRef.current.prune(nextValue);
        valueRef.current = nextValue;
        cursorRef.current = safeCursor;
        preferredColumnRef.current = preferredColumn;
        setValue(nextValue);
        setCursor(safeCursor);
        updateOverlayForInput(nextValue, safeCursor);
      },
      [updateOverlayForInput],
    );

    const resetTurnPasteState = useCallback(() => {
      turnPasteCounterRef.current.reset();
      turnPasteSlotsRef.current.reset();
    }, []);

    const clearInput = useCallback(() => {
      parserRef.current.reset();
      commitEditorState("", 0, null);
      setOverlay(EMPTY_OVERLAY);
    }, [commitEditorState]);

    const dismissOverlay = useCallback((): boolean => {
      if (!overlay.visible) return false;
      hideOverlay();
      return true;
    }, [overlay.visible, hideOverlay]);

    React.useImperativeHandle(ref, () => ({
      clear: clearInput,
      getValue: () => valueRef.current,
      resetTurnPasteCounter: () => {
        resetTurnPasteState();
      },
      dismissOverlay,
    }), [clearInput, resetTurnPasteState, dismissOverlay]);

    const acceptOverlaySelection = useCallback(() => {
      const sel = overlay.values[overlay.selected];
      if (!sel) {
        hideOverlay();
        return;
      }

      if (overlay.mode === "file") {
        const currentValue = valueRef.current;
        const currentCursor = cursorRef.current;
        const atIdx = currentValue.slice(0, currentCursor).lastIndexOf("@");
        if (atIdx < 0) {
          hideOverlay();
          return;
        }
        let tokenEnd = currentCursor;
        while (tokenEnd < currentValue.length && !/\s/.test(currentValue[tokenEnd])) {
          tokenEnd += 1;
        }
        const replacement = sel.includes(" ") ? `@"${sel}" ` : `@${sel} `;
        const newVal = currentValue.slice(0, atIdx) + replacement + currentValue.slice(tokenEnd);
        commitEditorState(newVal, atIdx + replacement.length, null);
        hideOverlay();
      } else if (overlay.mode === "command") {
        hideOverlay();
        if (sel === "/resume") {
          commitEditorState("/resume ", "/resume ".length, null);
        } else {
          // Check if this command has dynamic options → show option picker
          const cmd = commandRegistry.lookup(sel);
          if (cmd?.options) {
            commitEditorState(`${sel} `, `${sel} `.length, null);
            return;
          }
          const accepted = onSubmit(sel);
          if (accepted) clearInput();
        }
      } else if (overlay.mode === "resume") {
        hideOverlay();
        const accepted = onSubmit(`/resume ${sel}`);
        if (accepted) clearInput();
      } else if (overlay.mode === "command_options" && overlay.optionCommand) {
        // Check if this option has children (hierarchical selection)
        const children = overlay.childrenMap?.[sel];
        if (children && children.items.length > 0) {
          // Drill into children — replace overlay items
          const parentLabel = overlay.items[overlay.selected];
          setOverlay({
            ...overlay,
            items: children.items,
            values: children.values,
            selected: 0,
            childrenMap: undefined,
            parentLabel,
          });
          return;
        }
        hideOverlay();
        const accepted = onSubmit(`${overlay.optionCommand} ${sel}`);
        if (accepted) clearInput();
      }
    }, [overlay, hideOverlay, onSubmit, commitEditorState, clearInput]);

    const completeCommandSelection = useCallback(() => {
      const sel = overlay.values[overlay.selected];
      if (!sel || overlay.mode !== "command") {
        hideOverlay();
        return;
      }

      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;
      let tokenEnd = currentCursor;
      while (tokenEnd < currentValue.length && !/\s/.test(currentValue[tokenEnd])) {
        tokenEnd += 1;
      }

      const replacement = `${sel} `;
      const nextValue = replacement + currentValue.slice(tokenEnd);
      commitEditorState(nextValue, replacement.length, null);
    }, [overlay, commitEditorState, hideOverlay]);

    const applyCommand = useCallback((command: EditorCommand) => {
      const state = withValueAndCursor(
        valueRef.current,
        cursorRef.current,
        preferredColumnRef.current,
      );

      switch (command) {
        case "submit": {
          const expanded = turnPasteSlotsRef.current.expand(valueRef.current);
          const safe = sanitizeSubmitText(expanded).trim();
          if (!safe) return;
          const accepted = onSubmit(safe);
          if (!accepted) return;
          clearInput();
          resetTurnPasteState();
          return;
        }
        case "newline": {
          const next = insertText(state, "\n");
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_left": {
          const next = moveLeft(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_right": {
          const next = moveRight(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_up": {
          const next = moveUp(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_word_left": {
          const next = moveWordLeft(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_word_right": {
          const next = moveWordRight(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_down": {
          const next = moveDown(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_home": {
          const next = moveHome(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "move_end": {
          const next = moveEnd(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_backward": {
          const next = deleteBackward(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_forward": {
          const next = deleteForward(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_word_backward": {
          const next = deleteWordBackward(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_word_forward": {
          const next = deleteWordForward(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_to_line_start": {
          const next = deleteToLineStart(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "delete_to_line_end": {
          const next = deleteToLineEnd(state);
          commitEditorState(next.value, next.cursor, next.preferredColumn);
          return;
        }
        case "overlay_hide": {
          hideOverlay();
          return;
        }
        case "overlay_next":
        case "overlay_prev":
        case "overlay_accept": {
          // Handled before command mapping when overlay is visible.
          return;
        }
      }
    }, [onSubmit, clearInput, commitEditorState, hideOverlay]);

    const handleInsert = useCallback(
      (rawText: string, source: "typing" | "paste") => {
        const safeText = sanitizeInputText(rawText);
        if (!safeText) return;

        const shouldTreatAsPaste = source === "paste" || safeText.includes("\n");
        let textToInsert = safeText;
        if (shouldTreatAsPaste) {
          const decision = classifyPastedText(safeText, turnPasteCounterRef.current);
          if (decision.replacedWithPlaceholder && decision.index !== undefined) {
            const marker = turnPasteSlotsRef.current.create(
              safeText,
              decision.index,
              decision.lineCount,
            );
            textToInsert = marker ?? safeText;
          } else {
            textToInsert = decision.text;
          }
        }

        const state = withValueAndCursor(
          valueRef.current,
          cursorRef.current,
          preferredColumnRef.current,
        );
        const next = insertText(state, textToInsert);
        commitEditorState(next.value, next.cursor, next.preferredColumn);
      },
      [commitEditorState],
    );

    const handleInputEvent = useCallback(
      (event: InputEvent) => {
        if (disabled) return;

        if (event.type === "insert") {
          handleInsert(event.text, event.source);
          return;
        }

        // Overlay keyboard handling
        if (overlay.visible) {
          if (event.key === "escape") {
            if (overlay.parentLabel && overlay.optionCommand) {
              // Go back to parent level
              showCommandOptionsOverlay(overlay.optionCommand);
            } else {
              hideOverlay();
            }
            return;
          }
          if (overlay.mode === "command" && event.key === "tab" && !event.shift) {
            completeCommandSelection();
            return;
          }
          if (overlay.mode === "file" && event.key === "tab" && !event.shift) {
            acceptOverlaySelection();
            return;
          }
          if (event.key === "up") {
            setOverlay((prev) => ({
              ...prev,
              selected: (prev.selected - 1 + prev.items.length) % prev.items.length,
            }));
            return;
          }
          if (event.key === "tab" && event.shift) {
            setOverlay((prev) => ({
              ...prev,
              selected: (prev.selected - 1 + prev.items.length) % prev.items.length,
            }));
            return;
          }
          if (event.key === "down" || event.key === "tab") {
            setOverlay((prev) => ({
              ...prev,
              selected: (prev.selected + 1) % prev.items.length,
            }));
            return;
          }
          if (event.key === "enter") {
            acceptOverlaySelection();
            return;
          }
        }

        const command = mapInputEventToCommand(event);
        if (!command) return;

        // Overlay actions do nothing when overlay is hidden.
        if (!overlay.visible && command === "overlay_next") return;

        applyCommand(command);
      },
      [
        disabled,
        overlay.visible,
        overlay.mode,
        acceptOverlaySelection,
        applyCommand,
        handleInsert,
        hideOverlay,
        completeCommandSelection,
      ],
    );

    useEffect(() => {
      if (!stdin || disabled) return;

      const onData = (data: string | Buffer) => {
        const chunk =
          typeof data === "string" ? data : decoderRef.current.write(data);
        const events = parserRef.current.push(chunk);
        for (const event of events) {
          handleInputEvent(event);
        }
      };

      stdin.on("data", onData);
      return () => {
        const tail = decoderRef.current.end();
        if (tail.length > 0) {
          const events = parserRef.current.push(tail);
          for (const event of events) {
            handleInputEvent(event);
          }
        }
        stdin.off("data", onData);
      };
    }, [stdin, disabled, handleInputEvent]);

    const viewport = sliceInputViewport(value, cursor, INPUT_VIEWPORT_MAX_LINES);
    const renderedInput = renderValueWithCursor(
      viewport.text,
      viewport.cursor,
      !disabled,
      turnPasteSlotsRef.current,
    ).replaceAll(
      "\n",
      `\n${PROMPT_INDENT}`,
    );

    return (
      <Box flexDirection="column" marginTop={2}>
        <OverlayView state={overlay} />
        <Box
          borderStyle="single"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
        >
          <Box paddingX={1}>
            <Text>
              <Text color={theme.accent}>{PROMPT}</Text>
              <Text>{renderedInput}</Text>
            </Text>
          </Box>
        </Box>
        <Box paddingX={1}>
          <Text color="gray">
            {hint
              ? `  ${hint}`
              : "  Opt+Enter/^N newline · ^G Markdown raw · ^C Cancel/Quit"}
          </Text>
        </Box>
      </Box>
    );
  },
);
