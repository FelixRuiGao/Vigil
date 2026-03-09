/**
 * Built-in tool definitions and executors.
 *
 * 15 tools: read_file, list_dir, glob, grep, edit_file, write_file,
 * apply_patch, bash, bash_background, bash_output, kill_shell,
 * diff, test, web_search, web_fetch.
 */

import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { ToolDef } from "../providers/base.js";
import { ToolResult } from "../providers/base.js";
import {
  safePath,
  SafePathError,
  type PathAccessKind,
} from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import {
  WEB_SEARCH,
  toolBuiltinWebSearchPassthrough,
} from "./web-search.js";
import { WEB_FETCH, toolWebFetch } from "./web-fetch.js";
import {
  isProjectedDocumentPath,
  loadProjectedDocumentView,
  projectedDocumentLabel,
} from "../document-projection.js";
import { classifyFile, IMAGE_MEDIA_TYPES } from "../file-attach.js";

// ------------------------------------------------------------------
// Bash safety limits
// ------------------------------------------------------------------

const BASH_MAX_TIMEOUT = 600; // 10 minutes hard cap (seconds)
const BASH_DEFAULT_TIMEOUT = 60;
const BASH_MAX_OUTPUT_CHARS = 200_000; // ~200 KB text cap per stream
const BASH_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const BASH_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "USER",
  "LOGNAME",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]);

// ------------------------------------------------------------------
// Read limits
// ------------------------------------------------------------------

const READ_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const READ_MAX_LINES = 1000;
const READ_MAX_CHARS = 50_000;
const READ_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB limit for images

// ------------------------------------------------------------------
// Search safety limits
// ------------------------------------------------------------------

const SEARCH_MAX_RESULTS = 50;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_FILES = 2_000;
const SEARCH_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB per file
const SEARCH_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB total scanned text
const SEARCH_MAX_PATTERN_LENGTH = 300;
const SEARCH_MAX_DURATION_MS = 2_000;

// ------------------------------------------------------------------
// File write safety (Phase 5)
// ------------------------------------------------------------------

const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();

// ======================================================================
// Tool definitions (provider-agnostic JSON Schema)
// ======================================================================

const READ: ToolDef = {
  name: "read_file",
  description:
    "Read the contents of a text file (max 50 MB). " +
    "Some document formats such as PDF, DOCX, and XLSX are returned as an auto-extracted Markdown view of the original file. " +
    "Returns line window plus file metadata (including mtime_ms) for optional optimistic concurrency checks. " +
    "Each call returns at most 1000 lines and 50000 characters. " +
    "If the file exceeds these limits, the output is truncated with a notice. " +
    "Use start_line / end_line to navigate large files in multiple calls. " +
    "If both are omitted, reads from the beginning up to the limit.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path",
      },
      start_line: {
        type: "integer",
        description: "First line to read (1-indexed, inclusive). Defaults to 1.",
      },
      end_line: {
        type: "integer",
        description:
          "Last line to read (1-indexed, inclusive). " +
          "Use -1 to read to the end of the file.",
      },
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is reading {path}",
};

const LIST: ToolDef = {
  name: "list_dir",
  description: "List files and directories. Returns a tree up to 2 levels deep.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (default: current directory)",
        default: ".",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is listing {path}",
};


const EDIT: ToolDef = {
  name: "edit_file",
  description:
    "Apply a minimal patch to an existing file by replacing a unique string with a new string. The old_str must appear exactly once in the file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_str: {
        type: "string",
        description: "Exact string to find (must be unique in the file)",
      },
      new_str: { type: "string", description: "Replacement string" },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard. " +
          "If provided, edit is rejected when the file mtime differs (milliseconds since epoch).",
      },
    },
    required: ["path", "old_str", "new_str"],
  },
  summaryTemplate: "{agent} is editing {path}",
};

const WRITE: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full file content" },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard for overwrites. " +
          "If provided, write is rejected when the existing file mtime differs (milliseconds since epoch).",
      },
    },
    required: ["path", "content"],
  },
  summaryTemplate: "{agent} is writing to {path}",
};

const APPLY_PATCH: ToolDef = {
  name: "apply_patch",
  description:
    "Apply a structured multi-file patch. " +
    "Use for multi-hunk edits, appending to large files, and coordinated file changes. " +
    "Patch syntax uses explicit markers such as '*** Begin Patch', " +
    "'*** Update File:', '*** Append File:', '*** Add File:', '*** Delete File:', and '*** End Patch'.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Full patch text. Example:\n" +
          "*** Begin Patch\n" +
          "*** Update File: src/app.ts\n" +
          "@@\n" +
          "-old line\n" +
          "+new line\n" +
          "*** End Patch",
      },
    },
    required: ["patch"],
  },
  summaryTemplate: "{agent} is applying a patch",
};

const BASH: ToolDef = {
  name: "bash",
  description: "Execute a shell command and return stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: {
        type: "integer",
        description: `Timeout in seconds (default: ${BASH_DEFAULT_TIMEOUT}, max: ${BASH_MAX_TIMEOUT})`,
        default: BASH_DEFAULT_TIMEOUT,
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command (default: current directory)",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is running a shell command",
};

const DIFF: ToolDef = {
  name: "diff",
  description:
    "Show unified diff between two files, or between a file's current content and provided new content.",
  parameters: {
    type: "object",
    properties: {
      file_a: { type: "string", description: "Path to first file" },
      file_b: {
        type: "string",
        description: "Path to second file (optional if content_b is given)",
        default: "",
      },
      content_b: {
        type: "string",
        description:
          "Content to compare against file_a (optional if file_b is given)",
        default: "",
      },
    },
    required: ["file_a"],
  },
  summaryTemplate: "{agent} is comparing {file_a}",
};

const TEST: ToolDef = {
  name: "test",
  description: "Run a test command (e.g. pytest, unittest) and return the result.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Test command to run (default: 'python -m pytest')",
        default: "python -m pytest",
      },
      timeout: {
        type: "integer",
        description: "Timeout in seconds (default: 60)",
        default: 60,
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is running tests",
};

// ------------------------------------------------------------------
// Glob tool
// ------------------------------------------------------------------

const GLOB_MAX_RESULTS = 200;
const GLOB_MAX_FILES_SCANNED = 10_000;
const GLOB_MAX_DEPTH = 10;

const GLOB: ToolDef = {
  name: "glob",
  description:
    "Find files by name pattern. Returns matching paths sorted by modification time.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match (e.g. \"**/*.ts\", \"src/**/*.test.tsx\")",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory)",
        default: ".",
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is finding files matching '{pattern}'",
};

// ------------------------------------------------------------------
// Grep tool (enhanced search)
// ------------------------------------------------------------------

