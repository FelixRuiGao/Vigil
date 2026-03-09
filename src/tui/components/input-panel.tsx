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
import type { CommandOption } from "../../commands.js";
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
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  isCommandPickerActive,
  moveCommandPickerSelection,
  type CommandPickerState,
} from "../command-picker.js";
import {
  createCheckboxPicker,
  isCheckboxPickerActive,
  getCheckboxPickerVisibleRange,
  moveCheckboxSelection,
  toggleCheckboxItem,
  type CheckboxPickerState,
} from "../checkbox-picker.js";
import { theme } from "../theme.js";

// ------------------------------------------------------------------
// Overlay
// ------------------------------------------------------------------

interface OverlayState {
  visible: boolean;
  mode: "" | "file" | "command";
  items: string[];
  values: string[];
  selected: number;
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
const RESUME_PICKER_MAX_VISIBLE = 10;

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

  const maxVisible = state.items.length;
  const start = 0;
  const end = Math.min(state.items.length, start + maxVisible);
  const visibleItems = state.items.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1}>
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

function CommandPickerView({ picker }: { picker: CommandPickerState }): React.ReactElement | null {
  if (!isCommandPickerActive(picker)) return null;
  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.accent}>{picker.commandName}</Text>
      {path.length > 0 ? (
        <Text color="gray" dimColor>
          {"   "}
          {path.join(" · ")}
        </Text>
      ) : null}
      {visibleOptions.map((item, i) => {
        const actualIndex = start + i;
        return (
          <Text
            key={`picker-${actualIndex}`}
            color={actualIndex === level.selected ? theme.accent : "gray"}
            bold={actualIndex === level.selected}
          >
            {actualIndex === level.selected ? " > " : "   "}
            {item.label}
          </Text>
        );
      })}
    </Box>
  );
}

