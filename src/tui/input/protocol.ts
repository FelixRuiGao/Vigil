import type { InputEvent, InputKey, KeyInputEvent } from "./types.js";

const ESC = "\u001b";
const CSI_PREFIX = `${ESC}[`;
const SS3_PREFIX = `${ESC}O`;
const BRACKETED_PASTE_START = `${CSI_PREFIX}200~`;
const BRACKETED_PASTE_END = `${CSI_PREFIX}201~`;

interface EscapeParseResult {
  consumed: number;
  event?: KeyInputEvent;
  needMore: boolean;
}

type KeyModifiers = Pick<KeyInputEvent, "ctrl" | "alt" | "shift" | "meta" | "super">;

function keyEvent(key: InputKey, mods: Partial<KeyModifiers> = {}): KeyInputEvent {
  return {
    type: "key",
    key,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
    meta: mods.meta ?? false,
    super: mods.super ?? false,
  };
}

function decodeKittyModifiers(raw: number): KeyModifiers {
  const bits = Math.max(0, raw - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    super: (bits & 8) !== 0,
    meta: (bits & 32) !== 0,
  };
}

function keyFromKittyEnter(mod: KeyModifiers): KeyInputEvent {
  if (mod.shift) return keyEvent("shift_enter", mod);
  if (mod.alt || mod.meta || mod.super) return keyEvent("alt_enter", mod);
  if (mod.ctrl) return keyEvent("ctrl_n", mod);
  return keyEvent("enter", mod);
}

function keyFromArrowFinal(final: string): InputKey | undefined {
  switch (final) {
    case "A":
      return "up";
    case "B":
      return "down";
    case "C":
      return "right";
    case "D":
      return "left";
    case "H":
      return "home";
    case "F":
      return "end";
    default:
      return undefined;
  }
}

function codePointToLowerAscii(codePoint: number): string | null {
  if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint + 32);
  if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint);
  return null;
}

