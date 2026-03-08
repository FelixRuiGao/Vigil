/**
 * Bottom status bar — shows activity state with spinner, model info,
 * context token usage, and keyboard shortcuts.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

// ------------------------------------------------------------------
// Spinner
// ------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type ActivityPhase = "idle" | "working" | "thinking" | "tool_calling" | "generating" | "waiting";

export interface StatusBarProps {
  /** Current activity phase of the primary agent. */
  phase: ActivityPhase;
  /** Tool name when phase === "tool_calling". */
  toolName?: string;
  /** Error state — overrides phase display. */
  error?: boolean;
  /** Model identifier (e.g. "claude-opus-4"). */
  modelName?: string;
  /** Total input tokens (including cached) from last provider response. */
  contextTokens?: number;
  /** Maximum context window size. */
  contextLimit?: number;
  /** Cache read tokens from last provider response (subset of contextTokens). */
  cacheReadTokens?: number;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function StatusBar({
  phase,
  toolName,
  error,
  modelName,
  contextTokens,
  contextLimit,
  cacheReadTokens,
}: StatusBarProps): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const isActive = phase !== "idle" && !error;

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => clearInterval(timer);
  }, [isActive]);

  // --- Build activity label ---
  let label: string;
  let color: string;

  if (error) {
    label = "ERROR";
    color = "red";
  } else {
    switch (phase) {
      case "working":
        label = "Working";
        color = theme.accent;
        break;
      case "thinking":
        label = "Thinking";
        color = theme.accent;
        break;
      case "tool_calling":
        label = toolName ?? "tool";
        color = theme.accent;
        break;
      case "generating":
        label = "Generating";
        color = theme.accent;
        break;
      case "waiting":
        label = "Waiting";
        color = "yellow";
        break;
      default:
        label = "READY";
        color = theme.accent;
        break;
    }
  }

  // --- Token display ---
  const cacheSuffix =
    cacheReadTokens && cacheReadTokens > 0
      ? ` (${formatTokens(cacheReadTokens)} Cached)`
      : "";
  const tokenStr =
    contextTokens != null && contextLimit != null && contextLimit > 0
      ? `Occupied Context: ${formatTokens(contextTokens)} / ${formatTokens(contextLimit)}${cacheSuffix}`
      : contextTokens != null && contextTokens > 0
        ? `Occupied Context: ${formatTokens(contextTokens)}${cacheSuffix}`
        : null;

  return (
    <Box>
      {/* Activity indicator */}
      {isActive ? (
        <Text color={color}>{SPINNER_FRAMES[frame]} </Text>
      ) : (
        <Text color={color}>{"● "}</Text>
      )}
      <Text color={color}>{label}</Text>

      {/* Model name */}
      {modelName && (
        <>
          <Text dimColor>{"  |  "}</Text>
          <Text dimColor>{modelName}</Text>
        </>
      )}

      {/* Token usage */}
      {tokenStr && (
        <>
          <Text dimColor>{"  |  "}</Text>
          <Text dimColor>{tokenStr}</Text>
        </>
      )}

      {/* (shortcuts moved to input hint line) */}
    </Box>
  );
}
