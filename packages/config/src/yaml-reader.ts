/**
 * @file yaml-reader.ts
 * @module @jue/config/yaml-reader
 *
 * YAML 文件读取与解析,把 fs/yaml 的原生异常转换为 ConfigError 体系。
 *
 * 解析层选择:
 *   - 使用 `yaml` 包(eemeli/yaml)而不是 `js-yaml`
 *   - 开启 `merge: true` 以支持 YAML `<<:` 合并语法,便于多 yaml 之间共享片段
 *
 * 注意:
 *   - 顶层必须是对象,允许空文件(返回 `{}`)以便 yaml 占位但暂不填内容的场景
 *   - 不在此处做 schema 校验,只做"能不能读、能不能解析"两件事
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { ConfigFileNotFoundError, ConfigParseError } from "./errors.js";

export interface ReadYamlOptions {
  /**
   * 文件不存在时是否容忍。
   *   - false(默认):抛 {@link ConfigFileNotFoundError}
   *   - true        :返回 `undefined`,由调用方决定怎么兜底
   */
  optional?: boolean;
}

/**
 * 读取并解析 yaml 文件。
 *
 * @param filePath 相对/绝对路径都可,函数内部会 `resolve` 为绝对路径
 * @returns        解析后的原始 JS 对象/数组/原子值,可能为 `undefined`(仅当 optional)
 *
 * @throws {ConfigFileNotFoundError} 文件不存在且非 optional
 * @throws {ConfigParseError}        yaml 语法错误
 */
export function readYaml(
  filePath: string,
  options: ReadYamlOptions = {},
): unknown {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    if (options.optional) return undefined;
    throw new ConfigFileNotFoundError(abs);
  }
  const raw = readFileSync(abs, "utf-8");
  try {
    return YAML.parse(raw, { merge: true });
  } catch (err) {
    throw new ConfigParseError(abs, err);
  }
}

/**
 * 读取 yaml,并保证返回值一定是 `Record<string, unknown>`。
 *
 * 用法场景:每个 section 一份 yaml,即使该 section 完全没写也能拿到空对象,
 * 让后续的 schema 校验自动应用 default 值生成完整结构。
 *
 * @throws {ConfigParseError} 当 yaml 顶层既不是对象也不是 null/undefined 时
 */
export function readYamlOrEmpty(filePath: string): Record<string, unknown> {
  const v = readYaml(filePath, { optional: true });
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigParseError(filePath, new Error("yaml 顶层必须是对象"));
  }
  return v as Record<string, unknown>;
}
