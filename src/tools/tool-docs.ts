/**
 * Per-tool documentation, single-sourced next to the tool implementations.
 *
 * Each built-in tool has one markdown file in ./docs/ with two segments:
 *
 *   <!-- brief -->  short contract, rendered verbatim into ToolDef.description
 *   <!-- guide -->  detailed usage, rendered into the generated "# Tools"
 *                   section of each agent template's system prompt — only for
 *                   the tools that template actually has
 *
 * Briefs must stay template-variable-free: tool descriptions are NOT passed
 * through renderPromptVariables. Guides may use {PROJECT_ROOT} / {SHELL_NOTES}
 * etc. — the generated section is part of the system prompt and goes through
 * normal variable rendering.
 *
 * Implementation constants ({BASH_MAX_TIMEOUT}) are a separate, earlier
 * layer: loadDoc bakes them in at module init, in briefs and guides alike,
 * so docs can quote limits without copying numbers out of the code.
 *
 * The files are embedded at build time via Bun text imports, so they ship
 * inside the compiled binary and cannot drift from the code they sit next to.
 */

import askDoc from "./docs/ask.md" with { type: "text" };
import awaitEventDoc from "./docs/await_event.md" with { type: "text" };
import bashDoc from "./docs/bash.md" with { type: "text" };
import bashBackgroundDoc from "./docs/bash_background.md" with { type: "text" };
import bashOutputDoc from "./docs/bash_output.md" with { type: "text" };
import checkStatusDoc from "./docs/check_status.md" with { type: "text" };
import createGoalDoc from "./docs/create_goal.md" with { type: "text" };
import editFileDoc from "./docs/edit_file.md" with { type: "text" };
import globDoc from "./docs/glob.md" with { type: "text" };
import grepDoc from "./docs/grep.md" with { type: "text" };
import killAgentDoc from "./docs/kill_agent.md" with { type: "text" };
import killShellDoc from "./docs/kill_shell.md" with { type: "text" };
import listDirDoc from "./docs/list_dir.md" with { type: "text" };
import readFileDoc from "./docs/read_file.md" with { type: "text" };
import reloadDoc from "./docs/reload.md" with { type: "text" };
import sendDoc from "./docs/send.md" with { type: "text" };
import showContextDoc from "./docs/show_context.md" with { type: "text" };
import skillDoc from "./docs/skill.md" with { type: "text" };
import spawnDoc from "./docs/spawn.md" with { type: "text" };
import summarizeContextDoc from "./docs/summarize_context.md" with { type: "text" };
import timeDoc from "./docs/time.md" with { type: "text" };
import updateGoalDoc from "./docs/update_goal.md" with { type: "text" };
import webFetchDoc from "./docs/web_fetch.md" with { type: "text" };
import webSearchDoc from "./docs/web_search.md" with { type: "text" };
import writeFileDoc from "./docs/write_file.md" with { type: "text" };

import { BASH_MAX_TIMEOUT } from "./shared.js";

export interface ToolDoc {
  /** Short contract for ToolDef.description. Never empty. */
  brief: string;
  /** Detailed usage for the generated Tool Guidelines section. May be empty. */
  guide: string;
}

const BRIEF_MARKER = "<!-- brief -->";
const GUIDE_MARKER = "<!-- guide -->";

/** Bake implementation constants into a doc, then split it. */
function loadDoc(raw: string): ToolDoc {
  return parseToolDoc(
    raw.replaceAll("{BASH_MAX_TIMEOUT}", String(BASH_MAX_TIMEOUT)),
  );
}

/** Split a doc file into its brief and guide segments. */
export function parseToolDoc(raw: string): ToolDoc {
  const guideIdx = raw.indexOf(GUIDE_MARKER);
  const briefIdx = raw.indexOf(BRIEF_MARKER);
  const briefStart = briefIdx >= 0 ? briefIdx + BRIEF_MARKER.length : 0;
  const briefEnd = guideIdx >= 0 ? guideIdx : raw.length;
  return {
    brief: raw.slice(briefStart, briefEnd).trim(),
    guide: guideIdx >= 0 ? raw.slice(guideIdx + GUIDE_MARKER.length).trim() : "",
  };
}

export const TOOL_DOCS: Record<string, ToolDoc> = {
  read_file: loadDoc(readFileDoc),
  write_file: loadDoc(writeFileDoc),
  edit_file: loadDoc(editFileDoc),
  list_dir: loadDoc(listDirDoc),
  glob: loadDoc(globDoc),
  grep: loadDoc(grepDoc),
  bash: loadDoc(bashDoc),
  bash_background: loadDoc(bashBackgroundDoc),
  bash_output: loadDoc(bashOutputDoc),
  kill_shell: loadDoc(killShellDoc),
  time: loadDoc(timeDoc),
  web_search: loadDoc(webSearchDoc),
  web_fetch: loadDoc(webFetchDoc),
  spawn: loadDoc(spawnDoc),
  send: loadDoc(sendDoc),
  await_event: loadDoc(awaitEventDoc),
  kill_agent: loadDoc(killAgentDoc),
  check_status: loadDoc(checkStatusDoc),
  show_context: loadDoc(showContextDoc),
  summarize_context: loadDoc(summarizeContextDoc),
  ask: loadDoc(askDoc),
  skill: loadDoc(skillDoc),
  reload: loadDoc(reloadDoc),
  create_goal: loadDoc(createGoalDoc),
  update_goal: loadDoc(updateGoalDoc),
};

/**
 * The brief for a tool — used as its ToolDef.description.
 * Throws when the doc is missing so a renamed tool fails loudly at startup
 * (and in tests) instead of shipping an empty description.
 */
export function toolBrief(name: string): string {
  const doc = TOOL_DOCS[name];
  if (!doc?.brief) {
    throw new Error(`No brief doc for tool '${name}' (src/tools/docs/${name}.md)`);
  }
  return doc.brief;
}

/**
 * Canonical ordering of guides in the generated section. Deterministic order
 * is load-bearing: it keeps assembled prompts stable across reloads (snapshot
 * tests and prompt caching both depend on it).
 */
export const TOOL_GUIDELINE_ORDER: string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "bash",
  "bash_background",
  "bash_output",
  "kill_shell",
  "time",
  "web_search",
  "web_fetch",
  "spawn",
  "send",
  "await_event",
  "kill_agent",
  "check_status",
  "show_context",
  "summarize_context",
  "ask",
  "skill",
  "reload",
  "create_goal",
  "update_goal",
];

/**
 * Build the generated "# Tools" system-prompt section for a tool set.
 * Tools without a guide segment (or without a doc at all — e.g. MCP tools)
 * are skipped. Returns "" when nothing applies.
 */
export function buildToolGuidelinesSection(toolNames: Iterable<string>): string {
  const wanted = new Set(toolNames);
  const known = TOOL_GUIDELINE_ORDER.filter((n) => wanted.has(n));
  const unknown = [...wanted]
    .filter((n) => !TOOL_GUIDELINE_ORDER.includes(n))
    .sort();

  const parts: string[] = [];
  for (const name of [...known, ...unknown]) {
    const guide = TOOL_DOCS[name]?.guide;
    if (guide) {
      parts.push(`## \`${name}\`\n\n${guide}`);
    }
  }
  if (parts.length === 0) return "";
  return "# Tools\n\n" + parts.join("\n\n");
}
