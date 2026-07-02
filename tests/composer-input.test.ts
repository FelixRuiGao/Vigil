// Single-line <fermiInput> behaviors: newline stripping, Enter-submits,
// maxLength, controlled-value semantics and horizontal caret-follow scrolling.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { KeyEvent } from "../opentui-src/forked/core/lib/KeyHandler.js";
import { PasteEvent } from "../opentui-src/forked/core/lib/KeyHandler.js";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "../opentui-src/forked/core/testing/test-renderer.js";
import { FermiInputRenderable } from "../opentui-src/composer/composer-renderable.js";

let setup: TestRendererSetup;

function key(name: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    sequence: name.length === 1 ? name : "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    ...overrides,
  } as KeyEvent;
}

function type(input: FermiInputRenderable, text: string): void {
  for (const ch of text) input.handleKeyPress(key(ch, { sequence: ch }));
}

async function createInput(
  options: Record<string, unknown> = {},
): Promise<FermiInputRenderable> {
  const input = new FermiInputRenderable(setup.renderer, {
    width: 10,
    ...options,
  } as any);
  setup.renderer.root.add(input);
  await setup.renderOnce();
  return input;
}

describe("fermiInput — single-line composer", () => {
  beforeEach(async () => {
    setup = await createTestRenderer({ width: 40, height: 8 });
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  it("types text and submits the value on Enter", async () => {
    const input = await createInput();
    const submitted: string[] = [];
    input.onSubmit = (value) => submitted.push(value);

    type(input, "abc");
    expect(input.value).toBe("abc");

    input.handleKeyPress(key("return"));
    expect(submitted).toEqual(["abc"]);
  });

  it("Shift/Alt+Enter also submit — a one-line input has no newline", async () => {
    const input = await createInput();
    const submitted: string[] = [];
    input.onSubmit = (value) => submitted.push(value);
    type(input, "x");

    input.handleKeyPress(key("return", { shift: true }));
    input.handleKeyPress(key("return", { option: true, meta: true }));
    expect(submitted).toEqual(["x", "x"]);
    expect(input.value).toBe("x");
  });

  it("strips newlines from pastes instead of collapsing to a paste token", async () => {
    const input = await createInput();
    input.handlePaste(new PasteEvent(new TextEncoder().encode("multi\nline\r\npaste")));
    expect(input.value).toBe("multilinepaste");
    expect(input.tokens.length).toBe(0);
  });

  it("enforces maxLength on typing, paste and the value setter", async () => {
    const input = await createInput({ maxLength: 5 });
    type(input, "abcdefgh");
    expect(input.value).toBe("abcde");

    input.value = "";
    input.handlePaste(new PasteEvent(new TextEncoder().encode("0123456789")));
    expect(input.value).toBe("01234");

    input.value = "zyxwvuts";
    expect(input.value).toBe("zyxwv");
  });

  it("re-assigning the same controlled value does not move the caret", async () => {
    const input = await createInput();
    input.value = "hello";
    input.cursorOffset = 2;
    input.value = "hello"; // the controlled-prop echo after onInput
    expect(input.cursorOffset).toBe(2);
  });

  it("fires onInput with the new value on edits, not on cursor moves", async () => {
    const input = await createInput();
    const seen: string[] = [];
    input.onInput = (value) => seen.push(value);

    type(input, "ab");
    input.cursorOffset = 1;
    expect(seen).toEqual(["a", "ab"]);
  });

  it("measures one row high and scrolls horizontally to keep the caret visible", async () => {
    const input = await createInput({ width: 6 });
    type(input, "abcdefghij"); // wider than the 6-cell viewport
    await setup.renderOnce();

    expect(input.height).toBe(1);
    const frame = setup.captureCharFrame();
    // The caret sits past the last grapheme; the visible window is the TAIL
    // of the content (caret-follow), not the head.
    expect(frame).toContain("fghij");
    expect(frame).not.toContain("abc");
  });
});
