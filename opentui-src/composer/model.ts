// FermiComposerModel — the pure-TS editing core for the self-written composer.
//
// Design invariants (see Docs/composer-rewrite.md):
//   * The cursor is a GRAPHEME INDEX (0..graphemes.length), never a string
//     index or a display column. "Cursor inside a wide grapheme" is therefore
//     unrepresentable — the whole class of CJK/emoji cursor bugs is gone by
//     construction.
//   * Tokens (image/file/paste) are first-class atomic spans over the grapheme
//     sequence. The cursor never rests strictly inside a token; edits that
//     touch a token remove it whole (no orphan label fragments, no stale
//     extmarks) — which is exactly why deleting unrelated text can no longer
//     corrupt an image token.
//   * No native calls, no render tick: every method here is synchronously and
//     deterministically unit-testable.

import {
  graphemeIndexToStringOffset,
  segmentGraphemes,
  stringOffsetToGraphemeIndex,
} from "./graphemes.js";

export type ComposerTokenKind = "file" | "paste" | "image";

export interface ComposerToken {
  id: string;
  kind: ComposerTokenKind;
  /** Visible label occupying [start, end) graphemes of the text. */
  label: string;
  /** Expansion substituted for the label when the message is submitted. */
  submitText: string;
  start: number; // grapheme index, inclusive
  end: number; // grapheme index, exclusive
  imageId?: string;
  path?: string;
}

export interface TokenSpec {
  id?: string;
  kind: ComposerTokenKind;
  label: string;
  submitText: string;
  imageId?: string;
  path?: string;
}

export interface Selection {
  start: number; // grapheme index, inclusive (min)
  end: number; // grapheme index, exclusive (max)
}

interface Snapshot {
  text: string;
  cursor: number;
  anchor: number | null;
  tokens: ComposerToken[];
}

type CoalesceKey = string | null;

export class FermiComposerModel {
  private _text: string;
  private _graphemes: string[];
  private _cursor: number;
  private _anchor: number | null = null;
  private _tokens: ComposerToken[] = [];
  private _preferredCol: number | null = null;

  private _undo: Snapshot[] = [];
  private _redo: Snapshot[] = [];
  private _lastCoalesceKey: CoalesceKey = null;
  private _tokenSeq = 0;

  private _listeners = new Set<() => void>();

  constructor(initialText = "") {
    this._text = initialText;
    this._graphemes = segmentGraphemes(initialText);
    this._cursor = this._graphemes.length;
  }

  // ---- read API -----------------------------------------------------------

  get text(): string {
    return this._text;
  }
  get graphemes(): readonly string[] {
    return this._graphemes;
  }
  get length(): number {
    return this._graphemes.length;
  }
  get cursor(): number {
    return this._cursor;
  }
  get tokens(): readonly ComposerToken[] {
    return this._tokens;
  }
  get preferredCol(): number | null {
    return this._preferredCol;
  }
  set preferredCol(col: number | null) {
    this._preferredCol = col;
  }

  get selection(): Selection | null {
    if (this._anchor === null || this._anchor === this._cursor) return null;
    return {
      start: Math.min(this._anchor, this._cursor),
      end: Math.max(this._anchor, this._cursor),
    };
  }
  hasSelection(): boolean {
    return this._anchor !== null && this._anchor !== this._cursor;
  }

  onChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Submit text: token spans replaced by their submitText, in order. */
  serializeSubmitText(): string {
    if (this._tokens.length === 0) return this._text;
    const sorted = [...this._tokens].sort((a, b) => a.start - b.start);
    let out = "";
    let g = 0;
    for (const t of sorted) {
      if (t.start > g) out += this._graphemes.slice(g, t.start).join("");
      out += t.submitText;
      g = t.end;
    }
    if (g < this._graphemes.length) out += this._graphemes.slice(g).join("");
    return out;
  }

  // ---- cursor / selection movement ---------------------------------------

  clearSelection(): void {
    if (this._anchor !== null) {
      this._anchor = null;
      this._notify();
    }
  }

  setCursor(index: number, opts: { select?: boolean } = {}): void {
    const idx = this._snapOutOfToken(this._clamp(index));
    this._setCursorRaw(idx, opts.select ?? false);
    this._preferredCol = null;
    this._lastCoalesceKey = null;
    this._notify();
  }

  moveLeft(opts: { select?: boolean } = {}): void {
    const select = opts.select ?? false;
    if (!select && this.hasSelection()) {
      // Collapse to the left edge instead of moving.
      this._setCursorRaw(this.selection!.start, false);
    } else {
      const target = this._stepOverTokens(this._cursor - 1, -1);
      this._setCursorRaw(Math.max(0, target), select);
    }
    this._preferredCol = null;
    this._lastCoalesceKey = null;
    this._notify();
  }

