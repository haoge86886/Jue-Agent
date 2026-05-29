/**
 * @file tool.ts
 * @module @jue/shared-types/tool
 *
 * 统一工具协议。所有工具(builtin / external / mcp / subagent_bridge / remote)
 * 进入注册表前必须满足 {@link ToolSpec},不合规的外部工具应当通过适配层转换,
 * 不能直接放进 ToolRegistry。
 *
 * 关键模型:
 *   - {@link JsonSchemaLike}    : 兼容 JSON Schema 的宽类型,顶层可以是 boolean
 *   - {@link ToolSpec}          : 工具协议定义(11 个核心字段全覆盖)
 *   - {@link ToolCall}          : Agent 发起的一次工具调用意图
 *   - {@link ToolResult}        : 调用执行后的标准化结果
 *   - {@link ToolInvocation}    : Call + Result 的聚合视图
 *   - {@link ToolRegistration}  : ToolRegistry 中的一条注册记录
 *
 * 设计原则(详见 design.md §9):
 *   1. 工具少而精,内置工具不应超过必要范围
 *   2. 输入输出全部走 Zod/JSON Schema 校验
 *   3. 高风险工具必须显式声明 sideEffectLevel + permissionScope + confirmation
 *   4. 不规范工具先适配,实在不行就标记不可用并给明确原因
 */

import { z } from "zod";
import {
  ErrorInfoSchema,
  IdSchema,
  MetadataSchema,
  PermissionScopeSchema,
  SemverSchema,
  SensitivityLevelSchema,
  SideEffectLevelSchema,
  StatusSchema,
  TimestampSchema,
  TraceContextSchema,
} from "./common.js";

/* ----------------------------------------------------------------------------
 * JSON Schema 类型层
 * --------------------------------------------------------------------------*/

/**
 * 普通 JSON 值。用于 enum / const / default 等需要承载具体数据的位置,
 * 与 schema 描述结构区分开。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * JSON Schema 的 `type` 字段,可以是单值或数组(允许多类型并存,如 `["string", "null"]`)。
 */
export const JsonSchemaTypeSchema = z.union([
  z.enum(["string", "number", "integer", "boolean", "object", "array", "null"]),
  z.array(z.enum(["string", "number", "integer", "boolean", "object", "array", "null"])),
]);
export type JsonSchemaType = z.infer<typeof JsonSchemaTypeSchema>;

/**
 * 兼容标准 JSON Schema 的宽类型。
 *
 * 与"必须是对象"的过窄定义不同,允许:
 *   - 顶层为 `true / false`(标准 JSON Schema 语义:接受任何/拒绝所有)
 *   - 透传未知字段,不阻塞工具方提供超出最小集的描述
 *
 * `exactOptionalPropertyTypes: true` 下手写类型必须显式带 `| undefined`,
 * 否则与 `z.infer` 推导不兼容。
 */
export type JsonSchemaLike =
  | boolean
  | {
      type?: JsonSchemaType | undefined;
      properties?: Record<string, JsonSchemaLike> | undefined;
      required?: string[] | undefined;
      items?: JsonSchemaLike | JsonSchemaLike[] | undefined;
      enum?: JsonValue[] | undefined;
      const?: JsonValue | undefined;
      description?: string | undefined;
      title?: string | undefined;
      default?: JsonValue | undefined;
      examples?: JsonValue[] | undefined;
      format?: string | undefined;
      additionalProperties?: JsonSchemaLike | undefined;
      anyOf?: JsonSchemaLike[] | undefined;
      oneOf?: JsonSchemaLike[] | undefined;
      allOf?: JsonSchemaLike[] | undefined;
      not?: JsonSchemaLike | undefined;
      $ref?: string | undefined;
      $defs?: Record<string, JsonSchemaLike> | undefined;
      [k: string]: unknown;
    };

