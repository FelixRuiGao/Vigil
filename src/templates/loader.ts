/**
 * Agent template loader with multi-file prompt assembly.
 *
 * Provides `loadTemplate` / `loadTemplates` for agent templates.
 *
 * Template folder layout:
 *
 *   agent_templates/
 *   +-- main/
 *   |   +-- agent.yaml          # required
 *   |   +-- system_prompt.md    # referenced by system_prompt_file
 *   |   +-- knowledge/          # optional -- files appended to system prompt
 *   |       +-- style_guide.md
 *   +-- executor/
 *       +-- agent.yaml
 *       +-- system_prompt.md
 *
 * Prompt assembly pipeline (per template):
 *
 *   1. Read core system prompt from system_prompt.md
 *   2. Assemble tool prompts from prompts/tools/{name}.md
 *      (ordered by TOOL_PROMPT_ORDER, filtered by template's declared tools)
 *   3. Assemble section prompts from prompts/sections/{name}.md
 *      (controlled by template's prompt_sections field)
 *   4. Append knowledge/ files (existing mechanism)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as yaml from "js-yaml";

import { Agent } from "../agents/agent.js";
import type { Config } from "../config.js";
import type { ToolDef } from "../providers/base.js";
import { BASIC_TOOLS, BASIC_TOOLS_MAP } from "../tools/basic.js";
import type { MCPClientManager } from "../mcp-client.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const AGENT_YAML = "agent.yaml";
const REQUIRED_TEMPLATE_TYPE = "agent";
const MIN_TEMPLATE_MAX_TOOL_ROUNDS = 100;

/**
 * Canonical ordering for tool prompt assembly.
 * Tools not in this list are appended alphabetically after these.
 */
export const TOOL_PROMPT_ORDER: string[] = [
  // File I/O
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "list_dir",
  "glob",
  "grep",
  "diff",
  // Shell
  "bash",
  "bash_background",
  "bash_output",
  "kill_shell",
  "test",
  // Web
  "web_search",
  "web_fetch",
  // Orchestration
  "spawn_agent",
  "wait",
  "kill_agent",
  "check_status",
  // Context
  "show_context",
  "summarize_context",
  // Planning
  "plan",
  // Interaction
  "ask",
  "skill",
];

/**
 * Paired tool dependencies.
 * If a tool (key) is in the list, all its required companions (value) must also be present.
 */
export const TOOL_REQUIRES: Record<string, string[]> = {
  bash_output: ["bash_background"],
  kill_shell: ["bash_background"],
  bash_background: ["bash_output"],
};

/**
 * Default tools for custom templates that omit `tools` in agent.yaml.
 * Same set as the executor template.
 */
export const EXECUTOR_DEFAULT_TOOLS: string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "list_dir",
  "glob",
  "grep",
  "diff",
  "bash",
  "bash_background",
  "bash_output",
  "kill_shell",
  "test",
  "web_search",
  "web_fetch",
];

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load a single agent template from `templateDir`.
 *
 * @param templateDir  Path to the template folder (must contain `agent.yaml`).
 * @param config       Global Config instance (provides model resolution).
 * @param nameOverride If given, replaces the `name` field from the YAML.
 * @param mcpManager   Optional MCP client manager for MCP tool resolution.
 * @param promptsDir   Optional path to the shared `prompts/` directory.
 *                     If omitted, no tool/section prompts are assembled.
 * @returns            Fully constructed Agent, ready to use.
 */
export function loadTemplate(
  templateDir: string,
  config: Config,
  nameOverride?: string,
  mcpManager?: MCPClientManager,
  promptsDir?: string,
): Agent {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    throw new Error(`Template config not found: ${yamlPath}`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  const spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }

  const name =
    nameOverride ??
    (spec["name"] as string | undefined) ??
    basename(templateDir);
  const model = spec["model"] as string | undefined;

  // --- 1. Resolve core system prompt ---
  let systemPrompt = resolveSystemPrompt(spec, templateDir);

  // --- 2. Assemble tool prompts ---
  if (promptsDir) {
    const toolNames = resolveToolNames(spec);
    validateToolDependencies(toolNames);
    const toolPrompts = assembleToolPrompts(toolNames, promptsDir);
    if (toolPrompts) {
      systemPrompt = systemPrompt.trimEnd() + "\n\n---\n\n# Tools\n\n" + toolPrompts;
    }

    // --- 3. Assemble section prompts ---
    const sections = resolveSections(spec);
    const sectionPrompts = assembleSectionPrompts(sections, promptsDir);
    if (sectionPrompts) {
      systemPrompt = systemPrompt.trimEnd() + "\n\n" + sectionPrompts;
    }
  }

  // --- 4. Append knowledge files (if any) ---
  const knowledgeDir = join(templateDir, "knowledge");
  if (existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()) {
    const knowledgeParts: string[] = [];
    const entries = readdirSync(knowledgeDir).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(knowledgeDir, entry);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      knowledgeParts.push(readFileSync(fullPath, "utf-8"));
    }
    if (knowledgeParts.length > 0) {
      systemPrompt =
        systemPrompt.trimEnd() + "\n\n" + knowledgeParts.join("\n\n");
    }
  }

  return buildAgent(
    spec,
    name,
    model,
    systemPrompt,
    config,
    mcpManager,
  );
}