  moveRight(opts: { select?: boolean } = {}): void {
    const select = opts.select ?? false;
    if (!select && this.hasSelection()) {
      // Collapse to selection.end (after the last selected grapheme), not end-1.
      this._setCursorRaw(this.selection!.end, false);
    } else {
      const target = this._stepOverTokens(this._cursor + 1, 1);
      this._setCursorRaw(Math.min(this._graphemes.length, target), select);
    }
    this._preferredCol = null;
    this._lastCoalesceKey = null;
    this._notify();
  }

  moveWordLeft(opts: { select?: boolean } = {}): void {
    this.setCursor(this._wordBoundaryLeft(this._cursor), opts);
  }
  moveWordRight(opts: { select?: boolean } = {}): void {
    this.setCursor(this._wordBoundaryRight(this._cursor), opts);
  }

  moveToLogicalLineStart(opts: { select?: boolean } = {}): void {
    this.setCursor(this._logicalLineStart(this._cursor), opts);
  }
  moveToLogicalLineEnd(opts: { select?: boolean } = {}): void {
    this.setCursor(this._logicalLineEnd(this._cursor), opts);
  }

  selectAll(): void {
    this._anchor = 0;
    this._cursor = this._graphemes.length;
    this._preferredCol = null;
    this._lastCoalesceKey = null;
    this._notify();
  }

  // ---- editing ------------------------------------------------------------

  insertText(str: string): void {
    if (str === "") return;
    const sel = this.selection;
    const start = sel ? sel.start : this._cursor;
    const end = sel ? sel.end : this._cursor;
    // Word-level undo coalescing: whitespace/newline ends a group.
    const coalesce = !sel && /^[^\s]+$/.test(str) ? "ins-word" : null;
    this._applyEdit(start, end, str, "endOfInsert", coalesce);
  }

  deleteBackward(): void {
    if (this.hasSelection()) {
      const sel = this.selection!;
      this._applyEdit(sel.start, sel.end, "", "start", null);
      return;
    }
    if (this._cursor === 0) return;
    const token = this._tokenEndingAt(this._cursor);
    if (token) {
      this._applyEdit(token.start, token.end, "", "start", null);
      return;
    }
    this._applyEdit(this._cursor - 1, this._cursor, "", "start", "del-back");
  }

  deleteForward(): void {
    if (this.hasSelection()) {
      const sel = this.selection!;
      this._applyEdit(sel.start, sel.end, "", "start", null);
      return;
    }
    if (this._cursor === this._graphemes.length) return;
    const token = this._tokenStartingAt(this._cursor);
    if (token) {
      this._applyEdit(token.start, token.end, "", "start", null);
      return;
    }
    this._applyEdit(this._cursor, this._cursor + 1, "", "start", "del-fwd");
  }

  deleteWordBackward(): void {
    if (this.hasSelection()) return this.deleteBackward();
    if (this._cursor === 0) return;
    const token = this._tokenEndingAt(this._cursor);
    if (token) {
      this._applyEdit(token.start, token.end, "", "start", null);
      return;
    }
    const target = this._wordBoundaryLeft(this._cursor);
    this._applyEdit(target, this._cursor, "", "start", "del-word");
  }

  deleteWordForward(): void {
    if (this.hasSelection()) return this.deleteForward();
    if (this._cursor === this._graphemes.length) return;
    const token = this._tokenStartingAt(this._cursor);
    if (token) {
      this._applyEdit(token.start, token.end, "", "start", null);
      return;
    }
    const target = this._wordBoundaryRight(this._cursor);
    this._applyEdit(this._cursor, target, "", "start", "del-word");
  }

  /** Delete an explicit grapheme range; token-aware (expands over tokens). */
  deleteRange(start: number, end: number): void {
    const a = this._clamp(Math.min(start, end));
    const b = this._clamp(Math.max(start, end));
    if (a === b) return;
    this._applyEdit(a, b, "", "start", null);
  }

  /**
   * Delete from the logical line start to the cursor; at column 0 (and not the
   * first line) join with the previous line by removing the preceding newline.
   * Clearing a whole line leaves an empty line in place (no buffer rewrite, so
   * nothing else can be corrupted).
   */
  deleteToLogicalLineStart(): void {
    const lineStart = this._logicalLineStart(this._cursor);
    if (this._cursor > lineStart) {
      this._applyEdit(lineStart, this._cursor, "", "start", null);
    } else if (this._cursor > 0) {
      this._applyEdit(this._cursor - 1, this._cursor, "", "start", null);
    }
  }

