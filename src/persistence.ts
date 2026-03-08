/**
 * Session persistence — log-native session storage on disk.
 *
 * Storage layout:
 *
 *   <base_dir>/
 *   └── projects/
 *       ├── <project_slug>/           # <dir_name>_<sha256[:6]>
 *       │   ├── project.json
 *       │   ├── 20260212_143052_chat/
 *       │   │   ├── log.json
 *       │   │   └── artifacts/
 *       │   └── ...
 *       └── general/                  # sessions without a project path
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LogIdAllocator, type LogEntry, type LogEntryType, type TuiDisplayKind } from "./log-entry.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const DEFAULT_LONGERAGENT_DIRNAME = ".longeragent";
const ENV_BASE_DIR = "LONGERAGENT_HOME";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function projectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

function resolvePreferredBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir.replace(/^~/, homedir());
  const envValue = process.env[ENV_BASE_DIR];
  if (envValue) return envValue.replace(/^~/, homedir());
  return join(homedir(), DEFAULT_LONGERAGENT_DIRNAME);
}

function resolveSessionTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatLocalIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMins = pad(absOffset % 60);
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
    `${sign}${offsetHours}:${offsetMins}`,
  ].join("");
}

function toLocalIsoFromUtc(utcIso: string): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return formatLocalIso(new Date(ms));
}

function nowTimestamps(): {
  utcIso: string;
  localIso: string;
  epochMs: number;
  timeZone: string;
} {
  const now = new Date();
  return {
    utcIso: now.toISOString(),
    localIso: formatLocalIso(now),
    epochMs: now.getTime(),
    timeZone: resolveSessionTimezone(),
  };
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    "_",
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join("");
}

// ------------------------------------------------------------------
// SessionStore
// ------------------------------------------------------------------

export class SessionStore {
  private _projectPath: string | undefined;
  private _projectSlug: string;
  private _preferredBaseDir: string;
  private _activeBaseDir: string | undefined;
  private _projectDir: string;
  private _sessionDir: string | undefined;

  constructor(opts?: { projectPath?: string; baseDir?: string }) {
    this._projectPath = opts?.projectPath;
    this._projectSlug = opts?.projectPath
      ? projectSlug(opts.projectPath)
      : "general";
    this._preferredBaseDir = resolvePreferredBaseDir(opts?.baseDir);
    this._projectDir = join(this._preferredBaseDir, "projects", this._projectSlug);
  }

  // -- lifecycle --

  private _candidateBaseDirs(): string[] {
    const candidates = [
      this._preferredBaseDir,
      join(tmpdir(), "longeragent", "sessions"),
    ];
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      dedup.push(c);
    }
    return dedup;
  }

  private _ensureProjectMetadata(projectDir: string): void {
    const projectJson = join(projectDir, "project.json");
    if (existsSync(projectJson)) return;
    writeFileSync(
      projectJson,
      JSON.stringify(
        {
          original_path: this._projectPath ?? "",
          created_at: nowTimestamps().utcIso,
        },
        null,
        2,
      ),
    );
  }

  private static _createUniqueSessionDir(projectDir: string): string {
    const ts = timestampSlug();
    const first = join(projectDir, `${ts}_chat`);
    if (!existsSync(first)) {
      mkdirSync(first, { recursive: true });
      return first;
    }
    for (let idx = 1; idx < 1000; idx++) {
      const candidate = join(projectDir, `${ts}_${String(idx).padStart(3, "0")}_chat`);
      if (existsSync(candidate)) continue;
      mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    throw new Error("Failed to allocate a unique session directory.");
  }

  createSession(): string {
    const errors: string[] = [];

    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        const sessionDir = SessionStore._createUniqueSessionDir(projectDir);
        mkdirSync(join(sessionDir, "artifacts"), { recursive: true });

        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._sessionDir = sessionDir;

        if (baseDir !== this._preferredBaseDir) {
          console.warn(
            `SessionStore fallback active: preferred '${this._preferredBaseDir}' not writable, using '${baseDir}'`,
          );
        }
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
        continue;
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to create session storage directory. Tried: ${detail}`);
  }

  /** Clear the current session directory (used by /new to defer creation). */
  clearSession(): void {
    this._sessionDir = undefined;
  }

  listSessions(): Array<{ path: string; created: string; summary: string; turns: number }> {
    if (!existsSync(this._projectDir)) return [];

    const sessions: Array<{ path: string; created: string; summary: string; turns: number }> = [];
    const entries = readdirSync(this._projectDir).sort().reverse();

    for (const name of entries) {
      const d = join(this._projectDir, name);
      if (!name.endsWith("_chat")) continue;
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch {
        continue;
      }
      const logFile = join(d, "log.json");
      if (!existsSync(logFile)) continue;
      try {
        const raw = JSON.parse(readFileSync(logFile, "utf-8"));
        const createdUtc = (raw["created_at"] as string) ?? "";
        const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
        const summary = raw["summary"] ?? "";
        const turns = raw["turn_count"] ?? 0;
        sessions.push({ path: d, created, summary, turns });
      } catch {
        continue;
      }
    }
    return sessions;
  }

  get projectDir(): string {
    return this._projectDir;
  }

  get artifactsDir(): string | undefined {
    if (!this._sessionDir) return undefined;
    const d = join(this._sessionDir, "artifacts");
    try {
      mkdirSync(d, { recursive: true });
    } catch (exc) {
      console.warn(`Failed to ensure artifacts directory '${d}': ${exc}`);
      return undefined;
    }
    return d;
  }

  get sessionDir(): string | undefined {
    return this._sessionDir;
  }

  set sessionDir(value: string) {
    this._sessionDir = value;
  }
}

