/**
 * TUI launcher -- renders the Ink application.
 *
 * This is the entry point for the terminal UI.  It sets up the
 * progress bridge, wires session and store, and renders the
 * React/Ink component tree.
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import type { LaunchOptions, CommandRegistry, Session } from "./types.js";
import { ProgressReporter, type ProgressCallback } from "../progress.js";
import type { SessionStore } from "../persistence.js";
import { buildDefaultRegistry } from "../commands.js";

const KITTY_KEYBOARD_ENABLE = "\u001b[>1u";
const KITTY_KEYBOARD_DISABLE = "\u001b[<u";
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h";
const BRACKETED_PASTE_DISABLE = "\u001b[?2004l";

function shouldEnableKittyKeyboard(): boolean {
  if (process.env["LONGERAGENT_DISABLE_KITTY_KEYBOARD"] === "1") return false;
  return process.stdout.isTTY === true;
}

/**
 * Launch the Ink TUI.
 *
 * Creates a TuiProgress bridge that forwards session progress events
 * to the React app via callback, then renders and waits for exit.
 */
export async function launchTui(options: LaunchOptions): Promise<void>;
/**
 * Launch the Ink TUI using the positional-argument overload.
 */
export async function launchTui(
  session: Session,
  commandRegistry: CommandRegistry,
  store?: SessionStore | null,
  opts?: { verbose?: boolean },
): Promise<void>;
export async function launchTui(
  sessionOrOptions: Session | LaunchOptions,
  commandRegistryArg?: CommandRegistry,
  storeArg?: SessionStore | null,
  optsArg?: { verbose?: boolean },
): Promise<void> {
  let session: Session;
  let commandRegistry: CommandRegistry;
  let store: SessionStore | null;
  let verbose = false;

  if (
    typeof sessionOrOptions === "object" &&
    "session" in sessionOrOptions &&
    typeof (sessionOrOptions as LaunchOptions).session?.turn === "function"
  ) {
    // Options-object form
    const lo = sessionOrOptions as LaunchOptions;
    session = lo.session;
    commandRegistry =
      (lo.commandRegistry as CommandRegistry) ?? buildDefaultRegistry();
    store = lo.sessionStore ?? null;
  } else {
    // Positional form
    session = sessionOrOptions as Session;
    commandRegistry = commandRegistryArg ?? buildDefaultRegistry();
    store = storeArg ?? null;
    verbose = optsArg?.verbose ?? false;
  }

  // Progress bridge: captures progress events and forwards to React
  let progressCallback: ProgressCallback | undefined;

  const tuiProgress = new ProgressReporter({
    level: verbose ? "verbose" : "normal",
    callback: (event) => {
      if (progressCallback) {
        progressCallback(event);
      }
    },
  });

  // Wire progress to session
  session._progress = tuiProgress;

  let ttyFeaturesEnabled = false;
  if (process.stdout.isTTY === true) {
    try {
      process.stdout.write(BRACKETED_PASTE_ENABLE);
      if (shouldEnableKittyKeyboard()) {
        process.stdout.write(KITTY_KEYBOARD_ENABLE);
      }
      ttyFeaturesEnabled = true;
    } catch {
      // ignore
    }
  }

  try {
    const { waitUntilExit } = render(
      React.createElement(App, {
        session,
        commandRegistry,
        store,
        onProgressCallback: (cb: ProgressCallback) => {
          progressCallback = cb;
        },
      }),
      { exitOnCtrlC: false },
    );

    await waitUntilExit();
  } finally {
    if (ttyFeaturesEnabled) {
      try {
        if (shouldEnableKittyKeyboard()) {
          process.stdout.write(KITTY_KEYBOARD_DISABLE);
        }
        process.stdout.write(BRACKETED_PASTE_DISABLE);
      } catch {
        // ignore
      }
    }

    // Catch-all cleanup after TUI exits.
    // Safe to call even if close() was already called by /quit or Ctrl+C.
    try {
      await session.close();
    } catch {
      // ignore
    }
  }
}