const JsonSchemaObjectSchema: z.ZodType<Exclude<JsonSchemaLike, boolean>> = z.lazy(() =>
  z
    .object({
      type: JsonSchemaTypeSchema.optional(),
      properties: z.record(z.string(), JsonSchemaLikeSchema).optional(),
      required: z.array(z.string()).optional(),
      items: z
        .union([JsonSchemaLikeSchema, z.array(JsonSchemaLikeSchema)])
        .optional(),
      enum: z.array(JsonValueSchema).optional(),
      const: JsonValueSchema.optional(),
      description: z.string().optional(),
      title: z.string().optional(),
      default: JsonValueSchema.optional(),
      examples: z.array(JsonValueSchema).optional(),
      format: z.string().optional(),
      additionalProperties: JsonSchemaLikeSchema.optional(),
      anyOf: z.array(JsonSchemaLikeSchema).optional(),
      oneOf: z.array(JsonSchemaLikeSchema).optional(),
      allOf: z.array(JsonSchemaLikeSchema).optional(),
      not: JsonSchemaLikeSchema.optional(),
      $ref: z.string().optional(),
      $defs: z.record(z.string(), JsonSchemaLikeSchema).optional(),
    })
    .loose(),
);

export const JsonSchemaLikeSchema: z.ZodType<JsonSchemaLike> = z.lazy(() =>
  z.union([z.boolean(), JsonSchemaObjectSchema]),
);

/** @deprecated 保留向后兼容,新代码请使用 {@link JsonSchemaLikeSchema} */
export const JsonSchemaSchema = JsonSchemaLikeSchema;
export type JsonSchema = JsonSchemaLike;

/* ----------------------------------------------------------------------------
 * 工具分类
 * --------------------------------------------------------------------------*/

/**
 * 工具来源种类。`subagent_bridge` 表示把 SubAgent 暴露为工具,
 * `remote` 表示通过远程控制桥接到其他设备执行的工具。
 */
