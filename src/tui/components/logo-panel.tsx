/**
 * ASCII logo display at top of the TUI.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

const LOGO = `\
██╗      ██████╗ ███╗   ██╗ ██████╗ ███████╗██████╗
██║     ██╔═══██╗████╗  ██║██╔════╝ ██╔════╝██╔══██╗
██║     ██║   ██║██╔██╗ ██║██║  ███╗█████╗  ██████╔╝
██║     ██║   ██║██║╚██╗██║██║   ██║██╔══╝  ██╔══██╗
███████╗╚██████╔╝██║ ╚████║╚██████╔╝███████╗██║  ██║
╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
  █████╗  ██████╗ ███████╗███╗   ██╗████████╗
 ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
 ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
 ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
 ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝`;

export function LogoPanel(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={4} paddingTop={1}>
      <Text color={theme.accent}>{LOGO}</Text>
      <Text dimColor>{"─".repeat(55)}</Text>
    </Box>
  );
}
