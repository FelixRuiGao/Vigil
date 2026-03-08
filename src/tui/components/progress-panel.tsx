/**
 * Progress display -- shows tool call events and reasoning chunks
 * as gray inline lines in the conversation stream.
 *
 * Also exports `formatProgressMessage` used by the App to prepare
 * display text from raw ProgressEvent objects.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ProgressEvent } from "../../progress.js";

// ------------------------------------------------------------------
// ProgressLine
// ------------------------------------------------------------------

export interface ProgressLineProps {
  message: string;
  id?: string;
}

export function ProgressLine({ message }: ProgressLineProps): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{message}</Text>
    </Box>
  );
}

// ------------------------------------------------------------------
// ReasoningBlock — used inline in the conversation to show model
// thinking output.  When `collapsed` is true a one-line summary is
// shown instead of the full text.
// ------------------------------------------------------------------

export interface ReasoningBlockProps {
  text: string;
  collapsed?: boolean;
}

export function ReasoningBlock({ text, collapsed }: ReasoningBlockProps): React.ReactElement {
  if (collapsed) {
    const summary = text.replace(/\n/g, " ").trim();
    const display = summary.length > 80 ? summary.slice(0, 77) + "..." : summary;
    return (
      <Box>
        <Text color="gray">{"Thinking: "}{display}</Text>
      </Box>
    );
  }
  // Show only the last 2000 chars to avoid performance issues
  let display = text;
  if (display.length > 2000) {
    display = "..." + display.slice(-1997);
  }
  return (
    <Box>
      <Text color="gray">{display}</Text>
    </Box>
  );
}

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------

/** Format a progress event message for display. */
export function formatProgressMessage(event: ProgressEvent): string {
  const message = event.message || "";
  if (event.action === "tool_call") {
    return "    " + message.trimStart();
  }
  return message;
}
