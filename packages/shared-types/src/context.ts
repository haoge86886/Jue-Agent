/**
 * @file context.ts
 * @module @jue/shared-types/context
 *
 * 上下文工程的协议层。把"塞进模型上下文窗口"的内容显式拆成 {@link ContextBlock},
 * 每块带元数据(优先级、token 估算、压缩策略、缓存键),由
 * `packages/context` 的 `ContextManager / ContextBudgeter / ContextCompressor`
 * 在每轮请求开始时按预算进行选择、压缩、装配。
 *
 * 关键模型:
 *   - {@link ContextBlock}              : 单个上下文块,Prompt 的最小可调度单元
 *   - {@link ContextBudget}             : 本轮 token 预算分配
 *   - {@link ContextAssembly}           : 装配结果(包含被丢弃/被压缩的块)
 *   - {@link ContextCompressionResult}  : 单次压缩动作的执行记录(用于审计)
 *
 * 设计原则(详见 design.md §7):
 *   1. 不允许把上下文堆成一个大字符串,必须显式分块
 *   2. 块之间通过 priority + tokenEstimate 决定取舍
 *   3. 缓存键必须含 strategyVersion,避免压缩策略升级后旧缓存污染
 */

import { z } from "zod";
import {
  IdSchema,
  MetadataSchema,
  SensitivityLevelSchema,
  TimestampSchema,
} from "./common.js";

/**
 * 上下文块类型枚举。这套枚举与 design.md §7.2 一一对应。
 *
 * `custom` 留作扩展逃生口,但应尽量避免使用,新增固定类型需要先扩枚举再使用。
 */
export const ContextBlockTypeSchema = z.enum([
  "system_instruction",
  "global_rules",
  "user_input",
  "tool_summary",
  "subagent_summary",
  "subagent_system_prompt",
  "subagent_task",
  "subagent_tool_list",
  "subagent_output_format",
  "subagent_memory",
  "user_memory",
  "team_memory",
  "global_memory",
  "conversation_short_term",
  "recent_messages",
  "shell_history",
  "tool_result_history",
  "user_attachment",
  "task_state",
  "environment",
  "frontend_capabilities",
  "session_flags",
  "remote_device_status",
  "custom",
]);
export type ContextBlockType = z.infer<typeof ContextBlockTypeSchema>;

/**
 * 上下文块来源,用于审计和后续的反查("这一段从哪来")。
 */
export const ContextBlockSourceSchema = z.enum([
  "static_prompt",
  "dynamic_prompt",
  "session",
  "memory",
  "tool_result",
  "subagent_result",
  "subagent_prompt",
  "recommendation",
  "user_input",
  "system",
  "external",
]);
export type ContextBlockSource = z.infer<typeof ContextBlockSourceSchema>;

/**
 * 优先级,0~100。数值越大越优先保留。
 *
 * 推荐区间约定:
 *   - 90~100 : 系统硬约束(系统 prompt、安全规则)
 *   - 70~89  : 当前任务直接相关(最近工具结果、显式记忆)
 *   - 40~69  : 长期参考(用户偏好、团队记忆)
 *   - 10~39  : 推荐内容、历史摘要等
 */
export const ContextBlockPrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(100)
  .describe("0~100 分,数值越大越优先保留");
export type ContextBlockPriority = z.infer<typeof ContextBlockPrioritySchema>;

/**
 * 压缩策略。规则压缩不调用模型,总结压缩调用 SummarizerAgent,
 * `async_cold` 表示由 Worker 在后台慢慢处理,不阻塞主回复。
 */
export const ContextCompressionStrategySchema = z.enum([
  "none",
  "rule_truncate",
  "rule_extract",
  "summary",
  "rule_then_summary",
  "async_cold",
]);
export type ContextCompressionStrategy = z.infer<
  typeof ContextCompressionStrategySchema
>;

