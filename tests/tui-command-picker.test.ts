import { describe, expect, it } from "vitest";

import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  moveCommandPickerSelection,
} from "../src/tui/command-picker.js";

describe("command picker", () => {
  it("drills into nested command options before submitting", () => {
    const picker = createCommandPicker("/model", [
      {
        label: "openrouter",
        value: "openrouter",
        children: [
          { label: "kimi-k2.5", value: "openrouter:moonshotai/kimi-k2.5" },
        ],
      },
      {
        label: "anthropic",
        value: "anthropic",
        children: [
          { label: "claude-sonnet-4-6", value: "anthropic:claude-sonnet-4-6" },
        ],
      },
    ]);

    const firstAccept = acceptCommandPickerSelection(picker);
    expect(firstAccept).toEqual(
      expect.objectContaining({
        kind: "drill_down",
      }),
    );

    const nested = firstAccept?.kind === "drill_down" ? firstAccept.picker : null;
    expect(nested).not.toBeNull();
    expect(getCommandPickerPath(nested!)).toEqual(["openrouter"]);
    expect(getCommandPickerLevel(nested!).options[0]?.label).toBe("kimi-k2.5");

    const secondAccept = acceptCommandPickerSelection(nested!);
    expect(secondAccept).toEqual({
      kind: "submit",
      command: "/model openrouter:moonshotai/kimi-k2.5",
    });
  });

  it("supports cyclic selection movement and backing out of nested levels", () => {
    const picker = createCommandPicker("/thinking", [
      { label: "default", value: "default" },
      { label: "high", value: "high" },
    ]);

    const moved = moveCommandPickerSelection(picker, -1);
    expect(getCommandPickerLevel(moved).selected).toBe(1);

    const nestedPicker = createCommandPicker("/model", [
      {
        label: "openrouter",
        value: "openrouter",
        children: [{ label: "kimi-k2.5", value: "openrouter:moonshotai/kimi-k2.5" }],
      },
    ]);
    const drilled = acceptCommandPickerSelection(nestedPicker);
    expect(drilled?.kind).toBe("drill_down");
    const backedOut = drilled?.kind === "drill_down"
      ? exitCommandPickerLevel(drilled.picker)
      : null;
    expect(backedOut).not.toBeNull();
    expect(getCommandPickerPath(backedOut!)).toEqual([]);
    expect(exitCommandPickerLevel(backedOut!)).toBeNull();
  });

  it("shows a 10-row scrolling window when the selection moves past the bottom", () => {
    const picker = createCommandPicker(
      "/resume",
      Array.from({ length: 15 }, (_, i) => ({
        label: `session-${i + 1}`,
        value: String(i + 1),
      })),
      10,
    );

    expect(getCommandPickerVisibleRange(picker)).toEqual({ start: 0, end: 10 });

    const moved = Array.from({ length: 10 }).reduce(
      (current) => moveCommandPickerSelection(current, 1),
      picker,
    );
    expect(getCommandPickerLevel(moved).selected).toBe(10);
    expect(getCommandPickerVisibleRange(moved)).toEqual({ start: 1, end: 11 });
  });

  it("keeps the current window when moving back up within the visible range", () => {
    const picker = createCommandPicker(
      "/resume",
      Array.from({ length: 15 }, (_, i) => ({
        label: `session-${i + 1}`,
        value: String(i + 1),
      })),
      10,
    );

    const atBottom = Array.from({ length: 14 }).reduce(
      (current) => moveCommandPickerSelection(current, 1),
      picker,
    );
    expect(getCommandPickerLevel(atBottom).selected).toBe(14);
    expect(getCommandPickerVisibleRange(atBottom)).toEqual({ start: 5, end: 15 });

    const movedUpOnce = moveCommandPickerSelection(atBottom, -1);
    expect(getCommandPickerLevel(movedUpOnce).selected).toBe(13);
    expect(getCommandPickerVisibleRange(movedUpOnce)).toEqual({ start: 5, end: 15 });

    const movedAboveTop = Array.from({ length: 10 }).reduce(
      (current) => moveCommandPickerSelection(current, -1),
      movedUpOnce,
    );
    expect(getCommandPickerLevel(movedAboveTop).selected).toBe(3);
    expect(getCommandPickerVisibleRange(movedAboveTop)).toEqual({ start: 3, end: 13 });
  });
});
