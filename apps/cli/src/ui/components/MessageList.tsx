/**
 * @file MessageList.tsx
 * @module @jue/cli/ui/components/MessageList
 *
 * 消息列表容器。
 *
 * 职责很轻:接受 ChatItem[],逐条交给 MessageItem 渲染。
 *
 * 之所以单独开一个文件,是为了:
 *   - 给后续接入"虚拟滚动 / 限高 / 折叠 dev 块"留个稳定的接缝
 *   - AppRoot 主体保持简洁,只关心布局,不关心渲染细节
 */

import React from "react";
import { Box } from "ink";
import { MessageItem } from "./MessageItem.js";
import type { ChatItem } from "../types.js";

interface Props {
  items: readonly ChatItem[];
}

export const MessageList: React.FC<Props> = ({ items }) => (
  <Box flexDirection="column">
    {items.map((it) => (
      <MessageItem key={it.id} item={it} />
    ))}
  </Box>
);
