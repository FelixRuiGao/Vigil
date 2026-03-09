import { describe, it, expect } from "vitest";
import {
  resolveSettings,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
  type UserSettings,
} from "../src/settings.js";

describe("resolveSettings", () => {
  it("returns defaults when raw is null", () => {
    const result = resolveSettings(null);
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns defaults when raw is empty", () => {
    const result = resolveSettings({});
    expect(result.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts valid max_output_tokens", () => {
    const result = resolveSettings({ max_output_tokens: 16384 });
    expect(result.maxOutputTokens).toBe(16384);
    expect(result.warnings).toHaveLength(0);
  });

  it("clamps max_output_tokens below 4096", () => {
    const result = resolveSettings({ max_output_tokens: 1000 });
    expect(result.maxOutputTokens).toBe(4096);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("4096");
  });

  it("warns on non-number max_output_tokens", () => {
    const result = resolveSettings({ max_output_tokens: "abc" as any });
    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("数字");
  });

  it("accepts valid summarize thresholds", () => {
    const result = resolveSettings({
      context: { summarize_hint_level1: 50, summarize_hint_level2: 70 },
    });
    expect(result.thresholds.summarize_hint_level1).toBe(50);
    expect(result.thresholds.summarize_hint_level2).toBe(70);
    expect(result.thresholds.compact_output).toBe(DEFAULT_THRESHOLDS.compact_output);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts valid compact thresholds", () => {
    const result = resolveSettings({
      context: { compact_output: 80, compact_toolcall: 90 },
    });
    expect(result.thresholds.compact_output).toBe(80);
    expect(result.thresholds.compact_toolcall).toBe(90);
    expect(result.thresholds.summarize_hint_level1).toBe(DEFAULT_THRESHOLDS.summarize_hint_level1);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects summarize level2 < level1", () => {
    const result = resolveSettings({
      context: { summarize_hint_level1: 70, summarize_hint_level2: 50 },
    });
    expect(result.thresholds.summarize_hint_level1).toBe(DEFAULT_THRESHOLDS.summarize_hint_level1);
    expect(result.thresholds.summarize_hint_level2).toBe(DEFAULT_THRESHOLDS.summarize_hint_level2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("level2=50");
    expect(result.warnings[0]).toContain("level1=70");
  });

  it("rejects compact_toolcall < compact_output", () => {
    const result = resolveSettings({
      context: { compact_output: 90, compact_toolcall: 80 },
    });
    expect(result.thresholds.compact_output).toBe(DEFAULT_THRESHOLDS.compact_output);
    expect(result.thresholds.compact_toolcall).toBe(DEFAULT_THRESHOLDS.compact_toolcall);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("compact_toolcall=80");
  });

  it("rejects out-of-range threshold (below 20)", () => {
    const result = resolveSettings({
      context: { summarize_hint_level1: 10, summarize_hint_level2: 80 },
    });
    expect(result.thresholds.summarize_hint_level1).toBe(DEFAULT_THRESHOLDS.summarize_hint_level1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("不在 20-95 范围内");
  });

  it("rejects out-of-range threshold (above 95)", () => {
    const result = resolveSettings({
      context: { compact_output: 80, compact_toolcall: 99 },
    });
    expect(result.thresholds.compact_output).toBe(DEFAULT_THRESHOLDS.compact_output);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("不在 20-95 范围内");
  });

  it("summarize and compact are validated independently", () => {
    const result = resolveSettings({
      context: {
        summarize_hint_level1: 70,
        summarize_hint_level2: 50,  // invalid pair
        compact_output: 80,
        compact_toolcall: 90,       // valid pair
      },
    });
    // Summarize reverts to default
    expect(result.thresholds.summarize_hint_level1).toBe(DEFAULT_THRESHOLDS.summarize_hint_level1);
    expect(result.thresholds.summarize_hint_level2).toBe(DEFAULT_THRESHOLDS.summarize_hint_level2);
    // Compact stays as set
    expect(result.thresholds.compact_output).toBe(80);
    expect(result.thresholds.compact_toolcall).toBe(90);
    expect(result.warnings).toHaveLength(1);
  });

  it("accepts equal summarize thresholds", () => {
    const result = resolveSettings({
      context: { summarize_hint_level1: 60, summarize_hint_level2: 60 },
    });
    expect(result.thresholds.summarize_hint_level1).toBe(60);
    expect(result.thresholds.summarize_hint_level2).toBe(60);
    expect(result.warnings).toHaveLength(0);
  });

  it("uses default for missing half of a pair", () => {
    const result = resolveSettings({
      context: { summarize_hint_level1: 50 },
    });
    expect(result.thresholds.summarize_hint_level1).toBe(50);
    expect(result.thresholds.summarize_hint_level2).toBe(DEFAULT_THRESHOLDS.summarize_hint_level2);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("computeHysteresisThresholds", () => {
  it("derives correct values from default thresholds", () => {
    const h = computeHysteresisThresholds(DEFAULT_THRESHOLDS);
    // hintResetNone = 60 - 20 = 40
    expect(h.hintResetNone).toBe(40);
    // hintResetLevel1 = (60 + 80) / 2 = 70
    expect(h.hintResetLevel1).toBe(70);
  });

  it("derives correct values from custom thresholds", () => {
    const h = computeHysteresisThresholds({
      summarize_hint_level1: 50,
      summarize_hint_level2: 70,
      compact_output: 85,
      compact_toolcall: 90,
    });
    expect(h.hintResetNone).toBe(30);
    expect(h.hintResetLevel1).toBe(60);
  });
});
