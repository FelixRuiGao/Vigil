import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeTool } from "../src/tools/basic.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("apply_patch tool", () => {
  it("applies add/update/append/delete in one patch", async () => {
    const root = makeTempDir("longeragent-apply-patch-");
    try {
      writeFileSync(join(root, "modify.txt"), "line 1\nold value\n", "utf-8");
      writeFileSync(join(root, "append.txt"), "alpha\n", "utf-8");
      writeFileSync(join(root, "delete.txt"), "remove me\n", "utf-8");

      const patch = [
        "*** Begin Patch",
        "*** Add File: nested/new.txt",
        "+created",
        "*** Update File: modify.txt",
        "@@",
        "-old value",
        "+new value",
        "*** Append File: append.txt",
        "+beta",
        "+gamma",
        "*** Delete File: delete.txt",
        "*** End Patch",
      ].join("\n");

      const result = await executeTool("apply_patch", { patch }, { projectRoot: root });
      expect(result.content).toContain("Success. Updated the following files:");
      expect(result.content).toContain("A nested/new.txt");
      expect(result.content).toContain("M modify.txt");
      expect(result.content).toContain("M append.txt");
      expect(result.content).toContain("D delete.txt");
      expect(String((result.metadata.tui_preview as Record<string, unknown>).text)).toContain("new value");

      expect(readFileSync(join(root, "modify.txt"), "utf-8")).toBe("line 1\nnew value\n");
      expect(readFileSync(join(root, "append.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
      expect(readFileSync(join(root, "nested", "new.txt"), "utf-8")).toBe("created");
      expect(existsSync(join(root, "delete.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails validation before writing when any target cannot be prepared", async () => {
    const root = makeTempDir("longeragent-apply-patch-fail-");
    try {
      writeFileSync(join(root, "keep.txt"), "safe\n", "utf-8");

      const patch = [
        "*** Begin Patch",
        "*** Add File: created.txt",
        "+hello",
        "*** Update File: missing.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");

      const result = await executeTool("apply_patch", { patch }, { projectRoot: root });
      expect(result.content).toContain("ERROR: apply_patch verification failed");
      expect(existsSync(join(root, "created.txt"))).toBe(false);
      expect(readFileSync(join(root, "keep.txt"), "utf-8")).toBe("safe\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
