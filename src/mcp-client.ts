/**
 * MCP (Model Context Protocol) client manager.
 *
 * Connects to one or more MCP servers, discovers their tools, and makes
 * them available as LongerAgent ToolDef objects that can be injected into
 * any Agent's tool list.
 *
 * Lifecycle:
 *
 *   const manager = new MCPClientManager(serverConfigs);
 *   await manager.connectAll();
 *   const tools = manager.getAllTools();
 *   const result = await manager.callTool(namespacedName, args);
 *   await manager.closeAll();
 */

import type { MCPServerConfig } from "./config.js";
import { ToolDef, ToolResult } from "./providers/base.js";
import { chmodSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";

// ------------------------------------------------------------------
// Dynamic MCP SDK imports (optional dependency)
// ------------------------------------------------------------------

// These are populated lazily by _ensureMcpSdk()
let Client: any;
let StdioClientTransport: any;
let SSEClientTransport: any;
let mcpAvailable: boolean | undefined;

export const DEFAULT_MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "LANG",
  "LC_*",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_*",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function envKeyMatchesPattern(key: string, pattern: string): boolean {
  return globToRegExp(pattern).test(key);
}

function isCredentialFileEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized === "GOOGLE_APPLICATION_CREDENTIALS") return true;
  if (normalized === "AWS_SHARED_CREDENTIALS_FILE") return true;
  if (normalized === "AWS_CONFIG_FILE") return true;
  if (normalized === "KUBECONFIG") return true;
  if (normalized === "NETRC") return true;
  return (
    normalized.endsWith("_FILE") &&
    /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CRED|CERT|AUTH)/.test(normalized)
  ) || normalized.includes("CREDENTIALS_FILE");
}

function looksLikePathValue(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes(path.sep);
}

