import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Session } from "../src/session.js";
import { executeTool } from "../src/tools/basic.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Phase 2 tool validation and grep limits", () => {
  it("validates high-risk basic tool arguments at runtime", async () => {
    const root = makeTempDir("longeragent-phase2-basic-");
    try {
      const readBad = await executeTool("read_file", { path: 123 as unknown as string }, { projectRoot: root });
      expect(readBad.content).toContain("Invalid arguments for read_file");
      expect(readBad.content).toContain("'path' must be a string");

      const bashBad = await executeTool(
        "bash",
        { command: "echo hi", timeout: 1.5 as unknown as number },
        { projectRoot: root },
      );
      expect(bashBad.content).toContain("Invalid arguments for bash");
      expect(bashBad.content).toContain("'timeout' must be an integer");

      const editBad = await executeTool(
        "edit_file",
        { path: "a.txt", old_str: "", new_str: "x" },
        { projectRoot: root },
      );
      expect(editBad.content).toContain("Invalid arguments for edit_file");
      expect(editBad.content).toContain("'old_str' must be a non-empty string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects risky/overlong regex patterns before grep execution", async () => {
    const root = makeTempDir("longeragent-phase2-search-regex-");
    try {
      writeFileSync(join(root, "a.txt"), "aaaaab\n", "utf-8");

      const tooLong = await executeTool(
        "grep",
        { pattern: "a".repeat(301), path: "." },
        { projectRoot: root },
      );
      expect(tooLong.content).toContain("Invalid arguments for grep");
      expect(tooLong.content).toContain("max length");

      const risky = await executeTool(
        "grep",
        { pattern: "(a+)+$", path: "." },
        { projectRoot: root },
      );
      expect(risky.content).toContain("Regex appears too complex/risky");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces grep depth and file-size limits with notices", async () => {
    const root = makeTempDir("longeragent-phase2-search-limits-");
    try {
      // Depth > 6 should be skipped
      let deep = root;
      for (let i = 0; i < 8; i++) {
        deep = join(deep, `d${i}`);
        mkdirSync(deep);
      }
      writeFileSync(join(deep, "too-deep.txt"), "needle\n", "utf-8");

      // Large file > 1MB should be skipped
      writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 10) + "needle", "utf-8");

      const result = await executeTool(
        "grep",
        { pattern: "needle", path: "." },
        { projectRoot: root },
      );

      expect(result.content).toContain("No matches found.");
      expect(result.content).toContain("[Search notices]");
      expect(result.content).toContain("Depth limit reached");
      expect(result.content).toContain("Skipped 1 large file(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats explicit empty content_b as provided input for diff", async () => {
    const root = makeTempDir("longeragent-phase2-diff-empty-");
    const externalRoot = makeTempDir("longeragent-phase2-diff-ext-");
    try {
      writeFileSync(join(root, "a.txt"), "hello\n", "utf-8");
      const outside = join(externalRoot, "outside.txt");
      writeFileSync(outside, "outside\n", "utf-8");

      const result = await executeTool(
        "diff",
        { file_a: "a.txt", file_b: outside, content_b: "" },
        { projectRoot: root },
      );

      expect(result.content).toContain("+++ (provided content)");
      expect(result.content).not.toContain("project root boundary");
      expect(result.content).not.toContain("Provide either file_b or content_b");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("returns a diff preview metadata block for edit_file", async () => {
    const root = makeTempDir("longeragent-phase2-edit-preview-");
    try {
      writeFileSync(join(root, "a.txt"), "line 1\nold value\nline 3\n", "utf-8");

      const result = await executeTool(
        "edit_file",
        { path: "a.txt", old_str: "old value", new_str: "new value" },
        { projectRoot: root },
      );

      expect(result.content).toContain("OK: File edited successfully.");
      expect(result.metadata.path).toBe(join(root, "a.txt"));
      expect(result.metadata.tui_preview).toBeTruthy();
      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("| -old value");
      expect(String(preview.text)).toContain("| +new value");
      expect(String(preview.text)).toMatch(/^\s*2\s+\|\s-old value$/m);
      expect(String(preview.text)).toMatch(/^\s*2\s+\|\s\+new value$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collapses large edit diffs to head and tail previews", async () => {
    const root = makeTempDir("longeragent-phase2-edit-preview-large-");
    try {
      const oldBlock = Array.from({ length: 80 }, (_, i) => `old ${i + 1}`).join("\n");
      const newBlock = Array.from({ length: 80 }, (_, i) => `new ${i + 1}`).join("\n");
      writeFileSync(join(root, "big.txt"), `before\n${oldBlock}\nafter\n`, "utf-8");

      const result = await executeTool(
        "edit_file",
        { path: "big.txt", old_str: oldBlock, new_str: newBlock },
        { projectRoot: root },
      );

      const preview = result.metadata.tui_preview as Record<string, unknown>;
      expect(preview.kind).toBe("diff");
      expect(String(preview.text)).toContain("old 1");
      expect(String(preview.text)).toContain("new 80");
      expect(String(preview.text)).toContain("diff lines omitted");
      expect(String(preview.text)).toContain("diff preview truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates comm tool arguments at runtime", async () => {
    const fake = Object.create(Session.prototype) as any;
    fake._activeAgents = new Map();
    fake._progress = undefined;
    fake._turnCount = 0;
    fake._hasActiveAgents = () => false;

    const killBad = Session.prototype["_execKillAgent"].call(fake, { ids: "a" });
    expect(killBad.content).toContain("invalid arguments for kill_agent");

    const spawnBad = await Session.prototype["_execSpawnAgents"].call(fake, { file: 123 });
    expect(spawnBad.content).toContain("invalid arguments for spawn_agent");

    const askBad = Session.prototype["_execAsk"].call(fake, { questions: "bad" });
    expect(askBad.content).toContain("Error: 'questions' must be an array of 1-4 items.");
  });
});
