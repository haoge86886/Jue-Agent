/**
 * @file schema/app.ts
 * @module @jue/config/schema/app
 *
 * 应用级基础配置(对应 `configs/app.yaml`)。
 *
 * 定义影响所有领域的横切配置:运行环境、HTTP/WebSocket 服务、路径布局、
 * 日志/遥测、各前端入口的全局开关。
 *
 * 注意:
 *   - 所有嵌套对象都用 `.optional()`,不用 `.default({})`
 *     (Zod 4 要求外层 default 提供完整字段;改用 optional + 内层字段级默认)
 *   - 路径都使用相对路径,具体应用启动时再 resolve 为绝对路径
 */

import { z } from "zod";

/**
 * 应用运行环境。影响:日志格式、错误堆栈是否展开、`production` 下禁用某些调试工具。
 */
export const AppEnvSchema = z.enum(["development", "test", "staging", "production"]);
export type AppEnv = z.infer<typeof AppEnvSchema>;

/**
 * 日志级别。与 `pino` 默认级别对齐,便于直接传入 logger。
 */
export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * HTTP 服务器配置。
 *
 * - `host`      : 绑定网卡。默认 127.0.0.1 仅本机访问;远程开放需显式改为 0.0.0.0
 * - `publicUrl` : 反向代理后的公共访问地址,用于生成回调链接
 */
export const HttpServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(3030),
  publicUrl: z.string().url().optional(),
});
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;

/**
 * WebSocket 服务配置。流式回包与远程控制都依赖此服务。
 *
 * - `pingIntervalMs`  : 心跳间隔,过长会被中间代理断连
 * - `maxPayloadBytes` : 单帧最大字节数,默认 1 MiB
 */
export const WebSocketServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pingIntervalMs: z.number().int().positive().default(30_000),
  maxPayloadBytes: z.number().int().positive().default(1_048_576),
});
export type WebSocketServerConfig = z.infer<typeof WebSocketServerConfigSchema>;

/**
 * 关键路径布局。
 *
 * 所有运行时产生的文件(日志、SQLite、快照、缓存)都集中在这里声明,
 * 部署时改一个根目录就能整体迁移。
 */
export const PathsConfigSchema = z.object({
  promptsDir: z.string().default("./prompts"),
  dataDir: z.string().default("./data"),
  snapshotDir: z.string().default("./data/snapshots"),
  tempDir: z.string().default("./.cache"),
});
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

/**
 * 应用日志的文件落盘策略。
 *
 * 与"审计日志"是**两套独立**的写入通道:应用日志面向开发调试,
 * 审计日志面向后续合规与排查。两者分别由 `pino` 与 `FileAuditLogger` 写入。
 *
 * 字段语义:
 *   - `enabled`     : 是否开启文件落盘(默认 true,关掉就只走 stderr)
 *   - `file`        : 相对 `paths.logDir` 的文件名,默认 `app.log`
 *   - `mirrorStderr`: 是否同时写到 stderr(开发期方便看,默认 true)
 *   - `rotation`    : 极简滚动(按大小切),为 0 表示不滚动
 */
/**
 * 日志/遥测配置。
 *
 * `redactKeys` 是默认脱敏键列表;`security.secretsRedaction` 提供更细粒度的正则规则,
 * 二者合并使用。
 */
export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  logLevel: LogLevelSchema.default("info"),
  pretty: z.boolean().default(false),
  redactKeys: z.array(z.string()).default([
    "password",
    "token",
    "apiKey",
    "secret",
    "authorization",
  ]),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

/**
 * 各前端入口的全局开关。生产环境通常只开启需要的入口,降低攻击面。
 */
export const FrontendFlagsConfigSchema = z.object({
  cli: z.boolean().default(true),
  webConsole: z.boolean().default(false),
  mobileRemote: z.boolean().default(false),
  api: z.boolean().default(false),
});
export type FrontendFlagsConfig = z.infer<typeof FrontendFlagsConfigSchema>;

/**
 * Agent Loop 运行参数。硬上限用于防止模型/工具循环失控；生产默认不宜太低，
 * 具体消耗仍由上下文预算、工具确认、超时与审计共同约束。
 */
export const AgentLoopConfigSchema = z.object({
  maxIterations: z.number().int().positive().default(32),
});
export type AgentLoopConfig = z.infer<typeof AgentLoopConfigSchema>;

/**
 * 应用级配置主结构。
 *
 * 默认值设计:即使 yaml 是空文件 `{}`,parse 后也能得到一个**可启动**的最小配置:
 * `name=jue-agent / env=development / language=zh-CN / timezone=Asia/Shanghai`。
 */
export const AppConfigSchema = z.object({
  name: z.string().default("jue-agent"),
  env: AppEnvSchema.default("development"),
  defaultLanguage: z.string().default("zh-CN"),
  defaultTimezone: z.string().default("Asia/Shanghai"),
  http: HttpServerConfigSchema.optional(),
  websocket: WebSocketServerConfigSchema.optional(),
  paths: PathsConfigSchema.optional(),
  telemetry: TelemetryConfigSchema.optional(),
  frontends: FrontendFlagsConfigSchema.optional(),
  agentLoop: AgentLoopConfigSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
