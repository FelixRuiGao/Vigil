import React from "react";
import { Box, Text } from "ink";

export interface PlanCheckpointUi {
  text: string;
  checked: boolean;
}

export interface PlanPanelProps {
  checkpoints: PlanCheckpointUi[];
}

export function PlanPanel({ checkpoints }: PlanPanelProps): React.ReactElement {
  const done = checkpoints.filter((c) => c.checked).length;
  const total = checkpoints.length;

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        Plan ({done}/{total})
      </Text>
      {checkpoints.map((cp, i) => (
        <Text key={i} dimColor={cp.checked}>
          {cp.checked ? "  ✓ " : "  ○ "}
          {cp.text}
        </Text>
      ))}
    </Box>
  );
}
