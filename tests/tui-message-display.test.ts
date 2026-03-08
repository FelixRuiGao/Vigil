import { describe, expect, it } from "vitest";

import { extractDisplayText } from "../src/tui/message-display.js";

describe("extractDisplayText", () => {
  it("extracts text blocks and replaces images with a readable placeholder", () => {
    const content = [
      { type: "text", text: "里面是什么" },
      { type: "image", note: "stripped", media_type: "image/png" },
      { type: "text", text: "<context label=\"User Files\">X</context>" },
    ];

    const out = extractDisplayText(content);

    expect(out).toContain("里面是什么");
    expect(out).toContain("[image: image/png]");
    expect(out).toContain("<context label=\"User Files\">X</context>");
    expect(out).not.toContain("{\"type\":\"image\"");
  });

  it("uses placeholders for unknown structured blocks instead of raw JSON", () => {
    const content = [
      { type: "tool_use", name: "grep", input: { pattern: "abc" } },
      { type: "text", text: "done" },
    ];

    const out = extractDisplayText(content);

    expect(out).toContain("[tool_use]");
    expect(out).toContain("done");
    expect(out).not.toContain("\"input\":");
  });
});
