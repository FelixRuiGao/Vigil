/**
 * Tests for log projection functions (TUI + API).
 */

import { describe, it, expect } from "vitest";
import {
  createSystemPrompt,
  createTurnStart,
  createUserMessage,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult,
  createNoReply,
  createCompactMarker,
  createCompactContext,
  createSummary,
  createInterruptionMarker,
  createStatus,
  createError,
  createTokenUpdate,
  createAskRequest,
  createAskResolution,
  createSubAgentStart,
  createSubAgentToolCall,
  createSubAgentEnd,
  type LogEntry,
} from "../src/log-entry.js";
import { projectToTuiEntries, projectToApiMessages } from "../src/log-projection.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function basicLog(): LogEntry[] {
  return [
    createSystemPrompt("sys-001", "You are helpful"),
    createTurnStart("ts-001", 1),
    createUserMessage("user-001", 1, "Hello", "Hello", "c1"),
    createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!", "c2"),
  ];
}

// ------------------------------------------------------------------
// TUI Projection
// ------------------------------------------------------------------

describe("projectToTuiEntries", () => {
  it("projects basic conversation", () => {
    const entries = basicLog();
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2);
    expect(tui[0]).toEqual({ kind: "user", text: "Hello", id: "user-001" });
    expect(tui[1]).toEqual({ kind: "assistant", text: "Hi there!", id: "asst-001" });
  });

  it("skips tuiVisible=false entries", () => {
    const entries = [
      ...basicLog(),
      createToolResult("tr-001", 1, 0, { toolCallId: "1", toolName: "t", content: "r", toolSummary: "s" }, { isError: false }),
      createTokenUpdate("tok-001", 1, 5000),
    ];
    const tui = projectToTuiEntries(entries);
    // Only user + assistant visible
    expect(tui).toHaveLength(2);
  });

  it("projects tool calls and previewable tool results as dedicated TUI entries", () => {
    const entries = [
      ...basicLog(),
      createToolCall(
        "tc-001",
        1,
        1,
        "edit_file src/a.ts",
        { id: "call_1", name: "edit_file", arguments: { path: "src/a.ts" } },
        { toolCallId: "call_1", toolName: "edit_file", agentName: "agent", contextId: "c9" },
      ),
      createToolResult(
        "tr-001",
        1,
        1,
        { toolCallId: "call_1", toolName: "edit_file", content: "OK", toolSummary: "edit" },
        {
          isError: false,
          toolMetadata: {
            tui_preview: { kind: "diff", text: "@@ -1 +1 @@\n-old\n+new" },
          },
          previewText: "@@ -1 +1 @@\n-old\n+new",
        },
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui[2]).toMatchObject({ kind: "tool_call", text: "edit_file src/a.ts", id: "tc-001" });
    expect(tui[3]).toMatchObject({ kind: "tool_result", text: "@@ -1 +1 @@\n-old\n+new", id: "tr-001" });
  });

  it("keeps summarized entries visible in TUI and hides summary entries", () => {
    const entries = basicLog();
    entries[2].summarized = true; // Mark user message as summarized
    entries[3].summarized = true;
    const summary = createSummary("sum-001", 1, "Summary of conversation", "Summary of conversation", "c3", ["user-001", "asst-001"], 1);
    // Insert summary at position 2 (where the first summarized entry was)
    entries.splice(2, 0, summary);

    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2);
    expect(tui[0]).toEqual({ kind: "user", text: "Hello", id: "user-001" });
    expect(tui[1]).toEqual({ kind: "assistant", text: "Hi there!", id: "asst-001" });
  });

  it("skips discarded entries", () => {
    const entries = basicLog();
    entries[3].discarded = true;
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(1);
    expect(tui[0].kind).toBe("user");
  });

  it("shows compact markers", () => {
    const entries = [
      ...basicLog(),
      createCompactMarker("cm-001", 2, 0, 100000, 20000),
      createCompactContext("cc-001", 2, "continuation", "c3", 0),
      createUserMessage("user-002", 2, "Next", "Next", "c4"),
    ];
    const tui = projectToTuiEntries(entries);
    // user + assistant + compact_mark + user (compact_context is invisible)
    expect(tui).toHaveLength(4);
    expect(tui[2].kind).toBe("compact_mark");
    expect(tui[2].text).toContain("Compacted");
  });

  it("folds old windows when compact markers >= 3", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      // Window 0
      createUserMessage("user-001", 1, "msg1", "msg1", "c1"),
      createAssistantText("asst-001", 1, 0, "reply1", "reply1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      // Window 1
      createUserMessage("user-002", 2, "msg2", "msg2", "c2"),
      createAssistantText("asst-002", 2, 0, "reply2", "reply2"),
      createCompactMarker("cm-002", 2, 1, 100, 20),
      // Window 2
      createUserMessage("user-003", 3, "msg3", "msg3", "c3"),
      createAssistantText("asst-003", 3, 0, "reply3", "reply3"),
      createCompactMarker("cm-003", 3, 2, 100, 20),
      // Window 3 (current)
      createUserMessage("user-004", 4, "msg4", "msg4", "c4"),
    ];

    const tui = projectToTuiEntries(entries);

    // First entry should be fold placeholder
    expect(tui[0].kind).toBe("status");
    expect(tui[0].text).toContain("earlier entries");

    // Should show window 1, 2, 3 (3 visible windows)
    const userEntries = tui.filter((e) => e.kind === "user");
    expect(userEntries.map((e) => e.text)).toEqual(["msg2", "msg3", "msg4"]);
  });

  it("does not fold when compact markers < 3", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "msg1", "msg1", "c1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createUserMessage("user-002", 2, "msg2", "msg2", "c2"),
      createCompactMarker("cm-002", 2, 1, 100, 20),
      createUserMessage("user-003", 3, "msg3", "msg3", "c3"),
    ];

    const tui = projectToTuiEntries(entries);
    const userEntries = tui.filter((e) => e.kind === "user");
    expect(userEntries).toHaveLength(3); // All visible
  });

  it("shows status and error entries", () => {
    const entries = [
      ...basicLog(),
      createStatus("st-001", 1, "Retrying...", "retry"),
      createError("err-001", 1, "Network error", "network"),
    ];
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(4);
    expect(tui[2]).toEqual({ kind: "status", text: "Retrying...", id: "st-001" });
    expect(tui[3]).toEqual({ kind: "error", text: "Network error", id: "err-001" });
  });

  it("ask_request and ask_resolution are invisible", () => {
    const entries = [
      ...basicLog(),
      createAskRequest("askq-001", 1, {}, "a1", "agent_question", "tc-1", 0),
      createAskResolution("askr-001", 1, {}, "a1", "agent_question"),
    ];
    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(2); // Only user + assistant
  });

  it("folds sub-agent tool calls into a single rollup block", () => {
    const entries = [
      ...basicLog(),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createSubAgentToolCall("satc-002", 1, "[#2 explorer-B] grep \"auth\" src/", 2, "explorer-B", "grep", 1),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui).toHaveLength(3);
    expect(tui[2]).toEqual({
      kind: "sub_agent_rollup",
      id: "subrollup-satc-001",
      text: [
        "Last 2 sub-agent tool calls:",
        "[#1 explorer-A] read_file src/a.ts",
        "[#2 explorer-B] grep \"auth\" src/",
      ].join("\n"),
    });
  });

  it("keeps reasoning and assistant text contiguous by delaying interleaved sub-agent tool calls", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "r0" }),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createSubAgentToolCall("satc-002", 1, "[#2 explorer-B] grep \"auth\" src/", 2, "explorer-B", "grep", 1),
      createAssistantText("asst-001", 1, 0, "Done.", "Done."),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "sub_agent_rollup",
    ]);
    expect(tui[1].text).toBe("thinking...");
    expect(tui[2].text).toBe("Done.");
    expect(tui[3].text).toContain("Last 2 sub-agent tool calls:");
  });

  it("keeps reasoning and tool_call contiguous by delaying interleaved sub-agent tool calls", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "r0" }),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createToolCall(
        "tc-001",
        1,
        0,
        "read_file src/main.ts",
        { id: "call_1", name: "read_file", arguments: { path: "src/main.ts" } },
        { toolCallId: "call_1", toolName: "read_file", agentName: "agent" },
      ),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "tool_call",
      "sub_agent_rollup",
    ]);
    expect(tui[2].text).toBe("read_file src/main.ts");
  });

  it("flushes idle-period sub-agent tool calls before the next primary-agent round", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createAssistantText("asst-001", 1, 0, "First answer", "First answer"),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer-A] read_file src/a.ts", 1, "explorer-A", "read_file", 1),
      createReasoning("rsn-001", 1, 1, "second thinking", "second thinking", { state: "r1" }),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "sub_agent_rollup",
      "reasoning",
    ]);
  });

  it("shows only the last five sub-agent tool calls and hides sub-agent lifecycle entries", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createSubAgentStart("sas-001", 1, "started", 1, "explorer", "task"),
      createSubAgentToolCall("satc-001", 1, "[#1 explorer] tool 1", 1, "explorer", "tool1", 1),
      createSubAgentToolCall("satc-002", 1, "[#1 explorer] tool 2", 1, "explorer", "tool2", 2),
      createSubAgentToolCall("satc-003", 1, "[#1 explorer] tool 3", 1, "explorer", "tool3", 3),
      createSubAgentToolCall("satc-004", 1, "[#1 explorer] tool 4", 1, "explorer", "tool4", 4),
      createSubAgentToolCall("satc-005", 1, "[#1 explorer] tool 5", 1, "explorer", "tool5", 5),
      createSubAgentToolCall("satc-006", 1, "[#1 explorer] tool 6", 1, "explorer", "tool6", 6),
      createSubAgentToolCall("satc-007", 1, "[#1 explorer] tool 7", 1, "explorer", "tool7", 7),
      createSubAgentEnd("sae-001", 1, "done", 1, "explorer", 10, 7),
      createStatus("st-001", 1, "Status line", "info"),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual(["user", "sub_agent_rollup", "sub_agent_done", "status"]);
    expect(tui[1].text).toEqual([
      "2 earlier tool calls omitted, last 5:",
      "[#1 explorer] tool 3",
      "[#1 explorer] tool 4",
      "[#1 explorer] tool 5",
      "[#1 explorer] tool 6",
      "[#1 explorer] tool 7",
    ].join("\n"));
    expect(tui[2]).toEqual({
      kind: "sub_agent_done",
      id: "sae-001",
      text: "[#1 explorer] [done] (10.0s)",
    });
  });

  it("shows sub-agent completions between waits even when there are no new tool calls", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "investigate", "investigate", "c1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "wait 120s",
        { id: "wait:1", name: "wait", arguments: { seconds: 120 } },
        { toolCallId: "wait:1", toolName: "wait", agentName: "main" },
      ),
      createSubAgentEnd("sae-001", 1, "done", 6, "investigate-other-packages", 89.4, 49),
      createReasoning("rsn-001", 1, 1, "thinking", "thinking", { state: "r1" }),
      createAssistantText("asst-001", 1, 1, "continue waiting", "continue waiting"),
      createToolCall(
        "tc-002",
        1,
        1,
        "wait 120s",
        { id: "wait:2", name: "wait", arguments: { seconds: 120 } },
        { toolCallId: "wait:2", toolName: "wait", agentName: "main" },
      ),
      createSubAgentEnd("sae-002", 1, "done", 2, "investigate-opencode", 95.4, 34),
      createReasoning("rsn-002", 1, 2, "thinking again", "thinking again", { state: "r2" }),
      createAssistantText("asst-002", 1, 2, "still waiting", "still waiting"),
    ];

    const tui = projectToTuiEntries(entries);
    expect(tui.map((entry) => entry.kind)).toEqual([
      "user",
      "tool_call",
      "sub_agent_done",
      "reasoning",
      "assistant",
      "tool_call",
      "sub_agent_done",
      "reasoning",
      "assistant",
    ]);
    expect(tui[2].text).toBe("[#6 investigate-other-packages] [done] (89.4s)");
    expect(tui[6].text).toBe("[#2 investigate-opencode] [done] (95.4s)");
  });
});

