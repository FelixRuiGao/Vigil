import { describe, expect, it } from "bun:test";

import { FermiComposerModel, type ComposerToken } from "../opentui-src/composer/model.js";

function imageToken(m: FermiComposerModel): ComposerToken {
  return m.insertToken({ kind: "image", label: "[Image #1]", submitText: "<image:1>", imageId: "img-1" });
}

describe("FermiComposerModel — cursor & editing", () => {
  it("models the cursor as a grapheme index across wide chars", () => {
    const m = new FermiComposerModel("这是示例");
    expect(m.cursor).toBe(4); // 4 graphemes, not 8 columns
    m.setCursor(0);
    m.moveRight();
    expect(m.cursor).toBe(1); // one grapheme step, never lands "inside" 这
    m.moveRight();
    expect(m.cursor).toBe(2);
  });

  it("inserts and deletes at grapheme granularity", () => {
    const m = new FermiComposerModel("");
    m.insertText("a前b");
    expect(m.text).toBe("a前b");
    expect(m.cursor).toBe(3);
    m.deleteBackward();
    expect(m.text).toBe("a前");
    m.setCursor(1);
    m.deleteForward(); // removes 前
    expect(m.text).toBe("a");
  });

  it("word movement and word delete", () => {
    const m = new FermiComposerModel("hello world foo");
    m.setCursor(m.length);
    m.deleteWordBackward();
    expect(m.text).toBe("hello world ");
    m.moveWordLeft();
    m.moveWordLeft();
    expect(m.cursor).toBe(0);
  });
});

describe("FermiComposerModel — tokens are atomic", () => {
  it("cursor cannot rest strictly inside a token; arrows jump over it", () => {
    const m = new FermiComposerModel("");
    const tok = imageToken(m); // text === "[Image #1]", cursor at end (10)
    expect(m.text).toBe("[Image #1]");
    expect(tok.start).toBe(0);
    expect(tok.end).toBe(10);
    m.setCursor(0);
    m.moveRight(); // from token.start, one step jumps the whole token
    expect(m.cursor).toBe(10);
    m.moveLeft(); // back across the whole token
    expect(m.cursor).toBe(0);
  });

  it("backspace at a token's end deletes the whole token + prunes it", () => {
    const m = new FermiComposerModel("");
    imageToken(m);
    m.insertText(" hi");
    expect(m.text).toBe("[Image #1] hi");
    m.setCursor(10); // just after the token
    m.deleteBackward();
    expect(m.text).toBe(" hi");
    expect(m.tokens.length).toBe(0); // image draft would be pruned by the app
  });

  // The exact bug diagnosed earlier: deleting unrelated text on another line
  // used to corrupt the image token. With token-aware edits it cannot.
  it("deleting a different line leaves the image token intact (regression)", () => {
    const m = new FermiComposerModel("");
    const tok = imageToken(m); // "[Image #1]"
    m.insertText(" 你好\n1234");
    expect(m.text).toBe("[Image #1] 你好\n1234");
    // Cmd+Backspace at end of "1234" → delete-to-logical-line-start on last line.
    m.deleteToLogicalLineStart();
    expect(m.text).toBe("[Image #1] 你好\n");
    expect(m.tokens.length).toBe(1);
    const survived = m.tokens[0]!;
    expect(survived.label).toBe("[Image #1]");
    expect(survived.imageId).toBe("img-1");
    expect(survived.start).toBe(0);
    expect(survived.end).toBe(10);
    expect(m.serializeSubmitText()).toBe("<image:1> 你好\n");
  });

  it("a selection cutting through a token removes the whole token", () => {
    const m = new FermiComposerModel("");
    imageToken(m);
    m.insertText("xy");
    // select from middle of the token through "x"
    m.setCursor(3);
    m.setCursor(11, { select: true });
    m.deleteBackward();
    expect(m.text).toBe("y"); // token fully gone, no orphan "[Imag" fragment
    expect(m.tokens.length).toBe(0);
  });
});

describe("FermiComposerModel — last-line semantics", () => {
  it("clearing the whole last line preserves the empty line", () => {
    const m = new FermiComposerModel("first\nsecond");
    m.setCursor(m.length); // end of "second"
    m.deleteToLogicalLineStart();
    expect(m.text).toBe("first\n");
  });

  it("delete-to-line-start at column 0 joins with the previous line", () => {
    const m = new FermiComposerModel("first\nsecond");
    m.setCursor(6); // start of "second" (after the \n)
    m.deleteToLogicalLineStart();
    expect(m.text).toBe("firstsecond");
  });
});

describe("FermiComposerModel — selection, undo, serialize", () => {
  it("typing over a selection replaces it", () => {
    const m = new FermiComposerModel("hello world");
    m.setCursor(0);
    m.setCursor(5, { select: true }); // select "hello"
    m.insertText("hi");
    expect(m.text).toBe("hi world");
  });

  it("coalesces a typed word into one undo step but splits on space", () => {
    const m = new FermiComposerModel("");
    m.insertText("f");
    m.insertText("o");
    m.insertText("o");
    m.insertText(" ");
    m.insertText("b");
    m.insertText("a");
    m.insertText("r");
    expect(m.text).toBe("foo bar");
    m.undo();
    expect(m.text).toBe("foo "); // "bar" removed as one step
    m.undo();
    expect(m.text).toBe("foo"); // the space
    m.undo();
    expect(m.text).toBe(""); // "foo" removed as one step
  });

  it("Right with an active selection collapses to selection.end (not end-1)", () => {
    const m = new FermiComposerModel("hello world");
    m.setCursor(0);
    m.setCursor(5, { select: true }); // select "hello"
    m.moveRight();
    expect(m.cursor).toBe(5);
    expect(m.hasSelection()).toBe(false);
    expect(m.text).toBe("hello world");
  });

  it("Left with an active selection collapses to selection.start", () => {
    const m = new FermiComposerModel("hello world");
    m.setCursor(6);
    m.setCursor(11, { select: true }); // select "world"
    m.moveLeft();
    expect(m.cursor).toBe(6);
    expect(m.hasSelection()).toBe(false);
  });

  it("redo replays undone edits", () => {
    const m = new FermiComposerModel("");
    m.insertText("abc");
    m.undo();
    expect(m.text).toBe("");
    m.redo();
    expect(m.text).toBe("abc");
  });
});
