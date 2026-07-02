import { describe, expect, it } from "bun:test";

import { segmentGraphemes } from "../opentui-src/composer/graphemes.js";
import { FermiComposerModel } from "../opentui-src/composer/model.js";
import { cursorToVisual, layout, visualToCursor } from "../opentui-src/composer/layout.js";

function lay(text: string, width: number, tokens = []) {
  return layout(segmentGraphemes(text), tokens, width);
}
function lineTexts(l: ReturnType<typeof lay>): string[] {
  return l.lines.map((line) => line.cells.map((c) => c.grapheme).join(""));
}

describe("layout — word wrap", () => {
  it("wraps English on word boundaries", () => {
    expect(lineTexts(lay("hello world", 7))).toEqual(["hello ", "world"]);
  });

  it("wraps CJK by display column (no spaces needed)", () => {
    expect(lineTexts(lay("你好世界", 4))).toEqual(["你好", "世界"]);
  });

  it("hard-breaks a single word wider than the viewport", () => {
    expect(lineTexts(lay("abcdefghij", 4))).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps a token whole by wrapping before it", () => {
    const m = new FermiComposerModel("aaaaaaaaaaaaaa"); // 14 a's
    m.insertToken({ kind: "image", label: "[Image #1]", submitText: "<i>" });
    const l = layout(m.graphemes, m.tokens, 20);
    expect(lineTexts(l)).toEqual(["aaaaaaaaaaaaaa", "[Image #1]"]);
  });

  it("produces an empty trailing visual line after a final newline", () => {
    const l = lay("a\n", 80);
    expect(l.lines.length).toBe(2);
    expect(l.lines[1]!.cells.length).toBe(0);
    expect(l.lines[1]!.startIndex).toBe(2);
  });
});

describe("layout — cursor <-> visual mapping", () => {
  it("cursor display column always lands on a grapheme boundary (CJK)", () => {
    const l = lay("这是", 80); // 这=col0-1, 是=col2-3
    expect(cursorToVisual(l, 0)).toEqual({ row: 0, col: 0 });
    expect(cursorToVisual(l, 1)).toEqual({ row: 0, col: 2 }); // after 这 → col 2, never col 1
    expect(cursorToVisual(l, 2)).toEqual({ row: 0, col: 4 });
  });

  it("respects affinity at a soft-wrap boundary", () => {
    const l = lay("你好世界", 4); // ["你好","世界"], boundary index 2
    expect(cursorToVisual(l, 2, "after")).toEqual({ row: 1, col: 0 });
    expect(cursorToVisual(l, 2, "before")).toEqual({ row: 0, col: 4 });
  });

  it("maps a newline split correctly", () => {
    const l = lay("a\nb", 80);
    expect(cursorToVisual(l, 1)).toEqual({ row: 0, col: 1 }); // before \n
    expect(cursorToVisual(l, 2)).toEqual({ row: 1, col: 0 }); // after \n
  });

  it("maps a cursor inside a space run collapsed at a wrap boundary", () => {
    // "hello  world" @5 wraps to ["hello","world"]; the two spaces (indices
    // 5,6) are dropped at the boundary. Index 6 sits between them — it must
    // render at the start of the next line, NOT at the end of "world".
    const l = lay("hello  world", 5);
    expect(lineTexts(l)).toEqual(["hello", "world"]);
    expect(cursorToVisual(l, 6)).toEqual({ row: 1, col: 0 });
    expect(cursorToVisual(l, 5, "after")).toEqual({ row: 1, col: 0 });
    expect(cursorToVisual(l, 5, "before")).toEqual({ row: 0, col: 5 });
  });
});

describe("layout — clicks snap to a grapheme boundary", () => {
  it("clicking the trailing cell of a wide glyph snaps to its boundary, never mid", () => {
    const l = lay("这是", 80);
    expect(visualToCursor(l, 0, 0)).toBe(0); // left half of 这
    expect(visualToCursor(l, 0, 1)).toBe(1); // right half of 这 → after it
    expect(visualToCursor(l, 0, 2)).toBe(1); // left half of 是 → before it
    expect(visualToCursor(l, 0, 3)).toBe(2); // right half of 是 → after it
    expect(visualToCursor(l, 0, 99)).toBe(2); // past end → end index
  });

  it("clicking inside a token snaps the cursor out (via the model)", () => {
    const m = new FermiComposerModel("");
    m.insertToken({ kind: "image", label: "[Image #1]", submitText: "<i>" }); // [0,10)
    const l = layout(m.graphemes, m.tokens, 80);
    const idx = visualToCursor(l, 0, 4); // somewhere inside the token label
    m.setCursor(idx);
    // cursor must not rest strictly inside the token
    expect(m.cursor === 0 || m.cursor === 10).toBe(true);
  });
});
