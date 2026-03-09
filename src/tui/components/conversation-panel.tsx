/**
 * Conversation panel -- displays the conversation history.
 *
 * Renders user messages, agent responses (with markdown), progress lines,
 * reasoning blocks, and status messages.  Markdown is rendered via
 * marked + marked-terminal with width-aware reflow.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { ConversationEntry } from "../types.js";
import { theme } from "../theme.js";
import { stripAnsiSequences } from "../input/sanitize.js";

// ------------------------------------------------------------------
// Markdown rendering
// ------------------------------------------------------------------

type MarkdownDisplayMode = "rendered" | "raw";

const FALLBACK_MARKDOWN_WIDTH = 100;
const MIN_MARKDOWN_WIDTH = 40;
const MAX_CACHED_PARSERS = 6;
const STRONG_PUNCTUATION_FIX_RE =
  /([^\s])(\*\*|__)(?=["'“”‘’([{【「《<])/g;
const markdownParserByWidth = new Map<number, Marked>();
const TABLE_DELIMITER_RE =
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// ------------------------------------------------------------------
// Wide table → card layout helpers
// ------------------------------------------------------------------

function isFullWidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals, Kangxi, Ideographic
    (cp >= 0x3040 && cp <= 0x33bf) ||   // Hiragana, Katakana, Bopomofo, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x4e00 && cp <= 0xa4cf) ||   // CJK Unified, Yi
    (cp >= 0xac00 && cp <= 0xd7af) ||   // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK Compat Forms
    (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B+
    (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Extension G+
  );
}

function visualWidth(str: string): number {
  const stripped = stripAnsiSequences(str);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0)!;
    w += isFullWidthCodePoint(cp) ? 2 : 1;
  }
  return w;
}

function hasLineOverflow(rendered: string, maxWidth: number): boolean {
  return rendered.split("\n").some((line) => visualWidth(line) > maxWidth);
}

function parseTableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function renderTableAsCards(tableLines: string[], maxWidth: number): string {
  const headers = parseTableCells(tableLines[0]);
  const rows: string[][] = [];

  for (let i = 2; i < tableLines.length; i++) {
    if (!tableLines[i].trim()) continue;
    rows.push(parseTableCells(tableLines[i]));
  }
  if (rows.length === 0) return tableLines.join("\n");

  const cardParts: string[] = [];
  let maxLineLen = 0;

  for (const row of rows) {
    const rowLines: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const line = `  ${headers[c]}: ${row[c] ?? ""}`;
      rowLines.push(line);
      maxLineLen = Math.max(maxLineLen, line.length);
    }
    cardParts.push(rowLines.join("\n"));
  }

  const sepLen = Math.min(maxLineLen, maxWidth - 2);
  const separator = "  " + "─".repeat(Math.max(sepLen - 2, 10));

  return cardParts.join("\n" + separator + "\n");
}

interface MdSegment {
  type: "text" | "table";
  raw: string;
}

function segmentMarkdown(md: string): MdSegment[] {
  const lines = md.split("\n");
  const segments: MdSegment[] = [];
  let currentTextLines: string[] = [];
  let inFence = false;
  let fenceKind: string | null = null;
  let i = 0;

  function flushText(): void {
    if (currentTextLines.length > 0) {
      segments.push({ type: "text", raw: currentTextLines.join("\n") });
      currentTextLines = [];
    }
  }

  while (i < lines.length) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fenceMatch) {
      const kind = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceKind = kind;
      } else if (fenceKind === kind) {
        inFence = false;
        fenceKind = null;
      }
      currentTextLines.push(lines[i]);
      i++;
      continue;
    }

    if (inFence) {
      currentTextLines.push(lines[i]);
      i++;
      continue;
    }

    // Detect GFM table: header row with | followed by delimiter row
    if (
      lines[i].includes("|") &&
      i + 1 < lines.length &&
      TABLE_DELIMITER_RE.test(lines[i + 1])
    ) {
      flushText();
      const tableStart = i;
      i += 2; // skip header + delimiter
      while (
        i < lines.length &&
        lines[i].trim().length > 0 &&
        lines[i].includes("|")
      ) {
        i++;
      }
      segments.push({ type: "table", raw: lines.slice(tableStart, i).join("\n") });
      continue;
    }

    currentTextLines.push(lines[i]);
    i++;
  }

  flushText();
  return segments;
}

// ------------------------------------------------------------------
// Markdown helpers
// ------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildIndent(tab: number | string | undefined): string {
  if (typeof tab === "string" && tab.length > 0) return tab;
  if (typeof tab === "number" && tab > 0) return " ".repeat(tab);
  return "  ";
}

function isPointedLine(line: string, indent: string): boolean {
  const pointRegex = "(?:\\*|\\d+\\.)";
  const pattern = new RegExp(`^(?:${escapeRegExp(indent)})*${pointRegex}`);
  return pattern.test(line);
}

function formatUnorderedList(lines: string, indent: string): string {
  const markerRe = new RegExp(`^((?:${escapeRegExp(indent)})*)\\* `);
  return lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      if (isPointedLine(line, indent)) {
        return line.replace(markerRe, "$1- ");
      }
      return "  " + line;
    })
    .join("\n");
}

function formatOrderedList(lines: string, indent: string): string {
  const markerRe = new RegExp(`^((?:${escapeRegExp(indent)})*)\\* `);
  let num = 0;

  return lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      if (isPointedLine(line, indent)) {
        num += 1;
        return line.replace(markerRe, `$1${num}. `);
      }
      const align = `${Math.max(1, num)}. `.length;
      return " ".repeat(align) + line;
    })
    .join("\n");
}

function formatMarkdownList(body: string, ordered: boolean, tab?: number | string): string {
  const trimmed = body.trim();
  if (!trimmed) return trimmed;
  const indent = buildIndent(tab);
  if (ordered) return formatOrderedList(trimmed, indent);
  return formatUnorderedList(trimmed, indent);
}

function renderPlainCodeBlock(code: string, tab: number | string | undefined): string {
  const indent = buildIndent(tab);
  const body = code
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  return `\n${body}\n\n`;
}

function buildUnifiedTextRenderer(extension: {
  renderer?: {
    text?: (...args: unknown[]) => string;
    code?: (...args: unknown[]) => string;
  };
}): void {
  const baseText = extension.renderer?.text;
  const baseCode = extension.renderer?.code;
  if (!extension.renderer) return;

  extension.renderer.text = function (
    this: { parser?: { parseInline: (tokens: unknown[]) => string } },
    ...args: unknown[]
  ): string {
    const token = args[0];
    if (
      token &&
      typeof token === "object" &&
      Array.isArray((token as { tokens?: unknown[] }).tokens) &&
      this.parser
    ) {
      try {
        return this.parser.parseInline((token as { tokens: unknown[] }).tokens);
      } catch {
        // Fall through to base renderer when inline parsing fails.
      }
    }
    if (typeof baseText === "function") {
      return baseText.apply(this, args);
    }
    if (typeof token === "string") return token;
    if (token && typeof token === "object" && typeof (token as { text?: unknown }).text === "string") {
      return (token as { text: string }).text;
    }
    return "";
  };

  extension.renderer.code = function (...args: unknown[]): string {
    const token = args[0];
    let code = "";
    let lang = "";

    if (token && typeof token === "object") {
      code = typeof (token as { text?: unknown }).text === "string" ? (token as { text: string }).text : "";
      lang = typeof (token as { lang?: unknown }).lang === "string" ? (token as { lang: string }).lang.trim() : "";
    } else {
      code = typeof token === "string" ? token : "";
      lang = typeof args[1] === "string" ? args[1].trim() : "";
    }

    if (!lang) {
      return renderPlainCodeBlock(code, 2);
    }

    if (typeof baseCode === "function") {
      return baseCode.apply(this, args);
    }

    return renderPlainCodeBlock(code, 2);
  };
}

/** Width available for the activity panel (border + padding + content). */
const ACTIVITY_PANEL_RESERVE = 34;

