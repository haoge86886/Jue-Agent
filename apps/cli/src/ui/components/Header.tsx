/**
 * @file Header.tsx
 * @module @jue/cli/ui/components/Header
 *
 * 顶部状态条:左侧 IconSlot,接 LOGO 文本,中段是 model + sessionId,
 * 右侧是当前阶段(idle / sending / dev=on 等)。
 *
 * 视觉策略:
 *   - 用一根粗水平线 + 反色横条,辨识度高
 *   - 内容紧凑,占用一两行,不抢消息列表的视觉权重
 *   - sessionId 截断到 12 字符,长 id 不挤压布局
 */

import React from "react";
import { Box, Text } from "ink";
import { IconSlot } from "./IconSlot.js";
import { TEXT } from "../theme.js";

interface HeaderProps {
  appName: string;
  appEnv: string;
  modelId: string;
  sessionId?: string | undefined;
  phase: "idle" | "sending" | "exiting";
  devEnabled: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  appName,
  appEnv,
  modelId,
  sessionId,
  phase,
  devEnabled,
}) => {
  const phaseLabel =
    phase === "sending"
      ? "thinking"
      : phase === "exiting"
        ? "exiting"
        : "ready";
  const phaseColor =
    phase === "sending" ? TEXT.warn : phase === "exiting" ? TEXT.muted : "green";

  const sid = sessionId ? `${sessionId.slice(0, 12)}…` : "(new)";

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} paddingX={1} paddingY={0}>
        <IconSlot />
        <Text color={TEXT.accent} bold>
          jue
        </Text>
        <Text color={TEXT.muted}>·</Text>
        <Text color={TEXT.primary}>
          {appName}
          <Text color={TEXT.muted}>@{appEnv}</Text>
        </Text>
        <Text color={TEXT.muted}>·</Text>
        <Text color={TEXT.primary}>{modelId}</Text>
        <Text color={TEXT.muted}>·</Text>
        <Text color={TEXT.muted}>session</Text>
        <Text color={TEXT.primary}>{sid}</Text>
        <Box flexGrow={1} />
        {devEnabled ? (
          <Text backgroundColor="magenta" color="white" bold>
            {" dev "}
          </Text>
        ) : null}
        <Text color={phaseColor} bold>
          {" "}
          {phaseLabel}
        </Text>
      </Box>
      <Box>
        <Text color={TEXT.muted}>
          ────────────────────────────────────────────────────────────
        </Text>
      </Box>
    </Box>
  );
};
