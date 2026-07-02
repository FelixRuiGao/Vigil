// FermiComposerRenderable — the self-drawn composer widget.
//
// Extends the base forked Renderable (NOT the native EditBufferRenderable), so
// it owns every byte of its rendering: it paints cells into the framebuffer,
// draws its own reverse-video block cursor, and only parks a HIDDEN hardware
// cursor at the caret so terminal IME candidate windows anchor correctly (the
// same trick amp uses). All editing math comes from FermiComposerModel +
// LayoutEngine — no native edit buffer, no native cursor rendering.

import {
  Renderable,
  parseColor,
  decodePasteBytes,
  stripAnsiSequences,
  type RenderContext,
  type RenderableOptions,
  type OptimizedBuffer,
  type RGBA,
  type ColorInput,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  Yoga,
} from "@opentui/core";

import { classifyPastedText, TurnPasteCounter } from "../../src/ui/input/paste.js";

import {
  displayOffsetToGraphemeIndex,
  graphemeIndexToDisplayOffset,
  measureColumns,
} from "./graphemes.js";
import { FermiComposerModel, type ComposerToken, type ComposerTokenKind, type TokenSpec } from "./model.js";
import {
  cursorToVisual,
  deleteToVisualLineStartRange,
  layout,
  visualLineCount,
  visualToCursor,
  type Affinity,
  type Layout,
} from "./layout.js";

export interface FermiComposerOptions extends RenderableOptions<any> {
  textColor?: ColorInput;
  placeholderColor?: ColorInput;
  tokenColor?: ColorInput;
  selectionBg?: ColorInput;
  selectionFg?: ColorInput;
  cursorColor?: ColorInput;
  /** Glyph color shown under the reverse-video block cursor. */
  cursorTextColor?: ColorInput;
  placeholder?: string;
  minLines?: number;
  maxLines?: number;
  onSubmit?: () => void;
  /** Called with the selected text when a drag-selection completes (autocopy). */
  onSelectionCopy?: (text: string) => void;
  /** Reconciler-applied focus prop (handled via focus()/blur()). */
  focused?: boolean;
}

const DOUBLE_CLICK_MS = 350;

export class FermiComposerRenderable extends Renderable {
  private _model = new FermiComposerModel("");
  private _layout: Layout | null = null;
  private _layoutWidth = -1;
  private _layoutVersion = -1;
  private _version = 0;
  private _scrollY = 0;
  private _affinity: Affinity = "after";
  // One-shot "scroll the caret into view on the next render" request. Set on
  // model changes and re-wraps, consumed by _clampScroll. Ordinary re-renders
  // must NOT re-follow the caret, or wheel scrolling away from it would be
  // snapped right back every frame.
  private _followCaret = true;
  // True while a press-drag-release gesture that STARTED on this composer is
  // in flight. Distinguishes our own drags from a transcript-wide selection
  // sweep passing over us (those events arrive with e.isDragging === true).
  private _dragActive = false;

  private _minLines: number;
  private _maxLines: number;

  private _textColor: RGBA;
  private _placeholderColorRgba: RGBA;
  private _tokenColor: RGBA;
  private _selectionBg: RGBA;
  private _selectionFg: RGBA;
  private _cursorColorRgba: RGBA;
  private _cursorTextColor: RGBA;
  private _placeholder: string;

  private _showCursor = true;
  private _onSubmit?: () => void;
  private _onContentChange?: (text: string) => void;
  private _onCursorChange?: (offset: number) => void;

  private _lastClickAt = 0;
  private _clickStreak = 0;
  private _didDrag = false;
  private _pasteCounter = new TurnPasteCounter();
  private _onSelectionCopy?: (text: string) => void;

