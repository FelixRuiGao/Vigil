/**
 * Agent template loader.
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
 *   +-- coder/
 *       +-- agent.yaml
 *       +-- system_prompt.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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
 * @returns            Fully constructed Agent, ready to use.
 */
export function loadTemplate(
  templateDir: string,
  config: Config,
  nameOverride?: string,
  mcpManager?: MCPClientManager,
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

  // --- Resolve system prompt ---
  let systemPrompt = resolveSystemPrompt(spec, templateDir);

  // --- Append knowledge files (if any) ---
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
 * @returns `{ name: agent }` record, keyed by each template's `name` field
 *          (or folder name as fallback).
 */
export function loadTemplates(
  templatesRoot: string,
  config: Config,
  mcpManager?: MCPClientManager,
): Record<string, Agent> {
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new Error(`Templates root not found: ${templatesRoot}`);
  }

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

    const agent = loadTemplate(childPath, config, undefined, mcpManager);
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
 * - `"all"` => all built-in tools + comm tools + web_search
 * - A list of name strings => resolve each from BASIC_TOOLS_MAP
 * - Absent / null => empty list
 */
function resolveTools(spec: Record<string, unknown>): ToolDef[] {
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [];

  if (toolsSpec === "all") {
    // BASIC_TOOLS already includes WEB_SEARCH.
    // Comm tools are injected by Session at runtime, not here.
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