export function markdownWidth(rightPanelVisible = false): number {
  const columns = process.stdout.columns;
  if (!columns || Number.isNaN(columns)) return FALLBACK_MARKDOWN_WIDTH;
  // Account for panel/container padding so markdown reflow aligns with
  // what users actually see inside the conversation area.
  const reserve = rightPanelVisible ? ACTIVITY_PANEL_RESERVE : 0;
  return Math.max(MIN_MARKDOWN_WIDTH, columns - 6 - reserve);
}

function createMarkdownParser(width: number): Marked {
  const parser = new Marked({ gfm: true, breaks: false });
  const extension = markedTerminal({
    reflowText: true,
    width,
    tab: 2,
    showSectionPrefix: true,
    list: (body: string, ordered: boolean, tab?: number | string) =>
      formatMarkdownList(body, ordered, tab),
  }) as {
    renderer?: {
      text?: (...args: unknown[]) => string;
    };
  };
  buildUnifiedTextRenderer(extension);
  parser.use(extension);
  return parser;
}

function getMarkdownParser(width: number): Marked {
  let parser = markdownParserByWidth.get(width);
  if (parser) return parser;

  parser = createMarkdownParser(width);
  markdownParserByWidth.set(width, parser);
  if (markdownParserByWidth.size > MAX_CACHED_PARSERS) {
    markdownParserByWidth.clear();
    markdownParserByWidth.set(width, parser);
  }
  return parser;
}

