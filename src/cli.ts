#!/usr/bin/env node

/**
 * CLI entry point for LongerAgent.
 *
 * Usage:
 *
 *   longeragent                       # auto-detect config
 *   longeragent init                  # run initialization wizard
 *   longeragent --config my.yaml      # explicit config path
 *   longeragent --templates ./tpls    # explicit templates path
 *   longeragent --verbose             # enable debug logging
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { Config, resolveConfigPaths } from "./config.js";
import { Agent } from "./agents/agent.js";
import { Session } from "./session.js";
import { loadTemplates } from "./templates/loader.js";
import { loadSkills } from "./skills/loader.js";
import { SessionStore } from "./persistence.js";
import { buildDefaultRegistry, registerSkillCommands } from "./commands.js";
import type { Session as TuiSession } from "./tui/types.js";

// ------------------------------------------------------------------
// Primary agent resolution
// ------------------------------------------------------------------

function identifyPrimaryAgent(
  agents: Record<string, Agent>,
  name = "main",
): Agent {
  const agent = agents[name];
  if (agent) return agent;

  // Fallback: first agent alphabetically
  const names = Object.keys(agents).sort();
  if (names.length > 0) {
    const firstName = names[0];
    console.warn(
      `Warning: '${name}' agent not found, using '${firstName}' instead.`,
    );
    return agents[firstName];
  }

  console.error("Error: no agent templates found.");
  process.exit(1);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("longeragent")
    .description("Multi-agent CLI with proactive context summarization")
    .option("--config <path>", "Path to config.yaml")
    .option("--templates <path>", "Path to agent_templates directory")
    .option("--verbose", "Enable debug logging");

  // Init subcommand
  let ranSubcommand = false;
  program
    .command("init")
    .description("Initialize LongerAgent configuration")
    .action(async () => {
      ranSubcommand = true;
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
    });

  // Default action — prevents Commander from showing help and exiting
  // when no subcommand is provided.
  program.action(() => {});

  await program.parseAsync(process.argv);

  // If a subcommand ran, exit — don't continue into TUI
  if (ranSubcommand) return;

  const opts = program.opts<{
    config?: string;
    templates?: string;
    verbose?: boolean;
  }>();

  // Logging
  if (opts.verbose) {
    const origDebug = console.debug;
    console.debug = (...args: unknown[]) => origDebug("[DEBUG]", ...args);
  }

  // Resolve paths with discovery chain: CLI flags → ~/.longeragent/ → cwd/
  let paths = resolveConfigPaths({
    configFlag: opts.config,
    templatesFlag: opts.templates,
  });

  // If no config found, run the initialization wizard
  if (!paths.configPath) {
    console.log("No configuration found. Starting setup wizard...\n");
    try {
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
      // Re-resolve paths after wizard completes
      paths = resolveConfigPaths({
        configFlag: opts.config,
        templatesFlag: opts.templates,
      });
    } catch {
      console.error(
        "Error: no config.yaml found.\n" +
        "  Run 'longeragent init' to set up, or use --config to specify the path.",
      );
      process.exit(1);
    }
  }

  if (!paths.configPath) {
    console.error(
      "Error: no config.yaml found after setup.\n" +
      "  Run 'longeragent init' to set up, or use --config to specify the path.",
    );
    process.exit(1);
  }

  if (!paths.templatesPath) {
    console.error(
      "Error: no agent_templates/ directory found.\n" +
      "  Run 'longeragent init' to set up, or use --templates to specify the path.",
    );
    process.exit(1);
  }

  const configPath = paths.configPath;
  const templatesPath = paths.templatesPath;

  // Load config
  const config = new Config({ path: configPath });

  // Initialise MCP client manager (if mcp_servers configured)
  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      // Dynamic import to keep MCP optional
      const { MCPClientManager } = await import("./mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn(
        "Warning: mcp_servers configured but MCP client module not available. " +
          "Install with: npm install @modelcontextprotocol/sdk",
      );
    }
  }

  // Load agent templates
  const agents = loadTemplates(
    templatesPath,
    config,
    mcpManager as any,
  );
  const primary = identifyPrimaryAgent(agents);

  // Load skills
  const skillsPath = paths.skillsPath;
  const skills = skillsPath && existsSync(skillsPath) && statSync(skillsPath).isDirectory()
    ? loadSkills(skillsPath)
    : new Map();

  // Session store (session directory is created lazily on the first turn)
  let store: SessionStore;
  try {
    store = new SessionStore({ projectPath: process.cwd() });
  } catch (e) {
    console.error(
      `Error: Failed to initialize session storage.\n` +
      `Reason: ${e}\n` +
      `Possible causes:\n` +
      `  - Invalid LONGERAGENT_HOME configuration\n` +
      `  - File permission issues`,
    );
    process.exit(1);
  }

  // Build Session with store attached from the start
  const session = new Session({
    primaryAgent: primary as never,
    config,
    agentTemplates: agents as never,
    skills: skills as never,
    progress: undefined,
    mcpManager: mcpManager as never,
    store: store as never,
  });

  // Commands
  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  // Launch TUI
  const { launchTui } = await import("./tui/launch.js");
  await launchTui(session as unknown as TuiSession, commandRegistry, store, {
    verbose: opts.verbose,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
