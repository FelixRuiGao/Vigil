/**
 * OpenAI OAuth for ChatGPT account login.
 *
 * Two login methods:
 *   1. Browser login (PKCE) — recommended, opens browser for one-click auth
 *   2. Device code — fallback for SSH / headless environments
 *
 * Token persistence in ~/.longeragent/auth.json with automatic refresh.
 * No external dependencies — uses Node 18+ built-in fetch, crypto, http.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { confirm, select } from "@inquirer/prompts";
import { LONGERAGENT_HOME_DIR } from "../config.js";

// =============================================================================
// Constants
// =============================================================================

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFY_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// PKCE browser flow
const PKCE_CALLBACK_PORT = 1455;
const PKCE_CALLBACK_HOST = "127.0.0.1";
const PKCE_REDIRECT_URI = `http://localhost:${PKCE_CALLBACK_PORT}/auth/callback`;
const PKCE_SCOPES = "openid profile email offline_access";

/** Refresh the access token 2 minutes before it actually expires. */
const REFRESH_SKEW_SECONDS = 120;

/** Maximum time to wait for the user to complete login. */
const AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Timeout for individual HTTP requests. */
const HTTP_TIMEOUT_MS = 15_000;

// =============================================================================
// Types
// =============================================================================

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
}

interface AuthStoreData {
  version: 1;
  openai_codex?: {
    access_token: string;
    refresh_token: string;
    last_refresh: string;
  };
}

// =============================================================================
// Auth store (sync file I/O)
// =============================================================================

function authStorePath(): string {
  return join(homedir(), LONGERAGENT_HOME_DIR, "auth.json");
}

export function loadAuthStore(): AuthStoreData {
  const p = authStorePath();
  if (!existsSync(p)) return { version: 1 };
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && data.version === 1) {
      return data as AuthStoreData;
    }
    return { version: 1 };
  } catch {
    return { version: 1 };
  }
}

function saveAuthStore(store: AuthStoreData): void {
  const p = authStorePath();
  const dir = join(homedir(), LONGERAGENT_HOME_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function saveOAuthTokens(tokens: OAuthTokens): void {
  const store = loadAuthStore();
  store.openai_codex = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    last_refresh: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  saveAuthStore(store);
}

export function clearOAuthTokens(): void {
  const store = loadAuthStore();
  delete store.openai_codex;
  saveAuthStore(store);
}

/**
 * Read the stored OAuth access token (sync).
 * Returns null if no tokens are stored.
 */
export function readOAuthAccessToken(): string | null {
  const store = loadAuthStore();
  const token = store.openai_codex?.access_token;
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/** Check whether OAuth tokens exist in the auth store. */
export function hasOAuthTokens(): boolean {
  const store = loadAuthStore();
  const codex = store.openai_codex;
  return Boolean(
    codex &&
    typeof codex.access_token === "string" && codex.access_token.trim() !== "" &&
    typeof codex.refresh_token === "string" && codex.refresh_token.trim() !== "",
  );
}

// =============================================================================
// JWT helpers
// =============================================================================

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  let payload = parts[1];
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const raw = Buffer.from(payload, "base64url").toString("utf-8");
    const claims = JSON.parse(raw);
    return typeof claims === "object" && claims !== null ? claims : {};
  } catch {
    return {};
  }
}

/**
 * Check whether an OAuth access token is about to expire.
 * Returns true if the token will expire within `skewSeconds` seconds,
 * or if the expiry cannot be determined.
 */
export function isTokenExpiring(
  accessToken: string,
  skewSeconds = REFRESH_SKEW_SECONDS,
): boolean {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims["exp"];
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000) + Math.max(0, skewSeconds);
}

function getTokenExpiry(accessToken: string): Date | null {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims["exp"];
  if (typeof exp !== "number") return null;
  return new Date(exp * 1000);
}