function CheckboxPickerView({ picker }: { picker: CheckboxPickerState }): React.ReactElement | null {
  if (!isCheckboxPickerActive(picker)) return null;
  const { start, end } = getCheckboxPickerVisibleRange(picker);
  const visibleItems = picker.items.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.accent}>{picker.title}</Text>
      {visibleItems.map((item, i) => {
        const actualIndex = start + i;
        const checkbox = item.checked ? "[x]" : "[ ]";
        return (
          <Text
            key={`checkbox-${actualIndex}`}
            color={actualIndex === picker.selected ? theme.accent : "gray"}
            bold={actualIndex === picker.selected}
          >
            {actualIndex === picker.selected ? " > " : "   "}
            {checkbox} {item.label}
          </Text>
        );
      })}
      <Text color="gray" dimColor>
        {"  Space toggle · Enter confirm · Esc cancel"}
      </Text>
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
  onHintRequested?: (message: string, durationMs?: number) => void;
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
  function InputPanel(
    { onSubmit, disabled, commandRegistry, store, hint = null, onHintRequested, session: sessionProp },
    ref,
  ) {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);
    const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
    const [picker, setPicker] = useState<CommandPickerState | null>(null);
    const [checkboxPicker, setCheckboxPicker] = useState<CheckboxPickerState | null>(null);

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

    const hidePicker = useCallback(() => {
      setPicker(null);
      setCheckboxPicker(null);
    }, []);

    const buildCommandOptions = useCallback(
      (cmdName: string): CommandOption[] => {
        const cmd = commandRegistry.lookup(cmdName);
        if (!cmd?.options) return [];
        return cmd.options({
          session: sessionProp,
          store: store ?? undefined,
        });
      },
      [commandRegistry, sessionProp, store],
    );

    const startCommandPicker = useCallback(
      (cmdName: string): boolean => {
        const cmd = commandRegistry.lookup(cmdName);
        const options = buildCommandOptions(cmdName);
        if (options.length === 0) return false;
        hideOverlay();

        if (cmd?.checkboxMode) {
          // Use checkbox picker for multi-select commands like /skills
          const items = options.map((o) => ({
            label: o.label,
            value: o.value,
            checked: o.checked !== false,
          }));
          setCheckboxPicker(createCheckboxPicker(cmdName, items, Math.min(items.length, 15)));
          return true;
        }

        setPicker(
          createCommandPicker(
            cmdName,
            options,
            cmdName === "/resume" ? RESUME_PICKER_MAX_VISIBLE : options.length,
          ),
        );
        return true;
      },
      [commandRegistry, buildCommandOptions, hideOverlay],
    );

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
      [showCommandOverlay, showFileOverlay, hideOverlay],
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
      if (checkboxPicker) {
        hidePicker();
        return true;
      }
      if (picker) {
        hidePicker();
        return true;
      }
      if (!overlay.visible) return false;
      hideOverlay();
      return true;
    }, [checkboxPicker, picker, overlay.visible, hideOverlay, hidePicker]);

    React.useImperativeHandle(ref, () => ({
      clear: clearInput,
      getValue: () => valueRef.current,
      resetTurnPasteCounter: () => {
        resetTurnPasteState();
      },
      dismissOverlay,
    }), [clearInput, resetTurnPasteState, dismissOverlay]);

    const maybeStartPickerFromSubmittedText = useCallback(
      (submitted: string): boolean => {
        const trimmed = submitted.trim();
        if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return false;
        const cmd = commandRegistry.lookup(trimmed);
        if (!cmd?.options) return false;
        const started = startCommandPicker(trimmed);
        if (!started) return false;
        clearInput();
        resetTurnPasteState();
        return true;
      },
      [commandRegistry, startCommandPicker, clearInput, resetTurnPasteState],
    );

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
        const cmd = commandRegistry.lookup(sel);
        if (cmd?.options && startCommandPicker(sel)) {
          clearInput();
          resetTurnPasteState();
          return;
        }
        const accepted = onSubmit(sel);
        if (accepted) clearInput();
      }
    }, [
      overlay,
      hideOverlay,
      onSubmit,
      commitEditorState,
      clearInput,
      resetTurnPasteState,
      startCommandPicker,
      commandRegistry,
    ]);

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

    const acceptPickerSelection = useCallback(() => {
      if (!picker) return;
      const result = acceptCommandPickerSelection(picker);
      if (!result) {
        hidePicker();
        return;
      }
      if (result.kind === "drill_down") {
        setPicker(result.picker);
        return;
      }
      hidePicker();
      const accepted = onSubmit(result.command);
      if (accepted) clearInput();
    }, [picker, onSubmit, clearInput, hidePicker]);

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
          if (maybeStartPickerFromSubmittedText(safe)) return;
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
          if (checkboxPicker) {
            hidePicker();
            return;
          }
          if (picker) {
            const nextPicker = exitCommandPickerLevel(picker);
            if (nextPicker) {
              setPicker(nextPicker);
            } else {
              hidePicker();
            }
            return;
          }
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
    }, [
      onSubmit,
      clearInput,
      commitEditorState,
      hideOverlay,
      hidePicker,
      maybeStartPickerFromSubmittedText,
      picker,
      checkboxPicker,
      resetTurnPasteState,
    ]);

    const handleInsert = useCallback(
      (rawText: string, source: "typing" | "paste") => {
        if (checkboxPicker || picker) {
          onHintRequested?.("Picker is active. Press Esc to go back, Ctrl+C to close.", 2500);
          return;
        }
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
      [commitEditorState, onHintRequested, picker, checkboxPicker],
    );

    const handleInputEvent = useCallback(
      (event: InputEvent) => {
        if (disabled) return;

        // Checkbox picker takes priority
        if (checkboxPicker) {
          if (event.type === "insert") {
            // Space toggles the current item
            if (event.text === " ") {
              setCheckboxPicker((prev) => (prev ? toggleCheckboxItem(prev) : prev));
            }
            return;
          }
          if (event.key === "escape") {
            hidePicker();
            return;
          }
          if (event.key === "up" || (event.key === "tab" && event.shift)) {
            setCheckboxPicker((prev) => (prev ? moveCheckboxSelection(prev, -1) : prev));
            return;
          }
          if (event.key === "down" || event.key === "tab") {
            setCheckboxPicker((prev) => (prev ? moveCheckboxSelection(prev, 1) : prev));
            return;
          }
          if (event.key === "enter") {
            // Submit: collect checked items and invoke command
            const enabledValues = checkboxPicker.items
              .filter((it) => it.checked)
              .map((it) => it.value)
              .join(",");
            const cmdStr = `${checkboxPicker.title} ${enabledValues}`.trim();
            hidePicker();
            const accepted = onSubmit(cmdStr);
            if (accepted) clearInput();
            return;
          }
          const command = mapInputEventToCommand(event);
          if (command === "overlay_hide") {
            hidePicker();
          }
          return;
        }

        if (picker) {
          if (event.type === "insert") {
            handleInsert(event.text, event.source);
            return;
          }
          if (event.key === "escape") {
            const nextPicker = exitCommandPickerLevel(picker);
            if (nextPicker) {
              setPicker(nextPicker);
            } else {
              hidePicker();
            }
            return;
          }
          if (event.key === "up") {
            setPicker((prev) => (prev ? moveCommandPickerSelection(prev, -1) : prev));
            return;
          }
          if (event.key === "tab" && event.shift) {
            setPicker((prev) => (prev ? moveCommandPickerSelection(prev, -1) : prev));
            return;
          }
          if (event.key === "down" || event.key === "tab") {
            setPicker((prev) => (prev ? moveCommandPickerSelection(prev, 1) : prev));
            return;
          }
          if (event.key === "enter") {
            acceptPickerSelection();
            return;
          }

          const command = mapInputEventToCommand(event);
          if (command === "overlay_hide") {
            const nextPicker = exitCommandPickerLevel(picker);
            if (nextPicker) {
              setPicker(nextPicker);
            } else {
              hidePicker();
            }
            return;
          }
          return;
        }

        if (event.type === "insert") {
          handleInsert(event.text, event.source);
          return;
        }

        // Overlay keyboard handling
        if (overlay.visible) {
          if (event.key === "escape") {
            hideOverlay();
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
        picker,
        checkboxPicker,
        overlay.visible,
        overlay.mode,
        acceptPickerSelection,
        acceptOverlaySelection,
        applyCommand,
        handleInsert,
        hideOverlay,
        hidePicker,
        clearInput,
        onSubmit,
        completeCommandSelection,
        onHintRequested,
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
      !disabled && !picker && !checkboxPicker,
      turnPasteSlotsRef.current,
    ).replaceAll(
      "\n",
      `\n${PROMPT_INDENT}`,
    );
    const pickerHint = checkboxPicker
      ? "  Space toggle · Enter confirm · Esc cancel"
      : picker
      ? "  Enter select · Esc back/close · Ctrl+C close"
      : null;

    return (
      <Box flexDirection="column" marginTop={2}>
        {checkboxPicker ? <CheckboxPickerView picker={checkboxPicker} /> : picker ? <CommandPickerView picker={picker} /> : <OverlayView state={overlay} />}
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
            {pickerHint
              ? pickerHint
              : hint
              ? `  ${hint}`
              : "  Opt+Enter/^N newline · ^G Markdown raw · ^C Cancel/Quit"}
          </Text>
        </Box>
      </Box>
    );
  },
);
