// LayoutEngine — pure word-wrap + visual<->grapheme mapping for the composer.
//
// Input: the grapheme sequence + token spans + a viewport width.
// Output: visual lines of cells, and bidirectional maps between a grapheme
// index (the cursor) and a (row, col) display position.
//
// Because the cursor is a grapheme index, every cursor display column is a
// clean grapheme-boundary column — it can never land in the trailing cell of a
// wide glyph. Clicks snap to the nearest boundary. This is the structural cure
// for the wide-grapheme cursor bugs.

import { graphemeColumns } from "./graphemes.js";
import type { ComposerToken } from "./model.js";

export interface LayoutCell {
  graphemeIndex: number;
  grapheme: string;
  startCol: number;
  width: number;
  tokenId?: string;
}

export interface VisualLine {
  cells: LayoutCell[];
  startIndex: number; // grapheme index where this visual line begins
  endIndex: number; // grapheme index just past the last cell (exclusive)
  width: number; // total display columns of the line's cells
}

export interface Layout {
  lines: VisualLine[];
  viewportWidth: number;
}

export interface VisualPos {
  row: number;
  col: number;
}

export type Affinity = "before" | "after";

interface Unit {
  cells: { graphemeIndex: number; grapheme: string; width: number; tokenId?: string }[];
  width: number;
  kind: "word" | "wide" | "space" | "token" | "newline";
}

function tokenAt(tokens: readonly ComposerToken[], index: number): ComposerToken | undefined {
  for (const t of tokens) if (t.start === index) return t;
  return undefined;
}

function buildUnits(graphemes: readonly string[], tokens: readonly ComposerToken[]): Unit[] {
  const units: Unit[] = [];
  const n = graphemes.length;
  let i = 0;
  while (i < n) {
    const g = graphemes[i]!;
    if (g === "\n") {
      units.push({ cells: [], width: 0, kind: "newline" });
      i++;
      continue;
    }
    const tok = tokenAt(tokens, i);
    if (tok) {
      const cells = [];
      let w = 0;
      for (let k = tok.start; k < tok.end; k++) {
        const cw = graphemeColumns(graphemes[k]!);
        cells.push({ graphemeIndex: k, grapheme: graphemes[k]!, width: cw, tokenId: tok.id });
        w += cw;
      }
      units.push({ cells, width: w, kind: "token" });
      i = tok.end;
      continue;
    }
    if (/^\s$/.test(g)) {
      const cells = [];
      let w = 0;
      while (i < n && graphemes[i] !== "\n" && /^\s$/.test(graphemes[i]!) && !tokenAt(tokens, i)) {
        const cw = graphemeColumns(graphemes[i]!);
        cells.push({ graphemeIndex: i, grapheme: graphemes[i]!, width: cw });
        w += cw;
        i++;
      }
      units.push({ cells, width: w, kind: "space" });
      continue;
    }
    const width = graphemeColumns(g);
    if (width >= 2) {
      // Wide (CJK/emoji): its own break unit.
      units.push({ cells: [{ graphemeIndex: i, grapheme: g, width }], width, kind: "wide" });
      i++;
      continue;
    }
    // Narrow word: run until a break boundary.
    const cells = [];
    let w = 0;
    while (
      i < n &&
      graphemes[i] !== "\n" &&
      !/^\s$/.test(graphemes[i]!) &&
      graphemeColumns(graphemes[i]!) < 2 &&
      !tokenAt(tokens, i)
    ) {
      const cw = graphemeColumns(graphemes[i]!);
      cells.push({ graphemeIndex: i, grapheme: graphemes[i]!, width: cw });
      w += cw;
      i++;
    }
    units.push({ cells, width: w, kind: "word" });
  }
  return units;
}