const GREP: ToolDef = {
  name: "grep",
  description:
    "Search file contents using regex. Supports context lines, glob filtering, and multiple output modes.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: current directory)",
        default: ".",
      },
      glob: {
        type: "string",
        description: "Glob pattern to filter files (e.g. \"*.ts\", \"*.{ts,tsx}\")",
      },
      type: {
        type: "string",
        description: "File type filter by extension (e.g. \"js\", \"py\", \"ts\")",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "Output mode: \"content\" (matching lines with context), " +
          "\"files_with_matches\" (file paths only, default), " +
          "\"count\" (match counts per file)",
      },
      "-A": {
        type: "integer",
        description: "Lines to show after each match (content mode only)",
      },
      "-B": {
        type: "integer",
        description: "Lines to show before each match (content mode only)",
      },
      "-C": {
        type: "integer",
        description: "Lines to show before and after each match (content mode only)",
      },
      "-i": {
        type: "boolean",
        description: "Case insensitive search",
      },
      "-n": {
        type: "boolean",
        description: "Show line numbers (default true for content mode)",
      },
      head_limit: {
        type: "integer",
        description: "Limit output to first N entries",
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is searching for '{pattern}'",
};

// ------------------------------------------------------------------
// Background shell tools (tracked by Session)
// ------------------------------------------------------------------

export const BASH_BACKGROUND_TOOL: ToolDef = {
  name: "bash_background",
  description:
    "Start a background shell command tracked by the Session. " +
    "Use for dev servers, watchers, and long-running commands whose output you want to inspect later.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute in the background." },
      cwd: { type: "string", description: "Optional working directory for the command." },
      id: {
        type: "string",
        description: "Optional stable shell ID. If omitted, the Session generates one.",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is starting a background shell",
};

export const BASH_OUTPUT_TOOL: ToolDef = {
  name: "bash_output",
  description:
    "Read output from a tracked background shell. " +
    "By default, returns unread output since the last bash_output call for that shell. " +
    "Use tail_lines to inspect recent output without advancing the unread cursor.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Tracked shell ID." },
      tail_lines: {
        type: "integer",
        description: "Optional: return the last N lines without advancing unread state.",
      },
      max_chars: {
        type: "integer",
        description: "Optional max characters to return (default 8000).",
      },
    },
    required: ["id"],
  },
  summaryTemplate: "{agent} is reading background shell output",
};

export const KILL_SHELL_TOOL: ToolDef = {
  name: "kill_shell",
  description:
    "Terminate one or more tracked background shells. " +
    "Use when a watcher or dev server is no longer needed, or a command is stuck.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Tracked shell IDs to terminate.",
      },
      signal: {
        type: "string",
        description: "Optional signal name (default TERM).",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is terminating background shells",
};

// ------------------------------------------------------------------
// Exports: tool lists
// ------------------------------------------------------------------

export const BASIC_TOOLS: ToolDef[] = [
  READ,
  LIST,
  GLOB,
  GREP,
  EDIT,
  WRITE,
  APPLY_PATCH,
  BASH,
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  DIFF,
  TEST,
  WEB_SEARCH,
  WEB_FETCH,
];

export const BASIC_TOOLS_MAP: Record<string, ToolDef> = Object.fromEntries(
  BASIC_TOOLS.map((t) => [t.name, t]),
);

// ======================================================================
// Tool executors
// ======================================================================

// ------------------------------------------------------------------
// read_file
// ------------------------------------------------------------------

