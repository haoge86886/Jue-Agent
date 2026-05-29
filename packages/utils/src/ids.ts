/**
 * @file ids.ts
 * @module @jue/utils/ids
 *
 * 简单的 id 生成器。当前阶段不引入额外依赖,直接用 `crypto.randomUUID()`
 * 加业务前缀。后续如需切到雪花 id / KSUID,只改本文件即可。
 */

import { randomUUID } from "node:crypto";

/**
 * 生成带前缀的 id。例:`newId("sess")` → `sess_5e6b...`
 *
 * 前缀长度无强制要求,推荐 3-6 字符,语义清晰即可:
 *   sess / req / msg / call / mem / ctx / sub / audit
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** 生成 id 的工厂函数,适合 DI/测试时被替换 */
export type IdFactory = (prefix: string) => string;
export const defaultIdFactory: IdFactory = newId;
