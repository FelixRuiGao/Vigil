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
import { join } from "node:path";
import { Command } from "commander";

import { Config, resolveConfigPaths, getBundledAssetsDir } from "./config.js";
import { Agent } from "./agents/agent.js";
import { Session } from "./session.js";
import { loadTemplates } from "./templates/loader.js";
import { loadSkillsMulti } from "./skills/loader.js";
import { SessionStore } from "./persistence.js";
import { loadSettingsFile, resolveSettings } from "./settings.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
  reRegisterSkillCommands,
  resolveModelSelection,
} from "./commands.js";
import type { PersistedModelSelection } from "./model-selection.js";
import type { Session as TuiSession } from "./tui/types.js";
import { setAccent } from "./tui/theme.js";

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
    .description("A terminal AI coding agent built for long sessions")
    .option("--config <path>", "Path to config.yaml")
    .option("--templates <path>", "Path to agent_templates directory")
    .option("--verbose", "Enable debug logging");

  // Subcommands
  let ranSubcommand = false;
  program
    .command("init")
    .description("Initialize LongerAgent configuration")
    .action(async () => {
      ranSubcommand = true;
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
    });

  program
    .command("oauth [action]")
    .description("Manage OpenAI ChatGPT OAuth login (login/status/logout)")
    .action(async (action?: string) => {
      ranSubcommand = true;
      const { oauthCommand } = await import("./auth/openai-oauth.js");
      await oauthCommand(action);
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

  const configPath = paths.configPath;

  // Load config
  const config = new Config({ path: configPath });

  // Refresh OAuth tokens if any model uses them (before building providers)
  const oauthEntries = config.listModelEntries().filter(
    (e) => e.apiKeyRaw === "oauth:openai-codex",
  );
  if (oauthEntries.length > 0) {
    try {
      const { ensureFreshToken } = await import("./auth/openai-oauth.js");
      await ensureFreshToken();
    } catch (err) {
      console.warn(
        `Warning: OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn("Run 'longeragent oauth' to re-authenticate.\n");
    }
  }

  // Load user settings (~/.longeragent/settings.json)
  const rawSettings = loadSettingsFile(paths.homeDir);
  const settings = resolveSettings(rawSettings);

  // Display settings warnings (invalid thresholds, clamped values, etc.)
  for (const warning of settings.warnings) {
    console.warn(`Warning: ${warning}`);
  }

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

  // Bundled assets (always available from the installed package)
  const bundledDir = getBundledAssetsDir();
  const bundledTemplates = join(bundledDir, "agent_templates");
  const bundledPrompts = join(bundledDir, "prompts");

  // Build ordered prompts dirs: user override first, bundled second
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  // Load agent templates (bundled + user override, with layered prompt assembly)
  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as any,
    promptsDirs,
    paths.templatesPath ?? undefined,
  );
  const primary = identifyPrimaryAgent(agents);

  // Load skills (user overrides layered on top of bundled defaults).
  const bundledSkills = join(bundledDir, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  const userSkillsPath = paths.skillsPath;
  if (
    userSkillsPath &&
    userSkillsPath !== bundledSkills &&
    existsSync(userSkillsPath) &&
    statSync(userSkillsPath).isDirectory()
  ) {
    skillRoots.push(userSkillsPath);
  }
  const skills = loadSkillsMulti(skillRoots);

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
    skillRoots,
    progress: undefined,
    mcpManager: mcpManager as never,
    promptsDirs,
    store: store as never,
    settings,
  });

  const globalPreferences = store.loadGlobalPreferences();
  try {
    if (globalPreferences.modelConfigName) {
      try {
        session.switchModel(globalPreferences.modelConfigName);
        session.setPersistedModelSelection?.({
          modelConfigName: globalPreferences.modelConfigName,
          modelProvider: globalPreferences.modelProvider,
          modelSelectionKey: globalPreferences.modelSelectionKey,
          modelId: globalPreferences.modelId,
        } satisfies PersistedModelSelection);
      } catch {
        if (globalPreferences.modelProvider && (globalPreferences.modelSelectionKey || globalPreferences.modelId)) {
          const restored = resolveModelSelection(
            session,
            `${globalPreferences.modelProvider}:${globalPreferences.modelSelectionKey ?? globalPreferences.modelId}`,
          );
          session.switchModel(restored.selectedConfigName);
          session.setPersistedModelSelection?.({
            modelConfigName: restored.selectedConfigName,
            modelProvider: restored.modelProvider,
            modelSelectionKey: restored.modelSelectionKey,
            modelId: restored.modelId,
          } satisfies PersistedModelSelection);
        }
      }
    } else if (globalPreferences.modelProvider && (globalPreferences.modelSelectionKey || globalPreferences.modelId)) {
      const restored = resolveModelSelection(
        session,
        `${globalPreferences.modelProvider}:${globalPreferences.modelSelectionKey ?? globalPreferences.modelId}`,
      );
      session.switchModel(restored.selectedConfigName);
      session.setPersistedModelSelection?.({
        modelConfigName: restored.selectedConfigName,
        modelProvider: restored.modelProvider,
        modelSelectionKey: restored.modelSelectionKey,
        modelId: restored.modelId,
      } satisfies PersistedModelSelection);
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  session.applyGlobalPreferences(globalPreferences);
  if (globalPreferences.accentColor) {
    setAccent(globalPreferences.accentColor);
  }

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
