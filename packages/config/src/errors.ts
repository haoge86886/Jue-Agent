/**
 * @file errors.ts
 * @module @jue/config/errors
 *
 * 配置子系统的错误体系。所有配置加载/校验过程中的可预期错误都派生自 {@link ConfigError},
 * 调用方可以通过 `instanceof ConfigError` 或 {@link isConfigError} 一次性兜底。
 *
 * 设计要点:
 *   - 每个错误带稳定 `code`,便于审计/监控按码聚合
 *   - `ConfigValidationError.issues` 给出精确路径(如 `model.profiles.0.modelName`),
 *     CLI/日志里直接展示给开发者最有用
 *   - `EnvMissingError.referencedAt` 标明在哪个 yaml 路径上首次引用了该变量,
 *     便于排查"为什么这里要 ENV"
 *
 * 实现注意:
 *   每个子类都把 `name` 写为 `override name: string = "Xxx"`,而不是
 *   `override readonly name = "Xxx"`。后者会让 TS 把字面量类型("Xxx")
 *   作为属性类型,与基类 `name: "ConfigError"` 不兼容,导致 TS2416。
 */

/**
 * 配置错误基类。
 *
 * @param message  人类可读的错误描述
 * @param code     稳定的业务错误码,默认 "CONFIG_ERROR"
 * @param details  附加上下文(校验问题列表、原始路径、原始 cause 等)
 */
export class ConfigError extends Error {
  override name: string = "ConfigError";
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "CONFIG_ERROR", details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * 配置文件不存在。
 * 当 `optional: false`(默认)且目标 yaml 不存在时抛出。
 */
export class ConfigFileNotFoundError extends ConfigError {
  override name: string = "ConfigFileNotFoundError";
  readonly path: string;

  constructor(path: string) {
    super(`配置文件不存在: ${path}`, "CONFIG_FILE_NOT_FOUND");
    this.path = path;
  }
}

/**
 * 配置目录不存在。
 *
 * 与 {@link ConfigFileNotFoundError} 区分:目录都不存在时,通常是路径定位本身出了问题
 * (CLI / API / Worker 的 cwd 不一致),应当尽早把这种"环境错配"显式报出来,
 * 而不是回退到空 yaml 让某个 schema 字段必填校验失败,后者错误信息会非常误导。
 */
export class ConfigDirectoryNotFoundError extends ConfigError {
  override name: string = "ConfigDirectoryNotFoundError";
  readonly path: string;
  readonly searchedFrom: string;

  constructor(path: string, searchedFrom: string) {
    super(
      `配置目录不存在: ${path} (基于 ${searchedFrom} 解析;` +
        `可通过 initConfig({ cwd, configsDir }) 或 JUE_CONFIGS_DIR 环境变量覆盖)`,
      "CONFIG_DIR_NOT_FOUND",
      { path, searchedFrom },
    );
    this.path = path;
    this.searchedFrom = searchedFrom;
  }
}

/**
 * 配置文件解析失败。
 * 通常是 yaml 语法错误或顶层不是对象时抛出。
 *
 * @param cause 原始解析异常,进入 `details` 字段保存
 */
export class ConfigParseError extends ConfigError {
  override name: string = "ConfigParseError";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`配置文件解析失败: ${path}`, "CONFIG_PARSE_ERROR", cause);
    this.path = path;
  }
}

/**
 * Schema 校验失败(Zod 拒绝)。
 * `issues` 由 ConfigLoader 把 Zod issues 转换而来,字段路径已扁平化为点号串。
 */
export class ConfigValidationError extends ConfigError {
  override name: string = "ConfigValidationError";
  readonly section: string;
  readonly issues: ConfigIssue[];

  constructor(section: string, issues: ConfigIssue[]) {
    super(
      `配置校验失败: ${section}\n` +
        issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n"),
      "CONFIG_VALIDATION_FAILED",
      { section, issues },
    );
    this.section = section;
    this.issues = issues;
  }
}

/**
 * 环境变量循环引用 / 嵌套深度超限。
 *
 * 触发场景:env 值里再次包含 `${OTHER}`,展开 OTHER 后还有占位符,如此递归。
 * 当达到 `maxDepth`(默认 8)仍未收敛时抛出此错误,而**不是**静默返回未解析的字符串。
 *
 * 之所以单独建一个错误类,而不是复用 `EnvMissingError`,是因为这两类错误的处理建议截然不同:
 *   - 缺失变量:在 `.env` 里补上即可
 *   - 循环引用:配置组合方式有问题,需要重构
 */
export class EnvCircularReferenceError extends ConfigError {
  override name: string = "EnvCircularReferenceError";
  readonly referencedAt: string;
  readonly lastResolved: string;
  readonly maxDepth: number;

  constructor(referencedAt: string, lastResolved: string, maxDepth: number) {
    super(
      `环境变量占位符递归深度超过 ${maxDepth},疑似循环引用 (位置: ${referencedAt}, 最后一次替换结果: "${lastResolved}")`,
      "ENV_CIRCULAR_REFERENCE",
      { referencedAt, lastResolved, maxDepth },
    );
    this.referencedAt = referencedAt;
    this.lastResolved = lastResolved;
    this.maxDepth = maxDepth;
  }
}

/**
 * 环境变量缺失。
 *
 * 只有在以下情形抛出:
 *   1. `${VAR}`  无默认值且 env 中无值
 *   2. `${VAR:?msg}`  显式必需,缺失时携带自定义 msg
 *
 * `${VAR:-default}` 永不抛错,会回退到默认值。
 */
export class EnvMissingError extends ConfigError {
  override name: string = "EnvMissingError";
  readonly variable: string;
  readonly referencedAt: string | undefined;

  constructor(variable: string, referencedAt?: string) {
    const where = referencedAt ? ` (引用位置: ${referencedAt})` : "";
    super(
      `必需的环境变量缺失: ${variable}${where}`,
      "ENV_MISSING",
      { variable, referencedAt },
    );
    this.variable = variable;
    this.referencedAt = referencedAt;
  }
}

/**
 * 单条配置校验问题。从 Zod issue 转换而来。
 *
 * `path` 用点号串表达嵌套路径,顶层为 `<root>`。
 */
export interface ConfigIssue {
  path: string;
  message: string;
  code?: string;
}

/**
 * 是否为本子系统抛出的错误。便于上层在 `try/catch` 中区分"配置问题"与其他异常。
 */
export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError;
}
