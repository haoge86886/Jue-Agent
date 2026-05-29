/**
 * @file recommendation.ts
 * @module @jue/shared-types/recommendation
 *
 * 兴趣推荐子系统的协议层。包含三类对象:
 *   1. 用户兴趣画像({@link InterestProfile} / {@link InterestTag})
 *   2. 推荐内容条目({@link RecommendationItem})
 *   3. 批次({@link RecommendationBatch})
 *
 * 由 `packages/recommendation` 实现 InterestManager / SourceAdapter /
 * Ranker / Deduplicator / Deliverer 完整管线。
 *
 * 设计原则(详见 design.md §13):
 *   1. 数据源能扩展,适配器统一为 SourceAdapter 接口
 *   2. 必须有用户反馈通道(liked / disliked / saved / ignored / reported / opened),
 *      反馈反哺 InterestProfile
 *   3. 推送默认走主聊天流,支持降级到通知/邮件/卡片
 *   4. 排序分必须可解释(三个分项独立,最终分由权重合成)
 */

import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  TimestampSchema,
} from "./common.js";

/**
 * 推荐源种类。新增源时先扩枚举,再实现适配器。
 */
export const RecommendationSourceKindSchema = z.enum([
  "twitter",
  "x",
  "bilibili",
  "xiaohongshu",
  "weibo",
  "rss",
  "youtube",
  "github",
  "hackernews",
  "reddit",
  "custom",
]);
export type RecommendationSourceKind = z.infer<typeof RecommendationSourceKindSchema>;

/**
 * 兴趣标签来源。`feedback` 表示由用户对历史推荐的反馈反推得出。
 */
export const InterestSourceSchema = z.enum([
  "explicit",
  "auto_extracted",
  "feedback",
  "import",
]);
export type InterestSource = z.infer<typeof InterestSourceSchema>;

/**
 * 兴趣标签。
 *
 * - `freshnessHours` : 该兴趣的"新鲜度窗口",超过这个时间的内容会被新鲜度分降权
 * - `blocked`        : 该兴趣下要屏蔽的关键词(对作者/平台/词的黑名单)
 */
export const InterestTagSchema = z.object({
  id: IdSchema,
  topic: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  platforms: z.array(RecommendationSourceKindSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  freshnessHours: z.number().int().positive().default(72),
  blocked: z.array(z.string()).default([]),
  source: InterestSourceSchema.default("explicit"),
  weight: z.number().min(0).max(1).default(0.5),
  updatedAt: TimestampSchema.optional(),
});
export type InterestTag = z.infer<typeof InterestTagSchema>;

/**
 * 兴趣画像。一个用户一份。
 * `globalBlocked` 是跨标签的全局屏蔽词。
 */
export const InterestProfileSchema = z.object({
  userId: IdSchema,
  tags: z.array(InterestTagSchema).default([]),
  globalBlocked: z.array(z.string()).default([]),
  preferredLanguages: z.array(z.string()).default(["zh-CN"]),
  updatedAt: TimestampSchema,
});
export type InterestProfile = z.infer<typeof InterestProfileSchema>;

/**
 * 用户对推荐条目的反馈类型。会反馈给 InterestManager 做权重调整。
 *
 * - `opened` 与 `liked` 区分:点开浏览 ≠ 喜欢
 * - `reported` 触发后,该作者/源会进入隐式黑名单
 */
export const RecommendationFeedbackSchema = z.enum([
  "liked",
  "disliked",
  "saved",
  "ignored",
  "reported",
  "opened",
]);
export type RecommendationFeedback = z.infer<typeof RecommendationFeedbackSchema>;

/**
 * 推荐条目。
 *
 * 排序相关:
 *   - `relevanceScore` : 与兴趣画像的匹配度
 *   - `freshnessScore` : 时间新鲜度
 *   - `credibilityScore`: 来源可信度
 *   - `finalScore`     : 三者按 RankingWeights 合成的最终分
 *
 * - `externalId` : 来源平台的稳定 id,用于去重
 * - `pushedAt`   : 实际推送给用户的时间(可能晚于 fetchedAt)
 */
export const RecommendationItemSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  source: RecommendationSourceKindSchema,
  sourceUrl: z.string().url(),
  externalId: z.string().optional(),
  title: z.string().min(1),
  author: z.string().optional(),
  publishedAt: IsoDateTimeSchema.optional(),
  fetchedAt: TimestampSchema,

  language: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  thumbnailUrl: z.string().url().optional(),

  matchedTags: z.array(z.string()).default([]),
  relevanceScore: z.number().min(0).max(1).default(0),
  freshnessScore: z.number().min(0).max(1).default(0),
  credibilityScore: z.number().min(0).max(1).default(0),
  finalScore: z.number().min(0).max(1).default(0),

  feedback: RecommendationFeedbackSchema.optional(),
  pushedAt: TimestampSchema.optional(),

  metadata: MetadataSchema.optional(),
});
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;

/**
 * 推荐批次。每次定时拉取后产出一个 batch,排序、去重、推送都以 batch 为单位。
 */
export const RecommendationBatchSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  generatedAt: TimestampSchema,
  items: z.array(RecommendationItemSchema),
  strategy: z.string().default("default"),
  metadata: MetadataSchema.optional(),
});
export type RecommendationBatch = z.infer<typeof RecommendationBatchSchema>;
