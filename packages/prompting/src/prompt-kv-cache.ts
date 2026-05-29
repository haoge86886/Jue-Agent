/**
 * @file prompt-kv-cache.ts
 * @module @jue/prompting/prompt-kv-cache
 *
 * Prompt KVCache 预留接口的内存实现。当前阶段不做模型侧 KV cache,
 * 但为静态 prompt 命中、诊断和未来持久化留下稳定协议。
 */

import { createHash } from "node:crypto";
import type { PromptKvCache, PromptKvCacheEntry } from "./types.js";

export class InMemoryPromptKvCache implements PromptKvCache {
  private readonly entries = new Map<string, PromptKvCacheEntry>();

  get(key: string): PromptKvCacheEntry | undefined {
    return this.entries.get(key);
  }

  set(entry: PromptKvCacheEntry): void {
    this.entries.set(entry.key, entry);
  }

  makeKey(parts: readonly string[]): string {
    return createHash("sha256").update(parts.join("\0")).digest("hex");
  }

  clear(): void {
    this.entries.clear();
  }
}
