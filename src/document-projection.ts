import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECTED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
const PROJECTION_CACHE_DIR = ".document-projections";

type MarkItDownLike = {
  convert: (source: string) => Promise<{ markdown: string } | null | undefined>;
};

export interface ProjectedDocumentView {
  sourcePath: string;
  sourceExt: string;
  text: string;
  sizeBytes: number;
  mtimeMs: number;
}

let markItDownPromise: Promise<MarkItDownLike> | null = null;

function normalizeDocBaseName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)) || "document";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 64) || "document";
}

function buildCachePath(filePath: string, artifactsDir: string, sizeBytes: number, mtimeMs: number): string {
  const ext = path.extname(filePath).toLowerCase();
  const safeBase = normalizeDocBaseName(filePath);
  const hash = createHash("sha256")
    .update(`${filePath}:${sizeBytes}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 10);
  return path.join(artifactsDir, PROJECTION_CACHE_DIR, `${safeBase}-${hash}${ext}.md`);
}

async function getMarkItDown(): Promise<MarkItDownLike> {
  if (!markItDownPromise) {
    markItDownPromise = import("markitdown-ts").then((mod) => new mod.MarkItDown());
  }
  return markItDownPromise;
}

export function isProjectedDocumentPath(filePath: string): boolean {
  return PROJECTED_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function projectedDocumentLabel(filePath: string): string {
  return path.extname(filePath).toLowerCase().slice(1).toUpperCase() || "document";
}

export async function loadProjectedDocumentView(
  filePath: string,
  artifactsDir?: string,
): Promise<ProjectedDocumentView> {
  const ext = path.extname(filePath).toLowerCase();
  if (!PROJECTED_DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported projected document type: ${ext || "(no extension)"}`);
  }
  if (ext === ".pptx") {
    throw new Error("PPTX projection is not yet available in this runtime.");
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  let cachePath: string | null = null;
  if (artifactsDir) {
    cachePath = buildCachePath(filePath, artifactsDir, stat.size, stat.mtimeMs);
    if (existsSync(cachePath)) {
      return {
        sourcePath: filePath,
        sourceExt: ext,
        text: readFileSync(cachePath, "utf-8"),
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      };
    }
  }

  const markItDown = await getMarkItDown();
  const result = await markItDown.convert(filePath);
  const markdown = result?.markdown?.trim();
  if (!markdown) {
    throw new Error(`${projectedDocumentLabel(filePath)} conversion produced no text.`);
  }

  if (cachePath) {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, markdown, "utf-8");
  }

  return {
    sourcePath: filePath,
    sourceExt: ext,
    text: markdown,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}