/**
 * 单个上下文块。
 *
 * 字段语义:
 *   - `tokenEstimate`        : 该块占用 token 的估算值,由 ContextBudgeter 调度依据
 *   - `compressible`         : 是否允许被压缩(系统硬规则通常应为 false)
 *   - `compressionStrategy`  : 默认 `rule_truncate`,真要省钱再升到 `summary`
 *   - `cacheKey`             : 命中后可跳过重复装配,key 必须包含策略版本
 *   - `summaryRef`           : 若有压缩版本,指向 ToolResultStore 中的摘要 id
 *   - `rawRef`               : 反查原文的"指针",避免把巨型原文塞进每个块
 */
export const ContextBlockSchema = z.object({
  id: IdSchema,
  type: ContextBlockTypeSchema,
  source: ContextBlockSourceSchema,
  priority: ContextBlockPrioritySchema.default(50),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  relevance: z.number().min(0).max(1).default(0.5),
  pinned: z.boolean().default(false),
  lastReferencedAt: TimestampSchema.optional(),
  compressible: z.boolean().default(true),
  compressionStrategy: ContextCompressionStrategySchema.default("rule_truncate"),
  cacheKey: z.string().optional(),
  contentHash: z.string().optional(),
  summaryRef: IdSchema.optional(),
  sensitivity: SensitivityLevelSchema.default("internal"),
  content: z.string().describe("最终注入到 Prompt 中的文本内容"),
  rawRef: z
    .object({
      kind: z.enum(["tool_result", "memory", "file", "url", "subagent", "other"]),
      id: IdSchema,
    })
    .optional(),
  tags: z.array(z.string()).default([]),
  metadata: MetadataSchema.optional(),
});
export type ContextBlock = z.infer<typeof ContextBlockSchema>;

/**
 * 本轮 token 预算分配。
 *
 * `totalTokenBudget` 是模型上下文窗口减去为响应预留的部分。
 * 各 `reservedFor*` 是预留给具体类别的最低额度,ContextBudgeter 会先按这些额度划分,
 * 剩余额度再让所有块按 priority 抢占。
 */
export const ContextBudgetSchema = z.object({
  totalTokenBudget: z.number().int().positive(),
  reservedForResponse: z.number().int().nonnegative().default(0),
  reservedForSystem: z.number().int().nonnegative().default(0),
  reservedForTools: z.number().int().nonnegative().default(0),
  reservedForMemory: z.number().int().nonnegative().default(0),
  hardCeilingTokens: z.number().int().positive().optional(),
});
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

/**
 * 装配结果。每轮请求一份,落库后用于回放与压缩策略调优。
 *
 * - `droppedBlockIds`    : 被预算淘汰的块,审计能看到"这次没带哪些"
 * - `compressedBlockIds` : 被压缩过的块,可对照压缩前后效果
 * - `cacheHitKeys`       : 命中缓存的 key,用于评估缓存策略
 */
export const ContextAssemblySchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  requestId: IdSchema,
  createdAt: TimestampSchema,
  budget: ContextBudgetSchema,
  blocks: z.array(ContextBlockSchema),
  droppedBlockIds: z.array(IdSchema).default([]),
  compressedBlockIds: z.array(IdSchema).default([]),
  totalTokens: z.number().int().nonnegative(),
  strategyVersion: z.string().default("1"),
  cacheHitKeys: z.array(z.string()).default([]),
  metadata: MetadataSchema.optional(),
});
export type ContextAssembly = z.infer<typeof ContextAssemblySchema>;

/**
 * 单次压缩动作的执行记录。压缩本身可能涉及模型调用,所以独立记录耗时。
 */
export const ContextCompressionResultSchema = z.object({
  blockId: IdSchema,
  strategy: ContextCompressionStrategySchema,
  beforeTokens: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  summaryRef: IdSchema.optional(),
  cacheKey: z.string().optional(),
  durationMs: z.number().int().nonnegative().default(0),
});
export type ContextCompressionResult = z.infer<typeof ContextCompressionResultSchema>;