// =============================================================================
// HTTP helpers
// =============================================================================

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const data = (await resp.json()) as Record<string, unknown>;
    return { status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchForm(
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

// =============================================================================
// Platform helpers
// =============================================================================

function openBrowser(url: string): void {
  try {
    const p = platform();
    if (p === "darwin") {
      execSync(`open ${JSON.stringify(url)}`, { stdio: "ignore" });
    } else if (p === "win32") {
      execSync(`start "" ${JSON.stringify(url)}`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: "ignore" });
    }
  } catch {
    // Browser open failed — user will need to copy the URL manually
  }
}

function isRemoteSession(): boolean {
  return Boolean(process.env["SSH_CLIENT"] || process.env["SSH_TTY"]);
}

// =============================================================================
// PKCE helpers
// =============================================================================

function generateCodeVerifier(): string {
  // 32 random bytes → 43 base64url chars (RFC 7636 recommends 43-128)
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// =============================================================================
// PKCE Browser OAuth flow
// =============================================================================

/**
 * Start a temporary HTTP server on localhost to capture the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
function waitForCallback(
  expectedState: string,
): { promise: Promise<string>; server: Server } {
  let resolvePromise: (code: string) => void;
  let rejectPromise: (err: Error) => void;

  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const server = createServer({ keepAliveTimeout: 1 }, (req, res) => {
    res.setHeader("Connection", "close");
    const url = new URL(req.url ?? "/", `http://${PKCE_CALLBACK_HOST}:${PKCE_CALLBACK_PORT}`);

    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(callbackHtml("Login Failed", `Error: ${desc}. You can close this tab.`));
      rejectPromise(new Error(`OAuth error: ${desc}`));
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(callbackHtml("Login Failed", "Invalid callback. Please try again."));
      rejectPromise(new Error("Invalid OAuth callback: missing code or state mismatch."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(callbackHtml("Login Successful", "You can close this tab and return to the terminal."));
    resolvePromise(code);
  });

  server.listen(PKCE_CALLBACK_PORT, PKCE_CALLBACK_HOST);

  return { promise, server };
}

function callbackHtml(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
align-items:center;height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;border-radius:12px;background:#fff;
box-shadow:0 2px 8px rgba(0,0,0,.1)}h1{margin:0 0 .5rem;font-size:1.5rem}
p{color:#666;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Execute the PKCE browser OAuth flow.
 *
 * 1. Generate PKCE verifier + challenge + state
 * 2. Start local callback server on port 1455
 * 3. Open browser to OpenAI authorization URL
 * 4. Wait for callback with authorization code
 * 5. Exchange code for tokens
 */
export async function browserLogin(): Promise<OAuthTokens> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Build authorization URL (matches OpenAI's expected parameters)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: PKCE_REDIRECT_URI,
    scope: PKCE_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "longeragent",
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  // Start callback server
  const { promise: codePromise, server } = waitForCallback(state);

  const cleanup = () => {
    try {
      server.closeAllConnections();
      server.close();
    } catch { /* ignore */ }
  };

  try {
    console.log();
    if (isRemoteSession()) {
      console.log("  Open this URL in your browser:");
      console.log(`  \x1b[94m${authorizeUrl}\x1b[0m`);
    } else {
      console.log("  Opening browser for authentication...");
      openBrowser(authorizeUrl);
      console.log(`  If the browser didn't open, visit:`);
      console.log(`  \x1b[94m${authorizeUrl}\x1b[0m`);
    }
    console.log();
    console.log("  Waiting for authorization... (press Ctrl+C to cancel)");

    // Wait for callback or timeout
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Login timed out after 15 minutes.")), AUTH_TIMEOUT_MS);
    });

    const code = await Promise.race([codePromise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    cleanup();

    // Exchange code for tokens
    const { status, data } = await fetchForm(TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: PKCE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });

    if (status !== 200) {
      const detail = typeof data["error_description"] === "string"
        ? data["error_description"]
        : `status ${status}`;
      throw new Error(`Token exchange failed: ${detail}`);
    }

    const accessToken = String(data["access_token"] ?? "");
    const refreshToken = String(data["refresh_token"] ?? "");
    if (!accessToken) {
      throw new Error("Token exchange did not return an access_token.");
    }

    return { access_token: accessToken, refresh_token: refreshToken };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// =============================================================================
// Device Code OAuth flow
// =============================================================================

/**
 * Execute the Device Code OAuth login flow.
 *
 * 1. Request device code from OpenAI
 * 2. Display user code and verification URL
 * 3. Poll for authorization (up to 15 minutes)
 * 4. Exchange authorization code for tokens
 */
export async function deviceCodeLogin(): Promise<OAuthTokens> {
  // Step 1: Request device code
  let deviceData: Record<string, unknown>;
  try {
    const { status, data } = await fetchJson(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (status !== 200) {
      throw new Error(`Device code request returned status ${status}.`);
    }
    deviceData = data;
  } catch (err) {
    throw new Error(
      `Failed to request device code: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const userCode = String(deviceData["user_code"] ?? "");
  const deviceAuthId = String(deviceData["device_auth_id"] ?? "");
  const pollInterval = Math.max(3, Number(deviceData["interval"]) || 5);

  if (!userCode || !deviceAuthId) {
    throw new Error("Device code response missing required fields.");
  }

  // Step 2: Display user code
  console.log();
  console.log("  To continue, follow these steps:");
  console.log();
  console.log(`  1. Open this URL in your browser:`);
  console.log(`     \x1b[94m${DEVICE_VERIFY_URL}\x1b[0m`);
  console.log();
  console.log(`  2. Enter this code:`);
  console.log(`     \x1b[94m${userCode}\x1b[0m`);
  console.log();
  console.log("  Waiting for sign-in... (press Ctrl+C to cancel)");

  // Step 3: Poll for authorization code
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let codeResp: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval * 1000));

    try {
      const { status, data } = await fetchJson(DEVICE_POLL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
      });

      if (status === 200) {
        codeResp = data;
        break;
      } else if (status === 403 || status === 404) {
        continue;
      } else {
        throw new Error(`Device auth polling returned status ${status}.`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        continue;
      }
      throw err;
    }
  }

  if (codeResp === null) {
    throw new Error("Login timed out after 15 minutes.");
  }

  // Step 4: Exchange authorization code for tokens
  const authorizationCode = String(codeResp["authorization_code"] ?? "");
  const codeVerifier = String(codeResp["code_verifier"] ?? "");

  if (!authorizationCode || !codeVerifier) {
    throw new Error(
      "Device auth response missing authorization_code or code_verifier.",
    );
  }

  let tokenData: Record<string, unknown>;
  try {
    const { status, data } = await fetchForm(TOKEN_URL, {
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });
    if (status !== 200) {
      throw new Error(`Token exchange returned status ${status}.`);
    }
    tokenData = data;
  } catch (err) {
    throw new Error(
      `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const accessToken = String(tokenData["access_token"] ?? "");
  const refreshToken = String(tokenData["refresh_token"] ?? "");

  if (!accessToken) {
    throw new Error("Token exchange did not return an access_token.");
  }

  return { access_token: accessToken, refresh_token: refreshToken };
}

// =============================================================================
// Token refresh
// =============================================================================

export async function refreshAccessToken(
  refreshToken: string,
): Promise<OAuthTokens> {
  const { status, data } = await fetchForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  if (status !== 200) {
    const errDesc =
      typeof data["error_description"] === "string"
        ? data["error_description"]
        : typeof data["message"] === "string"
          ? data["message"]
          : `status ${status}`;
    const errCode = typeof data["error"] === "string" ? data["error"] : "";
    const reloginHint =
      errCode === "invalid_grant" || errCode === "invalid_token"
        ? " Run 'longeragent oauth' to re-authenticate."
        : "";
    throw new Error(`Token refresh failed: ${errDesc}.${reloginHint}`);
  }

  const accessToken = String(data["access_token"] ?? "");
  if (!accessToken) {
    throw new Error(
      "Token refresh response missing access_token. Run 'longeragent oauth' to re-authenticate.",
    );
  }

  const newRefreshToken =
    typeof data["refresh_token"] === "string" && data["refresh_token"]
      ? String(data["refresh_token"])
      : refreshToken;

  const tokens: OAuthTokens = {
    access_token: accessToken,
    refresh_token: newRefreshToken,
  };

  saveOAuthTokens(tokens);
  return tokens;
}

// =============================================================================
// Composite: ensure fresh token
// =============================================================================

export async function ensureFreshToken(): Promise<string> {
  const store = loadAuthStore();
  const codex = store.openai_codex;
  if (
    !codex ||
    typeof codex.access_token !== "string" ||
    !codex.access_token.trim() ||
    typeof codex.refresh_token !== "string" ||
    !codex.refresh_token.trim()
  ) {
    throw new Error(
      "No OpenAI OAuth credentials stored. Run 'longeragent oauth' to log in.",
    );
  }

  if (isTokenExpiring(codex.access_token)) {
    const refreshed = await refreshAccessToken(codex.refresh_token);
    return refreshed.access_token;
  }

  return codex.access_token;
}

// =============================================================================
// CLI command: `longeragent oauth [action]`
// =============================================================================

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (
    (err as { name?: string }).name === "ExitPromptError" ||
    (err as { code?: string }).code === "ERR_USE_AFTER_CLOSE"
  );
}

async function performLogin(): Promise<OAuthTokens> {
  const method = await select({
    message: "Login method",
    choices: [
      { name: "Browser login (recommended)", value: "browser" },
      { name: "Device code (SSH / headless)", value: "device" },
    ],
  });

  if (method === "browser") {
    return browserLogin();
  }
  return deviceCodeLogin();
}

async function oauthLogin(): Promise<void> {
  // Check if already logged in
  if (hasOAuthTokens()) {
    const token = readOAuthAccessToken()!;
    const expiry = getTokenExpiry(token);
    const expiryStr = expiry ? expiry.toLocaleString() : "unknown";
    const expired = expiry ? expiry.getTime() < Date.now() : false;
    const tokenStatus = expired ? "expired" : "valid";

    console.log(`  Existing login found (token ${tokenStatus}, expires: ${expiryStr})`);
    try {
      const reLogin = await confirm({
        message: "Re-authenticate with a new login?",
        default: false,
      });
      if (!reLogin) {
        if (expired || isTokenExpiring(token)) {
          console.log("  Refreshing token...");
          try {
            await ensureFreshToken();
            console.log("  Token refreshed successfully.");
          } catch (err) {
            console.error(
              `  Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            console.log("  Please re-authenticate.");
          }
        } else {
          console.log("  Using existing login.");
        }
        return;
      }
    } catch (err) {
      if (isUserCancel(err)) {
        console.log("\n  Cancelled.");
        return;
      }
      throw err;
    }
  }

  const tokens = await performLogin();
  saveOAuthTokens(tokens);
  console.log();
  console.log("  Login successful!");
  console.log("  OAuth tokens saved to ~/.longeragent/auth.json");
  console.log();
  console.log(
    "  To use with LongerAgent, run 'longeragent init' and select",
  );
  console.log("  'OpenAI (ChatGPT Login)', or add to your config.yaml:");
  console.log();
  console.log("    my-codex:");
  console.log("      provider: openai-codex");
  console.log("      model: gpt-5.3-codex");
  console.log("      api_key: \"oauth:openai-codex\"");
  console.log();
}

function oauthStatus(): void {
  if (!hasOAuthTokens()) {
    console.log("  Not logged in.");
    console.log("  Run 'longeragent oauth' to log in with your ChatGPT account.");
    return;
  }

  const token = readOAuthAccessToken()!;
  const expiry = getTokenExpiry(token);
  const expiryStr = expiry ? expiry.toLocaleString() : "unknown";
  const expired = expiry ? expiry.getTime() < Date.now() : false;
  const expiring = isTokenExpiring(token);

  const store = loadAuthStore();
  const lastRefresh = store.openai_codex?.last_refresh ?? "unknown";

  console.log("  OpenAI OAuth Status");
  console.log(`  Status:       ${expired ? "expired" : expiring ? "expiring soon" : "active"}`);
  console.log(`  Expires:      ${expiryStr}`);
  console.log(`  Last refresh: ${lastRefresh}`);
  console.log(`  Auth store:   ${authStorePath()}`);

  if (expired) {
    console.log();
    console.log("  Token has expired. Run 'longeragent oauth' to re-authenticate.");
  } else if (expiring) {
    console.log();
    console.log("  Token will expire soon. It will be auto-refreshed on next use.");
  }
}

function oauthLogout(): void {
  if (!hasOAuthTokens()) {
    console.log("  Not logged in — nothing to clear.");
    return;
  }
  clearOAuthTokens();
  console.log("  OAuth tokens cleared.");
}

/**
 * Entry point for `longeragent oauth [action]`.
 */
export async function oauthCommand(action?: string): Promise<void> {
  const normalized = (action ?? "").trim().toLowerCase();

  console.log();
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║      OpenAI ChatGPT OAuth Login      ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log();

  switch (normalized) {
    case "":
    case "login":
      await oauthLogin();
      break;
    case "status":
      oauthStatus();
      break;
    case "logout":
      oauthLogout();
      break;
    default:
      console.log(`  Unknown action: ${normalized}`);
      console.log("  Usage: longeragent oauth [login|status|logout]");
      break;
  }
}