function hasUnclosedFence(text: string): boolean {
  let openFence: "`" | "~" | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const kind = m[1][0] === "~" ? "~" : "`";
    if (openFence === null) {
      openFence = kind;
      continue;
    }
    if (openFence === kind) {
      openFence = null;
    }
  }
  return openFence !== null;
}

function findUnclosedFenceStart(text: string): number {
  let openFence: "`" | "~" | null = null;
  let openFenceStart = -1;
  let offset = 0;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const kind = m[1][0] === "~" ? "~" : "`";
      if (openFence === null) {
        openFence = kind;
        openFenceStart = offset;
      } else if (openFence === kind) {
        openFence = null;
        openFenceStart = -1;
      }
    }
    offset += line.length + 1;
  }
  return openFence === null ? -1 : openFenceStart;
}

function findLastBlankLineBoundary(text: string, upto: number): number {
  const chunk = text.slice(0, upto);
  const re = /\n[ \t]*\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    last = m.index + m[0].length;
  }
  return last;
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function looksLikeTableBlock(lines: string[]): boolean {
  if (lines.length < 2) return false;
  return lines.every((line) => line.includes("|"));
}

function isCompleteTableBlock(lines: string[]): boolean {
  if (lines.length < 3) return false;
  if (!TABLE_DELIMITER_RE.test(lines[1])) return false;
  const bodyLines = lines.slice(2).filter((line) => line.trim().length > 0);
  if (bodyLines.length === 0) return false;
  return bodyLines.every((line) => line.includes("|"));
}

function moveTrailingIncompleteTableBlock(stableText: string): { stable: string; tail: string } {
  if (!stableText) return { stable: stableText, tail: "" };

  let trimmedEnd = stableText.length;
  while (trimmedEnd > 0 && stableText[trimmedEnd - 1] === "\n") {
    trimmedEnd -= 1;
  }
  if (trimmedEnd === 0) return { stable: stableText, tail: "" };

  const blockStart = findLastBlankLineBoundary(stableText, trimmedEnd);
  const block = stableText.slice(blockStart, trimmedEnd);
  const blockLines = splitNonEmptyLines(block);

  if (!looksLikeTableBlock(blockLines)) return { stable: stableText, tail: "" };
  if (isCompleteTableBlock(blockLines)) return { stable: stableText, tail: "" };

  return {
    stable: stableText.slice(0, blockStart),
    tail: stableText.slice(blockStart),
  };
}

export interface StreamingMarkdownSplit {
  stable: string;
  tail: string;
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  if (!text) return { stable: "", tail: "" };

  const unclosedFenceStart = findUnclosedFenceStart(text);
  if (unclosedFenceStart >= 0) {
    return {
      stable: text.slice(0, unclosedFenceStart),
      tail: text.slice(unclosedFenceStart),
    };
  }

  let stableEnd = text.length;
  if (!text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) {
      return { stable: "", tail: text };
    }
    stableEnd = lastNewline + 1;
  }

  let stable = text.slice(0, stableEnd);
  let tail = text.slice(stableEnd);

  const adjusted = moveTrailingIncompleteTableBlock(stable);
  stable = adjusted.stable;
  if (adjusted.tail.length > 0) {
    tail = adjusted.tail + tail;
  }

  return { stable, tail };
}

