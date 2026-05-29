import type { ContextBlock, ContextBlockType, Id, Timestamp } from "@jue/shared-types";
import { defaultTokenEstimator, newId } from "@jue/utils";

/**
 * ToolResultStore 保存工具和 shell 输出的原文/摘要双态数据。
 * ContextManager 只从这里拿 ContextBlock；未来替换为持久化实现时接口保持不变。
 */

export type StoredToolResultKind = "tool" | "shell";

export interface StoreToolResultInput {
  kind: StoredToolResultKind;
  toolName: string;
  content: string;
  sessionId?: Id;
  requestId?: Id;
  callId?: Id;
  summary?: string;
  summaryRef?: Id;
  relevance?: number;
  createdAt?: Timestamp;
  lastReferencedAt?: Timestamp;
  metadata?: Record<string, unknown>;
}

export interface ToolResultQuery {
  kind?: StoredToolResultKind;
  limit?: number;
  minRelevance?: number;
  before?: Timestamp;
  after?: Timestamp;
  includeRawCleared?: boolean;
  orderBy?: "createdAt" | "relevance";
  direction?: "asc" | "desc";
}

export interface ToolResultRecord {
  id: Id;
  kind: StoredToolResultKind;
  toolName: string;
  content: string;
  tokenEstimate: number;
  summary?: string;
  summaryRef?: Id;
  rawCleared: boolean;
  relevance: number;
  createdAt: Timestamp;
  lastReferencedAt?: Timestamp;
  sessionId?: Id;
  requestId?: Id;
  callId?: Id;
  metadata?: Record<string, unknown>;
}

export interface ToolResultStore {
  add(input: StoreToolResultInput): ToolResultRecord;
  get(id: Id): ToolResultRecord | undefined;
  query(query?: ToolResultQuery): ToolResultRecord[];
  setSummary(id: Id, summary: string, summaryRef?: Id): ToolResultRecord | undefined;
  clearRawContent(id: Id): ToolResultRecord | undefined;
  toContextBlocks(query?: ToolResultQuery): ContextBlock[];
}

export class InMemoryToolResultStore implements ToolResultStore {
  private readonly records = new Map<Id, ToolResultRecord>();
  private readonly estimateTokens: (text: string) => number;

  constructor(options: { estimateTokens?: (text: string) => number } = {}) {
    this.estimateTokens = options.estimateTokens ?? ((text) => defaultTokenEstimator.estimate(text));
  }

  add(input: StoreToolResultInput): ToolResultRecord {
    const now = input.createdAt ?? Date.now();
    const record: ToolResultRecord = {
      id: newId(input.kind === "shell" ? "shell" : "tres"),
      kind: input.kind,
      toolName: input.toolName,
      content: input.content,
      tokenEstimate: this.estimateTokens(input.content),
      rawCleared: false,
      relevance: clampRelevance(input.relevance ?? 0.5),
      createdAt: now,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.summaryRef ? { summaryRef: input.summaryRef } : {}),
      ...(input.lastReferencedAt ? { lastReferencedAt: input.lastReferencedAt } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: Id): ToolResultRecord | undefined {
    return this.records.get(id);
  }

  /** 按时间或相关性查询，供 ContextManager 选择本轮要注入的历史工具结果。 */
  query(query: ToolResultQuery = {}): ToolResultRecord[] {
    const includeRawCleared = query.includeRawCleared === true;
    let records = Array.from(this.records.values()).filter((record) => {
      if (query.kind && record.kind !== query.kind) return false;
      if (!includeRawCleared && record.rawCleared) return false;
      if (query.minRelevance !== undefined && record.relevance < query.minRelevance) return false;
      if (query.before !== undefined && record.createdAt >= query.before) return false;
      if (query.after !== undefined && record.createdAt <= query.after) return false;
      return true;
    });
    const orderBy = query.orderBy ?? "createdAt";
    const direction = query.direction ?? "desc";
    records = records.sort((left, right) => {
      const diff = orderBy === "relevance"
        ? left.relevance - right.relevance
        : left.createdAt - right.createdAt;
      return direction === "asc" ? diff : -diff;
    });
    return records.slice(0, query.limit ?? records.length);
  }

  setSummary(id: Id, summary: string, summaryRef: Id = newId("sum")): ToolResultRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const next: ToolResultRecord = { ...record, summary, summaryRef };
    this.records.set(id, next);
    return next;
  }

  /** 原文被压缩后可清除，只保留摘要，避免大块工具输出长期占用上下文预算。 */
  clearRawContent(id: Id): ToolResultRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const fallback = record.summary ?? "[raw content cleared]";
    const next: ToolResultRecord = {
      ...record,
      content: fallback,
      tokenEstimate: this.estimateTokens(fallback),
      rawCleared: true,
    };
    this.records.set(id, next);
    return next;
  }

  /** 将存储记录转换为 ContextBlock，后续统一交给 Budgeter/Compressor 处理。 */
  toContextBlocks(query: ToolResultQuery = {}): ContextBlock[] {
    return this.query(query).map((record) => toolResultToBlock(record));
  }
}

function toolResultToBlock(record: ToolResultRecord): ContextBlock {
  const type: ContextBlockType = record.kind === "shell" ? "shell_history" : "tool_result_history";
  return {
    id: newId("ctxb"),
    type,
    source: "tool_result",
    priority: record.kind === "shell" ? 35 : 60,
    tokenEstimate: record.tokenEstimate,
    createdAt: record.createdAt,
    ...(record.lastReferencedAt ? { lastReferencedAt: record.lastReferencedAt } : {}),
    compressible: true,
    compressionStrategy: "rule_extract",
    relevance: record.relevance,
    pinned: false,
    sensitivity: "internal",
    content: record.content,
    summaryRef: record.summaryRef,
    rawRef: { kind: "tool_result", id: record.id },
    tags: [record.kind, record.toolName],
    metadata: {
      toolName: record.toolName,
      rawCleared: record.rawCleared,
      renderOrder: record.createdAt,
      sourceOrder: record.createdAt,
      decayPerTurn: record.kind === "shell" ? 0.08 : 0.05,
      ...(record.summary ? { summary: record.summary } : {}),
    },
  };
}

function clampRelevance(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
