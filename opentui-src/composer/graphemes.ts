// Grapheme + display-width primitives for the self-written composer.
//
// The composer models the cursor as a *grapheme index*, never a raw string
// index or a display-column. That single choice makes "cursor inside a wide
// grapheme" states unrepresentable. Display columns are a derived, render-time
// concern computed here.
//
// Width source is `string-width` to stay byte-for-byte consistent with
// `composer-token-logic.ts` (token serialization round-trips depend on it).

import stringWidth from "string-width";

const TAB_WIDTH = 2;

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Split text into grapheme clusters. `\n` is its own grapheme. */
export function segmentGraphemes(text: string): string[] {
  if (text === "") return [];
  if (segmenter) {
    const out: string[] = [];
    for (const { segment } of segmenter.segment(text)) out.push(segment);
    return out;
  }
  return Array.from(text);
}

/**
 * Display columns occupied by a single grapheme.
 * `\n` occupies no column (it terminates a visual line); `\t` is a fixed width.
 */
export function graphemeColumns(grapheme: string): number {
  if (grapheme === "\n") return 0;
  if (grapheme === "\t") return TAB_WIDTH;
  const w = stringWidth(grapheme);
  // Zero-width / control graphemes still get one cell so the cursor can rest on
  // them; negative is impossible but clamp defensively.
  return w <= 0 ? 1 : w;
}

/** Total display columns of a grapheme slice [start, end). */
export function measureColumns(graphemes: string[], start = 0, end = graphemes.length): number {
  let cols = 0;
  for (let i = start; i < end; i++) cols += graphemeColumns(graphemes[i]!);
  return cols;
}

/** String (JS char) offset of a grapheme boundary index. */
export function graphemeIndexToStringOffset(graphemes: string[], index: number): number {
  let off = 0;
  const n = Math.min(index, graphemes.length);
  for (let i = 0; i < n; i++) off += graphemes[i]!.length;
  return off;
}

/** Grapheme boundary index nearest-at-or-before a string offset. */
export function stringOffsetToGraphemeIndex(graphemes: string[], stringOffset: number): number {
  let off = 0;
  for (let i = 0; i < graphemes.length; i++) {
    if (off >= stringOffset) return i;
    off += graphemes[i]!.length;
  }
  return graphemes.length;
}

// Display-width offsets (newline counts as 1 column) — the unit app.tsx uses
// for `cursorOffset`, `@`-query bounds, and `getTextRange`. We keep them only
// at the API boundary; the model itself is grapheme-indexed.

function displayColsWithNewlines(grapheme: string): number {
  return grapheme === "\n" ? 1 : graphemeColumns(grapheme);
}

/** Display-width offset (newline = 1) of a grapheme boundary index. */
export function graphemeIndexToDisplayOffset(graphemes: readonly string[], index: number): number {
  let off = 0;
  const n = Math.min(index, graphemes.length);
  for (let i = 0; i < n; i++) off += displayColsWithNewlines(graphemes[i]!);
  return off;
}

/** Grapheme boundary index at-or-before a display-width offset. */
export function displayOffsetToGraphemeIndex(graphemes: readonly string[], displayOffset: number): number {
  let off = 0;
  for (let i = 0; i < graphemes.length; i++) {
    if (off >= displayOffset) return i;
    off += displayColsWithNewlines(graphemes[i]!);
  }
  return graphemes.length;
}
