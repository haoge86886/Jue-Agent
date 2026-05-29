import type { ContextBlock, MemoryQuery, MemoryRecord, MemoryScope } from "@jue/shared-types";
import { newId } from "@jue/utils";

import type { SubAgentMemoryProvider } from "./types.js";

export interface SubAgentMemorySource {
  recall?(query: MemoryQuery): Promise<MemoryRecord[]>;
  retrieve?(input: { text: string; scopes?: MemoryScope[]; workspaceRoot?: string; limit?: number; minScore?: number; subagentType?: string; minWeight?: number; minConfidence?: number }): Promise<{ memories: Array<{ record: MemoryRecord; score: number; reason: string; matchedTerms: string[]; requiresVerification: boolean; ageDays: number }> }>;
}

export interface ScopedSubAgentMemoryProviderOptions {
  memorySource: SubAgentMemorySource;
  fallback?: SubAgentMemoryProvider;
  workspaceRoot?: string;
  maxRecords?: number;
}

/**
 * 根据 SubAgent policy、任务目标和 sharing policy 选择最小必要长期记忆。
 * 默认不共享任何主记忆；只有 registration.defaultPolicy.allowedMemoryScopes 明确允许时才召回。
 */
export class ScopedSubAgentMemoryProvider implements SubAgentMemoryProvider {
  private readonly memorySource: SubAgentMemorySource;
  private readonly fallback: SubAgentMemoryProvider | undefined;
  private readonly workspaceRoot: string | undefined;
  private readonly maxRecords: number;

  constructor(options: ScopedSubAgentMemoryProviderOptions) {
    this.memorySource = options.memorySource;
    this.fallback = options.fallback;
    this.workspaceRoot = options.workspaceRoot;
    this.maxRecords = options.maxRecords ?? 4;
  }

  async loadForSubAgent(input: Parameters<SubAgentMemoryProvider["loadForSubAgent"]>[0]): Promise<{ records: MemoryRecord[]; blocks: ContextBlock[] }> {
    const fallback = await this.fallback?.loadForSubAgent(input);
    const policyScopes = input.registration.defaultPolicy?.allowedMemoryScopes ?? [];
    const allowedScopes = minimalScopesForSubAgent(input.registration.type, policyScopes);
    if (allowedScopes.length === 0) {
      return { records: fallback?.records ?? [], blocks: fallback?.blocks ?? [] };
    }
    const queryText = [input.task.title, input.task.input.goal, input.task.input.successCriteria.join(" "), input.task.input.constraints.join(" ")].join(" ");
    const retrieved = await this.retrieveMemories(queryText, input.registration.type, allowedScopes);
    const shared = retrieved
      .filter((item) => canShareWithSubAgent(item.record, input.registration.type))
      .slice(0, this.maxRecords);
    return {
      records: [...(fallback?.records ?? []), ...shared.map((item) => item.record)],
      blocks: [...(fallback?.blocks ?? []), ...shared.map((item) => recordToSharedMemoryBlock(item.record, input.registration.type, item))],
    };
  }

  async recordAfterRun(input: Parameters<NonNullable<SubAgentMemoryProvider["recordAfterRun"]>>[0]): Promise<void> {
    await this.fallback?.recordAfterRun?.(input);
  }

  private async retrieveMemories(queryText: string, subagentType: string, allowedScopes: MemoryScope[]): Promise<ScopedMemoryMatch[]> {
    if (this.memorySource.retrieve) {
      const result = await this.memorySource.retrieve({
        text: queryText,
        scopes: allowedScopes,
        limit: this.maxRecords * 2,
        minScore: 0.22,
        minWeight: 0.45,
        minConfidence: 0.55,
        subagentType,
        ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      });
      return result.memories.map((item) => ({
        record: item.record,
        score: item.score,
        reason: item.reason,
        matchedTerms: item.matchedTerms,
        requiresVerification: item.requiresVerification,
        ageDays: item.ageDays,
      }));
    }
    if (!this.memorySource.recall) return [];
    const records = await this.memorySource.recall({
      text: queryText,
      scopes: allowedScopes,
      kinds: [],
      tags: [],
      documentTypes: [],
      includeIndexOnly: false,
      status: "active",
      minWeight: 0.45,
      minConfidence: 0.55,
      limit: this.maxRecords * 2,
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
    });
    return records.map((record) => ({ record, score: Math.max(record.weight, record.confidence), reason: "fallback recall", matchedTerms: [], requiresVerification: false, ageDays: 0 }));
  }
}

interface ScopedMemoryMatch {
  record: MemoryRecord;
  score: number;
  reason: string;
  matchedTerms: string[];
  requiresVerification: boolean;
  ageDays: number;
}

function minimalScopesForSubAgent(type: string, policyScopes: MemoryScope[]): MemoryScope[] {
  const baseline: Record<string, MemoryScope[]> = {
    explorer: ["project"],
    verification: ["project"],
    plan: ["project", "global"],
    general: ["project", "global", "user"],
  };
  const desired = baseline[type] ?? policyScopes;
  const allowed = policyScopes.length > 0 ? desired.filter((scope) => policyScopes.includes(scope)) : desired;
  return Array.from(new Set(allowed.filter((scope) => scope !== "conversation" && scope !== "working")));
}

function canShareWithSubAgent(record: MemoryRecord, subagentType: string): boolean {
  if (record.sensitivity === "secret" || record.sensitivity === "private") return false;
  const sharing = record.sharing;
  if (!sharing) return true;
  if (!sharing.shareWithSubAgents) return false;
  return sharing.allowedSubAgentTypes.length === 0 || sharing.allowedSubAgentTypes.includes(subagentType);
}

function recordToSharedMemoryBlock(record: MemoryRecord, subagentType: string, match: ScopedMemoryMatch): ContextBlock {
  const verify = match.requiresVerification ? "\nVerification: this memory names code/files/versions; verify against current source before relying on it." : "";
  const content = [`[Shared memory for ${subagentType}]`, `${record.title}: ${record.summary ?? record.content}`, `Retrieval: score=${match.score.toFixed(3)}; ${match.reason}; ageDays=${match.ageDays}${verify}`].join("\n");
  return {
    id: newId("ctxb"),
    type: "subagent_memory",
    source: "memory",
    priority: 54,
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: Date.now(),
    expiresAt: record.expiresAt,
    relevance: Math.max(record.weight, record.confidence, match.score),
    pinned: false,
    compressible: true,
    compressionStrategy: "rule_extract",
    sensitivity: record.sensitivity,
    content,
    rawRef: { kind: "memory", id: record.id },
    tags: ["subagent_memory", "shared_memory", record.scope, record.kind],
    metadata: { scope: record.scope, sourceMemoryId: record.id, sharedWith: subagentType, retrievalScore: match.score, retrievalReason: match.reason, matchedTerms: match.matchedTerms, requiresVerification: match.requiresVerification, ageDays: match.ageDays },
  };
}

