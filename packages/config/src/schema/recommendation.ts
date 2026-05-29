/**
 * @file schema/recommendation.ts
 * @module @jue/config/schema/recommendation
 *
 * 推荐子系统配置(对应 `configs/recommendation.yaml`)。
 *
 * 配置层职责:数据源接入、调度、排序权重、推送通道。
 * 推荐主体形状(InterestProfile / RecommendationItem)在 `@jue/shared-types/recommendation`。
 *
 * 默认行为:整体 `enabled: false`——推荐功能必须显式打开,避免新部署的实例
 * 在用户没要求的情况下就开始拉取互联网内容。
 */

import { z } from "zod";
import { RecommendationSourceKindSchema } from "@jue/shared-types";

/**
 * 单个推荐源接入配置。
 *
 * 不同 `kind` 用不同字段:
 *   - REST API 类         : `apiBaseUrl + apiKey + customHeaders`
 *   - RSS                : `rssFeedUrl`
 *   - 社交平台(需 OAuth) : `apiBaseUrl + apiKey`,具体凭据由 SourceAdapter 解释
 *
 * `metadata` 留作适配器特有的扩展字段,不在 schema 层强约束。
 */
export const RecommendationSourceConfigSchema = z.object({
  kind: RecommendationSourceKindSchema,
  enabled: z.boolean().default(true),
  apiBaseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  rssFeedUrl: z.string().url().optional(),
  pageSize: z.number().int().positive().default(20),
  maxItemsPerFetch: z.number().int().positive().default(50),
  customHeaders: z.record(z.string(), z.string()).default({}),
  language: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RecommendationSourceConfig = z.infer<typeof RecommendationSourceConfigSchema>;

/**
 * 拉取调度。
 *
 * - `cron`          : 标准 cron 字符串,默认每 6 小时一次
 * - `jitterSeconds` : 随机抖动,避免多实例同步打雷拉取
 * - `retryMax`      : 拉取失败时的重试上限,超过后该批次跳过
 */
export const RecommendationScheduleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().default("0 */6 * * *"),
  jitterSeconds: z.number().int().nonnegative().default(60),
  fetchTimeoutMs: z.number().int().positive().default(30_000),
  retryMax: z.number().int().nonnegative().default(2),
});
export type RecommendationScheduleConfig = z.infer<typeof RecommendationScheduleConfigSchema>;

/**
 * 排序权重。Ranker 的最终分公式:
 *   `final = relevance * w.relevance + freshness * w.freshness + credibility * w.credibility`
 *
 * 三个权重不强求加和为 1,业务可按需调整;实际 final 仍裁剪到 [0, 1]。
 */
export const RecommendationRankingWeightsSchema = z.object({
  relevance: z.number().min(0).max(1).default(0.5),
  freshness: z.number().min(0).max(1).default(0.3),
  credibility: z.number().min(0).max(1).default(0.2),
});
export type RecommendationRankingWeights = z.infer<
  typeof RecommendationRankingWeightsSchema
>;

/**
 * 推送通道与策略。
 *
 * - `channel`           : 主聊天流 / 卡片面板 / 系统通知 / 邮件 / 不主动推送
 * - `maxItemsPerBatch`  : 单次推送条数上限,过多反而干扰
 * - `minScoreThreshold` : final 分低于此值的条目不会被推送
 */
export const RecommendationDeliveryConfigSchema = z.object({
  channel: z.enum(["chat", "card_panel", "notification", "email", "none"]).default("chat"),
  maxItemsPerBatch: z.number().int().positive().default(5),
  minScoreThreshold: z.number().min(0).max(1).default(0.4),
  showSourceBadge: z.boolean().default(true),
  showTimestamp: z.boolean().default(true),
});
export type RecommendationDeliveryConfig = z.infer<
  typeof RecommendationDeliveryConfigSchema
>;

/**
 * 推荐领域配置主结构。
 *
 * `globalBlockedKeywords` 是跨所有源的全局黑名单,优先级高于单源的 enabled。
 */
export const RecommendationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sources: z.array(RecommendationSourceConfigSchema).default([]),
  schedule: RecommendationScheduleConfigSchema.optional(),
  rankingWeights: RecommendationRankingWeightsSchema.optional(),
  delivery: RecommendationDeliveryConfigSchema.optional(),
  defaultLanguages: z.array(z.string()).default(["zh-CN"]),
  globalBlockedKeywords: z.array(z.string()).default([]),
});
export type RecommendationConfig = z.infer<typeof RecommendationConfigSchema>;