export const ToolKindSchema = z.enum([
  "builtin",
  "external",
  "mcp",
  "subagent_bridge",
  "remote",
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

/**
 * 工具业务类别,影响开关与确认策略(详见配置 `tools.categoryFlags`)。
 */
export const ToolCategorySchema = z.enum([
  "file",
  "shell",
  "http",
  "search",
  "scrape",
  "data",
  "memory",
  "recommendation",
  "remote_control",
  "system",
  "other",
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/* ----------------------------------------------------------------------------
 * 工具行为策略
 * --------------------------------------------------------------------------*/

/**
 * 重试策略。`retryOn` 为可重试的错误码白名单。
 */
export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(0),
  backoffMs: z.number().int().nonnegative().default(0),
  backoffStrategy: z.enum(["fixed", "linear", "exponential"]).default("fixed"),
  retryOn: z.array(z.string()).default([]),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * 确认策略。`autoApproveScopes` 列出哪些权限作用域可以免确认。
 */
export const ConfirmationPolicySchema = z.object({
  required: z.boolean().default(false),
  reason: z.string().optional(),
  autoApproveScopes: z.array(PermissionScopeSchema).default([]),
});
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;

/**
 * 错误映射规则。把工具底层抛出的原始错误映射到稳定的业务错误码。
 */
export const ToolErrorMappingSchema = z.object({
  pattern: z.string().describe("匹配原始错误的正则或前缀"),
  toCode: z.string(),
  retriable: z.boolean().default(false),
  hint: z.string().optional(),
});
export type ToolErrorMapping = z.infer<typeof ToolErrorMappingSchema>;

/**
 * 可用性探测描述。工具注册时可声明何时认为自己是"可用"的:
 *   - `always`   : 始终可用
 *   - `env`      : 指定环境变量都存在
 *   - `config`   : 配置中某 key 为真
 *   - `probe`    : 由 ToolAdapter 主动探测
 *   - `subagent` : 委托 SubAgent 判断
 */
export const ToolAvailabilitySchema = z.object({
  kind: z.enum(["always", "env", "config", "probe", "subagent"]),
  envKeys: z.array(z.string()).default([]),
  configKey: z.string().optional(),
  probeId: z.string().optional(),
});
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>;

/* ----------------------------------------------------------------------------
 * 工具协议主体
 * --------------------------------------------------------------------------*/

/**
 * 工具协议定义。本结构是 ToolRegistry 接受新工具的唯一入口形状。
 *
 * 11 个核心字段(对应 design.md §9.2 的最小协议):
 * `name / displayName / description / inputSchema / outputSchema /
 *  sideEffectLevel / timeoutMs / retryPolicy / permissionScope /
 *  availabilityCheck / errorMapping`
 *
 * - `name` 走小写蛇形 + 点号分组,便于按域过滤(`fs.read / http.get`)
 * - `inputSchema/outputSchema` 用 {@link JsonSchemaLikeSchema} 描述,跨语言可读
 */
export const ToolSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/, "工具名建议小写蛇形,可用点号分组"),
  displayName: z.string().min(1),
  description: z.string().min(1),
  version: SemverSchema.default("0.1.0"),
  kind: ToolKindSchema.default("builtin"),
  category: ToolCategorySchema.default("other"),

  inputSchema: JsonSchemaLikeSchema,
  outputSchema: JsonSchemaLikeSchema,

  sideEffectLevel: SideEffectLevelSchema.default("none"),
  timeoutMs: z.number().int().positive().default(30_000),
  retryPolicy: RetryPolicySchema.optional(),
  permissionScope: PermissionScopeSchema.default("user"),
  confirmation: ConfirmationPolicySchema.optional(),
  availabilityCheck: ToolAvailabilitySchema.optional(),
  errorMapping: z.array(ToolErrorMappingSchema).default([]),

  tags: z.array(z.string()).default([]),
  sensitivity: SensitivityLevelSchema.default("internal"),
  metadata: MetadataSchema.optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/* ----------------------------------------------------------------------------
 * 调用与结果
 * --------------------------------------------------------------------------*/

/**
 * Agent 决定调用工具时产生的"调用意图"。
 * 此对象在进入 ToolExecutor 前必须由 ToolValidator 完成 inputSchema 校验。
 */
export const ToolCallSchema = z.object({
  id: IdSchema,
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  relevanceScore: z.number().min(0).max(1).default(0.5).describe("模型对本次工具结果与当前任务相关性的初始评分"),
  invokedBy: z.enum(["agent", "subagent", "user", "system"]).default("agent"),
  sessionId: IdSchema,
  requestId: IdSchema,
  parentCallId: IdSchema.optional(),
  trace: TraceContextSchema.optional(),
  createdAt: TimestampSchema,
  timeoutMs: z.number().int().positive().optional(),
  metadata: MetadataSchema.optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * 工具结果状态。`rejected` 表示因权限/确认/可用性等原因被拒绝执行,
 * 与 `failed`(执行了但失败)区分开,便于审计聚合。
 */
export const ToolResultStatusSchema = z.enum([
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "rejected",
  "skipped",
]);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

/**
 * 工具结果。
 *
 * - `output`        : 直接结果。大对象建议放 `rawOutputRef` 引用 ToolResultStore
 * - `summary`       : 给上下文用的简短摘要,优先于完整 output 进入 prompt
 * - `tokenEstimate` : 该结果在上下文中的预估 token 占用
 * - `truncated`     : 是否被截断;用于上下文层判断是否需要展开二次查询
 */
export const ToolResultSchema = z.object({
  id: IdSchema,
  callId: IdSchema,
  toolName: z.string().min(1),
  status: ToolResultStatusSchema,
  output: z.unknown().optional(),
  rawOutputRef: IdSchema.optional(),
  summary: z.string().optional(),
  relevanceScore: z.number().min(0).max(1).default(0.5),
  tokenEstimate: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  error: ErrorInfoSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  truncated: z.boolean().default(false),
  metadata: MetadataSchema.optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * Call + Result 的聚合视图。常用于审计列表和上下文回放。
 * `result` 在调用尚未结束时为空,`status` 反映当前阶段。
 */
export const ToolInvocationSchema = z.object({
  call: ToolCallSchema,
  result: ToolResultSchema.optional(),
  status: StatusSchema,
});
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;

/**
 * ToolRegistry 中的一条注册记录。
 * 不可用时通过 `enabled = false + unavailableReason` 让前端给出明确提示。
 */
export const ToolRegistrationSchema = z.object({
  spec: ToolSpecSchema,
  enabled: z.boolean().default(true),
  registeredAt: TimestampSchema,
  unavailableReason: z.string().optional(),
});
export type ToolRegistration = z.infer<typeof ToolRegistrationSchema>;
