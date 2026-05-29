/**
 * @file config-registry.ts
 * @module @jue/config/config-registry
 *
 * 全局只读配置访问层。
 *
 * 这一层做三件事:
 *   1. 把 `loadConfig()` 的结果**深冻结**后缓存,避免运行时被任意包改写
 *   2. 暴露按领域(app/model/tools/memory/recommendation/security)分别拿配置的快捷方法
 *   3. 提供 `onChange` 监听 + `reload` 入口,为后续支持热重载留口子
 *
 * 使用方式:
 *   - 应用启动时调一次 {@link initConfig},完成 yaml + env + schema 校验
 *   - 业务代码全程用 {@link getConfig} / `getConfigRegistry()` 拿快照
 *   - **不要**自己再去 `loadConfig`,所有人共享同一份单例
 *
 * 安全设计:
 *   - 返回值都是 `Readonly<T>` 类型,且对象本身经过 `Object.freeze` 递归处理
 *   - 任何对返回对象的赋值在严格模式下会抛 TypeError(运行时也阻止)
 *   - 监听器异常被吞,不影响其他监听器(单点故障隔离)
 */

import { ConfigError } from "./errors.js";
import {
  ConfigLoaderOptions,
  LoadResult,
  loadConfig as loadConfigImpl,
} from "./config-loader.js";
import {
  AppConfig,
  ConfigSection,
  MemoryConfig,
  ModelConfig,
  RecommendationConfig,
  RootConfig,
  SecurityConfig,
  ToolsConfig,
} from "./schema/index.js";

/**
 * 配置变更监听器签名。
 * 调用时机:`init` / `setResult` / `reload` 完成后,在 listener 中拿到的是最新的只读快照。
 */
export type ConfigChangeListener = (cfg: Readonly<RootConfig>) => void;

/**
 * 在 registry 未初始化时调用 `getXxx()` 抛出。
 * 这是开发者错误:正确的做法是先 `initConfig()`。
 */
class NotInitializedError extends ConfigError {
  override name: string = "NotInitializedError";
  constructor() {
    super("ConfigRegistry 尚未初始化,请先调用 initConfig()", "CONFIG_NOT_INITIALIZED");
  }
}

/**
 * 配置注册表本体。
 *
 * 大多数业务代码只需要使用模块底部导出的 {@link initConfig} / {@link getConfig} 即可,
 * 直接使用 `ConfigRegistry` 实例的场景:
 *   - 测试:用 `setResult` 注入 fixture,无需读真实文件
 *   - 多 registry 隔离:在同一进程跑多个独立配置(如多租户场景)
 */
export class ConfigRegistry {
  private config: RootConfig | undefined;
  private sources: Record<ConfigSection, string> | undefined;
  private configsDir: string | undefined;
  private configFile: string | undefined;
  private envFile: string | undefined;
  private listeners = new Set<ConfigChangeListener>();
  private lastLoadOptions: ConfigLoaderOptions | undefined;

  /**
   * 初始化:加载、校验、缓存。可以重复调用以"重新读取磁盘"。
   *
   * @returns 已 deep-frozen 的只读 RootConfig
   */
  init(options: ConfigLoaderOptions = {}): Readonly<RootConfig> {
    const result = loadConfigImpl(options);
    this.applyResult(result);
    this.lastLoadOptions = options;
    return this.requireConfig();
  }

  /**
   * 直接注入一份预先准备好的 LoadResult,主要用于测试。
   * 业务代码不要使用此方法,正常流程应使用 {@link init}。
   */
  setResult(result: LoadResult): Readonly<RootConfig> {
    this.applyResult(result);
    return this.requireConfig();
  }

  /**
   * 用最近一次 init 时的参数重新加载。
   * 配合 `onChange` 监听,可以在配置文件改动后触发"软热重载"。
   *
   * @throws {ConfigError} 当从未调用过 init 时
   */
  reload(): Readonly<RootConfig> {
    if (!this.lastLoadOptions) {
      throw new ConfigError(
        "尚未通过 init 加载过配置,无法 reload",
        "CONFIG_RELOAD_BEFORE_INIT",
      );
    }
    return this.init(this.lastLoadOptions);
  }