// ------------------------------------------------------------------
// API Projection
// ------------------------------------------------------------------

describe("projectToApiMessages", () => {
  it("projects basic conversation", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(msgs[1]).toMatchObject({ role: "user", content: "Hello" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "Hi there!" });
  });

  it("uses provided systemPrompt override", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries, { systemPrompt: "Override" });
    expect(msgs[0]).toEqual({ role: "system", content: "Override" });
  });

  it("handles tool calls and results", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createAssistantText("asst-001", 1, 0, "OK", "OK", "r1"),
      createToolCall("tc-001", 1, 0, "summary", { id: "call_1", name: "read_file", arguments: { path: "x.ts" } }, { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "r1" }),
      createToolResult("tr-001", 1, 0, { toolCallId: "call_1", toolName: "read_file", content: "file content", toolSummary: "read" }, { isError: false, contextId: "r1" }),
    ];
    const msgs = projectToApiMessages(entries);

    // system + user + assistant(with tool_calls) + tool_result
    expect(msgs).toHaveLength(4);

    // Assistant message should have tool_calls and text
    const assistantMsg = msgs[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "x.ts" } }]);
    expect(assistantMsg.text).toBe("OK"); // text field when tool_calls present
    expect(assistantMsg._context_id).toBe("r1");

    // Tool result
    const toolResult = msgs[3];
    expect(toolResult.role).toBe("tool_result");
    expect(toolResult.tool_call_id).toBe("call_1");
    expect(toolResult.content).toBe("file content");
  });

  it("handles reasoning in assistant messages", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "think", "think", "c1"),
      createReasoning("rsn-001", 1, 0, "thinking...", "thinking...", { state: "abc" }),
      createAssistantText("asst-001", 1, 0, "result", "result"),
    ];
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);

    const assistantMsg = msgs[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("result");
    expect(assistantMsg.reasoning_content).toBe("thinking...");
    expect(assistantMsg._reasoning_state).toEqual({ state: "abc" });
  });

  it("handles no_reply", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "wait", "wait", "c1"),
      createNoReply("nr-001", 1, 0, "<NO_REPLY>"),
    ];
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(3);
    expect(msgs[2].content).toBe("<NO_REPLY>");
  });

  it("windows to last compact marker", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      // Old window
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createAssistantText("asst-001", 1, 0, "old reply", "old reply"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      // New window
      createCompactContext("cc-001", 2, "continuation", "c2", 0),
      createUserMessage("user-002", 2, "new", "new", "c3"),
    ];
    const msgs = projectToApiMessages(entries);

    // system + compact_context(user) + new user
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toMatchObject({ role: "user", content: "continuation" });
    expect(msgs[2]).toMatchObject({ role: "user", content: "new" });
  });

  it("annotates compact_context when show_context is active", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createCompactContext("cc-001", 2, "continuation", "c2", 0),
      createUserMessage("user-002", 2, "new", "new", "c3"),
    ];
    const msgs = projectToApiMessages(entries, {
      showContextAnnotations: new Map([
        ["c2", "§{c2}§ <1k — auto-compact"],
      ]),
    });

    expect(msgs[1]).toEqual({
      role: "user",
      content: "§{c2}§ <1k — auto-compact\n\ncontinuation",
      _context_id: "c2",
    });
  });

  it("skips summarized entries", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "c1"),
      createAssistantText("asst-001", 1, 0, "old reply", "old reply"),
      createUserMessage("user-002", 2, "newer", "newer", "c2"),
    ];
    entries[1].summarized = true;
    entries[2].summarized = true;

    // Insert summary
    const summary = createSummary("sum-001", 1, "Summary", "Summary text", "c3", ["user-001", "asst-001"], 1);
    entries.splice(1, 0, summary);

    const msgs = projectToApiMessages(entries);
    // system + summary(user) + user
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toMatchObject({ role: "user", content: "Summary text" });
  });

  it("skips discarded entries", () => {
    const entries = basicLog();
    entries[3].discarded = true;
    const msgs = projectToApiMessages(entries);
    expect(msgs).toHaveLength(2); // system + user
  });

  it("handles interruption_marker as user message", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createAssistantText("asst-001", 1, 0, "partial", "partial"),
      createInterruptionMarker("int-001", 1, "[System]: interrupted"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant + interruption(user)
    expect(msgs).toHaveLength(4);
    expect(msgs[3]).toEqual({ role: "user", content: "[System]: interrupted" });
  });

  it("skips sub_agent entries (apiRole null)", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "do it", "do it", "c1"),
      createSubAgentStart("sas-001", 1, "started", 1, "ex", "task"),
      createSubAgentEnd("sae-001", 1, "done", 1, "ex", 10, 5),
      createAssistantText("asst-001", 1, 0, "done", "done"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant (sub-agent entries skipped)
    expect(msgs).toHaveLength(3);
  });

  it("injects important log", () => {
    const entries = basicLog();
    const msgs = projectToApiMessages(entries, { importantLog: "Remember: use TypeScript" });
    // Important log merged into first user message
    expect(msgs).toHaveLength(3);
    expect((msgs[1].content as string)).toContain("[IMPORTANT LOG]");
    expect((msgs[1].content as string)).toContain("Remember: use TypeScript");
    expect((msgs[1].content as string)).toContain("Hello");
  });

  it("multiple rounds in same turn", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "multi", "multi", "c1"),
      // Round 0: tool call
      createAssistantText("asst-001", 1, 0, "Let me check", "Let me check"),
      createToolCall("tc-001", 1, 0, "reading", { id: "call_1", name: "read", arguments: {} }, { toolCallId: "call_1", toolName: "read", agentName: "a" }),
      createToolResult("tr-001", 1, 0, { toolCallId: "call_1", toolName: "read", content: "data", toolSummary: "ok" }, { isError: false }),
      // Round 1: final reply
      createAssistantText("asst-002", 1, 1, "Done", "Done"),
    ];
    const msgs = projectToApiMessages(entries);
    // system + user + assistant(round0 with tool_calls) + tool_result + assistant(round1)
    expect(msgs).toHaveLength(5);
    expect(msgs[2].tool_calls).toBeDefined();
    expect(msgs[4].content).toBe("Done");
  });
});
