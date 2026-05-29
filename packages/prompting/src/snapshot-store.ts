/**
 * @file snapshot-store.ts
 * @module @jue/prompting/snapshot-store
 *
 * Prompt 快照存储。当前实现是进程内 Map,但接口已经支持回放、摘要和诊断。
 */

import { newId } from "@jue/utils";
import type { Id } from "@jue/shared-types";
import type { BuiltPrompt, PromptSnapshotSummary } from "./types.js";

export interface SnapshotStore {
  save(snapshot: BuiltPrompt): void;
  load(snapshotId: Id): BuiltPrompt | undefined;
  list(): Id[];
  listSummaries?(): PromptSnapshotSummary[];
  latest?(): BuiltPrompt | undefined;
}

export interface InMemorySnapshotStoreOptions {
  maxEntries?: number;
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly maxEntries: number;
  private readonly store = new Map<Id, BuiltPrompt>();

  constructor(options: InMemorySnapshotStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
  }

  save(snapshot: BuiltPrompt): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(snapshot.snapshotId, snapshot);
  }

  load(snapshotId: Id): BuiltPrompt | undefined {
    return this.store.get(snapshotId);
  }

  list(): Id[] {
    return Array.from(this.store.keys());
  }

  listSummaries(): PromptSnapshotSummary[] {
    return Array.from(this.store.values()).map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      builtAt: snapshot.builtAt,
      totalChars: snapshot.text.length,
      segmentCount: snapshot.segments.length,
    }));
  }

  latest(): BuiltPrompt | undefined {
    const values = Array.from(this.store.values());
    return values.at(-1);
  }
}

export function newSnapshotId(): Id {
  return newId("snap");
}
