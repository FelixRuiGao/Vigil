import type { CommandOption } from "../commands.js";

export interface CommandPickerLevel {
  label: string;
  options: CommandOption[];
  selected: number;
  visibleStart: number;
}

export interface CommandPickerState {
  commandName: string;
  maxVisible: number;
  stack: CommandPickerLevel[];
}

export type CommandPickerAcceptResult =
  | { kind: "drill_down"; picker: CommandPickerState }
  | { kind: "submit"; command: string };

function clampSelection(selected: number, options: CommandOption[]): number {
  if (options.length === 0) return 0;
  if (selected < 0) return 0;
  if (selected >= options.length) return options.length - 1;
  return selected;
}

function clampVisibleStart(
  start: number,
  optionCount: number,
  maxVisible: number,
): number {
  if (optionCount <= maxVisible) return 0;
  return Math.max(0, Math.min(start, optionCount - maxVisible));
}

export function createCommandPicker(
  commandName: string,
  options: CommandOption[],
  maxVisible = options.length,
): CommandPickerState {
  return {
    commandName,
    maxVisible,
    stack: [{ label: commandName, options, selected: 0, visibleStart: 0 }],
  };
}

export function isCommandPickerActive(
  picker: CommandPickerState | null | undefined,
): picker is CommandPickerState {
  return Boolean(picker && picker.stack.length > 0);
}

export function getCommandPickerLevel(picker: CommandPickerState): CommandPickerLevel {
  return picker.stack[picker.stack.length - 1]!;
}

export function getCommandPickerPath(picker: CommandPickerState): string[] {
  return picker.stack.slice(1).map((level) => level.label);
}

export function getCommandPickerVisibleRange(
  picker: CommandPickerState,
): { start: number; end: number } {
  const level = getCommandPickerLevel(picker);
  const maxVisible = Math.max(1, picker.maxVisible);
  let start = clampVisibleStart(level.visibleStart, level.options.length, maxVisible);
  if (level.options.length <= maxVisible) {
    return { start: 0, end: level.options.length };
  }

  if (level.selected < start) {
    start = level.selected;
  } else if (level.selected >= start + maxVisible) {
    start = level.selected - maxVisible + 1;
  }

  start = clampVisibleStart(start, level.options.length, maxVisible);
  return { start, end: start + maxVisible };
}

export function moveCommandPickerSelection(
  picker: CommandPickerState,
  delta: number,
): CommandPickerState {
  const level = getCommandPickerLevel(picker);
  const count = level.options.length;
  if (count === 0 || delta === 0) return picker;

  const maxVisible = Math.max(1, picker.maxVisible);
  let nextSelected = level.selected;
  let nextVisibleStart = clampVisibleStart(level.visibleStart, count, maxVisible);
  const direction = delta > 0 ? 1 : -1;

  for (let step = 0; step < Math.abs(delta); step += 1) {
    nextSelected = (nextSelected + direction + count) % count;

    if (count <= maxVisible) {
      nextVisibleStart = 0;
      continue;
    }
    if (nextSelected < nextVisibleStart) {
      nextVisibleStart = nextSelected;
    } else if (nextSelected >= nextVisibleStart + maxVisible) {
      nextVisibleStart = nextSelected - maxVisible + 1;
    }
    nextVisibleStart = clampVisibleStart(nextVisibleStart, count, maxVisible);
  }

  return {
    ...picker,
    stack: [
      ...picker.stack.slice(0, -1),
      { ...level, selected: nextSelected, visibleStart: nextVisibleStart },
    ],
  };
}

export function exitCommandPickerLevel(picker: CommandPickerState): CommandPickerState | null {
  if (picker.stack.length <= 1) return null;
  return {
    ...picker,
    stack: picker.stack.slice(0, -1),
  };
}

export function acceptCommandPickerSelection(
  picker: CommandPickerState,
): CommandPickerAcceptResult | null {
  const level = getCommandPickerLevel(picker);
  const option = level.options[clampSelection(level.selected, level.options)];
  if (!option) return null;

  if (option.children && option.children.length > 0) {
    return {
      kind: "drill_down",
      picker: {
        ...picker,
        stack: [
          ...picker.stack,
          {
            label: option.label,
            options: option.children,
            selected: 0,
            visibleStart: 0,
          },
        ],
      },
    };
  }

  return {
    kind: "submit",
    command: `${picker.commandName} ${option.value}`.trim(),
  };
}