// ====================================================================
// Log-native persistence (v2)
// ====================================================================

// ------------------------------------------------------------------
// LogSessionMeta
// ------------------------------------------------------------------

export interface LogSessionMeta {
  version: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  modelConfigName: string;
  summary: string;
  turnCount: number;
  compactCount: number;
  thinkingLevel: string;
  cacheHitEnabled: boolean;
}

export function createLogSessionMeta(
  partial?: Partial<LogSessionMeta>,
): LogSessionMeta {
  return {
    version: 2,
    sessionId: "",
    createdAt: "",
    updatedAt: "",
    projectPath: "",
    modelConfigName: "",
    summary: "",
    turnCount: 0,
    compactCount: 0,
    thinkingLevel: "default",
    cacheHitEnabled: false,
    ...partial,
  };
}

// ------------------------------------------------------------------
// camelCase ↔ snake_case conversion for LogEntry
// ------------------------------------------------------------------

function entryToSnake(entry: LogEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    turn_index: entry.turnIndex,
    tui_visible: entry.tuiVisible,
    display_kind: entry.displayKind,
    display: entry.display,
    api_role: entry.apiRole,
    content: entry.content,
    archived: entry.archived,
    meta: entry.meta,
  };
  if (entry.roundIndex !== undefined) obj.round_index = entry.roundIndex;
  if (entry.summarized) obj.summarized = true;
  if (entry.summarizedBy) obj.summarized_by = entry.summarizedBy;
  if (entry.discarded) obj.discarded = true;
  return obj;
}

function entryFromSnake(obj: Record<string, unknown>): LogEntry {
  return {
    id: obj.id as string,
    type: obj.type as LogEntryType,
    timestamp: obj.timestamp as number,
    turnIndex: (obj.turn_index as number) ?? 0,
    roundIndex: obj.round_index as number | undefined,
    tuiVisible: (obj.tui_visible as boolean) ?? false,
    displayKind: (obj.display_kind as TuiDisplayKind | null) ?? null,
    display: (obj.display as string) ?? "",
    apiRole: (obj.api_role as LogEntry["apiRole"]) ?? null,
    content: obj.content ?? null,
    archived: (obj.archived as boolean) ?? false,
    meta: (obj.meta as Record<string, unknown>) ?? {},
    ...(obj.summarized ? { summarized: true } : {}),
    ...(obj.summarized_by ? { summarizedBy: obj.summarized_by as string } : {}),
    ...(obj.discarded ? { discarded: true } : {}),
  };
}

// ------------------------------------------------------------------
// saveLog / loadLog
// ------------------------------------------------------------------

export function saveLog(
  dir: string,
  meta: LogSessionMeta,
  entries: LogEntry[],
): void {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  const payload: Record<string, unknown> = {
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    summary: meta.summary,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    cache_hit_enabled: meta.cacheHitEnabled,
    entries: entries.map(entryToSnake),
  };

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, logFile);
}

export interface LoadLogResult {
  meta: LogSessionMeta;
  entries: LogEntry[];
  idAllocator: LogIdAllocator;
}

export function loadLog(dir: string): LoadLogResult {
  const logFile = join(dir, "log.json");
  const raw = JSON.parse(readFileSync(logFile, "utf-8"));

  const meta: LogSessionMeta = {
    version: raw.version ?? 2,
    sessionId: raw.session_id ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    projectPath: raw.project_path ?? "",
    modelConfigName: raw.model_config_name ?? "",
    summary: raw.summary ?? "",
    turnCount: raw.turn_count ?? 0,
    compactCount: raw.compact_count ?? 0,
    thinkingLevel: raw.thinking_level ?? "default",
    cacheHitEnabled: raw.cache_hit_enabled ?? false,
  };

  const rawEntries = (raw.entries ?? []) as Array<Record<string, unknown>>;
  const entries = rawEntries.map(entryFromSnake);

  // Validate entry ID uniqueness
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  // Restore ID allocator via full scan
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);

  return { meta, entries, idAllocator };
}

// ------------------------------------------------------------------
// validateAndRepairLog
// ------------------------------------------------------------------

export interface LogRepairResult {
  entries: LogEntry[];
  repaired: boolean;
  warnings: string[];
}