  deleteToLogicalLineEnd(): void {
    const lineEnd = this._logicalLineEnd(this._cursor);
    if (lineEnd > this._cursor) {
      this._applyEdit(this._cursor, lineEnd, "", "start", null);
    } else if (this._cursor < this._graphemes.length) {
      // At end of line: swallow the trailing newline (join next line up).
      this._applyEdit(this._cursor, this._cursor + 1, "", "start", null);
    }
  }

  // ---- tokens -------------------------------------------------------------

  /** Replace the current selection (or insert at cursor) with an atomic token. */
  insertToken(spec: TokenSpec, trailingText = ""): ComposerToken {
    const sel = this.selection;
    const start = sel ? sel.start : this._cursor;
    const end = sel ? sel.end : this._cursor;
    const id = spec.id ?? `tok-${++this._tokenSeq}`;
    const insertStr = spec.label + trailingText;
    this._applyEdit(start, end, insertStr, "endOfInsert", null, (newGraphemes, sStart) => {
      const labelGraphemes = segmentGraphemes(spec.label).length;
      const tokStart = stringOffsetToGraphemeIndex(newGraphemes, sStart);
      return {
        id,
        kind: spec.kind,
        label: spec.label,
        submitText: spec.submitText,
        start: tokStart,
        end: tokStart + labelGraphemes,
        imageId: spec.imageId,
        path: spec.path,
      };
    });
    return this._tokens.find((t) => t.id === id)!;
  }

  setText(text: string, opts: { cursorToEnd?: boolean; tokens?: ComposerToken[] } = {}): void {
    this._undo = [];
    this._redo = [];
    this._lastCoalesceKey = null;
    this._text = text;
    this._graphemes = segmentGraphemes(text);
    this._tokens = (opts.tokens ?? []).map((t) => ({ ...t })).sort((a, b) => a.start - b.start);
    this._anchor = null;
    this._cursor = opts.cursorToEnd === false ? 0 : this._graphemes.length;
    this._preferredCol = null;
    this._notify();
  }

  clear(): void {
    this.setText("");
  }

  // ---- undo / redo --------------------------------------------------------

  undo(): boolean {
    if (this._undo.length === 0) return false;
    const cur = this._snapshot();
    const prev = this._undo.pop()!;
    this._redo.push(cur);
    this._restore(prev);
    this._lastCoalesceKey = null;
    this._notify();
    return true;
  }

  redo(): boolean {
    if (this._redo.length === 0) return false;
    const cur = this._snapshot();
    const next = this._redo.pop()!;
    this._undo.push(cur);
    this._restore(next);
    this._lastCoalesceKey = null;
    this._notify();
    return true;
  }

  // ---- internals ----------------------------------------------------------

  private _clamp(idx: number): number {
    if (idx < 0) return 0;
    if (idx > this._graphemes.length) return this._graphemes.length;
    return idx;
  }

  private _setCursorRaw(idx: number, select: boolean): void {
    if (select) {
      if (this._anchor === null) this._anchor = this._cursor;
    } else {
      this._anchor = null;
    }
    this._cursor = idx;
  }

  /** Token strictly containing a grapheme index (start < idx < end). */
  private _tokenContaining(idx: number): ComposerToken | null {
    for (const t of this._tokens) if (t.start < idx && idx < t.end) return t;
    return null;
  }
  private _tokenEndingAt(idx: number): ComposerToken | null {
    for (const t of this._tokens) if (t.end === idx) return t;
    return null;
  }
  private _tokenStartingAt(idx: number): ComposerToken | null {
    for (const t of this._tokens) if (t.start === idx) return t;
    return null;
  }

  /** If `idx` lands strictly inside a token, continue to its far edge. */
  private _stepOverTokens(idx: number, dir: 1 | -1): number {
    const inside = this._tokenContaining(idx);
    if (!inside) return idx;
    return dir > 0 ? inside.end : inside.start;
  }

  /** If `idx` lands strictly inside a token, snap to the nearer edge. */
  private _snapOutOfToken(idx: number): number {
    const inside = this._tokenContaining(idx);
    if (!inside) return idx;
    return idx - inside.start <= inside.end - idx ? inside.start : inside.end;
  }

