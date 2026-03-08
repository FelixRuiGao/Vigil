import { describe, expect, it } from "vitest";
import { InputProtocolParser } from "../src/tui/input/protocol.js";
import { mapInputEventToCommand } from "../src/tui/input/keymap.js";
import {
  withValueAndCursor,
  deleteForward,
  moveWordLeft,
  moveWordRight,
  deleteWordForward,
} from "../src/tui/input/editor-state.js";
import { TurnPasteCounter, classifyPastedText } from "../src/tui/input/paste.js";
import { TurnPasteSlotStore } from "../src/tui/input/paste-slots.js";

describe("InputProtocolParser", () => {
  it("parses Shift+Enter modifyOtherKeys sequence", () => {
    const parser = new InputProtocolParser();
    const events = parser.push("\u001b[27;2;13~");
    expect(events).toEqual([
      {
        type: "key",
        key: "shift_enter",
        ctrl: false,
        alt: false,
        shift: true,
        meta: false,
        super: false,
      },
    ]);
  });

  it("parses kitty super+backspace", () => {
    const parser = new InputProtocolParser();
    const events = parser.push("\u001b[127;9u");
    expect(events).toEqual([
      {
        type: "key",
        key: "backspace",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        super: true,
      },
    ]);
  });

  it("parses bracketed paste as a single paste event", () => {
    const parser = new InputProtocolParser();
    const events = parser.push("\u001b[200~line1\nline2\u001b[201~");
    expect(events).toEqual([
      {
        type: "insert",
        source: "paste",
        text: "line1\nline2",
      },
    ]);
  });

  it("parses Ctrl+C in both raw and kitty protocol forms", () => {
    const parser = new InputProtocolParser();
    const raw = parser.push("\x03");
    expect(raw).toEqual([
      {
        type: "key",
        key: "ctrl_c",
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ]);

    const kitty = parser.push("\u001b[99;5u");
    expect(kitty).toEqual([
      {
        type: "key",
        key: "ctrl_c",
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ]);
  });

  it("parses Ctrl+G in both raw and kitty protocol forms", () => {
    const parser = new InputProtocolParser();
    const raw = parser.push("\x07");
    expect(raw).toEqual([
      {
        type: "key",
        key: "ctrl_g",
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ]);

    const kitty = parser.push("\u001b[103;5u");
    expect(kitty).toEqual([
      {
        type: "key",
        key: "ctrl_g",
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        super: false,
      },
    ]);
  });
});

describe("keymap", () => {
  it("maps super+backspace to delete_to_line_start", () => {
    const command = mapInputEventToCommand({
      type: "key",
      key: "backspace",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      super: true,
    });
    expect(command).toBe("delete_to_line_start");
  });

  it("maps delete to forward-delete commands", () => {
    const plainDelete = mapInputEventToCommand({
      type: "key",
      key: "delete",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      super: false,
    });
    const altDelete = mapInputEventToCommand({
      type: "key",
      key: "delete",
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      super: false,
    });
    expect(plainDelete).toBe("delete_forward");
    expect(altDelete).toBe("delete_word_forward");
  });

  it("does not map Ctrl+G to an editor command", () => {
    const command = mapInputEventToCommand({
      type: "key",
      key: "ctrl_g",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      super: false,
    });
    expect(command).toBeNull();
  });
});

describe("editor-state", () => {
  it("supports forward and word-level editing", () => {
    const s1 = withValueAndCursor("abc", 1, null);
    expect(deleteForward(s1)).toEqual({
      value: "ac",
      cursor: 1,
      preferredColumn: null,
    });

    const s2 = withValueAndCursor("foo bar baz", 11, null);
    expect(moveWordLeft(s2).cursor).toBe(8);
    expect(moveWordRight(withValueAndCursor("foo bar baz", 0, null)).cursor).toBe(3);

    const s3 = withValueAndCursor("foo bar baz", 4, null);
    expect(deleteWordForward(s3)).toEqual({
      value: "foo  baz",
      cursor: 4,
      preferredColumn: null,
    });
  });
});

describe("paste placeholder", () => {
  function multiLineText(lines: number): string {
    return Array.from({ length: lines }, (_, i) => `line${i + 1}`).join("\n");
  }

  it("uses monotonic indices per turn and resets on next turn", () => {
    const counter = new TurnPasteCounter();
    const p1 = classifyPastedText(multiLineText(16), counter);
    const p2 = classifyPastedText(multiLineText(17), counter);

    expect(p1.text).toBe("[Pasted Text #1 - 16 lines]");
    expect(p2.text).toBe("[Pasted Text #2 - 17 lines]");

    counter.reset();
    const p3 = classifyPastedText(multiLineText(16), counter);
    expect(p3.text).toBe("[Pasted Text #1 - 16 lines]");
  });

  it("collapses only when pasted text exceeds 15 lines", () => {
    const counter = new TurnPasteCounter();
    const fifteen = multiLineText(15);
    const sixteen = multiLineText(16);

    const p15 = classifyPastedText(fifteen, counter);
    expect(p15.replacedWithPlaceholder).toBe(false);
    expect(p15.text).toBe(fifteen);

    const p16 = classifyPastedText(sixteen, counter);
    expect(p16.replacedWithPlaceholder).toBe(true);
    expect(p16.text).toBe("[Pasted Text #1 - 16 lines]");
  });

  it("uses one-char marker in editor and expands to raw content on submit", () => {
    const slots = new TurnPasteSlotStore();
    const marker = slots.create("line1\nline2", 1, 2);
    expect(marker).not.toBeNull();

    const markerChar = marker as string;
    expect(slots.labelFor(markerChar)).toBe("[Pasted Text #1 - 2 lines]");

    const editorValue = `a${markerChar}b`;
    expect(editorValue.length).toBe(3);
    expect(slots.expand(editorValue)).toBe("aline1\nline2b");

    // Simulate one backspace/delete removing the marker.
    const afterDelete = "ab";
    slots.prune(afterDelete);
    expect(slots.expand(afterDelete)).toBe("ab");
  });
});