/**
 * Scan `templatesRoot` for template folders and load them all.
 *
 * A subfolder is considered a template if it contains `agent.yaml`.
 *
 * @param promptsDir  Path to the shared `prompts/` directory for prompt assembly.
 * @returns `{ name: agent }` record, keyed by each template's `name` field
 *          (or folder name as fallback).
 */
export function loadTemplates(
  templatesRoot: string,
  config: Config,
  mcpManager?: MCPClientManager,
  promptsDir?: string,
): Record<string, Agent> {
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new Error(`Templates root not found: ${templatesRoot}`);
  }

  // Auto-discover prompts/ as sibling of templates root if not provided
  const resolvedPromptsDir = promptsDir ?? resolvePromptsDir(templatesRoot);

  const agents: Record<string, Agent> = {};
  const children = readdirSync(templatesRoot).sort();
  for (const child of children) {
    const childPath = join(templatesRoot, child);
    try {
      if (!statSync(childPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(childPath, AGENT_YAML))) continue;

    const agent = loadTemplate(childPath, config, undefined, mcpManager, resolvedPromptsDir);
    agents[agent.name] = agent;
  }

  return agents;
}

/**
 * Validate a template directory without loading it.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTemplate(templateDir: string): string | null {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    return `Missing agent.yaml in ${templateDir}`;
  }

  let spec: Record<string, unknown>;
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } catch (e) {
    return `Invalid YAML in agent.yaml: ${e}`;
  }

  const typeError = validateTemplateType(spec);
  if (typeError) {
    return typeError;
  }

  if (!spec["system_prompt"] && !spec["system_prompt_file"]) {
    return "agent.yaml must have either 'system_prompt' or 'system_prompt_file'";
  }

  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      return `system_prompt_file not found: ${spec["system_prompt_file"]}`;
    }
  }

  const toolsSpec = spec["tools"];
  if (toolsSpec != null && toolsSpec !== "all" && !Array.isArray(toolsSpec)) {
    return `Invalid tools spec: must be "all", a list of tool names, or omitted`;
  }

  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    return maxRoundsError;
  }

  return null;
}

// ------------------------------------------------------------------
// Prompt assembly
// ------------------------------------------------------------------

/**
 * Resolve the prompts/ directory as a sibling of the templates root.
 * Returns the path if found, or undefined if not.
 */
export function resolvePromptsDir(templatesRoot: string): string | undefined {
  const candidate = join(dirname(templatesRoot), "prompts");
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  return undefined;
}

/**
 * Resolve tool names from the `tools` field in agent.yaml.
 *
 * - `"all"` → all tools in TOOL_PROMPT_ORDER
 * - Array of names → as-is
 * - Absent / null → EXECUTOR_DEFAULT_TOOLS (for custom templates)
 */
export function resolveToolNames(spec: Record<string, unknown>): string[] {
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [...EXECUTOR_DEFAULT_TOOLS];
  if (toolsSpec === "all") return [...TOOL_PROMPT_ORDER];
  if (Array.isArray(toolsSpec)) return toolsSpec as string[];
  throw new Error(`Invalid tools spec: ${JSON.stringify(toolsSpec)}`);
}

/**
 * Validate that paired tool dependencies are satisfied.
 */
export function validateToolDependencies(toolNames: string[]): void {
  const nameSet = new Set(toolNames);
  for (const [tool, requires] of Object.entries(TOOL_REQUIRES)) {
    if (!nameSet.has(tool)) continue;
    for (const req of requires) {
      if (!nameSet.has(req)) {
        throw new Error(
          `Tool '${tool}' requires '${req}' to be included in the tools list.`,
        );
      }
    }
  }
}

/**
 * Read and concatenate tool prompt files in canonical order.
 * Tools without a corresponding prompt file are silently skipped.
 */
