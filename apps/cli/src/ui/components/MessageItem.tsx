/**
 * @file MessageItem.tsx
 * @module @jue/cli/ui/components/MessageItem
 *
 * 单条聊天消息的渲染。
 *
 * 视觉策略:
 *   - 每条消息都是一张"小卡片":左侧色条 + 顶部角色徽标 + 内容主体
 *   - 不同 kind 用不同主色调,保证一眼区分(参考 theme.ROLE_PALETTE)
 *   - assistant_text 在 streaming=true 时尾部加 spinner,完成后消失
 *   - tool_call 单独成块,显示工具名 + 关键参数
 *   - tool_result 用绿色(succeeded)、红色(failed)、紫红色(rejected)边框
 *   - dev 块用紫色边框,内容是简洁缩进 JSON 摘要
 *
 * 实现细节:
 *   - 用 Box 的 borderLeft 模拟"左侧色条";Ink 不直接支持 borderLeft 单边,
 *     所以我们改用一列固定宽度的色块字符,效果一致
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type {
  AssistantTextChatItem,
  ChatItem,
  DevChatItem,
  ErrorChatItem,
  ResumeChoiceItem,
  SystemChatItem,
  ToolCallChatItem,
  ToolResultChatItem,
  UserChatItem,
} from "../types.js";
import { ROLE_PALETTE, TEXT } from "../theme.js";

type RolePalette = {
  bar: string;
  label: string;
  labelBg: string;
  labelFg: string;
};

interface Props {
  item: ChatItem;
}

export const MessageItem: React.FC<Props> = ({ item }) => {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} />;
    case "assistant_text":
      return <AssistantItem item={item} />;
    case "tool_call":
      return <ToolCallItem item={item} />;
    case "tool_result":
      return <ToolResultItem item={item} />;
    case "dev":
      return <DevItem item={item} />;
    case "resume_choice":
      return <ResumeChoice item={item} />;
    case "system":
      return <SystemItem item={item} />;
    case "error":
      return <ErrorItem item={item} />;
    default:
      return null;
  }
};

const ResumeChoice: React.FC<{ item: ResumeChoiceItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.system;
  return (
    <Card bar={palette.bar} label={<RoleBadge palette={palette} />}>
      <Text color={TEXT.muted}>历史会话列表，输入 /resume 后跟 sessionId 可恢复指定会话。</Text>
      <Box flexDirection="column" marginTop={1}>
        {item.sessions.map((session, index) => (
          <Box key={session.sessionId} flexDirection="column" marginBottom={1}>
            <Text color={TEXT.primary}>
              {index + 1}. {session.title || "(untitled)"}
            </Text>
            <Text color={TEXT.muted}>
              {session.sessionId} · {session.frontend} · {session.messageCount} messages · {new Date(session.lastActiveAt).toLocaleString()}
            </Text>
          </Box>
        ))}
      </Box>
    </Card>
  );
};

/**
 * 左侧色条 + 角色徽标 的通用框架。
 *
 * 用一列宽度为 1 的色块组成"左 border";内容区在右边。
 * label 可以是任意 Ink 节点,通常是带 inverse 背景的小徽标。
 */
const Card: React.FC<{
  bar: string;
  label: React.ReactNode;
  children: React.ReactNode;
  /** 末尾再加一行额外信息(用作 status / cost 等) */
  footer?: React.ReactNode;
}> = ({ bar, label, children, footer }) => (
  <Box flexDirection="row" marginBottom={1}>
    <Box flexDirection="column">
      <Text color={bar}>▌</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1} marginLeft={1}>
      <Box>{label}</Box>
      <Box flexDirection="column" marginTop={0}>
        {children}
      </Box>
      {footer ? <Box marginTop={0}>{footer}</Box> : null}
    </Box>
  </Box>
);

const RoleBadge: React.FC<{ palette: RolePalette }> = ({ palette }) => (
  <Text backgroundColor={palette.labelBg} color={palette.labelFg} bold>
    {` ${palette.label} `}
  </Text>
);

// ─── user ──────────────────────────────────────────────────────────
const UserItem: React.FC<{ item: UserChatItem }> = ({ item }) => (
  <Card bar={ROLE_PALETTE.user.bar} label={<RoleBadge palette={ROLE_PALETTE.user} />}>
    <Text color={TEXT.primary}>{item.text}</Text>
  </Card>
);

// ─── assistant ─────────────────────────────────────────────────────
const AssistantItem: React.FC<{ item: AssistantTextChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.assistant;
  const label = (
    <Box flexDirection="row" gap={1}>
      <RoleBadge palette={palette} />
      {item.streaming ? (
        <Text color={TEXT.muted}>
          <Spinner type="dots" /> 思考中
        </Text>
      ) : null}
    </Box>
  );
  return (
    <Card bar={palette.bar} label={label}>
      <Text color={TEXT.primary}>{item.text || (item.streaming ? " " : "(空)")}</Text>
    </Card>
  );
};

