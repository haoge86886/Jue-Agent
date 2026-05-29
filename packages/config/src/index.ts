/**
 * @file index.ts
 * @module @jue/config
 *
 * `@jue/config` 包总入口。
 *
 * 一句话:把"几个 yaml 文件 + .env + Zod schema"组装成全局只读、可热重载的 RootConfig 单例。
 *
 * 一般用法:
 *
 * ```ts
 * import { initConfig, getConfig } from "@jue/config";
 *
 * // 应用启动时调用一次
 * initConfig({ configsDir: "./configs" });
 *
 * // 业务代码任何位置:
 * const cfg = getConfig();
 * console.log(cfg.app.env, cfg.model.routing.main);
 * ```
 *
 * 子路径导入(在不需要拿 registry 的纯校验场景):
 *
 * ```ts
 * import { ModelConfigSchema } from "@jue/config/schema";
 * import { ConfigError } from "@jue/config/errors";
 * ```
 */

export * from "./errors.js";
export * from "./env-resolver.js";
export * from "./yaml-reader.js";
export * from "./config-loader.js";
export * from "./config-registry.js";
export * from "./schema/index.js";