export function assembleToolPrompts(
  toolNames: string[],
  promptsDir: string,
): string {
  const toolsDir = join(promptsDir, "tools");
  if (!existsSync(toolsDir)) return "";

  // Sort by TOOL_PROMPT_ORDER, unknowns go to the end alphabetically
  const orderIndex = new Map(TOOL_PROMPT_ORDER.map((n, i) => [n, i]));
  const sorted = [...toolNames].sort((a, b) => {
    const ia = orderIndex.get(a) ?? Infinity;
    const ib = orderIndex.get(b) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });

  const parts: string[] = [];
  for (const name of sorted) {
    const filePath = join(toolsDir, `${name}.md`);
    if (!existsSync(filePath)) continue;
    try {
      parts.push(readFileSync(filePath, "utf-8").trimEnd());
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join("\n\n");
}

/**
 * Resolve prompt_sections from the spec.
 * Defaults to ["important_log"] if omitted.
 */
function resolveSections(spec: Record<string, unknown>): string[] {
  const sections = spec["prompt_sections"];
  if (sections == null) return ["important_log"];
  if (Array.isArray(sections)) return sections as string[];
  return ["important_log"];
}

/**
 * Read and concatenate section prompt files.
 */
export function assembleSectionPrompts(
  sections: string[],
  promptsDir: string,
): string {
  const sectionsDir = join(promptsDir, "sections");
  if (!existsSync(sectionsDir) || sections.length === 0) return "";

  const parts: string[] = [];
  for (const name of sections) {
    const filePath = join(sectionsDir, `${name}.md`);
    if (!existsSync(filePath)) continue;
    try {
      parts.push(readFileSync(filePath, "utf-8").trimEnd());
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join("\n\n");
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Return the system prompt string from inline text or an external file.
 */
function resolveSystemPrompt(
  spec: Record<string, unknown>,
  templateDir: string,
): string {
  if (typeof spec["system_prompt"] === "string") {
    return spec["system_prompt"];
  }
  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      throw new Error(`system_prompt_file not found: ${promptPath}`);
    }
    return readFileSync(promptPath, "utf-8");
  }
  return "";
}

function validateTemplateType(spec: Record<string, unknown>): string | null {
  const type = spec["type"];
  if (typeof type !== "string" || !type.trim()) {
    return `agent.yaml must set type: ${REQUIRED_TEMPLATE_TYPE}`;
  }
  if (type !== REQUIRED_TEMPLATE_TYPE) {
    return `Invalid template type '${type}': expected '${REQUIRED_TEMPLATE_TYPE}'`;
  }
  return null;
}

function validateTemplateMaxToolRounds(spec: Record<string, unknown>): string | null {
  const raw = spec["max_tool_rounds"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return `agent.yaml must set integer max_tool_rounds >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS}`;
  }
  if (raw < MIN_TEMPLATE_MAX_TOOL_ROUNDS) {
    return `max_tool_rounds must be >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS} (got ${raw})`;
  }
  return null;
}

/**
 * Resolve the `tools` field to a list of ToolDef objects.
 *
 * - `"all"` => all built-in tools
 * - A list of name strings => resolve each from BASIC_TOOLS_MAP
 * - Absent / null => empty list (custom templates get defaults via resolveToolNames)
 */
function resolveTools(spec: Record<string, unknown>): ToolDef[] {
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [];

  if (toolsSpec === "all") {
    // BASIC_TOOLS includes all basic tools.
    // Comm tools (spawn_agent, wait, etc.) are injected by Session at runtime.
    return [...BASIC_TOOLS];
  }

  if (Array.isArray(toolsSpec)) {
    const resolved: ToolDef[] = [];
    for (const name of toolsSpec) {
      const tool = BASIC_TOOLS_MAP[name as string];
      if (!tool) {
        throw new Error(
          `Unknown tool '${name}'. Available: ${Object.keys(BASIC_TOOLS_MAP).join(", ")}`,
        );
      }
      resolved.push(tool);
    }
    return resolved;
  }

  throw new Error(`Invalid tools spec: ${JSON.stringify(toolsSpec)}`);
}

/**
 * Resolve the `mcp_tools` field to MCP ToolDef objects.
 */
function resolveMcpTools(
  spec: Record<string, unknown>,
  mcpManager?: MCPClientManager,
): ToolDef[] {
  if (!mcpManager) return [];

  const mcpSpec = spec["mcp_tools"];
  if (!mcpSpec || mcpSpec === "none") return [];

  if (mcpSpec === "all") {
    return mcpManager.getAllTools();
  }

  if (Array.isArray(mcpSpec)) {
    const tools: ToolDef[] = [];
    for (const serverName of mcpSpec) {
      const serverTools = mcpManager.getToolsForServer(serverName as string);
      if (serverTools.length === 0) {
        console.warn(
          `MCP server '${serverName}' has no tools or is not connected`,
        );
      }
      tools.push(...serverTools);
    }
    return tools;
  }

  return [];
}

/**
 * Build a fully configured Agent from the parsed YAML spec.
 */
function buildAgent(
  spec: Record<string, unknown>,
  name: string,
  model: string | undefined,
  systemPrompt: string,
  config: Config,
  mcpManager?: MCPClientManager,
): Agent {
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }
  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    throw new Error(maxRoundsError);
  }

  const resolvedModel = model ?? config.defaultModel;
  if (!resolvedModel) {
    throw new Error(
      `No model specified for template '${name}' and no default model in config.`,
    );
  }

  const tools = [...resolveTools(spec), ...resolveMcpTools(spec, mcpManager)];

  const opts: {
    name: string;
    role: string;
    model: string;
    config: Config;
    tools: ToolDef[];
    maxToolRounds?: number;
    description?: string;
  } = {
    name,
    role: systemPrompt,
    model: resolvedModel,
    config,
    tools,
  };

  opts.maxToolRounds = spec["max_tool_rounds"] as number;
  if (typeof spec["description"] === "string") {
    opts.description = spec["description"];
  }

  const agent = new Agent(opts);

  // Keep MCP selection intent for runtime lazy wiring in Session._ensureMcp().
  (agent as any)._mcpToolsSpec = spec["mcp_tools"] ?? undefined;

  return agent;
}