// ─── tool call ─────────────────────────────────────────────────────
const ToolCallItem: React.FC<{ item: ToolCallChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.tool;
  const label = (
    <Box flexDirection="row" gap={1}>
      <RoleBadge palette={palette} />
      <Text color={palette.bar} bold>
        ▶ {item.toolName}
      </Text>
    </Box>
  );
  return (
    <Card bar={palette.bar} label={label}>
      <Text color={TEXT.muted}>args: </Text>
      <Text color={TEXT.primary}>{compactJson(item.arguments)}</Text>
    </Card>
  );
};

// ─── tool result ───────────────────────────────────────────────────
const ToolResultItem: React.FC<{ item: ToolResultChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.tool;
  const ok = item.status === "succeeded";
  const bar = ok ? "green" : item.status === "rejected" ? "magenta" : "red";
  const label = (
    <Box flexDirection="row" gap={1}>
      <RoleBadge palette={palette} />
      <Text color={bar} bold>
        {ok ? "✓" : item.status === "rejected" ? "⊘" : "✗"} {item.toolName} · {item.status}
      </Text>
    </Box>
  );
  return (
    <Card bar={bar} label={label}>
      {item.summary ? <Text color={TEXT.primary}>{item.summary}</Text> : null}
      {item.error ? (
        <Text color="red">
          [{item.error.code}] {item.error.message}
        </Text>
      ) : null}
    </Card>
  );
};

// ─── dev (开发期专用) ─────────────────────────────────────────────
const DevItem: React.FC<{ item: DevChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.dev;
  const label = (
    <Box flexDirection="row" gap={1}>
      <RoleBadge palette={palette} />
      <Text color={palette.bar} bold>
        {item.channel}
      </Text>
    </Box>
  );
  return (
    <Card bar={palette.bar} label={label}>
      {renderDevPayload(item)}
    </Card>
  );
};

