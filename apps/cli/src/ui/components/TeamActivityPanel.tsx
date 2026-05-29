import React from "react";
import { Box, Text } from "ink";
import type { TeamStatus, TeamAgentActivity } from "../types.js";
import { TEXT } from "../theme.js";

interface TeamActivityPanelProps {
  status: TeamStatus | null;
  activities: TeamAgentActivity[];
  width: number;
}

export const TeamActivityPanel: React.FC<TeamActivityPanelProps> = ({ status, activities, width }) => {
  if (!status || activities.length === 0) return null;
  const visible = [...activities]
    .sort((a, b) => rankStatus(a) - rankStatus(b) || b.updatedAt - a.updatedAt)
    .slice(0, 5);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#45566f" paddingX={1} width={width}>
      <Box justifyContent="space-between">
        <Text color={TEXT.accent}>team activity</Text>
        <Text color={TEXT.muted}>{status.runningCount} running | {status.queuedCount} queued | inbox {status.pendingInboxCount}</Text>
      </Box>
      {visible.map((activity) => (
        <ActivityRow key={activity.memberName} activity={activity} width={Math.max(20, width - 4)} />
      ))}
    </Box>
  );
};

const ActivityRow: React.FC<{ activity: TeamAgentActivity; width: number }> = ({ activity, width }) => {
  const statusColor = colorForStatus(activity.status);
  const action = activity.currentAction || activity.status;
  const preview = activity.outputPreview ? ` | ${activity.outputPreview}` : "";
  const line = truncate(`${activity.memberName.padEnd(10)} ${action} | ${activity.task}${preview}`, width);
  return (
    <Box>
      <Text color={statusColor}>{statusGlyph(activity.status)}</Text>
      <Text> </Text>
      <Text color={TEXT.primary}>{line}</Text>
    </Box>
  );
};

function rankStatus(activity: TeamAgentActivity): number {
  if (activity.status === "running" || activity.status === "tool") return 0;
  if (activity.status === "queued") return 1;
  if (activity.status === "failed") return 2;
  return 3;
}

function colorForStatus(status: TeamAgentActivity["status"]): string {
  if (status === "failed") return "red";
  if (status === "completed") return "green";
  if (status === "interrupted") return TEXT.warn;
  if (status === "tool") return "yellow";
  if (status === "queued") return TEXT.muted;
  return TEXT.accent;
}

function statusGlyph(status: TeamAgentActivity["status"]): string {
  if (status === "completed") return "ok";
  if (status === "failed") return "!!";
  if (status === "interrupted") return "--";
  if (status === "queued") return "..";
  return ">>";
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}
