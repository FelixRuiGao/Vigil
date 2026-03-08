import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Session } from "../src/session.js";
import { executeTool } from "../src/tools/basic.js";

vi.mock("markitdown-ts", () => ({
  MarkItDown: class {
    async convert(source: string): Promise<{ markdown: string }> {
      if (source.endsWith(".docx")) {
        return { markdown: "# Converted DOCX\n\nDocx body\n".repeat(40) };
      }
      if (source.endsWith(".xlsx")) {
        return { markdown: "# Converted XLSX\n\n| A | B |\n| - | - |\n| 1 | 2 |\n".repeat(40) };
      }
      return {
        markdown: "# Converted PDF\n\nThis is a converted PDF body.\n".repeat(200),
      };
    }
  },
}));

async function callProcessFileAttachments(
  userInput: string,
  supportsMultimodal: boolean,
  projectRoot?: string,
  sessionArtifactsOverride?: string,
): Promise<string | Array<Record<string, unknown>>> {
  const fakeSession = {
    _projectRoot: projectRoot,
    _sessionArtifactsOverride: sessionArtifactsOverride,
    primaryAgent: {
      modelConfig: {
        supportsMultimodal,
      },
    },
  };
  return (Session.prototype as any)._processFileAttachments.call(fakeSession, userInput);
}

describe("Session file attachment integration", () => {
  it("injects text file context and removes @path from user text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longeragent-attach-text-"));
    try {
      const filePath = join(dir, "note.txt");
      writeFileSync(filePath, "hello from file\nsecond line\n", "utf-8");

      const result = await callProcessFileAttachments(`Please inspect @${filePath}`, false, dir);

      expect(typeof result).toBe("string");
      const text = result as string;
      expect(text).toContain("Please inspect");
      expect(text).not.toContain(`@${filePath}`);
      expect(text).toContain("<context label=\"User Files\">");
      expect(text).toContain("hello from file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds multimodal content parts for image attachments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longeragent-attach-img-"));
    try {
      const imgPath = join(dir, "tiny.png");
      // Bytes are enough for attachment packaging; image decoding is not performed here.
      writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

      const result = await callProcessFileAttachments(`Analyze this @${imgPath}`, true, dir);

      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<Record<string, unknown>>;

      const textParts = parts.filter((p) => p["type"] === "text");
      const imageParts = parts.filter((p) => p["type"] === "image");

      expect(imageParts).toHaveLength(1);
      expect(imageParts[0]["media_type"]).toBe("image/png");
      expect(typeof imageParts[0]["data"]).toBe("string");
      expect((imageParts[0]["data"] as string).length).toBeGreaterThan(0);

      expect(textParts.length).toBeGreaterThanOrEqual(1);
      const joinedText = textParts.map((p) => String(p["text"] ?? "")).join("\n");
      expect(joinedText).toContain("Analyze this");
      expect(joinedText).not.toContain(`@${imgPath}`);
      expect(joinedText).toContain("<context label=\"User Files\">");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows explicit external @file attachments in the current turn", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "longeragent-project-"));
    const externalDir = mkdtempSync(join(tmpdir(), "longeragent-external-"));
    try {
      const externalFile = join(externalDir, "secret.txt");
      writeFileSync(externalFile, "top secret\n", "utf-8");

      const result = await callProcessFileAttachments(`Check @${externalFile}`, false, projectDir);

      expect(typeof result).toBe("string");
      const text = result as string;
      expect(text).toContain("Check");
      expect(text).toContain("<context label=\"User Files\">");
      expect(text).toContain("top secret");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("converts PDF attachments to a hidden markdown view and keeps the original path for follow-up reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longeragent-attach-pdf-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "longeragent-attach-artifacts-"));
    try {
      const pdfPath = join(dir, "paper.pdf");
      writeFileSync(pdfPath, Buffer.from("%PDF-1.4\nfake\n"));

      const result = await callProcessFileAttachments(
        `Review @${pdfPath}`,
        false,
        dir,
        artifactsDir,
      );

      expect(typeof result).toBe("string");
      const text = result as string;
      expect(text).toContain("Review");
      expect(text).toContain("Converted PDF");
      expect(text).not.toContain(".pdf.md");
      expect(text).toContain(`Use read_file on the original path (${pdfPath})`);

      const readResult = await executeTool(
        "read_file",
        { path: pdfPath, start_line: 1, end_line: 5 },
        { projectRoot: dir, sessionArtifactsDir: artifactsDir },
      );
      expect(readResult.content).toContain("Auto-extracted Markdown view");
      expect(readResult.content).toContain(pdfPath);
      expect(readResult.content).toContain("Converted PDF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("routes DOCX and XLSX reads through the same extracted-markdown path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longeragent-attach-docproj-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "longeragent-attach-docproj-artifacts-"));
    try {
      const docxPath = join(dir, "spec.docx");
      const xlsxPath = join(dir, "table.xlsx");
      writeFileSync(docxPath, Buffer.from("fake-docx"));
      writeFileSync(xlsxPath, Buffer.from("fake-xlsx"));

      const docxResult = await executeTool(
        "read_file",
        { path: docxPath, start_line: 1, end_line: 4 },
        { projectRoot: dir, sessionArtifactsDir: artifactsDir },
      );
      expect(docxResult.content).toContain("DOCX source");
      expect(docxResult.content).toContain("Converted DOCX");

      const xlsxResult = await executeTool(
        "read_file",
        { path: xlsxPath, start_line: 1, end_line: 6 },
        { projectRoot: dir, sessionArtifactsDir: artifactsDir },
      );
      expect(xlsxResult.content).toContain("XLSX source");
      expect(xlsxResult.content).toContain("Converted XLSX");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("reports PPTX projection as unavailable in the current runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "longeragent-attach-pptx-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "longeragent-attach-pptx-artifacts-"));
    try {
      const pptxPath = join(dir, "slides.pptx");
      writeFileSync(pptxPath, Buffer.from("fake-pptx"));

      const result = await executeTool(
        "read_file",
        { path: pptxPath },
        { projectRoot: dir, sessionArtifactsDir: artifactsDir },
      );

      expect(result.content).toContain("PPTX projection is not yet available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