async function toolReadFile(
  filePath: string,
  startLine?: number,
  endLine?: number,
  artifactsDir?: string,
  supportsMultimodal?: boolean,
): Promise<string | ToolResult> {
  const sensitiveReason = getSensitiveFileReadReason(filePath);
  if (sensitiveReason) {
    return `ERROR: Access to sensitive file is blocked by default: ${filePath} (${sensitiveReason}).`;
  }

  if (!existsSync(filePath)) {
    return `ERROR: File not found: ${filePath}`;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!stat.isFile()) {
    return `ERROR: Not a file: ${filePath}`;
  }

  // --- Image file handling ---
  const [isImage] = classifyFile(filePath);
  if (isImage) {
    if (!supportsMultimodal) {
      return `ERROR: Cannot read image file: current model does not support multimodal input. File: ${filePath}`;
    }
    if (stat.size > READ_MAX_IMAGE_SIZE) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      return `ERROR: Image too large (${sizeMB} MB, limit ${READ_MAX_IMAGE_SIZE / 1024 / 1024} MB).`;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
    try {
      const raw = readFileSync(filePath);
      const b64Data = raw.toString("base64");
      const sizeFmt = stat.size < 1024
        ? `${stat.size} B`
        : stat.size < 1024 * 1024
          ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
      const description = `[Image: ${path.basename(filePath)} | ${mediaType} | ${sizeFmt}]`;
      return new ToolResult({
        content: description,
        contentBlocks: [
          { type: "text", text: description },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: b64Data,
            },
          },
        ],
      });
    } catch (e) {
      return `ERROR: Failed to read image: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (stat.size > READ_MAX_FILE_SIZE) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `ERROR: File too large (${sizeMB} MB, limit ${READ_MAX_FILE_SIZE / 1024 / 1024} MB).`;
  }

  const isProjectedDocument = isProjectedDocumentPath(filePath);

  let text: string;
  let mtimeMs = Math.trunc(stat.mtimeMs);
  let sizeBytes = stat.size;
  let headerPrefix = "";
  try {
    if (isProjectedDocument) {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);
      text = view.text;
      mtimeMs = view.mtimeMs;
      sizeBytes = view.sizeBytes;
      headerPrefix =
        `[Auto-extracted Markdown view of ${path.basename(filePath)} (${projectedDocumentLabel(filePath)} source) | ` +
        `original_path=${filePath}]` + "\n";
    } else {
      text = readFileSync(filePath, { encoding: "utf-8" });
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  const lines = text.split(/\r?\n/);
  // Keep trailing newline semantics: if file ends with \n the last split
  // element is "" but that represents "no extra line".
  const total = lines.length;
  let start = startLine ?? 1;
  let end = endLine == null || endLine === -1 ? total : endLine;

  if (start < 1) return `ERROR: start_line must be >= 1, got ${start}.`;
  if (start > total) return `ERROR: start_line ${start} exceeds total lines (${total}).`;
  if (end > total) end = total;
  if (end < start) return `ERROR: end_line (${end}) < start_line (${start}).`;

  // Apply line limit
  if (end - start + 1 > READ_MAX_LINES) {
    end = start + READ_MAX_LINES - 1;
  }

  let selected = lines.slice(start - 1, end);

  // Apply character limit
  let charCount = 0;
  let truncatedAtLine: number | null = null;
  for (let i = 0; i < selected.length; i++) {
    charCount += selected[i].length + 1; // +1 for newline
    if (charCount > READ_MAX_CHARS) {
      selected = selected.slice(0, i);
      truncatedAtLine = start + i; // 1-indexed line that exceeded the limit
      end = start + i - 1; // last fully included line
      break;
    }
  }

  let result =
    headerPrefix +
    `[Lines ${start}-${end} of ${total} | mtime_ms=${mtimeMs} | size_bytes=${sizeBytes}]\n` +
    selected.join("\n");

  if (truncatedAtLine !== null) {
    result +=
      `\n\n[WARNING: Reached ${READ_MAX_CHARS.toLocaleString()} character limit at line ` +
      `${truncatedAtLine}. Showing lines ${start}-${end} ` +
      `(${end - start + 1} complete lines). ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  } else if (end < total) {
    result +=
      `\n\n[Output truncated at ${READ_MAX_LINES} lines. ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  }

  return result;
}

// ------------------------------------------------------------------
// list_dir
// ------------------------------------------------------------------

function toolListDir(dirPath = "."): string {
  if (!existsSync(dirPath)) {
    return `ERROR: Directory not found: ${dirPath}`;
  }
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return `ERROR: Not a directory: ${dirPath}`;
  }

  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical
    const withStats = entries
      .filter(
        (name) =>
          !name.startsWith(".") &&
          name !== "node_modules" &&
          name !== "__pycache__",
      )
      .map((name) => {
        const full = path.join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // skip inaccessible
        }
        return { name, full, isDir };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of withStats) {
      const marker = entry.isDir ? "[DIR] " : "";
      lines.push(`${prefix}${marker}${entry.name}`);
      if (entry.isDir) {
        walk(entry.full, prefix + "  ", depth + 1);
      }
    }
  }

  walk(dirPath, "", 0);
  return lines.length > 0 ? lines.join("\n") : "(empty directory)";
}


interface FileVersionSnapshot {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  ino?: number;
  dev?: number;
  mode?: number;
}

class FileVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileVersionConflictError";
  }
}

function getFileVersionSnapshot(filePath: string): FileVersionSnapshot {
  if (!existsSync(filePath)) return { exists: false };
  const st = statSync(filePath);
  return {
    exists: true,
    mtimeMs: Math.trunc(st.mtimeMs),
    size: st.size,
    ino: typeof st.ino === "number" ? st.ino : undefined,
    dev: typeof st.dev === "number" ? st.dev : undefined,
    mode: st.mode,
  };
}

function sameFileVersion(a: FileVersionSnapshot, b: FileVersionSnapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

function validateExpectedMtime(
  filePath: string,
  expectedMtimeMs: number | undefined,
  current: FileVersionSnapshot,
): void {
  if (expectedMtimeMs == null) return;
  if (!current.exists) {
    throw new FileVersionConflictError(
      `File changed since last read (mtime conflict): ${filePath} (file does not exist).`,
    );
  }
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new FileVersionConflictError(
      `File changed since last read (mtime conflict): ${filePath} ` +
      `(expected ${expectedMtimeMs}, current ${current.mtimeMs}).`,
    );
  }
}

function fileWriteLockKey(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function withFileWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = fileWriteLockKey(filePath);
  const previous = FILE_WRITE_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  FILE_WRITE_LOCKS.set(key, chain);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (FILE_WRITE_LOCKS.get(key) === chain) {
      FILE_WRITE_LOCKS.delete(key);
    }
  }
}

// ------------------------------------------------------------------
// edit_file
// ------------------------------------------------------------------

async function toolEditFile(
  filePath: string,
  oldStr: string,
  newStr: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    let content: string;
    try {
      content = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return "ERROR: old_str not found in file.";
    }
    if (count > 1) {
      return `ERROR: old_str appears ${count} times (must be unique).`;
    }

    const newContent = content.replace(oldStr, newStr);
    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(
        content.split("\n"),
        newContent.split("\n"),
        filePath,
        filePath,
      ),
    );

    try {
      await atomicWriteTextFile(filePath, newContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    return new ToolResult({
      content: "OK: File edited successfully.",
      metadata: {
        path: filePath,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
      },
    });
  });
}

// ------------------------------------------------------------------
// write_file
// ------------------------------------------------------------------

async function toolWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
      const mode = initialVersion.mode;
      const before = initialVersion.exists
        ? readFileSync(filePath, { encoding: "utf-8" })
        : "";
      const beforeLines = before.length > 0 ? before.split("\n") : [];
      const afterLines = content.length > 0 ? content.split("\n") : [];
      const diffPreview = buildUnifiedDiffPreview(
        simpleUnifiedDiff(
          beforeLines,
          afterLines,
          filePath,
          filePath,
        ),
      );

      await atomicWriteTextFile(filePath, content, mode, initialVersion);

      return new ToolResult({
        content: `OK: Wrote ${content.length} characters to ${filePath}`,
        metadata: {
          path: filePath,
          tui_preview: {
            kind: "diff",
            text: diffPreview.text,
            truncated: diffPreview.truncated,
          },
        },
      });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

async function atomicWriteTextFile(
  filePath: string,
  content: string,
  mode?: number,
  expectedVersion?: FileVersionSnapshot,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${randomUUID()}`,
  );

  let tmpExists = false;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8" });
    tmpExists = true;

    if (mode !== undefined) {
      try {
        await fs.chmod(tmpPath, mode);
      } catch {
        // Best-effort permission preservation
      }
    }

    if (expectedVersion) {
      const currentVersion = getFileVersionSnapshot(filePath);
      if (!sameFileVersion(expectedVersion, currentVersion)) {
        throw new FileVersionConflictError(
          `File changed during write (mtime conflict): ${filePath}. Please re-read and retry.`,
        );
      }
    }

    await fs.rename(tmpPath, filePath);
    tmpExists = false;
  } finally {
    if (tmpExists) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

// ------------------------------------------------------------------
// apply_patch
// ------------------------------------------------------------------

type ApplyPatchOp =
  | { type: "add"; path: string; contents: string }
  | { type: "append"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; chunks: ApplyPatchChunk[] };

interface ApplyPatchChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
}

interface PreparedPatchChange {
  type: "add" | "append" | "delete" | "update";
  requestedPath: string;
  filePath: string;
  before: string;
  after: string | null;
  mode?: number;
}

function parsePatchBodyLines(lines: string[], startIdx: number): { contents: string; nextIdx: number } {
  const contentLines: string[] = [];
  let i = startIdx;
  while (i < lines.length && !lines[i].startsWith("***")) {
    const line = lines[i];
    if (line.startsWith("+")) {
      contentLines.push(line.slice(1));
    } else if (line.trim() !== "") {
      throw new Error(`Invalid patch line in add/append block: '${line}'`);
    }
    i += 1;
  }
  return { contents: contentLines.join("\n"), nextIdx: i };
}

function parsePatchUpdateChunks(lines: string[], startIdx: number): { chunks: ApplyPatchChunk[]; nextIdx: number } {
  const chunks: ApplyPatchChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (!lines[i].startsWith("@@")) {
      if (!lines[i].trim()) {
        i += 1;
        continue;
      }
      throw new Error(`Invalid patch chunk header: '${lines[i]}'`);
    }

    const changeContext = lines[i].slice(2).trim() || undefined;
    i += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
      const line = lines[i];
      if (line.startsWith(" ")) {
        const content = line.slice(1);
        oldLines.push(content);
        newLines.push(content);
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line.trim() !== "") {
        throw new Error(`Invalid patch change line: '${line}'`);
      }
      i += 1;
    }

    if (oldLines.length === 0 && newLines.length === 0) {
      throw new Error("Empty update chunk is not allowed.");
    }

    chunks.push({ oldLines, newLines, changeContext });
  }

  return { chunks, nextIdx: i };
}