  private _logicalLineStart(idx: number): number {
    for (let i = idx - 1; i >= 0; i--) {
      if (this._graphemes[i] === "\n") return i + 1;
    }
    return 0;
  }
  private _logicalLineEnd(idx: number): number {
    for (let i = idx; i < this._graphemes.length; i++) {
      if (this._graphemes[i] === "\n") return i;
    }
    return this._graphemes.length;
  }

  private _classOf(g: string | undefined): "ws" | "word" {
    if (g === undefined) return "ws";
    return /^\s$/.test(g) ? "ws" : "word";
  }

  private _wordBoundaryLeft(idx: number): number {
    let i = idx;
    while (i > 0 && this._classOf(this._graphemes[i - 1]) === "ws") i--;
    while (i > 0 && this._classOf(this._graphemes[i - 1]) === "word") i--;
    return i;
  }
  private _wordBoundaryRight(idx: number): number {
    let i = idx;
    const n = this._graphemes.length;
    while (i < n && this._classOf(this._graphemes[i]) === "ws") i++;
    while (i < n && this._classOf(this._graphemes[i]) === "word") i++;
    return i;
  }

  /**
   * The one mutation primitive. Replaces grapheme range [gStart, gEnd) with
   * `insert`, remapping tokens by string offset (partial overlaps are removed,
   * fully-covered ranges expand to include any partially-touched token so no
   * orphan label fragments survive), then re-derives graphemes.
   */
  private _applyEdit(
    gStart: number,
    gEnd: number,
    insert: string,
    cursorTo: "start" | "endOfInsert",
    coalesce: CoalesceKey,
    makeToken?: (newGraphemes: string[], insertStringStart: number) => ComposerToken,
  ): void {
    // Expand the deletion range to fully cover any token it partially touches.
    let a = gStart;
    let b = gEnd;
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of this._tokens) {
        if (t.start < b && t.end > a) {
          if (t.start < a) {
            a = t.start;
            changed = true;
          }
          if (t.end > b) {
            b = t.end;
            changed = true;
          }
        }
      }
    }

    const prev = this._snapshot();

    const sStart = graphemeIndexToStringOffset(this._graphemes, a);
    const sEnd = graphemeIndexToStringOffset(this._graphemes, b);
    const newText = this._text.slice(0, sStart) + insert + this._text.slice(sEnd);
    const delta = insert.length - (sEnd - sStart);
    const newGraphemes = segmentGraphemes(newText);

    // Remap surviving tokens via string offsets.
    const survivors: ComposerToken[] = [];
    for (const t of this._tokens) {
      const tS = graphemeIndexToStringOffset(this._graphemes, t.start);
      const tE = graphemeIndexToStringOffset(this._graphemes, t.end);
      if (tE <= sStart) {
        survivors.push({ ...t });
      } else if (tS >= sEnd) {
        const ns = tS + delta;
        const ne = tE + delta;
        survivors.push({
          ...t,
          start: stringOffsetToGraphemeIndex(newGraphemes, ns),
          end: stringOffsetToGraphemeIndex(newGraphemes, ne),
        });
      }
      // else: token overlapped the edit (range was expanded to cover it) → drop.
    }

    this._text = newText;
    this._graphemes = newGraphemes;
    this._tokens = survivors.sort((x, y) => x.start - y.start);

    if (makeToken) {
      this._tokens.push(makeToken(newGraphemes, sStart));
      this._tokens.sort((x, y) => x.start - y.start);
    }

    const newCursorStringOffset = cursorTo === "start" ? sStart : sStart + insert.length;
    this._cursor = stringOffsetToGraphemeIndex(newGraphemes, newCursorStringOffset);
    this._anchor = null;
    this._preferredCol = null;

    this._pushUndo(prev, coalesce);
    this._notify();
  }

  private _snapshot(): Snapshot {
    return {
      text: this._text,
      cursor: this._cursor,
      anchor: this._anchor,
      tokens: this._tokens.map((t) => ({ ...t })),
    };
  }

  private _restore(s: Snapshot): void {
    this._text = s.text;
    this._graphemes = segmentGraphemes(s.text);
    this._cursor = s.cursor;
    this._anchor = s.anchor;
    this._tokens = s.tokens.map((t) => ({ ...t }));
    this._preferredCol = null;
  }

  private _pushUndo(prev: Snapshot, coalesce: CoalesceKey): void {
    if (coalesce !== null && coalesce === this._lastCoalesceKey && this._undo.length > 0) {
      // Merge into the current undo group — don't push a new restore point.
    } else {
      this._undo.push(prev);
    }
    this._lastCoalesceKey = coalesce;
    this._redo = [];
  }

  private _notify(): void {
    for (const l of this._listeners) l();
  }
}