export function layout(
  graphemes: readonly string[],
  tokens: readonly ComposerToken[],
  viewportWidth: number,
): Layout {
  const width = Math.max(1, viewportWidth);
  const units = buildUnits(graphemes, tokens);
  const lines: VisualLine[] = [];

  let cells: LayoutCell[] = [];
  let lineWidth = 0;
  let lineStart = 0;

  const flush = (nextStart: number): void => {
    const endIndex = cells.length ? cells[cells.length - 1]!.graphemeIndex + 1 : lineStart;
    lines.push({ cells, startIndex: lineStart, endIndex, width: lineWidth });
    cells = [];
    lineWidth = 0;
    lineStart = nextStart;
  };

  const pushCells = (
    src: { graphemeIndex: number; grapheme: string; width: number; tokenId?: string }[],
  ): void => {
    for (const c of src) {
      cells.push({ ...c, startCol: lineWidth });
      lineWidth += c.width;
    }
  };

  for (const unit of units) {
    if (unit.kind === "newline") {
      // The \n grapheme is at the current frontier; next line starts after it.
      const nlIndex = cells.length ? cells[cells.length - 1]!.graphemeIndex + 1 : lineStart;
      flush(nlIndex + 1);
      continue;
    }

    if (lineWidth + unit.width > width && lineWidth > 0) {
      const wrapTo = cells[cells.length - 1]!.graphemeIndex + 1;
      flush(wrapTo);
      if (unit.kind === "space") continue; // collapse leading space at a wrap
    }

    if (unit.width > width) {
      // Single unit wider than the viewport (long URL, oversized token): hard
      // break by column.
      for (const c of unit.cells) {
        if (lineWidth + c.width > width && lineWidth > 0) {
          flush(c.graphemeIndex);
        }
        cells.push({ ...c, startCol: lineWidth });
        lineWidth += c.width;
      }
      continue;
    }

    pushCells(unit.cells);
  }

  flush(graphemes.length);
  return { lines, viewportWidth: width };
}

/** Display position of a grapheme-index cursor. */
export function cursorToVisual(layout: Layout, index: number, affinity: Affinity = "after"): VisualPos {
  const { lines } = layout;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    if (index < line.startIndex) break;
    // A cell on this line owns `index` if some cell has graphemeIndex === index.
    const cell = line.cells.find((c) => c.graphemeIndex === index);
    if (cell) {
      // index sits at the start of a placed cell. If it's also the end of the
      // previous line (soft wrap) and affinity is "before", defer to that line.
      if (
        affinity === "before" &&
        index === line.startIndex &&
        row > 0 &&
        lines[row - 1]!.endIndex === index
      ) {
        const prev = lines[row - 1]!;
        return { row: row - 1, col: prev.width };
      }
      return { row, col: cell.startCol };
    }
    if (index <= line.endIndex) {
      // index is at (or before) the end of this line with no cell starting here
      // → it's the line-end position.
      if (
        affinity === "after" &&
        index === line.endIndex &&
        row + 1 < lines.length &&
        lines[row + 1]!.startIndex === index
      ) {
        return { row: row + 1, col: 0 };
      }
      if (index < line.endIndex) {
        // No cell owns this index: the grapheme was dropped at a wrap boundary
        // (a collapsed space run). Snap to the first placed cell after it.
        const after = line.cells.find((c) => c.graphemeIndex > index);
        if (after) return { row, col: after.startCol };
      }
      return { row, col: line.width };
    }
  }
  const last = lines[lines.length - 1]!;
  return { row: lines.length - 1, col: last.width };
}

/** Nearest grapheme index for a click at (row, col); snaps to a boundary. */
export function visualToCursor(layout: Layout, row: number, col: number): number {
  const { lines } = layout;
  if (lines.length === 0) return 0;
  const r = Math.max(0, Math.min(row, lines.length - 1));
  const line = lines[r]!;
  if (line.cells.length === 0) return line.startIndex;
  for (const cell of line.cells) {
    if (col < cell.startCol + cell.width) {
      // Left half → before the grapheme; right half → after it (boundary snap).
      return col < cell.startCol + cell.width / 2 ? cell.graphemeIndex : cell.graphemeIndex + 1;
    }
  }
  return line.endIndex;
}

/** Total visual line count for a given width (for self-sizing the box). */
export function visualLineCount(
  graphemes: readonly string[],
  tokens: readonly ComposerToken[],
  viewportWidth: number,
): number {
  return layout(graphemes, tokens, viewportWidth).lines.length;
}
