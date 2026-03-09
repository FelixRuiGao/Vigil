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

const META_LABELS = {
  version: "Version:",
  directory: "Directory:",
} as const;

const META_LABEL_WIDTH = Math.max(
  ...Object.values(META_LABELS).map((label) => label.length),
);

const META_VALUE_MAX_WIDTH = 80;

export function truncateLeft(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `...${text.slice(-(maxChars - 3))}`;
}

export interface LogoPanelProps {
  cwd?: string;
}

export function getLogoMetaRows(
  cwd = process.cwd(),
  version = pkg.version,
): Array<{ label: string; value: string }> {
  return [
    { label: META_LABELS.version, value: `v${version}` },
    {
      label: META_LABELS.directory,
      value: truncateLeft(cwd, META_VALUE_MAX_WIDTH),
    },
  ];
}

export function LogoPanel({ cwd }: LogoPanelProps): React.ReactElement {
  const metaRows = getLogoMetaRows(cwd ?? process.cwd());

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
      {metaRows.map((row) => (
        <Box key={row.label}>
          <Box width={META_LABEL_WIDTH} marginRight={1} flexShrink={0}>
            <Text dimColor>{row.label}</Text>
          </Box>
          <Text dimColor>{row.value}</Text>
        </Box>
      ))}
    </Box>
  );
}
