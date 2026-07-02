import { describe, expect, it } from "bun:test";

import {
  graphemeColumns,
  graphemeIndexToStringOffset,
  measureColumns,
  segmentGraphemes,
  stringOffsetToGraphemeIndex,
} from "../opentui-src/composer/graphemes.js";

describe("composer graphemes", () => {
  it("segments CJK, emoji ZWJ sequences, and newlines as single graphemes", () => {
    expect(segmentGraphemes("a前\n🙂")).toEqual(["a", "前", "\n", "🙂"]);
    // ZWJ family is one grapheme cluster.
    expect(segmentGraphemes("x👨‍👩‍👧‍👦y")).toEqual(["x", "👨‍👩‍👧‍👦", "y"]);
  });

  it("measures display columns: ASCII=1, CJK=2, newline=0, tab=2", () => {
    expect(graphemeColumns("a")).toBe(1);
    expect(graphemeColumns("前")).toBe(2);
    expect(graphemeColumns("\n")).toBe(0);
    expect(graphemeColumns("\t")).toBe(2);
    expect(graphemeColumns("🙂")).toBe(2);
  });

  it("sums columns over a grapheme slice", () => {
    const g = segmentGraphemes("a前b");
    expect(measureColumns(g)).toBe(4);
    expect(measureColumns(g, 0, 1)).toBe(1);
    expect(measureColumns(g, 1, 2)).toBe(2);
  });

  it("bridges grapheme index <-> string offset across wide chars", () => {
    const g = segmentGraphemes("前后x"); // string length: 2 + 2 + 1 ... actually CJK are 1 JS char each
    // "前" and "后" are each a single UTF-16 code unit.
    expect(graphemeIndexToStringOffset(g, 0)).toBe(0);
    expect(graphemeIndexToStringOffset(g, 1)).toBe(1);
    expect(graphemeIndexToStringOffset(g, 2)).toBe(2);
    expect(graphemeIndexToStringOffset(g, 3)).toBe(3);
    expect(stringOffsetToGraphemeIndex(g, 0)).toBe(0);
    expect(stringOffsetToGraphemeIndex(g, 2)).toBe(2);
  });

  it("bridges across multi-code-unit emoji", () => {
    const g = segmentGraphemes("🙂!"); // 🙂 is 2 UTF-16 units
    expect(g).toEqual(["🙂", "!"]);
    expect(graphemeIndexToStringOffset(g, 1)).toBe(2);
    expect(graphemeIndexToStringOffset(g, 2)).toBe(3);
    // A string offset landing inside the emoji rounds to the next boundary.
    expect(stringOffsetToGraphemeIndex(g, 1)).toBe(1);
  });
});
