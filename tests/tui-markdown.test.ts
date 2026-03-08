import { describe, expect, it } from "vitest";
import {
  renderMarkdownForDisplay,
  splitStreamingMarkdown,
} from "../src/tui/components/conversation-panel.js";

describe("streaming markdown split", () => {
  it("keeps an incomplete trailing line as raw tail", () => {
    const split = splitStreamingMarkdown("line1\nline2");
    expect(split).toEqual({
      stable: "line1\n",
      tail: "line2",
    });
  });

  it("keeps an unclosed fenced block in raw tail", () => {
    const input = "intro\n```ts\nconst x = 1;\n";
    const split = splitStreamingMarkdown(input);
    expect(split).toEqual({
      stable: "intro\n",
      tail: "```ts\nconst x = 1;\n",
    });
  });

  it("keeps incomplete trailing table in raw tail", () => {
    const input = "## Title\n\n| A | B |\n| --- | --- |\n";
    const split = splitStreamingMarkdown(input);
    expect(split).toEqual({
      stable: "## Title\n\n",
      tail: "| A | B |\n| --- | --- |\n",
    });
  });
});

describe("markdown rendering consistency", () => {
  it("parses strong tokens inside list items", () => {
    const out = renderMarkdownForDisplay("- **AI 早报**: 每日汇总", 120);
    expect(out).not.toContain("**AI 早报**");
    expect(out).toContain("AI 早报");
    expect(out).toContain("- ");
  });

  it("parses strong tokens inside table cells", () => {
    const out = renderMarkdownForDisplay(
      "| 能力 | 说明 |\n| --- | --- |\n| **写代码** | 生成代码 |\n",
      120,
    );
    expect(out).not.toContain("**写代码**");
    expect(out).toContain("写代码");
  });

  it("does not syntax-highlight unlabeled fenced code blocks", () => {
    const out = renderMarkdownForDisplay(
      "```\n已分析：\n- packages/opencode/src/agents/agent.ts\n- packages/opencode/src/ 的部分目录\n```",
      120,
    );
    expect(out).toContain("packages/opencode/src/agents/agent.ts");
    expect(out).toContain("packages/opencode/src/ 的部分目录");
    expect(out).not.toMatch(/\u001b\[[0-9;]*m/);
  });
});