function parseApplyPatchText(patchText: string): ApplyPatchOp[] {
  const trimmed = patchText.trim();
  if (!trimmed) throw new Error("patchText is required.");

  const lines = trimmed.split("\n");
  const beginIdx = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIdx = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers.");
  }

  const ops: ApplyPatchOp[] = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      const requestedPath = line.slice("*** Add File:".length).trim();
      if (!requestedPath) throw new Error("Add File is missing a path.");
      const { contents, nextIdx } = parsePatchBodyLines(lines, i + 1);
      ops.push({ type: "add", path: requestedPath, contents });
      i = nextIdx;
      continue;
    }

    if (line.startsWith("*** Append File:")) {
      const requestedPath = line.slice("*** Append File:".length).trim();
      if (!requestedPath) throw new Error("Append File is missing a path.");
      const { contents, nextIdx } = parsePatchBodyLines(lines, i + 1);
      ops.push({ type: "append", path: requestedPath, contents });
      i = nextIdx;
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const requestedPath = line.slice("*** Delete File:".length).trim();
      if (!requestedPath) throw new Error("Delete File is missing a path.");
      ops.push({ type: "delete", path: requestedPath });
      i += 1;
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const requestedPath = line.slice("*** Update File:".length).trim();
      if (!requestedPath) throw new Error("Update File is missing a path.");
      const { chunks, nextIdx } = parsePatchUpdateChunks(lines, i + 1);
      if (!chunks.length) {
        throw new Error(`Update File '${requestedPath}' does not contain any chunks.`);
      }
      ops.push({ type: "update", path: requestedPath, chunks });
      i = nextIdx;
      continue;
    }

    throw new Error(`Invalid patch directive: '${line}'`);
  }

  if (!ops.length) {
    throw new Error("patch rejected: empty patch");
  }

  return ops;
}

function seekSequence(lines: string[], needle: string[], startIdx: number): number {
  if (needle.length === 0) return startIdx;
  outer:
  for (let i = Math.max(0, startIdx); i <= lines.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function applyUpdateChunksToContent(
  filePath: string,
  originalContent: string,
  chunks: ApplyPatchChunk[],
): string {
  let lines = originalContent.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  let cursor = 0;
  for (const chunk of chunks) {
    const oldSeq = chunk.oldLines;
    let matchIdx = -1;

    if (chunk.changeContext) {
      for (let i = cursor; i < lines.length; i += 1) {
        if (lines[i] !== chunk.changeContext) continue;
        const candidate = seekSequence(lines, oldSeq, i);
        if (candidate !== -1) {
          matchIdx = candidate;
          break;
        }
      }
    } else {
      matchIdx = seekSequence(lines, oldSeq, cursor);
      if (matchIdx === -1) {
        matchIdx = seekSequence(lines, oldSeq, 0);
      }
    }

    if (matchIdx === -1) {
      const detail = chunk.changeContext
        ? `context '${chunk.changeContext}'`
        : oldSeq.length > 0
          ? `sequence '${oldSeq[0]}'`
          : "target location";
      throw new Error(`Failed to match patch chunk in ${filePath}: ${detail}`);
    }

    lines.splice(matchIdx, oldSeq.length, ...chunk.newLines);
    cursor = matchIdx + chunk.newLines.length;
  }

  let nextContent = lines.join("\n");
  if (nextContent && !nextContent.endsWith("\n")) {
    nextContent += "\n";
  }
  return nextContent;
}

function displayRelativePath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath) || path.basename(filePath);
  return rel.split(path.sep).join("/");
}

async function toolApplyPatch(
  patchText: string,
  ctx?: ExecuteToolContext,
): Promise<ToolResult> {
  const ops = parseApplyPatchText(patchText);
  const root = toolRoot(ctx);
  const prepared: PreparedPatchChange[] = [];

  for (const op of ops) {
    if (op.type === "add") {
      const filePath = scopedPath(op.path, "write", ctx, { allowCreate: true, expectFile: true });
      if (existsSync(filePath)) {
        throw new Error(`apply_patch verification failed: File already exists: ${displayRelativePath(root, filePath)}`);
      }
      prepared.push({
        type: "add",
        requestedPath: op.path,
        filePath,
        before: "",
        after: op.contents,
      });
      continue;
    }

    if (op.type === "append") {
      const filePath = scopedPath(op.path, "write", ctx, { mustExist: true, expectFile: true });
      const before = readFileSync(filePath, "utf-8");
      const separator = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      let after = before + separator + op.contents;
      if (after && !after.endsWith("\n")) after += "\n";
      prepared.push({
        type: "append",
        requestedPath: op.path,
        filePath,
        before,
        after,
        mode: getFileVersionSnapshot(filePath).mode,
      });
      continue;
    }

    if (op.type === "delete") {
      const filePath = scopedPath(op.path, "write", ctx, { mustExist: true, expectFile: true });
      prepared.push({
        type: "delete",
        requestedPath: op.path,
        filePath,
        before: readFileSync(filePath, "utf-8"),
        after: null,
        mode: getFileVersionSnapshot(filePath).mode,
      });
      continue;
    }

    const filePath = scopedPath(op.path, "write", ctx, { mustExist: true, expectFile: true });
    const before = readFileSync(filePath, "utf-8");
    const after = applyUpdateChunksToContent(filePath, before, op.chunks);
    prepared.push({
      type: "update",
      requestedPath: op.path,
      filePath,
      before,
      after,
      mode: getFileVersionSnapshot(filePath).mode,
    });
  }

  const previewDiffs: string[] = [];
  for (const change of prepared) {
    const beforeLines = change.before.split("\n");
    const afterLines = (change.after ?? "").split("\n");
    previewDiffs.push(
      simpleUnifiedDiff(
        beforeLines,
        afterLines,
        change.filePath,
        change.filePath,
      ),
    );
  }
  const diffPreview = buildUnifiedDiffPreview(previewDiffs.join("\n"));

  for (const change of prepared) {
    if (change.after === null) {
      await fs.unlink(change.filePath);
      continue;
    }
    await fs.mkdir(path.dirname(change.filePath), { recursive: true });
    const expectedVersion = change.type === "add"
      ? undefined
      : getFileVersionSnapshot(change.filePath);
    await atomicWriteTextFile(change.filePath, change.after, change.mode, expectedVersion);
  }

  const lines = ["Success. Updated the following files:"];
  for (const change of prepared) {
    const kind = change.type === "add"
      ? "A"
      : change.type === "delete"
        ? "D"
        : "M";
    lines.push(`${kind} ${displayRelativePath(root, change.filePath)}`);
  }

  return new ToolResult({
    content: lines.join("\n"),
    metadata: {
      paths: prepared.map((change) => change.filePath),
      tui_preview: {
        kind: "diff",
        text: diffPreview.text,
        truncated: diffPreview.truncated,
      },
    },
  });
}

// ------------------------------------------------------------------
// bash
// ------------------------------------------------------------------

function truncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return (
    text.slice(0, half) +
    `\n\n... [truncated ${omitted.toLocaleString()} chars] ...\n\n` +
    text.slice(-half)
  );
}

export function buildBashEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (BASH_ENV_ALLOWLIST.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  // Keep a usable PATH even if parent PATH is missing.
  if (!env["PATH"]) {
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
  }
  return env;
}