  isInitialized(): boolean {
    return this.config !== undefined;
  }

  getRoot(): Readonly<RootConfig> {
    return this.requireConfig();
  }

  getApp(): Readonly<AppConfig> {
    return this.requireConfig().app;
  }

  getModel(): Readonly<ModelConfig> {
    return this.requireConfig().model;
  }

  getTools(): Readonly<ToolsConfig> {
    return this.requireConfig().tools;
  }

  getMemory(): Readonly<MemoryConfig> {
    return this.requireConfig().memory;
  }

  getRecommendation(): Readonly<RecommendationConfig> {
    return this.requireConfig().recommendation;
  }

  getSecurity(): Readonly<SecurityConfig> {
    return this.requireConfig().security;
  }

  /**
   * 拿到每个 section 实际加载的文件路径,用于诊断、日志、错误现场打印。
   */
  getSources(): Readonly<Record<ConfigSection, string>> {
    if (!this.sources) throw new NotInitializedError();
    return this.sources;
  }

  /** 实际生效的 configs 目录绝对路径,便于排查"加载到错误位置的配置"问题 */
  getConfigsDir(): string {
    if (!this.configsDir) throw new NotInitializedError();
    return this.configsDir;
  }

  /** 新版单文件配置路径；旧版 configsDir 兼容模式下返回 undefined。 */
  getConfigFile(): string | undefined {
    if (!this.config) throw new NotInitializedError();
    return this.configFile;
  }

  /** @deprecated .env 已迁移到用户级 config.yaml，始终返回 undefined。 */
  getEnvFile(): string | undefined {
    if (!this.config) throw new NotInitializedError();
    return this.envFile;
  }

  /**
   * 注册一个变更监听器,返回反注册函数。
   *
   * @example
   * ```ts
   * const off = registry.onChange((cfg) => log.info({ env: cfg.app.env }, "config reloaded"));
   * // 之后想取消监听时:
   * off();
   * ```
   */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireConfig(): RootConfig {
    if (!this.config) throw new NotInitializedError();
    return this.config;
  }

  private applyResult(result: LoadResult): void {
    this.config = deepFreeze(result.config);
    this.sources = { ...result.sources };
    this.configsDir = result.configsDir;
    this.configFile = result.configFile;
    this.envFile = result.envFile;
    for (const listener of this.listeners) {
      try {
        listener(this.config);
      } catch {
        // 监听器异常不影响其他监听器,也不影响主流程
      }
    }
  }
}

/** 进程内的全局单例。绝大多数代码使用 {@link initConfig} / {@link getConfig} 间接访问 */
const globalRegistry = new ConfigRegistry();

/**
 * 应用入口处调用一次。完成 yaml 读取 / env 替换 / schema 校验 / 深冻结。
 * 返回已冻结的 RootConfig 副本,后续可通过 {@link getConfig} 重复获取同一份。
 */
export function initConfig(options: ConfigLoaderOptions = {}): Readonly<RootConfig> {
  return globalRegistry.init(options);
}

/**
 * 全局只读访问入口。
 * @throws 当未先调用 {@link initConfig} 时抛出 NotInitializedError
 */
export function getConfig(): Readonly<RootConfig> {
  return globalRegistry.getRoot();
}

/**
 * 拿到全局单例 registry,用于注册 onChange / 触发 reload 等操作。
 */
export function getConfigRegistry(): ConfigRegistry {
  return globalRegistry;
}

/**
 * 递归 `Object.freeze`。
 *
 * 内置的 `Object.freeze` 是浅冻结,这里手动深入到所有嵌套对象/数组,
 * 确保业务代码无法通过 `cfg.app.http.port = 80` 之类的写法绕过只读保护。
 *
 * 注意:已经被冻结的对象不会重复处理(避免循环引用导致的栈溢出)。
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}