function mapEscapeSequence(seq: string): KeyInputEvent | undefined {
  switch (seq) {
    case `${CSI_PREFIX}A`:
      return keyEvent("up");
    case `${CSI_PREFIX}B`:
      return keyEvent("down");
    case `${CSI_PREFIX}C`:
      return keyEvent("right");
    case `${CSI_PREFIX}D`:
      return keyEvent("left");
    case `${CSI_PREFIX}H`:
    case `${CSI_PREFIX}1~`:
    case `${CSI_PREFIX}7~`:
      return keyEvent("home");
    case `${CSI_PREFIX}F`:
    case `${CSI_PREFIX}4~`:
    case `${CSI_PREFIX}8~`:
      return keyEvent("end");
    case `${CSI_PREFIX}3~`:
      return keyEvent("delete");
    case `${CSI_PREFIX}Z`:
      return keyEvent("tab", { shift: true });
    case `${SS3_PREFIX}A`:
      return keyEvent("up");
    case `${SS3_PREFIX}B`:
      return keyEvent("down");
    case `${SS3_PREFIX}C`:
      return keyEvent("right");
    case `${SS3_PREFIX}D`:
      return keyEvent("left");
    case `${SS3_PREFIX}H`:
      return keyEvent("home");
    case `${SS3_PREFIX}F`:
      return keyEvent("end");
    default:
      break;
  }

  const modifyOtherKeysEnter = /^\u001b\[27;(\d+);13~$/.exec(seq);
  if (modifyOtherKeysEnter) {
    return keyFromKittyEnter(decodeKittyModifiers(Number(modifyOtherKeysEnter[1])));
  }

  const modifyOtherKeysBackspace = /^\u001b\[27;(\d+);127~$/.exec(seq);
  if (modifyOtherKeysBackspace) {
    return keyEvent("backspace", decodeKittyModifiers(Number(modifyOtherKeysBackspace[1])));
  }

  const modifiedArrow = /^\u001b\[(\d+);(\d+)([ABCDHF])$/.exec(seq);
  if (modifiedArrow) {
    const key = keyFromArrowFinal(modifiedArrow[3]);
    if (!key) return undefined;
    return keyEvent(key, decodeKittyModifiers(Number(modifiedArrow[2])));
  }

  const modifiedTilde = /^\u001b\[(\d+);(\d+)~$/.exec(seq);
  if (modifiedTilde) {
    const keyCode = Number(modifiedTilde[1]);
    const mods = decodeKittyModifiers(Number(modifiedTilde[2]));
    if (keyCode === 3) return keyEvent("delete", mods);
    if (keyCode === 1 || keyCode === 7) return keyEvent("home", mods);
    if (keyCode === 4 || keyCode === 8) return keyEvent("end", mods);
  }

  const kitty = /^\u001b\[(\d+)(?:;(\d+)(?::\d+)?)?u$/.exec(seq);
  if (kitty) {
    const codePoint = Number(kitty[1]);
    const mods = decodeKittyModifiers(Number(kitty[2] ?? "1"));
    const lower = codePointToLowerAscii(codePoint);

    if (codePoint === 13) return keyFromKittyEnter(mods);
    if (codePoint === 9) return keyEvent("tab", mods);
    if (codePoint === 27) return keyEvent("escape", mods);
    if (codePoint === 8 || codePoint === 127) return keyEvent("backspace", mods);
    if (codePoint === 57367) return keyEvent("left", mods);
    if (codePoint === 57366) return keyEvent("right", mods);
    if (codePoint === 57364) return keyEvent("up", mods);
    if (codePoint === 57365) return keyEvent("down", mods);
    if (codePoint === 57360) return keyEvent("home", mods);
    if (codePoint === 57361) return keyEvent("end", mods);
    if (codePoint === 57359) return keyEvent("delete", mods);

    if (mods.ctrl && !mods.alt && !mods.meta && !mods.super && lower) {
      switch (lower) {
        case "a":
          return keyEvent("ctrl_a", mods);
        case "c":
          return keyEvent("ctrl_c", mods);
        case "b":
          return keyEvent("ctrl_b", mods);
        case "d":
          return keyEvent("ctrl_d", mods);
        case "e":
          return keyEvent("ctrl_e", mods);
        case "f":
          return keyEvent("ctrl_f", mods);
        case "g":
          return keyEvent("ctrl_g", mods);
        case "k":
          return keyEvent("ctrl_k", mods);
        case "l":
          return keyEvent("ctrl_l", mods);
        case "n":
          return keyEvent("ctrl_n", mods);
        case "u":
          return keyEvent("ctrl_u", mods);
        case "w":
          return keyEvent("ctrl_w", mods);
        case "y":
          return keyEvent("ctrl_y", mods);
      }
    }

    if (lower === "b" && (mods.alt || mods.meta || mods.super || mods.ctrl)) {
      return keyEvent("word_left", mods);
    }
    if (lower === "f" && (mods.alt || mods.meta || mods.super || mods.ctrl)) {
      return keyEvent("word_right", mods);
    }
    if (lower === "d" && (mods.alt || mods.meta || mods.super || mods.ctrl)) {
      return keyEvent("delete", mods);
    }
  }

  return undefined;
}

function consumeEscapeSequence(buffer: string): EscapeParseResult {
  if (buffer.length < 2) return { consumed: 0, needMore: true };
  const second = buffer[1];

  if (second === "\r" || second === "\n") {
    return { consumed: 2, event: keyEvent("alt_enter", { alt: true }), needMore: false };
  }

  if (second === "\x7f" || second === "\b") {
    return { consumed: 2, event: keyEvent("backspace", { alt: true }), needMore: false };
  }

  if (second === "b" || second === "B") {
    return { consumed: 2, event: keyEvent("word_left", { alt: true }), needMore: false };
  }

  if (second === "f" || second === "F") {
    return { consumed: 2, event: keyEvent("word_right", { alt: true }), needMore: false };
  }

  if (second === "d" || second === "D") {
    return { consumed: 2, event: keyEvent("delete", { alt: true }), needMore: false };
  }

  if (second !== "[" && second !== "O") {
    return { consumed: 2, needMore: false };
  }

  let i = 2;
  while (i < buffer.length) {
    const code = buffer.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      const seq = buffer.slice(0, i + 1);
      const event = mapEscapeSequence(seq);
      return { consumed: i + 1, event, needMore: false };
    }
    i += 1;
  }

  return { consumed: 0, needMore: true };
}

function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export class InputProtocolParser {
  private buffer = "";
  private inBracketedPaste = false;
  private bracketedPasteBuffer = "";

  reset(): void {
    this.buffer = "";
    this.inBracketedPaste = false;
    this.bracketedPasteBuffer = "";
  }

  push(chunk: string): InputEvent[] {
    const events: InputEvent[] = [];
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (this.inBracketedPaste) {
        const endIdx = this.buffer.indexOf(BRACKETED_PASTE_END);
        if (endIdx < 0) {
          this.bracketedPasteBuffer += this.buffer;
          this.buffer = "";
          break;
        }
        this.bracketedPasteBuffer += this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + BRACKETED_PASTE_END.length);
        events.push({
          type: "insert",
          source: "paste",
          text: this.bracketedPasteBuffer,
        });
        this.bracketedPasteBuffer = "";
        this.inBracketedPaste = false;
        continue;
      }

      if (this.buffer.startsWith(BRACKETED_PASTE_START)) {
        this.buffer = this.buffer.slice(BRACKETED_PASTE_START.length);
        this.inBracketedPaste = true;
        this.bracketedPasteBuffer = "";
        continue;
      }

      const ch = this.buffer[0];
      if (ch === ESC) {
        const parsed = consumeEscapeSequence(this.buffer);
        if (parsed.needMore) break;
        this.buffer = this.buffer.slice(parsed.consumed);
        if (parsed.event) events.push(parsed.event);
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        if (this.buffer.startsWith("\r\n")) {
          this.buffer = this.buffer.slice(2);
        } else {
          this.buffer = this.buffer.slice(1);
        }
        events.push(keyEvent("enter"));
        continue;
      }

      if (ch === "\t") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("tab"));
        continue;
      }

      if (ch === "\x7f" || ch === "\b") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("backspace"));
        continue;
      }

      if (ch === "\x15") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_u", { ctrl: true }));
        continue;
      }

      if (ch === "\x0b") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_k", { ctrl: true }));
        continue;
      }

      if (ch === "\x01") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_a", { ctrl: true }));
        continue;
      }

      if (ch === "\x05") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_e", { ctrl: true }));
        continue;
      }

      if (ch === "\x17") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_w", { ctrl: true }));
        continue;
      }

      if (ch === "\x03") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_c", { ctrl: true }));
        continue;
      }

      if (ch === "\x0e") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_n", { ctrl: true }));
        continue;
      }

      if (ch === "\x04") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_d", { ctrl: true }));
        continue;
      }

      if (ch === "\x07") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_g", { ctrl: true }));
        continue;
      }

      if (ch === "\x02") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_b", { ctrl: true }));
        continue;
      }

      if (ch === "\x06") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_f", { ctrl: true }));
        continue;
      }

      if (ch === "\x0c") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_l", { ctrl: true }));
        continue;
      }

      if (ch === "\x19") {
        this.buffer = this.buffer.slice(1);
        events.push(keyEvent("ctrl_y", { ctrl: true }));
        continue;
      }

      if (isControlChar(ch)) {
        this.buffer = this.buffer.slice(1);
        continue;
      }

      let i = 0;
      while (i < this.buffer.length) {
        const c = this.buffer[i];
        if (c === ESC || isControlChar(c)) break;
        i += 1;
      }

      const text = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i);
      if (text.length > 0) {
        events.push({
          type: "insert",
          source: "typing",
          text,
        });
      }
    }

    return events;
  }
}
