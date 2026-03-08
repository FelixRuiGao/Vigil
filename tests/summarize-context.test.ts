import { describe, expect, it } from "vitest";

import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSummary,
  createSystemPrompt,
  createToolCall,
  createToolResult,
  createUserMessage,
  type LogEntry,
} from "../src/log-entry.js";
import { execSummarizeContextOnLog, truncateSummaryText } from "../src/summarize-context.js";

function allocIds(prefix: string): () => string {
  let i = 0;
  return () => `${prefix}${++i}`;
}

describe("truncateSummaryText", () => {
  it("keeps short summaries unchanged", () => {
    const text = "short summary";
    expect(truncateSummaryText(text)).toBe(text);
  });

  it("truncates long summaries and includes the result context reference", () => {
    const text = "A".repeat(180);
    const out = truncateSummaryText(text, "ctx9");
    expect(out).toContain("Truncated");
    expect(out).toContain("context_id ctx9");
    expect(out.length).toBeLessThan(text.length + 80);
  });
});

describe("execSummarizeContextOnLog", () => {
  it("summarizes a visible context range in-place", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1"], summary: "compressed" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries[1].type).toBe("summary");
    expect(String(entries[1].content)).not.toContain("§{");
    expect(entries[2].summarized).toBe(true);
    expect((entries[1].meta as Record<string, unknown>)["summaryDepth"]).toBe(1);
  });

  it("allows summarizing compact_context in the active window", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createCompactContext("cc-001", 1, "continuation", "cc1", 0),
      createUserMessage("user-002", 1, "new", "new", "u2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["cc1"], summary: "compact summary" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries.some((e) => e.type === "summary" && String(e.content).includes("compact summary"))).toBe(true);
    expect(entries.find((e) => e.id === "cc-001")?.summarized).toBe(true);
  });

  it("treats sub-context IDs as part of their main context", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "Checking", "Checking", "7.1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "read_file",
        { id: "call_1", name: "read_file", arguments: { path: "x.ts" } },
        { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "7.1" },
      ),
      createToolResult(
        "tr-001",
        1,
        0,
        { toolCallId: "call_1", toolName: "read_file", content: "source", toolSummary: "read" },
        { isError: false, contextId: "7.1" },
      ),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["7"], summary: "tool round summary" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries.filter((e) => e.summarized).map((e) => e.id)).toEqual([
      "asst-001",
      "tc-001",
      "tr-001",
    ]);
  });

  it("rejects non-contiguous contexts", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "a", "a", "c1"),
      createAssistantText("asst-001", 1, 0, "gap", "gap", "c2"),
      createUserMessage("user-002", 1, "b", "b", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1", "c3"], summary: "bad" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("Not spatially contiguous");
  });

  it("rejects contexts before the last compact marker", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createSummary("sum-keep", 1, "kept", "kept", "new1", ["old1"], 1),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["old1"], summary: "hidden" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("before the last compact marker");
  });

  it("rejects duplicate references within the same call", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      {
        operations: [
          { context_ids: ["c1"], summary: "first" },
          { context_ids: ["c1"], summary: "second" },
        ],
      },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded, 1 failed");
    expect(result.output).toContain("already referenced by another operation");
  });

  it("supports re-summarization with depth tracking", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];
    const ctxAlloc = allocIds("ctx-");
    const logAlloc = allocIds("sum-");

    const first = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1"], summary: "first summary" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );
    const firstSummaryId = first.results[0].newContextId!;

    const second = execSummarizeContextOnLog(
      { operations: [{ context_ids: [firstSummaryId], summary: "second summary" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );

    expect(second.output).toContain("1 succeeded");
    const latestSummary = entries.find((e) => e.type === "summary" && e.id === "sum-2")!;
    expect((latestSummary.meta as Record<string, unknown>)["summaryDepth"]).toBe(2);
  });

  it("returns a direct error when no operations are provided", () => {
    const result = execSummarizeContextOnLog(
      { operations: [] },
      [],
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toBe("Error: no operations provided.");
    expect(result.results[0].success).toBe(false);
  });
});