function normalizeMarkdownForRender(md: string): string {
  const lines = md.split("\n");
  let inFence = false;
  let fenceKind: "`" | "~" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const kind = fence[1][0] === "~" ? "~" : "`";
      if (!inFence) {
        inFence = true;
        fenceKind = kind;
      } else if (fenceKind === kind) {
        inFence = false;
        fenceKind = null;
      }
      continue;
    }
    if (inFence) continue;
    lines[i] = line.replace(STRONG_PUNCTUATION_FIX_RE, "$1 $2");
  }

  return lines.join("\n");
}

function renderMarkdown(md: string, width: number, trimEndOutput = true): string {
  try {
    const normalized = normalizeMarkdownForRender(md);
    const segments = segmentMarkdown(normalized);

    // Fast path: single text segment (most common case — no tables)
    if (segments.length === 1 && segments[0].type === "text") {
      const rendered = getMarkdownParser(width).parse(segments[0].raw) as string;
      return trimEndOutput ? rendered.trimEnd() : rendered;
    }

    const parts: string[] = [];
    for (const seg of segments) {
      if (seg.type === "table") {
        // Render through marked first, then check actual visual width
        const rendered = getMarkdownParser(width).parse(seg.raw) as string;
        if (hasLineOverflow(rendered, width)) {
          const tableLines = seg.raw.split("\n").filter((l) => l.trim());
          parts.push(renderTableAsCards(tableLines, width));
          continue;
        }
        parts.push(rendered);
      } else if (seg.raw.trim()) {
        parts.push(getMarkdownParser(width).parse(seg.raw) as string);
      }
    }

    const result = parts.join("");
    return trimEndOutput ? result.trimEnd() : result;
  } catch {
    return md;
  }
}

export function renderMarkdownForDisplay(md: string, width = FALLBACK_MARKDOWN_WIDTH): string {
  return renderMarkdown(md, width);
}

// ------------------------------------------------------------------
// Entry renderers (exported for use by Static rendering in app.tsx)
// ------------------------------------------------------------------

export function UserMessageView({ text, queued }: { text: string; queued?: boolean }): React.ReactElement {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text color={theme.accent} bold>{"> "}</Text>
      <Text>{text}</Text>
      {queued && <Text color="yellow">{" (Queued)"}</Text>}
    </Box>
  );
}

interface AssistantResponseViewProps {
  text: string;
  markdownMode: MarkdownDisplayMode;
  isStreaming: boolean;
  width: number;
}

export function AssistantResponseView({
  text,
  markdownMode,
  isStreaming,
  width,
}: AssistantResponseViewProps): React.ReactElement {
  let output = text;
  if (markdownMode === "rendered") {
    if (isStreaming) {
      const split = splitStreamingMarkdown(text);
      const renderedStable = split.stable.length > 0
        ? renderMarkdown(split.stable, width, false)
        : "";
      if (
        renderedStable &&
        split.tail &&
        !renderedStable.endsWith("\n") &&
        !split.tail.startsWith("\n")
      ) {
        output = `${renderedStable}\n${split.tail}`;
      } else {
        output = renderedStable + split.tail;
      }
    } else {
      output = hasUnclosedFence(text) ? text : renderMarkdown(text, width);
    }
  }

  return (
    <Box paddingLeft={1} marginTop={0}>
      <Text>{output}</Text>
    </Box>
  );
}

export function ProgressLineView({ text }: { text: string }): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

