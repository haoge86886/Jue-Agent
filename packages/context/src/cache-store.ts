/**
 * @file cache-store.ts
 * @module @jue/context/cache-store
 *
 * 上下文块缓存接口。
 *
 * 当前阶段只保留接口和 Noop 实现，方便未来接入持久化缓存；本次不实现真实缓存命中。
 */

import type { ContextBlock } from "@jue/shared-types";

export interface ContextCacheStore {
  get(cacheKey: string): ContextBlock | undefined;
  set(cacheKey: string, block: ContextBlock): void;
  invalidate(cacheKey: string): void;
}

/** 测试/降级用实现：永远不命中缓存。 */
export class NoopContextCacheStore implements ContextCacheStore {
  get(): undefined {
    return undefined;
  }
  set(): void {
    /* no-op */
  }
  invalidate(): void {
    /* no-op */
  }
}