function toolBash(
  command: string,
  timeout = BASH_DEFAULT_TIMEOUT,
  cwd = "",
): string {
  // Enforce timeout bounds
  if (typeof timeout !== "number" || timeout < 1) {
    timeout = BASH_DEFAULT_TIMEOUT;
  }
  timeout = Math.min(timeout, BASH_MAX_TIMEOUT);

  // Resolve working directory
  let runCwd: string | undefined;
  if (cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return `ERROR: Working directory does not exist or is not a directory: ${cwd}`;
    }
    runCwd = cwd;
  }

  const result = spawnSync("sh", ["-c", command], {
    cwd: runCwd,
    timeout: timeout * 1000,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
    env: buildBashEnv(),
    killSignal: BASH_TIMEOUT_KILL_SIGNAL,
  });

  if (result.error) {
    if (
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
      result.signal === "SIGTERM" ||
      result.signal === BASH_TIMEOUT_KILL_SIGNAL
    ) {
      return (
        `ERROR: Command timed out after ${timeout}s (max allowed: ${BASH_MAX_TIMEOUT}s). ` +
        `Shell process was terminated (${BASH_TIMEOUT_KILL_SIGNAL}); child-process tree termination is best-effort.`
      );
    }
    return `ERROR: ${result.error.message}`;
  }

  const parts: string[] = [];
  if (result.stdout) {
    parts.push(`STDOUT:\n${truncateOutput(result.stdout, BASH_MAX_OUTPUT_CHARS)}`);
  }
  if (result.stderr) {
    parts.push(`STDERR:\n${truncateOutput(result.stderr, BASH_MAX_OUTPUT_CHARS)}`);
  }
  parts.push(`EXIT CODE: ${result.status ?? 1}`);
  return parts.join("\n");
}

// ------------------------------------------------------------------
// diff
// ------------------------------------------------------------------

function toolDiff(
  fileA: string,
  fileB = "",
  contentB = "",
  contentBProvided = false,
): string {
  const sensitiveA = getSensitiveFileReadReason(fileA);
  if (sensitiveA) {
    return `ERROR: Access to sensitive file is blocked by default: ${fileA} (${sensitiveA}).`;
  }
  if (!existsSync(fileA)) {
    return `ERROR: File not found: ${fileA}`;
  }

  let linesA: string[];
  try {
    linesA = readFileSync(fileA, { encoding: "utf-8" }).split("\n");
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  let linesB: string[];
  let labelB: string;

  if (contentBProvided) {
    linesB = contentB.split("\n");
    labelB = "(provided content)";
  } else if (fileB) {
    const sensitiveB = getSensitiveFileReadReason(fileB);
    if (sensitiveB) {
      return `ERROR: Access to sensitive file is blocked by default: ${fileB} (${sensitiveB}).`;
    }
    if (!existsSync(fileB)) {
      return `ERROR: File not found: ${fileB}`;
    }
    try {
      linesB = readFileSync(fileB, { encoding: "utf-8" }).split("\n");
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    labelB = fileB;
  } else {
    return "ERROR: Provide either file_b or content_b.";
  }

  // Simple unified diff implementation
  const result = simpleUnifiedDiff(linesA, linesB, fileA, labelB);
  return result || "No differences found.";
}

function buildUnifiedDiffPreview(
  diff: string,
  maxLines = 80,
  maxChars = 8_000,
): { text: string; truncated: boolean } {
  if (!diff) {
    return { text: "(No textual changes.)", truncated: false };
  }

  type PreviewLine = {
    raw: string;
    oldLine?: number;
    newLine?: number;
  };

  const parsedLines: PreviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("-")) {
      parsedLines.push({ raw, oldLine });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("+")) {
      parsedLines.push({ raw, newLine });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsedLines.push({ raw, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    parsedLines.push({ raw });
  }

  const displayLineFor = (line: PreviewLine): number | undefined => {
    if (line.raw.startsWith("-")) return line.oldLine;
    if (line.raw.startsWith("+")) return line.newLine;
    if (line.raw.startsWith(" ")) return line.newLine;
    return undefined;
  };

  const maxLineNumber = parsedLines.reduce((max, line) => {
    return Math.max(max, displayLineFor(line) ?? 0);
  }, 0);
  const numberWidth = Math.max(String(maxLineNumber || 0).length, 2);

  const formatLine = (line: PreviewLine): string => {
    const displayLine = displayLineFor(line);
    const lineCol = displayLine == null ? "".padStart(numberWidth, " ") : String(displayLine).padStart(numberWidth, " ");
    return `${lineCol} | ${line.raw}`;
  };

  let previewLines = parsedLines;
  let truncated = false;
  if (previewLines.length > 60) {
    const omitted = previewLines.length - 50;
    previewLines = [
      ...previewLines.slice(0, 25),
      { raw: `... [${omitted} diff lines omitted] ...` },
      ...previewLines.slice(-25),
    ];
    truncated = true;
  }
  if (previewLines.length > maxLines) {
    previewLines = previewLines.slice(0, maxLines);
    truncated = true;
  }

  let text = previewLines.map(formatLine).join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline !== -1) {
      text = text.slice(0, lastNewline);
    }
    truncated = true;
  }

  if (truncated && !text.includes("diff preview truncated")) {
    text += `\n${"".padStart(numberWidth)} | ... [diff preview truncated]`;
  }

  return { text, truncated };
}

/**
 * Minimal unified diff: generates a unified diff string from two line arrays.
 */
function simpleUnifiedDiff(
  a: string[],
  b: string[],
  labelA: string,
  labelB: string,
): string {
  // Use a simple LCS-based approach
  const n = a.length;
  const m = b.length;

  // For very large files, fall back to a simpler comparison
  if (n * m > 10_000_000) {
    // Too large for full LCS, just show stats
    return (
      `--- ${labelA}\n+++ ${labelB}\n` +
      `(Files differ: ${n} lines vs ${m} lines, diff too large to compute)`
    );
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find edit script
  const ops: Array<{ type: "equal" | "delete" | "insert"; line: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const contextLines = 3;
  const hunks: string[] = [];
  let hunkStart = -1;
  let hunkLines: string[] = [];
  let aLine = 0;
  let bLine = 0;
  let aStart = 0;
  let bStart = 0;
  let aCount = 0;
  let bCount = 0;
  let lastChangeIdx = -contextLines - 1;

  function flushHunk(): void {
    if (hunkLines.length > 0) {
      hunks.push(
        `@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n` +
        hunkLines.join("\n"),
      );
      hunkLines = [];
    }
  }

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (hunkStart === -1 || idx - lastChangeIdx > contextLines * 2) {
        // Start a new hunk
        flushHunk();
        hunkStart = idx;
        aStart = aLine;
        bStart = bLine;
        aCount = 0;
        bCount = 0;
        // Add leading context
        const ctxStart = Math.max(0, idx - contextLines);
        // We need to recount from ctxStart -- but for simplicity, just
        // include context from current position
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx - lastChangeIdx <= contextLines) {
      if (op.type === "equal") {
        hunkLines.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        hunkLines.push(`-${op.line}`);
        aCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        bCount++;
      }
    }

    if (op.type === "equal" || op.type === "delete") aLine++;
    if (op.type === "equal" || op.type === "insert") bLine++;
  }

  flushHunk();

  if (hunks.length === 0) return "";
  return `--- ${labelA}\n+++ ${labelB}\n${hunks.join("\n")}`;
}

// ------------------------------------------------------------------
// test
// ------------------------------------------------------------------

function toolTest(command = "python -m pytest", timeout = 60): string {
  return toolBash(command, timeout);
}

// ======================================================================
// Dispatcher
// ======================================================================

type ToolExecutor = (args: Record<string, unknown>) => Promise<string | ToolResult> | string | ToolResult;

export interface ExecuteToolContext {
  projectRoot?: string;
  externalPathAllowlist?: string[];
  sessionArtifactsDir?: string;
  supportsMultimodal?: boolean;
}

class ToolArgValidationError extends Error {
  toolName: string;
  field: string;

  constructor(toolName: string, field: string, message: string) {
    super(message);
    this.name = "ToolArgValidationError";
    this.toolName = toolName;
    this.field = field;
  }
}

function toolRoot(ctx?: ExecuteToolContext): string {
  return path.resolve(ctx?.projectRoot ?? process.cwd());
}

function formatToolError(toolName: string, err: unknown): string {
  if (err instanceof ToolArgValidationError) {
    return `ERROR: Invalid arguments for ${toolName}: ${err.message}`;
  }
  if (err instanceof SafePathError) {
    const p = err.details.resolvedPath || err.details.requestedPath;
    switch (err.code) {
      case "PATH_OUTSIDE_SCOPE":
        return `ERROR: ${toolName} path is outside the project root boundary: ${err.details.requestedPath}`;
      case "PATH_SYMLINK_ESCAPES_SCOPE":
        return `ERROR: ${toolName} path escapes the project root via a symbolic link: ${err.details.requestedPath}`;
      case "PATH_NOT_FOUND":
        return `ERROR: Path not found: ${p}`;
      case "PATH_NOT_FILE":
        return `ERROR: Not a file: ${p}`;
      case "PATH_NOT_DIRECTORY":
        return `ERROR: Not a directory: ${p}`;
      case "PATH_INVALID_INPUT":
        return `ERROR: ${err.message}`;
      default:
        return `ERROR: ${err.message}`;
    }
  }
  return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

function expectArgsObject(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolArgValidationError(toolName, "(root)", "arguments must be an object.");
  }
  return args;
}

function requiredStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !v.trim()) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a non-empty string.`);
  }
  if (opts?.maxLen !== undefined && v.length > opts.maxLen) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' exceeds max length (${opts.maxLen}).`,
    );
  }
  return v;
}

function optionalStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = args[key];
  if (v == null) return fallback;
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  return v;
}

function optionalIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

function scopedPath(
  requestedPath: string,
  accessKind: PathAccessKind,
  ctx: ExecuteToolContext | undefined,
  opts: {
    mustExist?: boolean;
    allowCreate?: boolean;
    expectFile?: boolean;
    expectDirectory?: boolean;
  },
): string {
  const baseDir = toolRoot(ctx);
  const attempt = (scopeBaseDir: string): string => safePath({
    baseDir: scopeBaseDir,
    requestedPath,
    cwd: baseDir,
    accessKind,
    mustExist: opts.mustExist,
    allowCreate: opts.allowCreate,
    expectFile: opts.expectFile,
    expectDirectory: opts.expectDirectory,
  }).safePath!;

  try {
    return attempt(baseDir);
  } catch (err) {
    if (!(err instanceof SafePathError)) throw err;
    if (err.code !== "PATH_OUTSIDE_SCOPE" && err.code !== "PATH_SYMLINK_ESCAPES_SCOPE") {
      throw err;
    }

    const allowlist = ctx?.externalPathAllowlist ?? [];
    for (const allowedRoot of allowlist) {
      try {
        return attempt(allowedRoot);
      } catch (inner) {
        if (inner instanceof SafePathError &&
            (inner.code === "PATH_OUTSIDE_SCOPE" || inner.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
          continue;
        }
        throw inner;
      }
    }
    throw err;
  }
}

// ------------------------------------------------------------------
// glob executor
// ------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any including slash), `?` (single char),
 * `{a,b}` (alternatives), and literal characters.
 */
function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including slashes
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ matches zero or more directories
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (".+^$|()[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

const GLOB_SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".next", ".nuxt",
  "dist", ".tox", ".mypy_cache", ".pytest_cache", ".venv", "venv",
]);

function toolGlob(pattern: string, searchPath: string): string {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  const regex = globToRegex(pattern);

  const results: Array<{ path: string; mtime: number }> = [];
  let filesScanned = 0;

  function walk(dir: string, depth: number, relPrefix: string): void {
    if (depth > GLOB_MAX_DEPTH) return;
    if (results.length >= GLOB_MAX_RESULTS) return;
    if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (results.length >= GLOB_MAX_RESULTS) return;
      if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;

      if (GLOB_SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".") continue;

      const full = path.join(dir, name);
      const rel = relPrefix ? relPrefix + "/" + name : name;

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full, depth + 1, rel);
      } else if (stat.isFile()) {
        filesScanned++;
        if (regex.test(rel)) {
          results.push({ path: full, mtime: stat.mtimeMs });
        }
      }
    }
  }

  walk(searchPath, 0, "");

  if (results.length === 0) {
    return "No files found matching the pattern.";
  }

  // Sort by mtime descending (most recently modified first)
  results.sort((a, b) => b.mtime - a.mtime);

  const lines = results.map((r) => r.path);
  let output = lines.join("\n");
  if (results.length >= GLOB_MAX_RESULTS) {
    output += `\n... (truncated at ${GLOB_MAX_RESULTS} results)`;
  }
  return output;
}

// ------------------------------------------------------------------
// grep executor (enhanced search)
// ------------------------------------------------------------------

interface GrepOptions {
  glob?: string;
  fileType?: string;
  outputMode: "content" | "files_with_matches" | "count";
  afterContext: number;
  beforeContext: number;
  caseInsensitive: boolean;
  showLineNumbers: boolean;
  headLimit: number;
}

/** Check if a filename matches a simple glob pattern (e.g. "*.ts", "*.{ts,tsx}") */
function matchFileGlob(filename: string, globPattern: string): boolean {
  const regex = globToRegex(globPattern);
  return regex.test(filename);
}

/** Check if file extension matches a type filter */
function matchFileType(filename: string, typeFilter: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext === typeFilter.toLowerCase();
}