export function ensureCredentialFilePermissions(
  serverName: string,
  env: Record<string, string>,
): void {
  if (process.platform === "win32") return;
  for (const [key, rawValue] of Object.entries(env)) {
    if (!isCredentialFileEnvKey(key)) continue;
    if (!looksLikePathValue(rawValue)) continue;
    const filePath = rawValue.replace(/^~(?=$|\/|\\)/, process.env["HOME"] ?? "~");
    if (!existsSync(filePath)) continue;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if ((st.mode & 0o077) === 0) continue;
    try {
      chmodSync(filePath, 0o600);
      console.warn(
        `Tightened credential file permissions for MCP server '${serverName}' (${key}) to 0o600: ${filePath}`,
      );
    } catch (err) {
      console.warn(
        `Credential file for MCP server '${serverName}' should be 0o600 (${key}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export function validateMcpSseUrl(serverName: string, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid SSE URL for MCP server '${serverName}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP server '${serverName}' SSE URL must use http/https (got ${parsed.protocol})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `MCP server '${serverName}' SSE URL must not embed credentials`,
    );
  }
  return parsed;
}

export function buildMcpServerEnv(
  cfg: MCPServerConfig,
  inheritedEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowlist = [...DEFAULT_MCP_ENV_ALLOWLIST, ...(cfg.envAllowlist ?? [])];
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value !== "string") continue;
    if (!allowlist.some((p) => envKeyMatchesPattern(key, p))) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    out[key] = value;
  }
  return out;
}

async function ensureMcpSdk(): Promise<boolean> {
  if (mcpAvailable !== undefined) return mcpAvailable;
  try {
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    Client = sdk.Client;
    const stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
    StdioClientTransport = stdioMod.StdioClientTransport;
    mcpAvailable = true;
  } catch {
    mcpAvailable = false;
  }
  // SSE transport is optional even when the core SDK exists
  if (mcpAvailable && !SSEClientTransport) {
    try {
      const sseMod = await import("@modelcontextprotocol/sdk/client/sse.js");
      SSEClientTransport = sseMod.SSEClientTransport;
    } catch {
      // SSE not available — that's fine
    }
  }
  return mcpAvailable;
}

// ------------------------------------------------------------------
// MCPClientManager
// ------------------------------------------------------------------

/**
 * Manage connections to one or more MCP servers.
 *
 * Each server's tools are namespaced as `mcp__<server>__<tool>`
 * to avoid collisions with built-in LongerAgent tools.
 */
export class MCPClientManager {
  private _configs: MCPServerConfig[];
  private _configByName: Map<string, MCPServerConfig>;
  private _clients: Map<string, any> = new Map();        // server name -> Client
  private _transports: Map<string, any> = new Map();     // server name -> Transport
  private _toolDefs: Map<string, ToolDef> = new Map();   // namespaced -> ToolDef
  private _toolServer: Map<string, string> = new Map();  // namespaced -> server name
  private _toolOriginal: Map<string, string> = new Map();// namespaced -> original name
  private _serverTools: Map<string, string[]> = new Map();// server -> [namespaced names]
  private _connected = false;

  constructor(serverConfigs: MCPServerConfig[]) {
    this._configs = serverConfigs;
    this._configByName = new Map(serverConfigs.map((c) => [c.name, c]));
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  /**
   * Connect to all configured MCP servers and discover tools.
   * Idempotent — already connected servers are skipped.
   */
  async connectAll(): Promise<void> {
    const available = await ensureMcpSdk();
    if (!available) {
      throw new Error(
        "The '@modelcontextprotocol/sdk' package is required for MCP support. " +
        "Install it with: npm install @modelcontextprotocol/sdk",
      );
    }

    if (!this._configs.length) {
      this._connected = true;
      return;
    }

    for (const cfg of this._configs) {
      if (this._clients.has(cfg.name)) continue;
      try {
        await this._connectServer(cfg);
      } catch (err) {
        console.error(`Failed to connect to MCP server '${cfg.name}':`, err);
      }
    }
    this._connected = this._clients.size === this._configs.length;
  }

  private async _connectServer(cfg: MCPServerConfig): Promise<void> {
    let transport: any;

    if (cfg.transport === "stdio") {
      const env = buildMcpServerEnv(cfg);
      ensureCredentialFilePermissions(cfg.name, env);
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: Object.keys(env).length > 0 ? env : undefined,
      });
    } else if (cfg.transport === "sse") {
      if (!SSEClientTransport) {
        console.warn(
          `SSE transport requested for MCP server '${cfg.name}' but ` +
          "SSEClientTransport is not available",
        );
        return;
      }
      transport = new SSEClientTransport(validateMcpSseUrl(cfg.name, cfg.url));
    } else {
      console.warn(`Unknown MCP transport '${cfg.transport}' for server '${cfg.name}'`);
      return;
    }

    const client = new Client(
      { name: "longeragent", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    this._clients.set(cfg.name, client);
    this._transports.set(cfg.name, transport);

    // Discover tools
    const response = await client.listTools();
    const namespacedNames: string[] = [];
    for (const tool of response.tools) {
      const nsName = `mcp__${cfg.name}__${tool.name}`;
      const td: ToolDef = {
        name: nsName,
        description: `[MCP:${cfg.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        summaryTemplate: `{agent} is calling ${tool.name} via MCP:${cfg.name}`,
      };
      this._toolDefs.set(nsName, td);
      this._toolServer.set(nsName, cfg.name);
      this._toolOriginal.set(nsName, tool.name);
      namespacedNames.push(nsName);
    }
    this._serverTools.set(cfg.name, namespacedNames);
  }

  // ------------------------------------------------------------------
  // Tool queries
  // ------------------------------------------------------------------

  /** Return all discovered MCP tools as ToolDef objects. */
  getAllTools(): ToolDef[] {
    return Array.from(this._toolDefs.values());
  }

  /** Return tools from a specific MCP server. */
  getToolsForServer(serverName: string): ToolDef[] {
    const names = this._serverTools.get(serverName) ?? [];
    return names
      .map((n) => this._toolDefs.get(n))
      .filter((td): td is ToolDef => td !== undefined);
  }

  // ------------------------------------------------------------------
  // Tool execution
  // ------------------------------------------------------------------

  private async _reconnectServer(serverName: string): Promise<boolean> {
    const cfg = this._configByName.get(serverName);
    if (!cfg) return false;

    // 1. Clean up old tool registrations
    const oldTools = this._serverTools.get(serverName);
    if (oldTools) {
      for (const toolName of oldTools) {
        this._toolDefs.delete(toolName);
        this._toolServer.delete(toolName);
        this._toolOriginal.delete(toolName);
      }
      this._serverTools.delete(serverName);
    }

    // 2. Close old transport
    const oldTransport = this._transports.get(serverName);
    if (oldTransport) {
      try {
        await oldTransport.close();
      } catch {
        // ignore
      }
      this._transports.delete(serverName);
    }

    // 3. Remove stale client
    this._clients.delete(serverName);

    // 4. Reconnect
    try {
      await this._connectServer(cfg);
      return this._clients.has(cfg.name);
    } catch (err) {
      console.error(`MCP reconnect failed for '${serverName}':`, err);
      return false;
    }
  }

  /** Execute an MCP tool and return a LongerAgent ToolResult. */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const serverName = this._toolServer.get(namespacedName);
    if (!serverName) {
      return new ToolResult({ content: `ERROR: Unknown MCP tool '${namespacedName}'` });
    }

    let client = this._clients.get(serverName);
    if (!client) {
      if (await this._reconnectServer(serverName)) {
        client = this._clients.get(serverName);
      }
      if (!client) {
        return new ToolResult({ content: `ERROR: MCP server '${serverName}' is not connected` });
      }
    }

    const originalName = this._toolOriginal.get(namespacedName)!;

    const extractText = (result: any): string => {
      const parts: string[] = [];
      for (const block of result.content) {
        if (block.text !== undefined) {
          parts.push(block.text);
        } else {
          parts.push(String(block));
        }
      }
      return parts.join("\n");
    };

    try {
      const result = await client.callTool({ name: originalName, arguments: args });
      return new ToolResult({ content: extractText(result) });
    } catch (err) {
      // Connection may be stale — try one reconnect
      console.warn(`MCP tool '${originalName}' failed, attempting reconnect:`, err);
      if (await this._reconnectServer(serverName)) {
        client = this._clients.get(serverName);
        if (client) {
          try {
            const result = await client.callTool({ name: originalName, arguments: args });
            return new ToolResult({ content: extractText(result) });
          } catch (e2) {
            return new ToolResult({
              content: `ERROR: MCP tool '${originalName}' failed after reconnect: ${e2}`,
            });
          }
        }
      }
      return new ToolResult({ content: `ERROR: MCP tool '${originalName}' failed: ${err}` });
    }
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  /** Close all MCP server connections. */
  async closeAll(): Promise<void> {
    for (const [name, transport] of Array.from(this._transports.entries())) {
      try {
        await transport.close();
      } catch {
        console.warn(`Error closing MCP server '${name}'`);
      }
    }
    this._clients.clear();
    this._transports.clear();
    this._toolDefs.clear();
    this._toolServer.clear();
    this._toolOriginal.clear();
    this._serverTools.clear();
    this._connected = false;
  }
}
