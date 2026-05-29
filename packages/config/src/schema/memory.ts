/**
 * @file schema/memory.ts
 * @module @jue/config/schema/memory
 *
 * 记忆子系统配置(对应 `configs/memory.yaml`)。
 *
 * 配置层职责:存储后端选择、自动抽取策略、共享策略、清理策略、配额。
 * 记忆主体形状(MemoryRecord)在 `@jue/shared-types/memory`。
 *
 * 关键策略:
 *   1. 自动抽取默认走"保守模式"——`conservativeMode: true` + `minConfidenceToActivate: 0.7`,
 *      宁可漏记也不要错记
 *   2. 共享给 SubAgent 默认关闭,显式打开后还要走 redactKeys 脱敏
 *   3. 清理周期默认 24h,过期阈值 90 天,可按业务调整
 */

import { z } from "zod";
import { MemoryScopeSchema, SensitivityLevelSchema } from "@jue/shared-types";

/**
 * 存储后端。
 *   - `sqlite`   : 默认,文件即数据库,本地部署最方便
 *   - `postgres` : 多用户/远程部署使用
 *   - `memory`   : 仅用于测试,进程退出即清空
 */
export const MemoryStorageBackendSchema = z.enum(["sqlite", "postgres", "memory"]);
export type MemoryStorageBackend = z.infer<typeof MemoryStorageBackendSchema>;

/**
 * 存储后端配置。`enableEmbedding` 打开后,记忆会异步生成向量并支持相似度检索。
 */
export const MemoryStorageConfigSchema = z.object({
  backend: MemoryStorageBackendSchema.default("sqlite"),
  sqlitePath: z.string().default("./data/memory.db"),
  postgresUrl: z.string().url().optional(),
  enableEmbedding: z.boolean().default(false),
  embeddingModelId: z.string().optional(),
});
export type MemoryStorageConfig = z.infer<typeof MemoryStorageConfigSchema>;

/**
 * 自动记忆抽取策略。
 *
 * - `conservativeMode`        : 仅抽取明确事实,跳过推断/猜测
 * - `maxCandidatesPerTurn`    : 单轮对话至多产生几条候选记忆
 * - `minConfidenceToActivate` : 候选记忆自动转 `active` 的置信度门槛,
 *                               低于此值的留在 `candidate` 等待人工/规则审核
 * - `extractorModelId`        : 使用哪个模型角色做抽取(为空则使用 `model.routing.extractor`)
 * - `asyncWrite`              : 抽取过程异步走 MemoryPipeline,不阻塞主回复
 */
export const MemoryExtractionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  conservativeMode: z.boolean().default(true),
  maxCandidatesPerTurn: z.number().int().nonnegative().default(3),
  minConfidenceToActivate: z.number().min(0).max(1).default(0.7),
  extractorModelId: z.string().optional(),
  asyncWrite: z.boolean().default(true),
});
export type MemoryExtractionConfig = z.infer<typeof MemoryExtractionConfigSchema>;

/**
 * 单个 scope 的配额。超过限额时会触发清理或拒绝写入。
 */
export const MemoryQuotaSchema = z.object({
  scope: MemoryScopeSchema,
  maxRecords: z.number().int().positive().default(1_000),
  maxTokensPerRecord: z.number().int().positive().default(2_048),
  defaultTtlMs: z.number().int().positive().optional(),
});
export type MemoryQuota = z.infer<typeof MemoryQuotaSchema>;

/**
 * 共享给 SubAgent 的策略默认值。
 * 单条 MemoryRecord.sharing 可以覆盖这里的全局默认。
 */
export const MemorySharingConfigSchema = z.object({
  shareWithSubAgentsByDefault: z.boolean().default(false),
  defaultRedactKeys: z.array(z.string()).default([
    "apiKey",
    "token",
    "password",
    "secret",
  ]),
  maxSharedRecords: z.number().int().positive().default(20),
});
export type MemorySharingConfig = z.infer<typeof MemorySharingConfigSchema>;

/**
 * 清理策略。
 *
 * - `intervalMs`           : 清理任务运行周期,默认 24 小时
 * - `expireOlderThanMs`    : 超过此时长且未访问过的记录视为过期,默认 90 天
 * - `mergeDuplicates`      : 合并近似重复记忆
 * - `decayLowValueRecords` : 周期性下调低活跃度记忆的 weight
 */
export const MemoryCleanupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  expireOlderThanMs: z.number().int().positive().default(90 * 24 * 60 * 60 * 1000),
  mergeDuplicates: z.boolean().default(true),
  decayLowValueRecords: z.boolean().default(true),
});
export type MemoryCleanupConfig = z.infer<typeof MemoryCleanupConfigSchema>;

/**
 * 记忆领域配置主结构。
 *
 * `enabledScopes` 默认只开 `user / conversation / working` 三个,
 * `team / global` 需在 yaml 中显式打开,避免误共享。
 */
export const MemoryConfigSchema = z.object({
  enabledScopes: z.array(MemoryScopeSchema).default([
    "user",
    "conversation",
    "working",
  ]),
  defaultSensitivity: SensitivityLevelSchema.default("internal"),
  storage: MemoryStorageConfigSchema.optional(),
  extraction: MemoryExtractionConfigSchema.optional(),
  sharing: MemorySharingConfigSchema.optional(),
  cleanup: MemoryCleanupConfigSchema.optional(),
  quotas: z.array(MemoryQuotaSchema).default([]),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
