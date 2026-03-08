export interface EditorState {
  value: string;
  cursor: number;
  preferredColumn: number | null;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineEnd(starts: number[], line: number, textLength: number): number {
  const nextStart = line + 1 < starts.length ? starts[line + 1] : textLength + 1;
  return nextStart - 1;
}

function lineAndColumn(
  text: string,
  cursor: number,
  starts: number[],
): { line: number; column: number } {
  let line = starts.length - 1;
  for (let i = 0; i < starts.length; i++) {
    const nextStart = i + 1 < starts.length ? starts[i + 1] : text.length + 1;
    if (cursor < nextStart) {
      line = i;
      break;
    }
  }
  return { line, column: cursor - starts[line] };
}

export function withValueAndCursor(
  value: string,
  cursor: number,
  preferredColumn: number | null,
): EditorState {
  return {
    value,
    cursor: clamp(cursor, 0, value.length),
    preferredColumn,
  };
}

export function insertText(state: EditorState, text: string): EditorState {
  if (!text) return state;
  const nextValue = state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
  return withValueAndCursor(nextValue, state.cursor + text.length, null);
}

export function moveLeft(state: EditorState): EditorState {
  return withValueAndCursor(state.value, state.cursor - 1, null);
}

export function moveRight(state: EditorState): EditorState {
  return withValueAndCursor(state.value, state.cursor + 1, null);
}

export function moveWordLeft(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  let i = state.cursor;
  while (i > 0 && /\s/.test(state.value[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(state.value[i - 1] ?? "")) i -= 1;
  return withValueAndCursor(state.value, i, null);
}

export function moveWordRight(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  let i = state.cursor;
  while (i < state.value.length && /\s/.test(state.value[i] ?? "")) i += 1;
  while (i < state.value.length && !/\s/.test(state.value[i] ?? "")) i += 1;
  return withValueAndCursor(state.value, i, null);
}

export function moveHome(state: EditorState): EditorState {
  const lineStart = state.value.lastIndexOf("\n", state.cursor - 1) + 1;
  return withValueAndCursor(state.value, lineStart, null);
}

export function moveEnd(state: EditorState): EditorState {
  const nextBreak = state.value.indexOf("\n", state.cursor);
  const lineEndPos = nextBreak >= 0 ? nextBreak : state.value.length;
  return withValueAndCursor(state.value, lineEndPos, null);
}

export function moveUp(state: EditorState): EditorState {
  const starts = lineStarts(state.value);
  const { line, column } = lineAndColumn(state.value, state.cursor, starts);
  const desiredColumn = state.preferredColumn ?? column;
  if (line === 0) {
    return withValueAndCursor(state.value, 0, desiredColumn);
  }
  const targetStart = starts[line - 1];
  const targetEnd = lineEnd(starts, line - 1, state.value.length);
  const targetColumn = Math.min(desiredColumn, targetEnd - targetStart);
  return withValueAndCursor(state.value, targetStart + targetColumn, desiredColumn);
}

export function moveDown(state: EditorState): EditorState {
  const starts = lineStarts(state.value);
  const { line, column } = lineAndColumn(state.value, state.cursor, starts);
  const desiredColumn = state.preferredColumn ?? column;
  const lastLine = starts.length - 1;
  if (line === lastLine) {
    return withValueAndCursor(
      state.value,
      lineEnd(starts, line, state.value.length),
      desiredColumn,
    );
  }
  const targetStart = starts[line + 1];
  const targetEnd = lineEnd(starts, line + 1, state.value.length);
  const targetColumn = Math.min(desiredColumn, targetEnd - targetStart);
  return withValueAndCursor(state.value, targetStart + targetColumn, desiredColumn);
}

export function deleteBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const nextValue = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
  return withValueAndCursor(nextValue, state.cursor - 1, null);
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  const nextValue = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1);
  return withValueAndCursor(nextValue, state.cursor, null);
}

export function deleteToLineStart(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const lineStart = state.value.lastIndexOf("\n", state.cursor - 1) + 1;
  if (lineStart === state.cursor) return state;
  const nextValue = state.value.slice(0, lineStart) + state.value.slice(state.cursor);
  return withValueAndCursor(nextValue, lineStart, null);
}

export function deleteToLineEnd(state: EditorState): EditorState {
  const lineBreak = state.value.indexOf("\n", state.cursor);
  const lineEndPos = lineBreak >= 0 ? lineBreak : state.value.length;
  if (lineEndPos === state.cursor) return state;
  const nextValue = state.value.slice(0, state.cursor) + state.value.slice(lineEndPos);
  return withValueAndCursor(nextValue, state.cursor, null);
}

export function deleteWordBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  let i = state.cursor;
  while (i > 0 && /\s/.test(state.value[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(state.value[i - 1] ?? "")) i -= 1;
  const nextValue = state.value.slice(0, i) + state.value.slice(state.cursor);
  return withValueAndCursor(nextValue, i, null);
}

export function deleteWordForward(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  let i = state.cursor;
  while (i < state.value.length && /\s/.test(state.value[i] ?? "")) i += 1;
  while (i < state.value.length && !/\s/.test(state.value[i] ?? "")) i += 1;
  if (i === state.cursor) return state;
  const nextValue = state.value.slice(0, state.cursor) + state.value.slice(i);
  return withValueAndCursor(nextValue, state.cursor, null);
}
