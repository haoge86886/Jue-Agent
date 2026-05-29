/**
 * @file common.ts
 * @module @jue/shared-types/common
 *
 * 跨包共享的基础原子类型与公共枚举,所有领域(session / context / tool / memory /
 * subagent / recommendation / audit)都直接消费这里的定义,避免重复造轮子。
 *
 * 本文件不依赖任何其他 shared-types 模块,处于依赖图最底层。
 *
 * 命名约定:
 *   - 形如 `XxxSchema`     : Zod schema,用于运行时校验
 *   - 形如 `Xxx`           : 由 `z.infer` 派生的 TypeScript 类型
 *   - 形如 `XxxShape`(常量)只在需要复用 raw shape 拼接更大对象时导出
 */

import { z } from "zod";

/**
 * 通用 ID,业务上可能是 UUIDv4,也可能是带前缀的短哈希(如 `sess_xxx`)。
 * 仅做最小校验:非空字符串。
 */
export const IdSchema = z.string().min(1).describe("通用 ID(UUID 或业务前缀+短哈希)");
export type Id = z.infer<typeof IdSchema>;

/**
 * Unix 毫秒时间戳。整数,非负。
 * 全系统统一使用毫秒,而不是秒,因为日志/审计/事件流需要更高精度。
 */
export const TimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Unix 毫秒时间戳");
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * ISO-8601 带时区的日期时间字符串,用于跨进程/跨平台传输人类可读时间。
 * 仅在与外部系统(推荐源、审计导出)交互时使用,内部尽量用 `TimestampSchema`。
 */
export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO-8601 日期时间字符串");
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/**
 * 语义化版本号,允许带 `-pre` / `+build` 后缀。用于工具版本、压缩策略版本等。
 */
export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+([-+].+)?$/);
export type Semver = z.infer<typeof SemverSchema>;

/**
 * 前端类型,标识请求来自哪一类入口。
 * Session 层根据此值决定流式策略、能力感知、审计标签等。
 */
export const FrontendKindSchema = z.enum(["cli", "web", "mobile", "api", "webhook"]);
export type FrontendKind = z.infer<typeof FrontendKindSchema>;

/**
 * 会话模式,影响 Prompt 装配、SubAgent 选择和工具开关。
 * 例:`coding` 模式会启用更多代码工具,`recommendation` 模式倾向只读探索。
 */
export const SessionModeSchema = z.enum([
  "chat",
  "task",
  "coding",
  "review",
  "research",
  "recommendation",
]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/**
 * 消息发送者角色。
 * `subagent` 与 `tool` 是为了区分"内部委派结果"与"工具返回结果",方便审计。
 */
export const RoleSchema = z.enum(["system", "user", "assistant", "tool", "subagent"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * 数据敏感度,记忆/上下文块/工具结果都会带此字段。
 * 主要用于:SubAgent 共享裁剪、日志脱敏、审计分级。
 */
export const SensitivityLevelSchema = z.enum(["public", "internal", "private", "secret"]);
export type SensitivityLevel = z.infer<typeof SensitivityLevelSchema>;

/**
 * 工具副作用等级。从无副作用到不可逆破坏性递增。
 * `ToolExecutor` 将根据此字段决定是否要求确认、是否写审计、是否允许重试。
 */
export const SideEffectLevelSchema = z.enum([
  "none",
  "read",
  "write",
  "external",
  "destructive",
]);
export type SideEffectLevel = z.infer<typeof SideEffectLevelSchema>;

/**
 * 权限作用域。记忆共享、工具调用、远程访问的权限分级共用此枚举。
 */
export const PermissionScopeSchema = z.enum([
  "user",
  "workspace",
  "team",
  "global",
  "admin",
]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/**
 * 通用任务/调用状态。覆盖 SubAgent、Tool、Memory pipeline 等异步流程。
 */
export const StatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "timeout",
]);
export type Status = z.infer<typeof StatusSchema>;

/**
 * 日志/审计严重等级,与 `pino` 默认等级对齐。
 */
export const SeveritySchema = z.enum(["debug", "info", "warn", "error", "fatal"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * 通用 metadata 容器。所有实体的可扩展字段都走此类型,避免反复改 schema。
 * 注意:写入此字段的内容不会被 Zod 严格校验,使用方自行约束。
 */
export const MetadataSchema = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * 分布式追踪上下文。Engine、ToolExecutor、SubAgent、Worker 之间传递时携带,
 * 用于把跨进程/跨包的同一次会话串成单一 trace。
 */
export const TraceContextSchema = z.object({
  traceId: IdSchema,
  spanId: IdSchema.optional(),
  parentSpanId: IdSchema.optional(),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

/**
 * 标准化错误描述,用于跨边界传递错误(工具结果、SubAgent 结果、SessionResponse)。
 *
 * - `code`     : 业务级错误码,稳定且可被监控聚合
 * - `retriable`: 上层是否可以安全重试,直接影响 RetryPolicy 行为
 */
export const ErrorInfoSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  cause: z.string().optional(),
  retriable: z.boolean().default(false),
  details: MetadataSchema.optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

/**
 * 通用游标分页。
 * 用 `cursor` 而不是 `offset` 是为了在记忆/审计这类追加流上保持稳定排序。
 */
export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export type Pagination = z.infer<typeof PaginationSchema>;

/**
 * Schema 版本标记。当数据库存量数据需要做迁移时,据此判断结构形态。
 */
export const VersionedSchema = z.object({
  schemaVersion: z.string().default("1"),
});
export type Versioned = z.infer<typeof VersionedSchema>;

/**
 * 持久化实体的通用字段形状。以 raw shape 形式导出,方便其他 schema 用
 * `z.object({ ...BaseEntityShape, foo: ... })` 直接拼接,而不是 `.extend`。
 */
export const BaseEntityShape = {
  id: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  status: StatusSchema.optional(),
  source: z.string().optional(),
  metadata: MetadataSchema.optional(),
} as const;

export const BaseEntitySchema = z.object(BaseEntityShape);
export type BaseEntity = z.infer<typeof BaseEntitySchema>;
