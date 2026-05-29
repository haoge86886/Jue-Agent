/**
 * @file schema/model.ts
 * @module @jue/config/schema/model
 *
 * LLM/Embedding 模型配置(对应 `configs/model.yaml`)。
 *
 * 核心思想:
 *   1. 每个具体的可用模型都是一个 {@link ModelProfile},通过 `id` 命名引用
 *   2. 系统在不同任务上使用不同模型,通过 {@link ModelRouting} 把任务角色映射到 profile id
 *   3. routing 引用必须能在 profiles 中找到 → 由 schema 末尾的 `.refine` 强校验
 *
 * 这种"配置驱动 + 引用校验"的好处:
 *   - 业务代码不直接写"模型名",只写"我要 summarizer",换模型 0 改代码
 *   - 写错引用 yaml 启动时立刻报错,不会到运行时才挂
 */

import { z } from "zod";

/**
 * 模型供应商。新增供应商时需扩枚举,并在 ModelProvider Adapter 中实现接入。
 */
export const ModelProviderSchema = z.enum([
  "openai",
  "anthropic",
  "azure_openai",
  "deepseek",
  "qwen",
  "moonshot",
  "ollama",
  "custom",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/**
 * 模型角色。系统在不同流程中通过角色找模型,而不是直接写模型名。
 *
 * 例:总结压缩调用 `summarizer`,记忆抽取调用 `extractor`,主回复调用 `main`,
 * 当 `main` 不可用时 fallback。
 */
export const ModelRoleSchema = z.enum([
  "main",
  "planner",
  "summarizer",
  "extractor",
  "embedding",
  "reranker",
  "vision",
  "fallback",
]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

/**
 * 模型容量与速率限制。
 *
 * - `contextWindow`       : 模型支持的最大上下文 token
 * - `maxOutputTokens`     : 单轮最大生成 token
 * - `reservedForResponse` : ContextBudgeter 在装配上下文时为响应预留的额度
 * - `rateLimit*`          : 由 ProviderAdapter 用作客户端限流提示
 */
export const ModelLimitsSchema = z.object({
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(4_096),
  reservedForResponse: z.number().int().nonnegative().default(2_048),
  rateLimitRpm: z.number().int().positive().optional(),
  rateLimitTpm: z.number().int().positive().optional(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

/**
 * 采样参数。`temperature 0.3` 是默认偏稳健的取值,创意类任务建议在 yaml 中显式覆盖。
 */
export const ModelSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.3),
  topP: z.number().min(0).max(1).default(1),
  presencePenalty: z.number().min(-2).max(2).default(0),
  frequencyPenalty: z.number().min(-2).max(2).default(0),
});
export type ModelSampling = z.infer<typeof ModelSamplingSchema>;

/**
 * 一个具体可用的模型实例。
 *
 * - `id`        : 业务引用名,完全自定义(如 `gpt4-main`、`qwen-fast`、`local-llama`)
 * - `apiKey`    : 推荐通过 `${OPENAI_API_KEY}` 占位符注入,不直接写明文
 * - `enabled`   : false 时该 profile 在 routing 中仍可引用但启动期会被警告
 */
export const ModelProfileSchema = z.object({
  id: z.string().min(1).describe("内部引用名,如 main / summarizer-fast"),
  provider: ModelProviderSchema,
  modelName: z.string().min(1),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  organization: z.string().optional(),
  role: ModelRoleSchema.default("main"),
  limits: ModelLimitsSchema.optional(),
  sampling: ModelSamplingSchema.optional(),
  timeoutMs: z.number().int().positive().default(60_000),
  retryMax: z.number().int().nonnegative().default(2),
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * 角色 → profile id 的路由表。仅 `main` 必填,其余角色未配置时由代码层决定降级策略
 * (常见做法:fallback 到 `main`)。
 */
export const ModelRoutingSchema = z.object({
  main: z.string().min(1),
  planner: z.string().optional(),
  summarizer: z.string().optional(),
  extractor: z.string().optional(),
  embedding: z.string().optional(),
  reranker: z.string().optional(),
  vision: z.string().optional(),
  fallback: z.string().optional(),
});
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

/**
 * 模型领域配置主结构。
 *
 * 末尾的 `superRefine` 是关键约束:
 *   1. routing 中所有非 undefined 的 id 必须能在 profiles 中找到
 *   2. 引用的 profile 必须 `enabled !== false`
 *
 * 如果只检查存在,可能出现"配置文件里把模型禁用了,但 routing 还指向它"的情况——
 * 启动期不报错,等到第一次实际调用模型才挂。这里直接在 schema 层拦截,
 * 并按角色给出独立的错误路径,排查时能直接定位到 `routing.summarizer` 这种精确字段。
 */
export const ModelConfigSchema = z
  .object({
    profiles: z.array(ModelProfileSchema).min(1),
    routing: ModelRoutingSchema,
    streamByDefault: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    const profileById = new Map(cfg.profiles.map((p) => [p.id, p]));
    const roles: (keyof typeof cfg.routing)[] = [
      "main",
      "planner",
      "summarizer",
      "extractor",
      "embedding",
      "reranker",
      "vision",
      "fallback",
    ];
    for (const role of roles) {
      const id = cfg.routing[role];
      if (id === undefined) continue;
      const profile = profileById.get(id);
      if (!profile) {
        ctx.addIssue({
          code: "custom",
          path: ["routing", role],
          message: `routing.${role} 引用了未定义的 profile id: ${id}`,
        });
        continue;
      }
      if (profile.enabled === false) {
        ctx.addIssue({
          code: "custom",
          path: ["routing", role],
          message: `routing.${role} 引用了已禁用的 profile id: ${id}(profile.enabled=false)`,
        });
      }
    }
  });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
