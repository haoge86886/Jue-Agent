/**
 * @file audit.ts
 * @module @jue/shared-types/audit
 *
 * 审计事件协议。每一次"会触发副作用、影响安全/隐私/资源消耗"的动作都应当生成
 * 一条 {@link AuditEvent},由 `packages/audit` 落库,长期保留以便:
 *   - 安全溯源(谁在什么时候做了什么)
 *   - 配额/费用复核
 *   - 行为分析与策略调优
 *
 * 设计原则(详见 design.md §17):
 *   1. 不在 AuditEvent 中存储完整 payload,大对象用 `payloadRef` 指向独立存储
 *   2. 强制带上 actor / target / outcome,便于跨维度聚合
 *   3. 敏感事件本身要做脱敏,`sensitivity` 决定持久化与展示策略
 *   4. 时间统一用毫秒时间戳,排序无歧义
 */

import { z } from "zod";
import {
  FrontendKindSchema,
  IdSchema,
  MetadataSchema,
  SensitivityLevelSchema,
  SeveritySchema,
  TimestampSchema,
  TraceContextSchema,
} from "./common.js";

/**
 * 审计大类。新增类别需要先扩枚举,避免审计端混入未知字符串。
 */
export const AuditCategorySchema = z.enum([
  "session",
  "model_call",
  "tool_call",
  "subagent_call",
  "context_compression",
  "memory_write",
  "memory_cleanup",
  "recommendation_fetch",
  "recommendation_push",
  "remote_access",
  "auth",
  "config_change",
  "security",
  "system",
]);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

/**
 * 行为发起者。
 * `remote_device` 与 `scheduler` 单独区分,避免被混入 `system` 模糊标签。
 */
export const AuditActorSchema = z.object({
  kind: z.enum(["user", "agent", "subagent", "system", "remote_device", "scheduler"]),
  id: IdSchema.optional(),
  name: z.string().optional(),
  frontend: FrontendKindSchema.optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/**
 * 行为目标。统一描述被影响的对象(工具/记忆/推荐项/设备/配置/文件/URL/...)。
 */
export const AuditTargetSchema = z.object({
  kind: z.enum([
    "session",
    "tool",
    "subagent",
    "memory",
    "context_block",
    "recommendation",
    "device",
    "config",
    "file",
    "url",
    "other",
  ]),
  id: IdSchema.optional(),
  name: z.string().optional(),
});
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

/**
 * 单条审计事件。
 *
 * 字段语义:
 *   - `action`         : 动作动词,与 category 配合表达"`tool_call.invoke`"等语义
 *   - `outcome`        : 与 status 不同,审计关注是否被允许/拒绝/跳过
 *   - `payloadSummary` : 简短可读的摘要,直接进入查询界面
 *   - `payloadRef`     : 指向 ToolResultStore 等独立存储中的完整 payload
 *   - `sensitivity`    : 控制本条事件是否可在普通界面显示
 */
export const AuditEventSchema = z.object({
  id: IdSchema,
  category: AuditCategorySchema,
  action: z.string().min(1).describe("如 invoke/grant/deny/compress/extract/push 等"),
  severity: SeveritySchema.default("info"),
  actor: AuditActorSchema,
  target: AuditTargetSchema.optional(),
  sessionId: IdSchema.optional(),
  requestId: IdSchema.optional(),
  trace: TraceContextSchema.optional(),
  outcome: z.enum(["success", "failure", "denied", "skipped"]).default("success"),
  reason: z.string().optional(),
  sensitivity: SensitivityLevelSchema.default("internal"),
  payloadSummary: z.string().optional(),
  payloadRef: IdSchema.optional(),
  occurredAt: TimestampSchema,
  metadata: MetadataSchema.optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