  constructor(ctx: RenderContext, options: FermiComposerOptions) {
    super(ctx, options);

    // CRITICAL: the base Renderable defaults focusable=false, which makes
    // focus() a no-op (no keyboard, no cursor). The composer must be focusable.
    this.focusable = true;

    this._minLines = options.minLines ?? 1;
    this._maxLines = options.maxLines ?? 8;
    this._textColor = parseColor(options.textColor ?? "#d4d4d4");
    this._placeholderColorRgba = parseColor(options.placeholderColor ?? "#6b6b6b");
    this._tokenColor = parseColor(options.tokenColor ?? "#b4a0ec");
    this._selectionBg = parseColor(options.selectionBg ?? "#3a4a6a");
    this._selectionFg = parseColor(options.selectionFg ?? options.textColor ?? "#ffffff");
    this._cursorColorRgba = parseColor(options.cursorColor ?? "#ffffff");
    this._cursorTextColor = parseColor(options.cursorTextColor ?? "#1e1e1e");
    this._placeholder = options.placeholder ?? "";
    this._onSubmit = options.onSubmit;
    this._onSelectionCopy = options.onSelectionCopy;

    this._model.onChange(() => this._onModelChanged());

    this.yogaNode.setMeasureFunc((width, widthMode, height, heightMode) =>
      this._measure(width, widthMode, height, heightMode),
    );

    this.onMouseDown = (e) => this._handleMouseDown(e);
    this.onMouseDrag = (e) => this._handleMouseDrag(e);
    this.onMouseUp = (e) => this._handleMouseUp(e);
    this.onMouseScroll = (e) => this._handleScroll(e);
    // The base render() calls renderSelf then this renderAfter hook.
    this.renderAfter = (buffer) => this.renderAfterCursor(buffer);
  }

  // ---- model bridge -------------------------------------------------------

  get model(): FermiComposerModel {
    return this._model;
  }

  private _onModelChanged(): void {
    this._version++;
    this._followCaret = true;
    // Every model change resets to the default affinity; operations that land
    // the caret on a soft-wrap boundary (visual line end, clicks, vertical
    // moves) assign "before" right after their model call.
    this._affinity = "after";
    this.yogaNode.markDirty();
    this.requestRender();
    this._onContentChange?.(this._model.text);
    this._onCursorChange?.(this.cursorOffset);
  }

  private _ensureLayout(): Layout {
    const w = Math.max(1, this.width);
    if (this._layout && this._layoutWidth === w && this._layoutVersion === this._version) {
      return this._layout;
    }
    // A width change re-wraps the text under the caret — re-follow it.
    if (this._layoutWidth !== w) this._followCaret = true;
    this._layout = layout(this._model.graphemes, this._model.tokens, w);
    this._layoutWidth = w;
    this._layoutVersion = this._version;
    return this._layout;
  }

  // ---- self-sizing --------------------------------------------------------

  private _measure(
    width: number,
    widthMode: Yoga.MeasureMode,
    _height: number,
    _heightMode: Yoga.MeasureMode,
  ): { width: number; height: number } {
    const intrinsicWidth = Math.max(1, this._intrinsicWidth());
    const effectiveWidth =
      widthMode === Yoga.MeasureMode.Undefined || isNaN(width) ? intrinsicWidth : Math.floor(width);
    const lines = visualLineCount(this._model.graphemes, this._model.tokens, Math.max(1, effectiveWidth));
    const height = Math.max(this._minLines, Math.min(lines, this._maxLines));
    if (widthMode === Yoga.MeasureMode.AtMost) {
      return { width: Math.min(effectiveWidth, intrinsicWidth), height };
    }
    return { width: widthMode === Yoga.MeasureMode.Exactly ? effectiveWidth : intrinsicWidth, height };
  }

  private _intrinsicWidth(): number {
    // Widest logical line (no wrap) — natural width when unconstrained.
    const g = this._model.graphemes;
    let max = 1;
    let lineStart = 0;
    for (let i = 0; i <= g.length; i++) {
      if (i === g.length || g[i] === "\n") {
        max = Math.max(max, measureColumns(g as string[], lineStart, i));
        lineStart = i + 1;
      }
    }
    return max;
  }

  // ---- rendering ----------------------------------------------------------

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return;
    const lay = this._ensureLayout();
    this._clampScroll(lay);

    const screenX = this._screenX;
    const screenY = this._screenY;