function toolGrep(pattern: string, searchPath: string, options: GrepOptions): string {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  if (!pattern) {
    return "ERROR: pattern must be a non-empty string.";
  }
  if (pattern.length > SEARCH_MAX_PATTERN_LENGTH) {
    return (
      `ERROR: Regex pattern too long (${pattern.length} chars, ` +
      `limit ${SEARCH_MAX_PATTERN_LENGTH}).`
    );
  }
  // Catastrophic backtracking check
  if (/(^|[^\\])\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return "ERROR: Regex appears too complex/risky (nested quantified group).";
  }

  let regex: RegExp;
  try {
    const flags = options.caseInsensitive ? "i" : "";
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return `ERROR: Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }

  const startedAt = Date.now();
  const stats = {
    filesScanned: 0,
    bytesScanned: 0,
    skippedLargeFiles: 0,
    skippedSensitiveFiles: 0,
    depthLimitHits: 0,
    maxFilesHit: false,
    maxBytesHit: false,
    timeoutHit: false,
  };

  // Results storage depends on output mode
  const fileMatches: Array<{ file: string; matches: Array<{ line: number; text: string }>; count: number }> = [];
  let totalEntries = 0;

  function shouldStop(): boolean {
    if (options.headLimit > 0 && totalEntries >= options.headLimit) return true;
    if (stats.maxFilesHit || stats.maxBytesHit || stats.timeoutHit) return true;
    if (Date.now() - startedAt > SEARCH_MAX_DURATION_MS) {
      stats.timeoutHit = true;
      return true;
    }
    return false;
  }

  function shouldIncludeFile(filename: string): boolean {
    if (options.glob && !matchFileGlob(filename, options.glob)) return false;
    if (options.fileType && !matchFileType(filename, options.fileType)) return false;
    return true;
  }

  function processFile(filePath: string): void {
    let raw: Buffer;
    try {
      raw = readFileSync(filePath);
    } catch {
      return;
    }
    // Skip binary files
    const header = raw.subarray(0, 8192);
    if (header.includes(0)) return;

    const text = raw.toString("utf-8");
    const lines = text.split("\n");
    const matchingLines: Array<{ line: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.global || regex.sticky) regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        matchingLines.push({ line: i + 1, text: lines[i].trimEnd() });
      }
    }

    if (matchingLines.length > 0) {
      fileMatches.push({
        file: filePath,
        matches: matchingLines,
        count: matchingLines.length,
      });
      totalEntries++;
    }
  }

  function walkForGrep(dir: string, depth: number): void {
    if (shouldStop()) return;
    if (depth > SEARCH_MAX_DEPTH) {
      stats.depthLimitHits += 1;
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (shouldStop()) return;
      if (name.startsWith(".") || name === "__pycache__" || name === "node_modules") continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walkForGrep(full, depth + 1);
      } else if (stat.isFile()) {
        if (!shouldIncludeFile(name)) continue;
        if (getSensitiveFileReadReason(full)) {
          stats.skippedSensitiveFiles += 1;
          continue;
        }
        if (stats.filesScanned >= SEARCH_MAX_FILES) {
          stats.maxFilesHit = true;
          return;
        }
        stats.filesScanned += 1;

        if (stat.size > SEARCH_MAX_FILE_SIZE) {
          stats.skippedLargeFiles += 1;
          continue;
        }
        if (stats.bytesScanned + stat.size > SEARCH_MAX_TOTAL_BYTES) {
          stats.maxBytesHit = true;
          return;
        }
        stats.bytesScanned += stat.size;

        processFile(full);
      }
    }
  }

  // Handle single file path
  const pathStat = statSync(searchPath);
  if (pathStat.isFile()) {
    if (shouldIncludeFile(path.basename(searchPath))) {
      processFile(searchPath);
    }
  } else {
    walkForGrep(searchPath, 0);
  }

  // Format output based on mode
  let output = "";
  const { outputMode } = options;

  if (fileMatches.length === 0) {
    output = "No matches found.";
  } else if (outputMode === "files_with_matches") {
    const lines = fileMatches.map((f) => f.file);
    output = lines.join("\n");
  } else if (outputMode === "count") {
    const lines = fileMatches.map((f) => `${f.file}:${f.count}`);
    output = lines.join("\n");
  } else {
    // content mode — show matching lines with optional context
    const parts: string[] = [];
    const beforeCtx = options.beforeContext;
    const afterCtx = options.afterContext;
    const showNumbers = options.showLineNumbers;

    for (const fm of fileMatches) {
      if (options.headLimit > 0 && parts.length >= options.headLimit) break;

      if (beforeCtx > 0 || afterCtx > 0) {
        // Need to re-read file for context lines
        let fileLines: string[];
        try {
          fileLines = readFileSync(fm.file, "utf-8").split("\n");
        } catch {
          continue;
        }

        for (const m of fm.matches) {
          if (options.headLimit > 0 && parts.length >= options.headLimit) break;
          const startL = Math.max(0, m.line - 1 - beforeCtx);
          const endL = Math.min(fileLines.length, m.line + afterCtx);

          for (let li = startL; li < endL; li++) {
            const isMatch = li === m.line - 1;
            const prefix = isMatch ? ">" : " ";
            const lineText = fileLines[li].trimEnd();
            if (showNumbers) {
              parts.push(`${fm.file}:${li + 1}:${prefix} ${lineText}`);
            } else {
              parts.push(`${fm.file}:${prefix} ${lineText}`);
            }
          }
          parts.push("--");
        }
      } else {
        // No context — just matching lines
        for (const m of fm.matches) {
          if (options.headLimit > 0 && parts.length >= options.headLimit) break;
          if (showNumbers) {
            parts.push(`${fm.file}:${m.line}: ${m.text}`);
          } else {
            parts.push(`${fm.file}: ${m.text}`);
          }
        }
      }
    }
    output = parts.join("\n");
  }

  // Append notices
  const notices: string[] = [];
  if (stats.skippedLargeFiles > 0) {
    notices.push(`Skipped ${stats.skippedLargeFiles} large file(s) over ${Math.round(SEARCH_MAX_FILE_SIZE / 1024)} KB.`);
  }
  if (stats.skippedSensitiveFiles > 0) {
    notices.push(`Skipped ${stats.skippedSensitiveFiles} sensitive file(s).`);
  }
  if (stats.depthLimitHits > 0) {
    notices.push(`Depth limit reached in ${stats.depthLimitHits} director${stats.depthLimitHits === 1 ? "y" : "ies"} (max depth ${SEARCH_MAX_DEPTH}).`);
  }
  if (stats.maxFilesHit) {
    notices.push(`Stopped after scanning ${SEARCH_MAX_FILES} files.`);
  }
  if (stats.maxBytesHit) {
    notices.push(`Stopped after scanning ${Math.round(SEARCH_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
  }
  if (stats.timeoutHit) {
    notices.push(`Stopped after ${SEARCH_MAX_DURATION_MS}ms time limit.`);
  }
  if (notices.length > 0) {
    output += "\n\n[Search notices]\n" + notices.map((n) => `- ${n}`).join("\n");
  }
  return output;
}

function createDispatch(ctx?: ExecuteToolContext): Record<string, ToolExecutor> {
  return {
    read_file: (args) => {
      try {
        const a = expectArgsObject("read_file", args);
        const requestedPath = requiredStringArg("read_file", a, "path", { nonEmpty: true });
        const startLine = optionalIntegerArg("read_file", a, "start_line");
        const endLine = optionalIntegerArg("read_file", a, "end_line");
        const filePath = scopedPath(
          requestedPath,
          "read",
          ctx,
          { mustExist: true, expectFile: true },
        );
        return toolReadFile(
          filePath,
          startLine,
          endLine,
          ctx?.sessionArtifactsDir,
          ctx?.supportsMultimodal,
        );
      } catch (e) {
        return formatToolError("read_file", e);
      }
    },
    list_dir: (args) => {
      try {
        const a = expectArgsObject("list_dir", args);
        const requestedPath = optionalStringArg("list_dir", a, "path", ".");
        const dirPath = scopedPath(
          requestedPath,
          "list",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return toolListDir(dirPath);
      } catch (e) {
        return formatToolError("list_dir", e);
      }
    },
    edit_file: (args) => {
      try {
        const a = expectArgsObject("edit_file", args);
        const requestedPath = requiredStringArg("edit_file", a, "path", { nonEmpty: true });
        const oldStr = requiredStringArg("edit_file", a, "old_str", { nonEmpty: true });
        const newStr = requiredStringArg("edit_file", a, "new_str");
        const expectedMtimeMs = optionalIntegerArg("edit_file", a, "expected_mtime_ms");
        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { mustExist: true, expectFile: true },
        );
        return toolEditFile(
          filePath,
          oldStr,
          newStr,
          expectedMtimeMs,
        );
      } catch (e) {
        return formatToolError("edit_file", e);
      }
    },
    write_file: (args) => {
      try {
        const a = expectArgsObject("write_file", args);
        const requestedPath = requiredStringArg("write_file", a, "path", { nonEmpty: true });
        const content = requiredStringArg("write_file", a, "content");
        const expectedMtimeMs = optionalIntegerArg("write_file", a, "expected_mtime_ms");
        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { allowCreate: true, expectFile: true },
        );
        return toolWriteFile(filePath, content, expectedMtimeMs);
      } catch (e) {
        return formatToolError("write_file", e);
      }
    },
    apply_patch: async (args) => {
      try {
        const a = expectArgsObject("apply_patch", args);
        const patch = requiredStringArg("apply_patch", a, "patch", { nonEmpty: true, maxLen: 200_000 });
        return await toolApplyPatch(patch, ctx);
      } catch (e) {
        if (e instanceof ToolArgValidationError) {
          return formatToolError("apply_patch", e);
        }
        return `ERROR: apply_patch verification failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    bash: (args) => {
      try {
        const a = expectArgsObject("bash", args);
        const command = requiredStringArg("bash", a, "command", { nonEmpty: true, maxLen: 20_000 });
        const timeout = optionalIntegerArg("bash", a, "timeout");
        const cwdArg = optionalStringArg("bash", a, "cwd", "");
        let cwd = "";
        if (cwdArg.trim()) {
          cwd = scopedPath(
            cwdArg,
            "list",
            ctx,
            { mustExist: true, expectDirectory: true },
          );
        }
        return toolBash(command, timeout ?? BASH_DEFAULT_TIMEOUT, cwd);
      } catch (e) {
        return formatToolError("bash", e);
      }
    },
    diff: (args) => {
      try {
        const a = expectArgsObject("diff", args);
        const fileAArg = requiredStringArg("diff", a, "file_a", { nonEmpty: true });
        const rawFileB = optionalStringArg("diff", a, "file_b", "");
        const hasContentB = Object.prototype.hasOwnProperty.call(a, "content_b");
        const contentB = optionalStringArg("diff", a, "content_b", "");
        const fileA = scopedPath(
          fileAArg,
          "diff",
          ctx,
          { mustExist: true, expectFile: true },
        );

        let fileB = "";
        if (!hasContentB && rawFileB) {
          fileB = scopedPath(
            rawFileB,
            "diff",
            ctx,
            { mustExist: true, expectFile: true },
          );
        } else {
          fileB = rawFileB;
        }

        return toolDiff(fileA, fileB, contentB, hasContentB);
      } catch (e) {
        return formatToolError("diff", e);
      }
    },
    test: (args) => {
      try {
        const a = expectArgsObject("test", args);
        const command = optionalStringArg("test", a, "command", "python -m pytest");
        const timeout = optionalIntegerArg("test", a, "timeout");
        return toolTest(command, timeout ?? 60);
      } catch (e) {
        return formatToolError("test", e);
      }
    },
    glob: (args) => {
      try {
        const a = expectArgsObject("glob", args);
        const pattern = requiredStringArg("glob", a, "pattern", { nonEmpty: true });
        const requestedPath = optionalStringArg("glob", a, "path", ".");
        const globPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return toolGlob(pattern, globPath);
      } catch (e) {
        return formatToolError("glob", e);
      }
    },
    grep: (args) => {
      try {
        const a = expectArgsObject("grep", args);
        const pattern = requiredStringArg("grep", a, "pattern", { nonEmpty: true, maxLen: SEARCH_MAX_PATTERN_LENGTH });
        const requestedPath = optionalStringArg("grep", a, "path", ".");
        const searchPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true },
        );
        const globFilter = optionalStringArg("grep", a, "glob", "");
        const fileType = optionalStringArg("grep", a, "type", "");
        const outputMode = optionalStringArg("grep", a, "output_mode", "files_with_matches") as "content" | "files_with_matches" | "count";
        const afterCtx = optionalIntegerArg("grep", a, "-A") ?? 0;
        const beforeCtx = optionalIntegerArg("grep", a, "-B") ?? 0;
        const contextCtx = optionalIntegerArg("grep", a, "-C") ?? 0;
        const caseInsensitive = a["-i"] === true;
        const showLineNumbers = a["-n"] !== false; // default true
        const headLimit = optionalIntegerArg("grep", a, "head_limit") ?? 0;
        return toolGrep(pattern, searchPath, {
          glob: globFilter || undefined,
          fileType: fileType || undefined,
          outputMode,
          afterContext: contextCtx > 0 ? contextCtx : afterCtx,
          beforeContext: contextCtx > 0 ? contextCtx : beforeCtx,
          caseInsensitive,
          showLineNumbers,
          headLimit,
        });
      } catch (e) {
        return formatToolError("grep", e);
      }
    },
    web_fetch: async (args) => {
      try {
        const a = expectArgsObject("web_fetch", args);
        const url = requiredStringArg("web_fetch", a, "url", { nonEmpty: true });
        const prompt = optionalStringArg("web_fetch", a, "prompt", "");
        return toolWebFetch(url, prompt || undefined);
      } catch (e) {
        return formatToolError("web_fetch", e);
      }
    },
    $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
  };
}

/**
 * Execute a tool by name and return a `ToolResult`.
 *
 * Tool functions may return either a plain `string` (wrapped automatically)
 * or a `ToolResult` with optional action hints, tags, and metadata.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ExecuteToolContext,
): Promise<ToolResult> {
  const fn = createDispatch(ctx)[name];
  if (!fn) {
    return new ToolResult({ content: `ERROR: Unknown tool '${name}'` });
  }
  try {
    const raw = await fn(args);
    if (raw instanceof ToolResult) {
      return raw;
    }
    return new ToolResult({ content: raw });
  } catch (e) {
    return new ToolResult({
      content: `ERROR executing ${name}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
