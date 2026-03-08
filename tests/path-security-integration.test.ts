import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
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

describe("path security integration", () => {
  it("enforces project-root boundary for file tools via executeTool context", async () => {
    const projectRoot = makeTempDir("longeragent-tool-root-");
    const externalRoot = makeTempDir("longeragent-tool-ext-");
    try {
      const insideFile = join(projectRoot, "inside.txt");
      writeFileSync(insideFile, "hello\n", "utf-8");

      const insideRead = await executeTool(
        "read_file",
        { path: "inside.txt" },
        { projectRoot },
      );
      expect(insideRead.content).toContain("hello");

      const outsideFile = join(externalRoot, "outside.txt");
      writeFileSync(outsideFile, "outside\n", "utf-8");

      const cases: Array<[string, Record<string, unknown>]> = [
        ["read_file", { path: outsideFile }],
        ["list_dir", { path: externalRoot }],
        ["grep", { pattern: "outside", path: externalRoot }],
        ["edit_file", { path: outsideFile, old_str: "outside", new_str: "edited" }],
        ["write_file", { path: join(externalRoot, "new.txt"), content: "x" }],
        ["diff", { file_a: outsideFile, content_b: "changed" }],
      ];

      for (const [toolName, args] of cases) {
        const result = await executeTool(toolName, args, { projectRoot });
        expect(result.content).toContain("project root boundary");
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects spawn_agents call files outside SESSION_ARTIFACTS", async () => {
    const artifactsDir = makeTempDir("longeragent-artifacts-");
    try {
      const fakeSession = Object.create(Session.prototype) as any;
      fakeSession._resolveSessionArtifacts = () => artifactsDir;

      const result = await (Session.prototype as any)._execSpawnAgents.call(
        fakeSession,
        { file: "../outside.yaml" },
      );

      expect(result.content).toContain("must be within SESSION_ARTIFACTS");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("enforces SESSION_ARTIFACTS boundary for template_path (including symlink escapes)", () => {
    const artifactsDir = makeTempDir("longeragent-template-artifacts-");
    const externalDir = makeTempDir("longeragent-template-ext-");
    try {
      const validTemplate = join(artifactsDir, "my-template");
      mkdirSync(validTemplate, { recursive: true });
      writeFileSync(
        join(validTemplate, "agent.yaml"),
        "type: agent\nname: test\nsystem_prompt: hello\nmax_tool_rounds: 100\n",
        "utf-8",
      );

      const fakeSession = {
        _resolveSessionArtifacts: () => artifactsDir,
      };

      const resolved = (Session.prototype as any)._resolveTemplatePath.call(
        fakeSession,
        "my-template",
      );
      expect(resolved).toBe(validTemplate);

      expect(() =>
        (Session.prototype as any)._resolveTemplatePath.call(fakeSession, "../escape"),
      ).toThrow(/within SESSION_ARTIFACTS/);

      const linkDir = join(artifactsDir, "linked-template");
      try {
        symlinkSync(externalDir, linkDir, "dir");
      } catch (e: any) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          return;
        }
        throw e;
      }

      mkdirSync(externalDir, { recursive: true });
      writeFileSync(
        join(externalDir, "agent.yaml"),
        "type: agent\nname: ext\nsystem_prompt: hello\nmax_tool_rounds: 100\n",
        "utf-8",
      );

      expect(() =>
        (Session.prototype as any)._resolveTemplatePath.call(fakeSession, "linked-template"),
      ).toThrow(/symbolic link/);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
