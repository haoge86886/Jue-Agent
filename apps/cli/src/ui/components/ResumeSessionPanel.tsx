import React from "react";
import { Box, Text } from "ink";
import type { ResumeSelectorState } from "../types.js";
import { TEXT } from "../theme.js";

interface Props {
  state: ResumeSelectorState;
  width: number;
}

export const ResumeSessionPanel: React.FC<Props> = ({ state, width }) => {
  const pageSize = Math.max(1, state.pageSize);
  const pageCount = Math.max(1, Math.ceil(state.sessions.length / pageSize));
  const pageIndex = Math.min(pageCount - 1, Math.max(0, state.pageIndex));
  const start = pageIndex * pageSize;
  const visibleSessions = state.sessions.slice(start, start + pageSize);

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>选择要恢复的历史会话</Text>
      <Text color={TEXT.muted}>↑/↓ 选择，←/→ 或 PageUp/PageDown 翻页，Enter 恢复，Esc 取消</Text>
      <Text color={TEXT.muted}>第 {pageIndex + 1}/{pageCount} 页，共 {state.sessions.length} 个历史会话</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleSessions.map((session, index) => {
          const absoluteIndex = start + index;
          const selected = absoluteIndex === state.selectedIndex;
          return (
            <Box key={session.sessionId} flexDirection="column" marginBottom={1}>
              <Text color={selected ? "cyan" : TEXT.primary} bold={selected}>
                {selected ? "› " : "  "}{session.title || "(untitled)"}
              </Text>
              <Text color={TEXT.muted}>
                {"  "}{session.sessionId} · {session.messageCount} messages · {new Date(session.lastActiveAt).toLocaleString()}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