    if (this._model.length === 0 && this._placeholder) {
      buffer.drawText(this._placeholder, screenX, screenY, this._placeholderColorRgba);
      return;
    }

    const sel = this._model.selection;
    const last = Math.min(lay.lines.length, this._scrollY + this.height);
    for (let row = this._scrollY; row < last; row++) {
      const line = lay.lines[row]!;
      const y = screenY + (row - this._scrollY);
      for (const cell of line.cells) {
        if (cell.startCol >= this.width) break;
        const selected = sel !== null && cell.graphemeIndex >= sel.start && cell.graphemeIndex < sel.end;
        const fg = selected ? this._selectionFg : cell.tokenId ? this._tokenColor : this._textColor;
        const bg = selected ? this._selectionBg : undefined;
        buffer.drawText(cell.grapheme, screenX + cell.startCol, y, fg, bg);
      }
    }
  }

  // renderAfter hook target — positions the caret after the text is drawn.
  protected renderAfterCursor(_buffer: OptimizedBuffer): void {
    if (!this._showCursor || !this._focused || this.isDestroyed) return;
    const lay = this._ensureLayout();
    const pos = cursorToVisual(lay, this._model.cursor, this._affinity);
    const visualRow = pos.row - this._scrollY;

    const cx = this._screenX + pos.col;
    const cy = this._screenY + visualRow;

    // Out of the visible viewport → hide the caret.
    if (visualRow < 0 || visualRow >= this.height || pos.col > this.width) {
      this._ctx.setCursorPosition(cx + 1, cy + 1, false);
      return;
    }

    // Use the REAL terminal cursor as the caret. Its column is computed from our
    // own layout, so it always lands on a grapheme boundary (the wide-grapheme
    // cursor bug stays fixed) — but the terminal owns rendering it, which is
    // what makes IME preedit/candidate windows anchor here and lets the cursor
    // hide itself during composition. A self-drawn block can do neither (the
    // terminal can't anchor IME to it, and we can't detect composition to hide
    // it). 1-based terminal coords.
    this._ctx.setCursorPosition(cx + 1, cy + 1, true);
    this._ctx.setCursorStyle({ style: "block", blinking: false, color: this._cursorColorRgba });
  }

  private _clampScroll(lay: Layout): void {
    // Caret-follow is one-shot (armed by model changes / re-wraps), so a
    // wheel-scrolled viewport stays where the user put it; here we only pull
    // the scroll back into bounds and never touch the caret.
    if (this._followCaret) {
      this._followCaret = false;
      const pos = cursorToVisual(lay, this._model.cursor, this._affinity);
      if (pos.row < this._scrollY) this._scrollY = pos.row;
      else if (pos.row >= this._scrollY + this.height) this._scrollY = pos.row - this.height + 1;
    }
    const maxScroll = Math.max(0, lay.lines.length - this.height);
    this._scrollY = Math.max(0, Math.min(this._scrollY, maxScroll));
  }

  // ---- focus --------------------------------------------------------------

  public override focus(): void {
    super.focus();
    this.requestRender();
  }

  public override blur(): void {
    super.blur();
    this._ctx.setCursorPosition(0, 0, false);
    this.requestRender();
  }

  // ---- keyboard -----------------------------------------------------------

  // Modifier semantics (see parse.keypress: Alt/Option sets BOTH key.meta and
  // key.option; key.super is Cmd/Win): meta/option → word ops, super → visual
  // line / whole-buffer ops, mirroring defaultTextareaKeyBindings + the app's
  // COMPOSER_KEY_BINDINGS overrides.
  public override handleKeyPress(key: KeyEvent): boolean {
    const m = this._model;
    const select = key.shift === true;

    switch (key.name) {
      case "left":
        // Ctrl+Left is owned by the app (tab switching). Defer it.
        if (key.ctrl) return false;
        if (key.super) this.gotoVisualLineHome({ select });
        else if (key.meta || key.option) m.moveWordLeft({ select });
        else m.moveLeft({ select });
        return true;
      case "right":
        if (key.ctrl) return false; // Ctrl+Right → app (tab switching)
        if (key.super) this.gotoVisualLineEnd({ select });
        else if (key.meta || key.option) m.moveWordRight({ select });
        else m.moveRight({ select });
        return true;
      case "up":
      case "down": {
        const dir: 1 | -1 = key.name === "up" ? -1 : 1;
        if (key.super) {
          m.setCursor(dir < 0 ? 0 : m.length, { select }); // native: buffer-home/end
          return true;
        }
        if (key.shift && !key.ctrl && !key.meta) {
          this._moveVertical(dir, true); // native: select-up/down
          return true;
        }
        // Plain up/down are owned by the app's useKeyboard handler (prompt
        // history + vertical move via composer.moveCursorUp/Down) — handling
        // them here too would move the cursor twice.
        return false;
      }
      case "home":
        m.setCursor(0, { select }); // native binding: buffer-home
        return true;
      case "end":
        m.setCursor(m.length, { select }); // native binding: buffer-end
        return true;
      case "backspace":
        // Cmd/Option+Backspace (delete-to-line-start) is owned by the
        // app-level useKeyboard handler (deleteToVisualLineStart) — handling
        // it here too would delete twice. Defer it.
        if (key.meta || key.super) return false;
        if (key.ctrl) m.deleteWordBackward();
        else m.deleteBackward();
        return true;
      case "delete":
        if (key.ctrl || key.meta || key.option) m.deleteWordForward();
        else m.deleteForward();
        return true;
      case "return":
      case "enter":
      case "kpenter":
        if (key.shift || key.option || key.meta) m.insertText("\n");
        else this._onSubmit?.();
        return true;
      case "linefeed": // Ctrl+J — the app maps it to submit
        this._onSubmit?.();
        return true;
      default:
        break;
    }

    // Cmd/Win bindings.
    if (key.super) {
      switch (key.name) {
        case "a":
          m.selectAll();
          return true;
        case "z":
          if (key.shift) m.redo();
          else m.undo();
          return true;
        default:
          return false;
      }
    }

    // Emacs-style control bindings.
    if (key.ctrl) {
      switch (key.name) {
        case "a":
          m.moveToLogicalLineStart({ select });
          return true;
        case "e":
          m.moveToLogicalLineEnd({ select });
          return true;
        case "b":
          m.moveLeft({ select });
          return true;
        case "f":
          m.moveRight({ select });
          return true;
        case "d":
          m.deleteForward();
          return true;
        case "n":
          m.insertText("\n"); // app binding: Ctrl+N → newline
          return true;
        case "u":
          // Ctrl+U (delete-to-line-start) is owned by the app useKeyboard
          // handler — defer to avoid a double delete.
          return false;
        case "k":
          m.deleteToLogicalLineEnd();
          return true;
        case "w":
          m.deleteWordBackward();
          return true;
        case "-":
          m.undo();
          return true;
        case ".":
          m.redo();
          return true;
        default:
          return false;
      }
    }

    // Alt/Option (meta) word + visual-line bindings.
    if (key.meta || key.option) {
      switch (key.name) {
        case "a":
          this.gotoVisualLineHome({ select });
          return true;
        case "e":
          this.gotoVisualLineEnd({ select });
          return true;
        case "b":
          m.moveWordLeft({ select });
          return true;
        case "f":
          m.moveWordRight({ select });
          return true;
        case "d":
          m.deleteWordForward();
          return true;
        default:
          return false;
      }
    }

    // Printable input.
    if (!key.ctrl && !key.meta && !key.super && !key.hyper && key.sequence && key.sequence.length > 0) {
      const code = key.sequence.codePointAt(0)!;
      if (code >= 0x20 && code !== 0x7f) {
        m.insertText(key.sequence);
        return true;
      }
    }
    return false;
  }

  private _moveVertical(dir: 1 | -1, select: boolean): boolean {
    const lay = this._ensureLayout();
    const cur = cursorToVisual(lay, this._model.cursor, this._affinity);
    const targetRow = cur.row + dir;
    if (targetRow < 0 || targetRow >= lay.lines.length) return false;
    const preferred = this._model.preferredCol ?? cur.col;
    const targetIdx = visualToCursor(lay, targetRow, preferred);
    this._model.setCursor(targetIdx, { select });
    this._model.preferredCol = preferred; // setCursor resets it; restore for sticky column
    // A target column past a soft-wrapped line's end resolves to the wrap
    // boundary index; without "before" affinity the caret would DISPLAY on the
    // row after the one we moved to.
    this._affinity = this._boundaryAffinity(lay, this._model.cursor, targetRow);
    return true;
  }

  /** "before" iff `idx` is the soft-wrap boundary at the end of visual row `row`. */
  private _boundaryAffinity(lay: Layout, idx: number, row: number): Affinity {
    const r = Math.max(0, Math.min(row, lay.lines.length - 1));
    const line = lay.lines[r];
    if (!line) return "after";
    return idx === line.endIndex && r + 1 < lay.lines.length && lay.lines[r + 1]!.startIndex === idx
      ? "before"
      : "after";
  }

  // ---- mouse --------------------------------------------------------------

  private _hitTo(e: MouseEvent): { lay: Layout; idx: number; row: number } {
    const lay = this._ensureLayout();
    // In SGR-Pixels mode (DECSET 1016) mouse coordinates are FRACTIONAL cells;
    // the row must be floored to index visual lines. The fractional column is
    // kept as-is — it makes the half-cell boundary snap exact.
    const row = Math.floor(e.y - this._screenY) + this._scrollY;
    const col = Math.max(0, e.x - this._screenX);
    return { lay, idx: visualToCursor(lay, row, col), row };
  }

  private _handleMouseDown(e: MouseEvent): void {
    if (e.isDragging) return; // a transcript-wide selection sweep, not our click
    const now = Date.now();
    this._clickStreak = now - this._lastClickAt < DOUBLE_CLICK_MS ? this._clickStreak + 1 : 1;
    this._lastClickAt = now;
    this._didDrag = false;
    this._dragActive = true;

    const { lay, idx, row } = this._hitTo(e);
    if (this._clickStreak >= 3) {
      // Triple click: select the whole logical line.
      this._model.setCursor(idx);
      this._model.moveToLogicalLineStart();
      this._model.moveToLogicalLineEnd({ select: true });
    } else if (this._clickStreak === 2) {
      // Double click: select the word under the caret.
      this._model.setCursor(idx);
      this._model.moveWordLeft();
      this._model.moveWordRight({ select: true });
    } else {
      this._model.setCursor(idx);
      // Clicking past the end of a soft-wrapped line keeps the caret rendered
      // on the clicked row instead of the next row's start.
      this._affinity = this._boundaryAffinity(lay, this._model.cursor, row);
    }
    // No preventDefault: the renderer's default for an unclaimed left-click
    // clears an existing transcript selection, which a click here should do.
  }

  private _handleMouseDrag(e: MouseEvent): void {
    if (e.isDragging || !this._dragActive) return; // transcript selection sweep
    this._didDrag = true;
    const { lay, idx, row } = this._hitTo(e);
    this._model.setCursor(idx, { select: true });
    this._affinity = this._boundaryAffinity(lay, this._model.cursor, row);
    e.preventDefault();
  }

  private _handleMouseUp(e: MouseEvent): void {
    const wasOurs = this._dragActive;
    this._dragActive = false;
    if (e.isDragging || !wasOurs) return; // finishing a transcript selection
    // Select-to-copy: when a drag selection finishes, hand the selected text to
    // the app, which honours /autocopy (copyOnSelect) and toasts. The highlight
    // is intentionally kept.
    if (this._didDrag && this._onSelectionCopy) {
      const sel = this._model.selection;
      if (sel) {
        const text = this._model.graphemes.slice(sel.start, sel.end).join("");
        if (text) this._onSelectionCopy(text);
      }
    }
    this._didDrag = false;
  }

  /** Bracketed-paste: decode + ANSI-strip, collapse large pastes into a token. */
  public handlePaste(event: PasteEvent): void {
    const raw = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!raw) return;
    const decision = classifyPastedText(raw, this._pasteCounter);
    if (decision.replacedWithPlaceholder && decision.index !== undefined) {
      this._model.insertToken({ kind: "paste", label: decision.text, submitText: raw });
    } else {
      this._model.insertText(raw);
    }
  }

  private _handleScroll(e: MouseEvent): void {
    // Native-parity semantics: only vertical wheel events, only when we can
    // actually scroll that way; consumed events stop propagating, everything
    // else bubbles (matches EditBufferRenderable.handleScroll).
    const direction = e.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    const lay = this._ensureLayout();
    const maxScroll = Math.max(0, lay.lines.length - this.height);
    const delta = (e.scroll?.delta ?? 1) * (direction === "up" ? -1 : 1);
    const next = Math.max(0, Math.min(maxScroll, this._scrollY + delta));
    if (next === this._scrollY) return;
    this._scrollY = next;
    e.stopPropagation();
    e.preventDefault();
    this.requestRender();
  }

  // ---- drop-in API used by app.tsx ---------------------------------------

  get plainText(): string {
    return this._model.text;
  }

  get cursorOffset(): number {
    return graphemeIndexToDisplayOffset(this._model.graphemes, this._model.cursor);
  }
  set cursorOffset(displayOffset: number) {
    this._model.setCursor(displayOffsetToGraphemeIndex(this._model.graphemes, displayOffset));
  }

  get lineCount(): number {
    return this._ensureLayout().lines.length;
  }

  setText(text: string): void {
    this._model.setText(text, { cursorToEnd: true });
    this._pasteCounter.reset();
  }

  getTextRange(startOffset: number, endOffset: number): string {
    const g = this._model.graphemes as string[];
    const a = displayOffsetToGraphemeIndex(g, startOffset);
    const b = displayOffsetToGraphemeIndex(g, endOffset);
    return g.slice(a, b).join("");
  }

  hasSelection(): boolean {
    return this._model.hasSelection();
  }

  deleteCharBackward(): void {
    this._model.deleteBackward();
  }

  /**
   * Delete to the start of the current VISUAL line — a faithful port of the
   * app's getDeleteToVisualLineStartAction + Textarea.deleteToLineStart:
   *   - caret mid-line            → delete from the visual line start to caret
   *   - caret at a wrapped-row start → delete the previous visual row
   *   - caret at a logical line start → join with the previous line
   * (Cmd+Backspace / Ctrl+U route here from the app's useKeyboard handler.)
   */
  deleteToVisualLineStart(): void {
    if (this._model.hasSelection()) {
      this._model.deleteBackward();
      return;
    }
    const range = deleteToVisualLineStartRange(
      this._ensureLayout(),
      this._model.graphemes,
      this._model.cursor,
    );
    if (range) this._model.deleteRange(range.start, range.end);
  }

  /** Kept for API compatibility; prefer deleteToVisualLineStart(). */
  deleteToLineStart(): void {
    this.deleteToVisualLineStart();
  }

  gotoVisualLineHome(opts: { select?: boolean } = {}): void {
    const lay = this._ensureLayout();
    // Use the DISPLAY affinity so "home" targets the row the caret is shown
    // on; the model change resets affinity to "after", which renders a
    // soft-boundary start on its own row — correct for a line start.
    const pos = cursorToVisual(lay, this._model.cursor, this._affinity);
    const line = lay.lines[pos.row]!;
    this._model.setCursor(line.startIndex, opts);
  }

  gotoVisualLineEnd(opts: { select?: boolean } = {}): void {
    const lay = this._ensureLayout();
    const pos = cursorToVisual(lay, this._model.cursor, this._affinity);
    const line = lay.lines[pos.row]!;
    this._model.setCursor(line.endIndex, opts);
    // At a soft wrap the line-end index doubles as the next line's start; keep
    // the caret rendered at the end of THIS line.
    this._affinity = this._boundaryAffinity(lay, this._model.cursor, pos.row);
  }

  moveCursorUp(opts: { select?: boolean } = {}): boolean {
    return this._moveVertical(-1, opts.select ?? false);
  }
  moveCursorDown(opts: { select?: boolean } = {}): boolean {
    return this._moveVertical(1, opts.select ?? false);
  }

  /** True when the caret is on the first visual row (history-up boundary). */
  isAtFirstVisualLine(): boolean {
    const lay = this._ensureLayout();
    return cursorToVisual(lay, this._model.cursor, this._affinity).row === 0;
  }
  isAtLastVisualLine(): boolean {
    const lay = this._ensureLayout();
    return cursorToVisual(lay, this._model.cursor, this._affinity).row === lay.lines.length - 1;
  }

  // Token API (replaces the extmark monkeypatch layer).
  insertToken(spec: TokenSpec, trailingText = ""): ComposerToken {
    return this._model.insertToken(spec, trailingText);
  }

  /**
   * Replace a display-offset range with an atomic token — the @file / image
   * insert path (mirrors replaceRangeWithComposerToken on the native composer).
   */
  replaceRangeWithToken(opts: {
    rangeStart: number;
    rangeEnd: number;
    label: string;
    submitText: string;
    kind: ComposerTokenKind;
    imageId?: string;
    path?: string;
    trailingText?: string;
  }): void {
    const g = this._model.graphemes as string[];
    const a = displayOffsetToGraphemeIndex(g, opts.rangeStart);
    const b = displayOffsetToGraphemeIndex(g, opts.rangeEnd);
    this._model.setCursor(a);
    if (b > a) this._model.setCursor(b, { select: true });
    this._model.insertToken(
      { kind: opts.kind, label: opts.label, submitText: opts.submitText, imageId: opts.imageId, path: opts.path },
      opts.trailingText ?? "",
    );
  }
  get tokens(): readonly ComposerToken[] {
    return this._model.tokens;
  }
  serializeSubmitText(): string {
    return this._model.serializeSubmitText();
  }

  /** Clear text, tokens and paste numbering — the app's input-reset path. */
  clearContent(): void {
    this._model.clear();
    this._pasteCounter.reset();
  }

  // Dynamic props applied by the reconciler via setProperty (instance[key]=v).
  set placeholder(value: string) {
    this._placeholder = value ?? "";
    this.requestRender();
  }
  set textColor(value: ColorInput) {
    this._textColor = parseColor(value);
    this.requestRender();
  }
  set placeholderColor(value: ColorInput) {
    this._placeholderColorRgba = parseColor(value);
    this.requestRender();
  }
  set tokenColor(value: ColorInput) {
    this._tokenColor = parseColor(value);
    this.requestRender();
  }
  set maxLines(value: number) {
    this._maxLines = value;
    this._followCaret = true; // the viewport window changed; re-anchor on the caret
    this.yogaNode.markDirty();
    this.requestRender();
  }

  set onContentChange(handler: ((text: string) => void) | undefined) {
    this._onContentChange = handler;
  }
  set onCursorChange(handler: ((offset: number) => void) | undefined) {
    this._onCursorChange = handler;
  }
  set onSubmit(handler: (() => void) | undefined) {
    this._onSubmit = handler;
  }
  set onSelectionCopy(handler: ((text: string) => void) | undefined) {
    this._onSelectionCopy = handler;
  }
  setShowCursor(show: boolean): void {
    this._showCursor = show;
    this.requestRender();
  }

  protected override onRemove(): void {
    if (this._focused) this._ctx.setCursorPosition(0, 0, false);
  }
}

/** Type guard so app glue can branch native-vs-self composer paths. */
export function isFermiComposer(composer: unknown): composer is FermiComposerRenderable {
  return composer instanceof FermiComposerRenderable;
}

/**
 * Returns the composer typed as a FermiComposerRenderable, or null. Use this
 * (instead of the boolean guard) when the app holds the ref as a
 * TextareaRenderable but needs to call self-composer-only methods — a plain
 * type guard would narrow the disjoint class to `never`.
 */
export function asFermiComposer(composer: unknown): FermiComposerRenderable | null {
  return composer instanceof FermiComposerRenderable ? composer : null;
}
