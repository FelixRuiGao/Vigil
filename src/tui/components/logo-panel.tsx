/**
 * ASCII logo panel at top of the TUI.
 */

import React from "react";
import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { theme } from "../theme.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const LOGO = `\
╦  ╔═╗╔╗╔╔═╗╔═╗╦═╗  ╔═╗╔═╗╔═╗╔╗╔╔╦╗
║  ║ ║║║║║ ╦║╣ ╠╦╝  ╠═╣║ ╦║╣ ║║║ ║
╩═╝╚═╝╝╚╝╚═╝╚═╝╩╚═  ╩ ╩╚═╝╚═╝╝╚╝ ╩`;

function truncateLeft(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `...${text.slice(-(maxChars - 3))}`;
}

export interface LogoPanelProps {
  cwd?: string;
}

export function LogoPanel({ cwd }: LogoPanelProps): React.ReactElement {
  const displayPath = truncateLeft(cwd || process.cwd(), 50);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
      alignSelf="flex-start"
    >
      <Text color={theme.accent}>{LOGO}</Text>
      <Text dimColor>v{pkg.version}</Text>
      <Text dimColor>{displayPath}</Text>
    </Box>
  );
}
