import type { EditorCommand, InputEvent, KeyInputEvent } from "./types.js";

function keyCommand(event: KeyInputEvent): EditorCommand | null {
  switch (event.key) {
    case "enter":
      return "submit";
    case "shift_enter":
    case "alt_enter":
    case "ctrl_n":
      return "newline";
    case "left":
      if (event.ctrl || event.alt) return "move_word_left";
      if (event.super || event.meta) return "move_home";
      return "move_left";
    case "right":
      if (event.ctrl || event.alt) return "move_word_right";
      if (event.super || event.meta) return "move_end";
      return "move_right";
    case "word_left":
      return "move_word_left";
    case "word_right":
      return "move_word_right";
    case "up":
      return "move_up";
    case "down":
      return "move_down";
    case "home":
    case "ctrl_a":
      return "move_home";
    case "end":
    case "ctrl_e":
      return "move_end";
    case "ctrl_b":
      return "move_left";
    case "ctrl_f":
      return "move_right";
    case "backspace":
      if (event.super || event.meta) return "delete_to_line_start";
      if (event.ctrl || event.alt) return "delete_word_backward";
      return "delete_backward";
    case "delete":
      if (event.super || event.meta) return "delete_to_line_end";
      if (event.ctrl || event.alt) return "delete_word_forward";
      return "delete_forward";
    case "ctrl_u":
      return "delete_to_line_start";
    case "ctrl_k":
      return "delete_to_line_end";
    case "ctrl_w":
      return "delete_word_backward";
    case "ctrl_d":
      return "delete_forward";
    case "tab":
      return event.shift ? "overlay_prev" : "overlay_next";
    case "escape":
      return "overlay_hide";
    default:
      return null;
  }
}

export function mapInputEventToCommand(event: InputEvent): EditorCommand | null {
  if (event.type !== "key") return null;
  return keyCommand(event);
}
