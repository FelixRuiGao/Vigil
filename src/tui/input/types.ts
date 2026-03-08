export type InputKey =
  | "enter"
  | "shift_enter"
  | "alt_enter"
  | "ctrl_n"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "word_left"
  | "word_right"
  | "backspace"
  | "delete"
  | "tab"
  | "escape"
  | "ctrl_u"
  | "ctrl_k"
  | "ctrl_a"
  | "ctrl_e"
  | "ctrl_w"
  | "ctrl_d"
  | "ctrl_g"
  | "ctrl_b"
  | "ctrl_f"
  | "ctrl_c"
  | "ctrl_l"
  | "ctrl_y";

export interface KeyInputEvent {
  type: "key";
  key: InputKey;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  super: boolean;
}

export interface InsertInputEvent {
  type: "insert";
  text: string;
  source: "typing" | "paste";
}

export type InputEvent = KeyInputEvent | InsertInputEvent;

export type EditorCommand =
  | "submit"
  | "newline"
  | "move_left"
  | "move_right"
  | "move_word_left"
  | "move_word_right"
  | "move_up"
  | "move_down"
  | "move_home"
  | "move_end"
  | "delete_backward"
  | "delete_forward"
  | "delete_word_backward"
  | "delete_word_forward"
  | "delete_to_line_start"
  | "delete_to_line_end"
  | "overlay_next"
  | "overlay_prev"
  | "overlay_accept"
  | "overlay_hide";
