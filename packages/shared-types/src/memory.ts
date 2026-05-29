/**
 * @file memory.ts
 * @module @jue/shared-types/memory
 *
 * 长期记忆协议层。Context 中的内容是临时工作记忆；这里描述的是不能从当前项目
 * 状态直接推导出的长期信息，例如用户偏好、全局协作规则、项目决策原因和外部引用。
 *
 * 设计约束：
 * - 自动提取必须保守，默认不写入；用户显式要求“记住”时才直接进入高优先级写入。
 * - 记忆以结构化 Markdown 保存，文件 frontmatter 是索引、检索和维护的单一事实源。
 * - SubAgent 默认不共享长期记忆，只能由主 Agent 或 ContextManager 注入最小必要子集。
 */

import { z } from "zod";
import {
  IdSchema,
  MetadataSchema,
  SensitivityLevelSchema,
  TimestampSchema,
} from "./common.js";

export const MemoryScopeSchema = z.enum([
  "user",
  "team",
  "global",
  "project",
  "conversation",
  "working",
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryKindSchema = z.enum([
  "fact",
  "preference",
  "skill",
  "goal",
  "task",
  "summary",
  "rule",
  "credential_ref",
  "other",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryOriginSchema = z.enum([
  "explicit_user",
  "auto_extracted",
  "subagent",
  "tool_result",
  "import",
  "system",
]);
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>;

export const MemoryProvenanceSchema = z.enum([
  "explicit",
  "inferred",
  "observed",
]);
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemoryStatusSchema = z.enum([
  "candidate",
  "active",
  "archived",
  "expired",
  "rejected",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/**
 * Markdown 记忆文件的业务类型。scope 决定落盘位置，type 决定正文格式与维护策略。
 */
export const MemoryDocumentTypeSchema = z.enum([
  "user",
  "global",
  "feedback",
  "project",
  "reference",
]);
export type MemoryDocumentType = z.infer<typeof MemoryDocumentTypeSchema>;

export const MemorySharingPolicySchema = z.object({
  shareWithSubAgents: z.boolean().default(false),
  allowedSubAgentTypes: z.array(z.string()).default([]),
  redactKeys: z.array(z.string()).default([]),
});
export type MemorySharingPolicy = z.infer<typeof MemorySharingPolicySchema>;

export const MemoryRecordSchema = z.object({
  id: IdSchema,
  scope: MemoryScopeSchema,
  ownerId: IdSchema.describe("user/team/global/session/run/project 的所属 id"),
  kind: MemoryKindSchema,
  origin: MemoryOriginSchema,
  provenance: MemoryProvenanceSchema.default("inferred"),
  status: MemoryStatusSchema.default("candidate"),

  title: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().optional(),

  weight: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.5),
  sensitivity: SensitivityLevelSchema.default("internal"),

  tags: z.array(z.string()).default([]),
  embeddingRef: IdSchema.optional(),

  sourceMessageIds: z.array(IdSchema).default([]),
  sourceToolResultIds: z.array(IdSchema).default([]),

  ttlMs: z.number().int().nonnegative().optional(),
  expiresAt: TimestampSchema.optional(),
  originSessionId: IdSchema.optional(),

  sharing: MemorySharingPolicySchema.optional(),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  lastAccessedAt: TimestampSchema.optional(),
  accessCount: z.number().int().nonnegative().default(0),

  metadata: MetadataSchema.optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryFrontmatterSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name 必须是 kebab-case"),
  description: z.string().min(1),
  type: MemoryDocumentTypeSchema,
  scope: MemoryScopeSchema,
  originSessionId: IdSchema,
  ttlMs: z.number().int().nonnegative(),
  weight: z.number().min(0).max(1),
  sensitivity: SensitivityLevelSchema,
  provenance: MemoryProvenanceSchema.default("inferred"),
  status: MemoryStatusSchema.default("active"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  tags: z.array(z.string()).default([]),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

export const MemoryDocumentSchema = z.object({
  id: IdSchema,
  path: z.string().min(1),
  frontmatter: MemoryFrontmatterSchema,
  body: z.string().min(1),
  indexLine: z.string().min(1),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

export const MemoryIndexEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: MemoryDocumentTypeSchema,
  scope: MemoryScopeSchema,
  relativePath: z.string().min(1),
  weight: z.number().min(0).max(1),
  updatedAt: TimestampSchema.optional(),
  tags: z.array(z.string()).default([]),
});
export type MemoryIndexEntry = z.infer<typeof MemoryIndexEntrySchema>;

export const MemoryQuerySchema = z.object({
  scope: MemoryScopeSchema.optional(),
  scopes: z.array(MemoryScopeSchema).default([]),
  ownerId: IdSchema.optional(),
  workspaceRoot: z.string().optional(),
  kinds: z.array(MemoryKindSchema).default([]),
  documentTypes: z.array(MemoryDocumentTypeSchema).default([]),
  tags: z.array(z.string()).default([]),
  text: z.string().optional(),
  minWeight: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  status: MemoryStatusSchema.optional(),
  includeIndexOnly: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(20),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemoryWriteRequestSchema = z.object({
  requestId: IdSchema,
  sessionId: IdSchema.optional(),
  workspaceRoot: z.string().optional(),
  source: MemoryOriginSchema,
  records: z.array(MemoryRecordSchema.partial()),
});
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;

export const MemoryExtractionPrioritySchema = z.enum(["high", "normal", "low"]);
export type MemoryExtractionPriority = z.infer<typeof MemoryExtractionPrioritySchema>;

export const MemoryExtractionInputSchema = z.object({
  kind: z.enum(["message", "tool_result", "session_summary", "manual"]),
  payload: z.unknown(),
  requestId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  userId: IdSchema.optional(),
  workspaceRoot: z.string().optional(),
  priority: MemoryExtractionPrioritySchema.default("normal"),
});
export type MemoryExtractionInput = z.infer<typeof MemoryExtractionInputSchema>;

export const MemoryMaintenanceResultSchema = z.object({
  checked: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  compacted: z.number().int().nonnegative(),
  rewrittenIndexes: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()).default([]),
});
export type MemoryMaintenanceResult = z.infer<typeof MemoryMaintenanceResultSchema>;