export function SubAgentRollupView({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text
          key={idx}
          dimColor
          wrap="truncate-end"
        >
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

export function SubAgentDoneView({ text }: { text: string }): React.ReactElement {
  const match = text.match(/^\[(.+)\] \[done\] \((.+)\)$/);
  if (!match) {
    return (
      <Box>
        <Text dimColor>{"- "}{text}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>{"- "}</Text>
      <Text dimColor>{"["}{match[1]}{"] "}</Text>
      <Text color="green">{"[done]"}</Text>
      <Text dimColor>{" ("}{match[2]}{")"}</Text>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallView({
  text,
  startedAt,
  elapsedMs,
}: {
  text: string;
  startedAt?: number;
  elapsedMs?: number;
}): React.ReactElement {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(" ");
  const toolName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  // Live timer for in-progress tool calls
  const [liveMs, setLiveMs] = useState<number | null>(null);

  useEffect(() => {
    if (elapsedMs !== undefined || !startedAt) {
      setLiveMs(null);
      return;
    }
    // Update every 100ms for smooth display
    setLiveMs(Date.now() - startedAt);
    const interval = setInterval(() => {
      setLiveMs(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(interval);
  }, [startedAt, elapsedMs]);

  const timeDisplay = elapsedMs !== undefined
    ? formatElapsed(elapsedMs)
    : liveMs !== null
    ? formatElapsed(liveMs)
    : null;

  return (
    <Box>
      <Text color="cyan">{"- "}{toolName}</Text>
      {timeDisplay ? (
        <Text dimColor>{" ("}{timeDisplay}{elapsedMs !== undefined ? "" : "…"}{") "}</Text>
      ) : null}
      {rest ? <Text dimColor>{rest}</Text> : null}
    </Box>
  );
}

function diffLineColor(line: string): string | undefined {
  const payloadIdx = line.indexOf("| ");
  const payload = payloadIdx >= 0 ? line.slice(payloadIdx + 2) : line;
  if (payload.startsWith("@@")) return "yellow";
  if (payload.startsWith("+++ ") || payload.startsWith("--- ")) return "gray";
  if (payload.startsWith("+")) return "green";
  if (payload.startsWith("-")) return "red";
  if (payload.startsWith("... [")) return "gray";
  return undefined;
}

export function ToolResultView({ text, dim }: { text: string; dim?: boolean }): React.ReactElement {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, idx) => (
        <Text key={idx} color={dim ? undefined : diffLineColor(line)} dimColor={dim}>
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

export function ReasoningView({ text }: { text: string }): React.ReactElement {
  return (
    <Box>
      <Text color="gray">{text}</Text>
    </Box>
  );
}

export function StatusView({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="yellow">{text}</Text>
    </Box>
  );
}

export function ErrorView({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="red">{"[x] Error: "}{text}</Text>
    </Box>
  );
}

// ------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------

export interface ConversationPanelProps {
  entries: ConversationEntry[];
  markdownMode?: MarkdownDisplayMode;
  streamingAssistantEntryId?: string | null;
  /** Whether the right-side activity panel is visible (affects markdown width). */
  rightPanelVisible?: boolean;
}

export function ConversationPanel({
  entries,
  markdownMode = "rendered",
  streamingAssistantEntryId = null,
  rightPanelVisible = false,
}: ConversationPanelProps): React.ReactElement {
  const width = markdownWidth(rightPanelVisible);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
    >
      <Box marginBottom={0}>
        <Text color={theme.accent} bold>{"CONVERSATION"}</Text>
      </Box>
      {entries.map((entry, i) => {
        const key = entry.id ?? `entry-${i}`;
        // Add visual spacing when a reasoning block follows a progress entry
        // (indicates a new thinking segment after a tool call).
        const prev = i > 0 ? entries[i - 1] : null;
        const needsSpacing = entry.kind === "reasoning" && (
          prev?.kind === "progress" ||
          prev?.kind === "tool_call" ||
          prev?.kind === "sub_agent_rollup"
        );

        switch (entry.kind) {
          case "user":
            return <UserMessageView key={key} text={entry.text} queued={entry.queued} />;
          case "assistant":
            return (
              <AssistantResponseView
                key={key}
                text={entry.text}
                markdownMode={markdownMode}
                isStreaming={entry.id === streamingAssistantEntryId}
                width={width}
              />
            );
          case "progress":
            return <ProgressLineView key={key} text={entry.text} />;
          case "sub_agent_rollup":
            return <SubAgentRollupView key={key} text={entry.text} />;
          case "sub_agent_done":
            return <SubAgentDoneView key={key} text={entry.text} />;
          case "tool_call":
            return <ToolCallView key={key} text={entry.text} startedAt={entry.startedAt} elapsedMs={entry.elapsedMs} />;
          case "tool_result":
            return <ToolResultView key={key} text={entry.text} dim={entry.dim} />;
          case "reasoning":
            return (
              <React.Fragment key={key}>
                {needsSpacing && <Box marginTop={1} />}
                <ReasoningView text={entry.text} />
              </React.Fragment>
            );
          case "status":
            return <StatusView key={key} text={entry.text} />;
          case "error":
            return <ErrorView key={key} text={entry.text} />;
          case "compact_mark":
            return <StatusView key={key} text={entry.text} />;
          default:
            return null;
        }
      })}
    </Box>
  );
}
