/**
 * @file env-resolver.ts
 * @module @jue/config/env-resolver
 *
 * 把 yaml 解析出来的对象树里的 `${VAR}` 占位符替换为环境变量值。
 *
 * 支持三种语法:
 *   - `${VAR}`                  : 必需。env 中没有则抛 {@link EnvMissingError}
 *   - `${VAR:-default}`         : 可选。env 中没有则使用 `default`
 *   - `${VAR:?missing message}` : 显式必需,缺失时附带自定义 message
 *
 * 设计要点:
 *   1. 在 schema 校验**之前**完成,这样校验能针对最终值做判断(例如 url 校验)
 *   2. 递归遍历 object/array,字符串才做替换;number/boolean/null 原样返回
 *   3. 同一字符串里允许多个占位符,允许部分必需 + 部分可选混排
 *   4. 替换后允许再次扫描(通过 `maxDepth` 限制),避免值里嵌套占位符导致死循环
 *   5. 缺失变量的报错信息一定要带"在哪个 yaml 路径上首次引用",
 *      否则面对几百行 yaml 完全没法 debug
 */

import { EnvCircularReferenceError, EnvMissingError } from "./errors.js";

export interface EnvResolverOptions {
  /**
   * 环境变量来源,默认 `process.env`。
   * 测试时可以传一个普通对象,完全脱离进程环境。
   */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;

  /**
   * 是否允许使用 `${VAR:-default}` 语法。默认 true。
   */
  allowDefault?: boolean;

  /**
   * 是否允许使用 `${VAR:?error message}` 语法。默认 true。
   */
  allowRequired?: boolean;

  /**
   * 最大递归深度。
   *
   * 一个字符串里替换一轮后再次扫描,如果发现还有占位符,最多再扫 `maxDepth - 1` 次。
   * 防止 env 值里再写 `${OTHER}` 导致无限循环。默认 8。
   */
  maxDepth?: number;
}

const DEFAULT_OPTIONS: Required<Omit<EnvResolverOptions, "env">> = {
  allowDefault: true,
  allowRequired: true,
  maxDepth: 8,
};

/**
 * 占位符匹配模式:
 *   `\$\{NAME(:-default|:?required)?\}`
 *
 * 三个分组:
 *   1. 变量名(必填)
 *   2. `:-` 后的默认值(可选)
 *   3. `:?` 后的报错消息(可选)
 */
const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*)|:\?([^}]*))?\}/g;

interface ResolveContext {
  env: Record<string, string | undefined>;
  options: Required<Omit<EnvResolverOptions, "env">>;
  pathStack: string[];
}

/**
 * 递归替换对象树中所有字符串里的环境变量占位符。
 *
 * 顶层也可以是任意类型(对象/数组/字符串/原子值),返回值类型与输入保持一致。
 *
 * @example
 * ```ts
 * const yaml = { db: { url: "postgres://${DB_HOST:-localhost}:5432/app" } };
 * const resolved = resolveEnv(yaml, { env: { DB_HOST: "db.prod" } });
 * // resolved.db.url === "postgres://db.prod:5432/app"
 * ```
 *
 * @throws {EnvMissingError} 当遇到 `${VAR}` 或 `${VAR:?msg}` 但环境变量缺失时
 */
export function resolveEnv<T>(value: T, options: EnvResolverOptions = {}): T {
  const ctx: ResolveContext = {
    env: (options.env ?? process.env) as Record<string, string | undefined>,
    options: { ...DEFAULT_OPTIONS, ...options },
    pathStack: [],
  };
  return walk(value, ctx) as T;
}

/**
 * 深度优先遍历,只替换字符串叶子节点。
 *
 * 用 `pathStack` 记录当前路径,叶子节点报错时能给出 yaml 中的精确位置。
 */
function walk(value: unknown, ctx: ResolveContext): unknown {
  if (typeof value === "string") {
    return resolveString(value, ctx, ctx.pathStack.join(".") || "<root>");
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      ctx.pathStack.push(String(idx));
      try {
        return walk(item, ctx);
      } finally {
        ctx.pathStack.pop();
      }
    });
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      ctx.pathStack.push(k);
      try {
        out[k] = walk(v, ctx);
      } finally {
        ctx.pathStack.pop();
      }
    }
    return out;
  }
  return value;
}

/**
 * 单个字符串的占位符替换。
 *
 * 多次扫描的原因:env 值里可能再写占位符,
 * 比如 `BASE_URL=https://${API_HOST}/api`。
 * `maxDepth` 提供一个硬上限,超过后抛 {@link EnvCircularReferenceError},
 * **不会**静默返回未解析字符串(否则配置错误会被悄悄带到运行时)。
 *
 * 替换规则:
 *   - 命中且 env 有值(非空字符串)→ 替换
 *   - 命中但 env 无值,且写了 `:-default` → 用默认值
 *   - 命中但 env 无值,且写了 `:?msg`     → 抛 EnvMissingError 带 msg
 *   - 命中但 env 无值,且没写默认/必需   → 抛 EnvMissingError(纯必需)
 */
function resolveString(input: string, ctx: ResolveContext, location: string): string {
  // 没有占位符的字符串走快路径,避免无谓的 RegExp.exec
  if (!input.includes("${")) return input;

  let current = input;
  for (let depth = 0; depth < ctx.options.maxDepth; depth++) {
    const next = current.replace(
      PATTERN,
      (raw: string, name: string, defaultPart?: string, requiredPart?: string) => {
        const v = ctx.env[name];
        if (v !== undefined && v !== "") return v;
        if (defaultPart !== undefined && ctx.options.allowDefault) {
          return defaultPart;
        }
        if (requiredPart !== undefined && ctx.options.allowRequired) {
          throw new EnvMissingError(name, `${location}: ${requiredPart.trim()}`);
        }
        if (defaultPart === undefined && requiredPart === undefined) {
          throw new EnvMissingError(name, location);
        }
        return raw;
      },
    );
    if (next === current) {
      // 收敛:本轮没有任何替换发生,要么已无占位符,要么剩下的占位符都是无法替换的
      // 后者只会出现在 allowDefault/allowRequired 都为 false 的禁用场景下,直接返回即可
      return next;
    }
    current = next;
  }

  // 达到 maxDepth 仍未收敛:大概率是循环引用(VAR_A=${VAR_B}, VAR_B=${VAR_A})
  // 不能静默返回带占位符的字符串,否则错误会被带到运行时
  throw new EnvCircularReferenceError(location, current, ctx.options.maxDepth);
}