function renderDevPayload(item: DevChatItem): React.ReactNode {
  if (item.channel === "context.compressor") {
    const data = item.data as {
      pressure: string;
      totalTokens: number;
      blockCount: number;
      droppedBlockIds: string[];
      compressedBlockIds: string[];
      cacheHitKeys: string[];
      blocks: Array<{
        id: string;
        type: string;
        source: string;
        tokenEstimate: number;
        pinned: boolean;
        compressible: boolean;
        relevance: number;
        summaryRef?: string;
        compressionStrategy?: string;
        compressedBy?: string;
        compactionNotice?: string;
        fallbackReason?: string;
        persisted?: boolean;
        sourceBlockIds?: string[];
        sourceMessageIds?: string[];
        preview: string;
      }>;
    };
    return (
      <Box flexDirection="column">
        <Text color={TEXT.muted}>
          pressure=<Text color="magenta">{data.pressure}</Text>, tokens={data.totalTokens}, blocks={data.blockCount}
        </Text>
        <Text color={TEXT.muted}>
          compressed={data.compressedBlockIds.length}, dropped={data.droppedBlockIds.length}, cacheHits={data.cacheHitKeys.length}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {data.blocks.map((block, index) => (
            <Box key={`${block.id}-${index}`} flexDirection="column" marginLeft={2} marginBottom={1}>
              <Text color="magenta">
                [{block.type}] tokens={block.tokenEstimate} relevance={block.relevance.toFixed(2)} pinned={String(block.pinned)} compressible={String(block.compressible)}
                {block.summaryRef ? ` summaryRef=${block.summaryRef}` : ""}
                {block.compressionStrategy ? ` strategy=${block.compressionStrategy}` : ""}
                {block.compressedBy ? ` compressedBy=${block.compressedBy}` : ""}
                {block.persisted ? " persisted=true" : ""}
                {block.sourceBlockIds && block.sourceBlockIds.length > 0 ? ` replaces=${block.sourceBlockIds.length}` : ""}
              </Text>
              {block.compactionNotice ? <Text color={TEXT.muted}>{block.compactionNotice}</Text> : null}
              {block.fallbackReason ? <Text color={TEXT.muted}>fallbackReason={block.fallbackReason}</Text> : null}
              {block.sourceBlockIds && block.sourceBlockIds.length > 0 ? <Text color={TEXT.muted}>sourceBlockIds={block.sourceBlockIds.join(",")}</Text> : null}
              {block.sourceMessageIds && block.sourceMessageIds.length > 0 ? <Text color={TEXT.muted}>sourceMessageIds={block.sourceMessageIds.join(",")}</Text> : null}
              <Text color={TEXT.primary}>{block.preview || "(empty)"}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  if (item.channel === "memory.dream") {
    const data = item.data as {
      gate?: { reason?: string; hoursSinceLastRun?: number | null; newMemorySessionCount?: number };
      maintenance?: { checked?: number; removed?: number; compacted?: number; rewrittenIndexes?: number; diagnostics?: string[] };
      statePath?: string;
    };
    const maintenance = data.maintenance;
    return (
      <Box flexDirection="column">
        <Text color={TEXT.muted}>reason={data.gate?.reason ?? "manual"}</Text>
        {data.gate ? (
          <Text color={TEXT.muted}>
            hoursSinceLastRun={data.gate.hoursSinceLastRun ?? "none"}, newMemorySessions={data.gate.newMemorySessionCount ?? 0}
          </Text>
        ) : null}
        {maintenance ? (
          <Text color={TEXT.muted}>
            checked={maintenance.checked ?? 0}, removed={maintenance.removed ?? 0}, compacted={maintenance.compacted ?? 0}, rewrittenIndexes={maintenance.rewrittenIndexes ?? 0}
          </Text>
        ) : null}
        {data.statePath ? <Text color={TEXT.muted}>state={data.statePath}</Text> : null}
        {maintenance?.diagnostics?.length ? (
          <Box flexDirection="column" marginTop={1}>
            {maintenance.diagnostics.slice(0, 20).map((line, index) => (
              <Text key={index} color={TEXT.primary}>- {line}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  }
  if (item.channel === "model.invoke") {
    const data = item.data as {
      messages: Array<{
        role: string;
        content: string;
        hasToolCalls?: boolean;
        toolCalls?: Array<{ name: string; args: string }>;
        toolCallId?: string;
      }>;
      tools: unknown[];
      providerOptions?: Record<string, unknown>;
    };
    return (
      <Box flexDirection="column">
        <Text color={TEXT.muted}>tools ({data.tools.length}):</Text>
        {data.providerOptions ? <Text color={TEXT.muted}>providerOptions: {compactJson(data.providerOptions)}</Text> : null}
        <Text color={TEXT.muted}>messages ({data.messages.length}):</Text>
        {data.messages.map((m, i) => (
          <Box key={i} flexDirection="column" marginLeft={2} marginBottom={1}>
            <Text color="magenta">
              [{m.role}]
              {m.hasToolCalls
                ? ` · tool_calls=${m.toolCalls?.map((t) => t.name).join(",") ?? ""}`
                : ""}
              {m.toolCallId ? ` · tool_call_id=${m.toolCallId}` : ""}
            </Text>
            <Text color={TEXT.primary}>{m.content || "(empty)"}</Text>
            {m.toolCalls?.length ? (
              <Box flexDirection="column" marginLeft={2}>
                {m.toolCalls.map((toolCall, toolCallIndex) => (
                  <Text key={toolCallIndex} color={TEXT.primary}>
                    {toolCall.name}: {toolCall.args || "{}"}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    );
  }
  if (item.channel === "model.finish") {
    const d = item.data as { finishReason?: string; tokens?: number };
    return (
      <Text color={TEXT.muted}>
        finish=<Text color="magenta">{d.finishReason ?? "?"}</Text>
        {d.tokens !== undefined ? `, total_tokens=${d.tokens}` : ""}
      </Text>
    );
  }
  return <Text color={TEXT.primary}>{compactJson(item.data)}</Text>;
}

function formatDevValue(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
// ─── system ────────────────────────────────────────────────────────
const SystemItem: React.FC<{ item: SystemChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.system;
  const color: string =
    item.flavor === "ack"
      ? "green"
      : item.flavor === "info"
        ? TEXT.muted
        : item.flavor === "tip"
          ? TEXT.warn
          : palette.bar;
  const labelPalette: RolePalette =
    item.flavor === "banner" ? { ...palette, labelBg: "cyan" } : palette;
  return (
    <Card bar={color} label={<RoleBadge palette={labelPalette} />}>
      <Text color={color}>{item.text}</Text>
    </Card>
  );
};

// ─── error ─────────────────────────────────────────────────────────
const ErrorItem: React.FC<{ item: ErrorChatItem }> = ({ item }) => {
  const palette = ROLE_PALETTE.error;
  return (
    <Card bar={palette.bar} label={<RoleBadge palette={palette} />}>
      <Text color="red">{item.text}</Text>
    </Card>
  );
};

/**
 * 把任意值压成单行字符串。失败时回退到 String(),
 * 截断到 240 字符,避免长输入撑爆 UI。
 */
function compactJson(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (!s) return "{}";
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}