export function validateAndRepairLog(
  entries: LogEntry[],
): LogRepairResult {
  const warnings: string[] = [];
  let repaired = false;

  if (!entries || entries.length === 0) {
    return { entries: entries ?? [], repaired: false, warnings: [] };
  }

  // --- 1. Orphaned compactPhase entries (no compact_marker after them) ---
  {
    // Find the last compact_marker index
    let lastCompactMarkerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_marker" && !entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }
    // Mark compactPhase entries after the last compact_marker as discarded
    for (let i = lastCompactMarkerIdx + 1; i < entries.length; i++) {
      if (entries[i].meta?.compactPhase && !entries[i].discarded) {
        entries[i].discarded = true;
        warnings.push(`Discarded orphaned compactPhase entry ${entries[i].id}.`);
        repaired = true;
      }
    }
  }

  // --- 2. Fix orphaned tool_calls (missing tool_results) ---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || entry.discarded) continue;

    const toolCallId = entry.meta.toolCallId as string;
    // Check if there's a matching tool_result
    let hasResult = false;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
        hasResult = true;
        break;
      }
    }
    if (!hasResult) {
      // Check if this is the last entry or near the end — likely a crash
      const isNearEnd = entries.length - i <= 5;
      if (isNearEnd) {
        // Add a recovered tool_result (we need an ID — use a predictable format)
        const recoveredId = `tr-recovered-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: entry.turnIndex,
          roundIndex: entry.roundIndex,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: entry.meta.toolName as string,
            content: "Session recovered. Tool result unavailable due to abnormal termination.",
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: entry.meta.toolName,
            isError: false,
            recovered: true,
            ...(entry.meta.contextId !== undefined ? { contextId: entry.meta.contextId } : {}),
          },
        };
        // Insert after the tool_call
        entries.splice(i + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result for tool_call ${entry.id} (${toolCallId}).`);
        repaired = true;
      }
    }
  }

  // --- 3. ask repair ---
  {
    // Build ask_request → ask_resolution mapping
    const askRequests = new Map<string, number>();
    const askResolutions = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.discarded) continue;
      if (e.type === "ask_request") {
        askRequests.set(e.meta.askId as string, i);
      } else if (e.type === "ask_resolution") {
        askResolutions.set(e.meta.askId as string, i);
      }
    }

    // Orphan ask_resolution (no matching ask_request) → discard
    for (const [askId, idx] of askResolutions) {
      if (!askRequests.has(askId)) {
        entries[idx].discarded = true;
        warnings.push(`Discarded orphan ask_resolution ${entries[idx].id} (askId=${askId}).`);
        repaired = true;
      }
    }

    // ask_resolution exists but no tool_result → add recovered tool_result
    for (const [askId, resIdx] of askResolutions) {
      if (entries[resIdx].discarded) continue;
      const reqIdx = askRequests.get(askId);
      if (reqIdx === undefined) continue;

      const reqEntry = entries[reqIdx];
      const toolCallId = reqEntry.meta.toolCallId as string;
      if (!toolCallId) continue;

      // Check if there's a tool_result for this toolCallId after the resolution
      let hasToolResult = false;
      for (let j = resIdx + 1; j < entries.length; j++) {
        if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
          hasToolResult = true;
          break;
        }
      }
      if (!hasToolResult) {
        const recoveredId = `tr-askrecv-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: reqEntry.turnIndex,
          roundIndex: reqEntry.meta.roundIndex as number | undefined,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            content: "Ask resolved. Session recovered from abnormal termination.",
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            isError: false,
            recovered: true,
            ...(reqEntry.meta.contextId !== undefined ? { contextId: reqEntry.meta.contextId } : {}),
          },
        };
        entries.splice(resIdx + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result after ask_resolution ${entries[resIdx].id} (askId=${askId}).`);
        repaired = true;
      }
    }
  }

  return { entries, repaired, warnings };
}

// ------------------------------------------------------------------
// Archive window
// ------------------------------------------------------------------

export function archiveWindow(
  dir: string,
  windowIndex: number,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): void {
  const archiveDir = join(dir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const archived: Array<{ id: string; content: unknown }> = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const e = entries[i];
    if (e.content !== null && !e.archived) {
      archived.push({ id: e.id, content: e.content });
      e.content = null;
      e.archived = true;
    }
  }

  const archiveFile = join(archiveDir, `window-${windowIndex}.json.gz`);
  const json = JSON.stringify(archived);
  const compressed = gzipSync(Buffer.from(json));
  writeFileSync(archiveFile, compressed);
}

export function loadArchive(
  dir: string,
  windowIndex: number,
): Array<{ id: string; content: unknown }> {
  const archiveFile = join(dir, "archive", `window-${windowIndex}.json.gz`);
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * Restore archived content back into entries (in-memory only).
 */
export function restoreArchiveToEntries(
  entries: LogEntry[],
  archived: Array<{ id: string; content: unknown }>,
): void {
  const contentMap = new Map(archived.map((a) => [a.id, a.content]));
  for (const e of entries) {
    if (e.archived && contentMap.has(e.id)) {
      e.content = contentMap.get(e.id)!;
    }
  }
}
