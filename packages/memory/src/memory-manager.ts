/**
 * @file memory-manager.ts
 * @module @jue/memory/memory-manager
 *
 * 记忆模块对外入口。长期记忆的生命周期是：产生候选 -> 提取/去重/安全检查 ->
 * 写入 Markdown 仓库 -> 按需召回 -> 周期整理和压缩。
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getModuleLogger } from "@jue/utils";
import type {
  MemoryExtractionInput,
  MemoryMaintenanceResult,
  MemoryQuery,
  MemoryDocument,
  MemoryRecord,
  MemoryWriteRequest,
} from "@jue/shared-types";
import type { DreamMemoryPruningContext } from "./dream-memory-service.js";
import { LlmDreamMemoryPruner, LlmDreamObservationPruner, type DreamMemoryPrunerRunner, type DreamObservationPrunerRunner, type MemoryLlmGateway } from "./llm-memory-agents.js";
import {
  workspacePathSlug,
  InMemoryMemoryRepository,
  type MemoryRepository,
} from "./repository.js";
import { NoopMemoryPipeline, type MemoryPipeline, type MemoryPipelineResult } from "./pipeline.js";
import { MemoryRetriever, type MemoryRetrievalInput, type MemoryRetrievalResult } from "./memory-retriever.js";
import { StyleObserver } from "./style-observer.js";

export interface MemoryManagerDebugEvent {
  type: "memory.recall" | "memory.write" | "memory.extract" | "memory.forget" | "memory.maintain" | "memory.prune" | "memory.observe";
  at: number;
  payload: Record<string, unknown>;
}

export interface MemoryDebugSnapshot {
  recentEvents: MemoryManagerDebugEvent[];
}

export interface MemoryManagerOptions {
  repository?: MemoryRepository;
  pipeline?: MemoryPipeline;
  llmGateway?: MemoryLlmGateway;
  prunerRunner?: DreamMemoryPrunerRunner;
  observationPrunerRunner?: DreamObservationPrunerRunner;
  extractionEveryTurns?: number;
}


interface MemoryPruningPolicy {
  mode: "user_conservative" | "global_guarded" | "project_active";
  allowLlmDelete: boolean;
  allowRuleDelete: boolean;
  allowMerge: boolean;
  requireSameScopeMerge: boolean;
}

interface ValidatedMergeGroup {
  keepName: string;
  removeNames: string[];
  reason: string;
  mergedDescription?: string;
  mergedBody?: string;
  tags?: string[];
}

function pruningPolicyFor(doc: MemoryDocument): MemoryPruningPolicy {
  if (doc.frontmatter.scope === "user" || doc.frontmatter.type === "user") {
    return {
      mode: "user_conservative",
      allowLlmDelete: false,
      allowRuleDelete: true,
      allowMerge: true,
      requireSameScopeMerge: true,
    };
  }
  if (doc.frontmatter.scope === "global" || doc.frontmatter.type === "global") {
    return {
      mode: "global_guarded",
      allowLlmDelete: false,
      allowRuleDelete: false,
      allowMerge: true,
      requireSameScopeMerge: true,
    };
  }
  return {
    mode: "project_active",
    allowLlmDelete: true,
    allowRuleDelete: true,
    allowMerge: true,
    requireSameScopeMerge: true,
  };
}

function validateLlmDelete(doc: MemoryDocument): { ok: boolean; reason?: string } {
  const policy = pruningPolicyFor(doc);
  if (!policy.allowLlmDelete) return { ok: false, reason: `${policy.mode} blocks direct LLM deletion` };
  if (doc.frontmatter.status === "active" && doc.frontmatter.weight >= 0.85) {
    return { ok: false, reason: "high-weight active memory requires explicit user deletion or rule-expiry" };
  }
  return { ok: true };
}

function validateRuleDelete(doc: MemoryDocument): { ok: boolean; reason?: string } {
  const policy = pruningPolicyFor(doc);
  if (!policy.allowRuleDelete) return { ok: false, reason: `${policy.mode} blocks rule deletion` };
  return { ok: true };
}

function validateMergeGroup(input: { docs: MemoryDocument[]; keepName: string; removeNames: string[]; reason: string; mergedDescription?: string; mergedBody?: string; tags?: string[] }): { ok: true; group: ValidatedMergeGroup } | { ok: false; reason: string } {
  const keep = input.docs.find((doc) => doc.frontmatter.name === input.keepName);
  if (!keep) return { ok: false, reason: `keep memory not found: ${input.keepName}` };
  const requestedRemoveNames = input.removeNames.filter((name) => name !== input.keepName);
  if (requestedRemoveNames.length === 0) return { ok: false, reason: `merge group must delete at least one duplicate target: ${input.keepName}` };

  const removeDocs: MemoryDocument[] = [];
  const missingRemoveNames: string[] = [];
  for (const name of requestedRemoveNames) {
    const doc = input.docs.find((item) => item.frontmatter.name === name);
    if (doc) removeDocs.push(doc);
    else missingRemoveNames.push(name);
  }
  if (missingRemoveNames.length > 0) return { ok: false, reason: `remove target not found: ${missingRemoveNames.join(", ")}` };
  if (removeDocs.length === 0) return { ok: false, reason: `merge group has no existing remove targets: ${input.keepName}` };

  const keepPolicy = pruningPolicyFor(keep);
  if (!keepPolicy.allowMerge) return { ok: false, reason: `${keepPolicy.mode} blocks merge` };
  for (const doc of removeDocs) {
    const removePolicy = pruningPolicyFor(doc);
    if (!removePolicy.allowMerge) return { ok: false, reason: `${removePolicy.mode} blocks merge for ${doc.frontmatter.name}` };
    if ((keepPolicy.requireSameScopeMerge || removePolicy.requireSameScopeMerge) && keep.frontmatter.scope !== doc.frontmatter.scope) {
      return { ok: false, reason: `cross-scope merge blocked: ${keep.frontmatter.scope} <- ${doc.frontmatter.scope}` };
    }
    if (keep.frontmatter.type !== doc.frontmatter.type) {
      return { ok: false, reason: `cross-type merge blocked: ${keep.frontmatter.type} <- ${doc.frontmatter.type}` };
    }
  }

  const compatibility = validateSemanticMergeCompatibility(keep, removeDocs);
  if (!compatibility.ok) return { ok: false, reason: compatibility.reason };

  const sourceText = sourceMemoryText([keep, ...removeDocs]);
  const safeMergedDescription = input.mergedDescription && preservesConcreteMemoryFacts(input.mergedDescription, sourceText) ? input.mergedDescription : undefined;
  const safeMergedBody = input.mergedBody && preservesConcreteMemoryFacts(input.mergedBody, sourceText) ? input.mergedBody : undefined;
  return {
    ok: true,
    group: {
      keepName: keep.frontmatter.name,
      removeNames: removeDocs.map((doc) => doc.frontmatter.name),
      reason: input.reason,
      ...(safeMergedDescription ? { mergedDescription: safeMergedDescription } : {}),
      ...(safeMergedBody ? { mergedBody: safeMergedBody } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    },
  };
}



interface MemorySemanticProfile {
  category: "identity" | "preference" | "dislike" | "ability" | "relationship" | "collaboration" | "goal" | "reference" | "project" | "global" | "other";
  keywords: string[];
}

function validateSemanticMergeCompatibility(keep: MemoryDocument, removeDocs: MemoryDocument[]): { ok: true } | { ok: false; reason: string } {
  const keepProfile = semanticProfileForMemory(keep);
  for (const doc of removeDocs) {
    const removeProfile = semanticProfileForMemory(doc);
    if (keepProfile.category !== removeProfile.category) {
      return { ok: false, reason: `semantic category mismatch: ${keep.frontmatter.name}=${keepProfile.category} <- ${doc.frontmatter.name}=${removeProfile.category}` };
    }
    if (!hasCompatibleMemoryKeywords(keepProfile, removeProfile)) {
      return { ok: false, reason: `semantic entity mismatch: ${keep.frontmatter.name} <- ${doc.frontmatter.name}` };
    }
  }
  return { ok: true };
}

function semanticProfileForMemory(doc: MemoryDocument): MemorySemanticProfile {
  const text = normalizeMemoryText(`${doc.frontmatter.description}\n${doc.body}\n${doc.frontmatter.tags.join(" ")}`);
  const category = classifyMemorySemanticCategory(doc, text);
  return { category, keywords: extractConcreteMemoryKeywords(text) };
}

function classifyMemorySemanticCategory(doc: MemoryDocument, text: string): MemorySemanticProfile["category"] {
  if (doc.frontmatter.type === "reference") return "reference";
  if (doc.frontmatter.type === "project") return "project";
  if (doc.frontmatter.type === "global") return "global";
  if (containsAsciiWord(text, ["reference", "dashboard", "linear", "slack", "url"])) return "reference";
  if (containsAny(text, IDENTITY_TERMS)) return "identity";
  if (containsAny(text, DISLIKE_TERMS)) return "dislike";
  if (containsAny(text, PREFERENCE_TERMS)) return "preference";
  if (containsAny(text, ABILITY_TERMS)) return "ability";
  if (containsAny(text, RELATIONSHIP_TERMS)) return "relationship";
  if (containsAny(text, COLLABORATION_TERMS)) return "collaboration";
  if (containsAny(text, GOAL_TERMS)) return "goal";
  return "other";
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function containsAsciiWord(text: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IDENTITY_TERMS = ["\u7537", "\u5973", "\u7537\u6027", "\u5973\u6027", "\u8eab\u4efd", "\u6211\u662f", "\u7528\u6237\u662f", "\u8bfb\u7814", "\u5b66\u751f", "\u5de5\u7a0b\u5e08", "\u5f00\u53d1\u8005", "\u5317\u65b9\u4eba", "\u5357\u65b9\u4eba"];
const PREFERENCE_TERMS = ["\u559c\u6b22", "\u504f\u597d", "\u7231\u597d", "\u6700\u7231", "\u949f\u7231", "\u4e2d\u610f", "preference", "prefer", "like", "love", "fan"];
const DISLIKE_TERMS = ["\u8ba8\u538c", "\u4e0d\u559c\u6b22", "\u6392\u65a5", "\u6297\u62d2", "\u53d7\u4e0d\u4e86", "\u5acc", "dislike", "hate"];
const ABILITY_TERMS = ["\u4f1a", "\u719f\u6089", "\u64c5\u957f", "\u7cbe\u901a", "\u4e0d\u61c2", "\u4e0d\u4f1a", "\u7ecf\u9a8c", "\u5c0f\u767d", "expert", "familiar"];
const RELATIONSHIP_TERMS = ["\u4f34\u4fa3", "\u5bf9\u8c61", "\u5973\u670b\u53cb", "\u7537\u670b\u53cb", "\u7236\u4eb2", "\u6bcd\u4eb2", "\u5ba4\u53cb", "\u540c\u4e8b", "\u8001\u677f", "\u5bfc\u5e08", "relationship"];
const COLLABORATION_TERMS = ["\u7b80\u6d01", "\u8be6\u7ec6", "\u522b\u5e9f\u8bdd", "\u7ed9\u7ed3\u8bba", "\u4e00\u6b65\u4e00\u6b65", "\u534f\u4f5c", "\u56de\u590d\u98ce\u683c", "style", "collaboration"];
const GOAL_TERMS = ["\u76ee\u6807", "\u8ba1\u5212", "\u51c6\u5907", "\u6253\u7b97", "\u8003\u7814", "\u8df3\u69fd", "\u8f6c\u884c", "goal", "plan"];

function hasCompatibleMemoryKeywords(left: MemorySemanticProfile, right: MemorySemanticProfile): boolean {
  if (left.category === "other") return keywordOverlapScore(left.keywords, right.keywords) >= 0.5;
  if (left.keywords.length === 0 || right.keywords.length === 0) return false;
  return keywordOverlapScore(left.keywords, right.keywords) > 0;
}

function keywordOverlapScore(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item) || [...rightSet].some((other) => item.includes(other) || other.includes(item))) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function sourceMemoryText(docs: MemoryDocument[]): string {
  return docs.map((doc) => `${doc.frontmatter.description}\n${doc.body}`).join("\n");
}

function preservesConcreteMemoryFacts(candidate: string, sourceText: string): boolean {
  const sourceKeywords = extractConcreteMemoryKeywords(sourceText);
  if (sourceKeywords.length === 0) return true;
  const normalizedCandidate = normalizeMemoryText(candidate);
  const preserved = sourceKeywords.filter((keyword) => normalizedCandidate.includes(keyword));
  return preserved.length >= Math.min(2, sourceKeywords.length);
}

function extractConcreteMemoryKeywords(text: string): string[] {
  const compact = text.replace(/[\[\](){}<>??"'????`*_#|:?,?.?!???;??]/g, " ");
  const raw = compact.match(/[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9_-]{1,}/gu) ?? [];
  const stop = new Set([
    "user", "memory", "preference", "preferences", "topic", "topics", "thing", "things",
    "??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "??",
    "??", "??", "??", "??", "??", "??", "??", "??", "??", "??",
  ]);
  return Array.from(new Set(raw
    .map((item) => normalizeMemoryText(item))
    .filter((item) => item.length >= 2 && !stop.has(item) && !/^\d+$/.test(item))))
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
}

function scopeModeLabel(doc: MemoryDocument): string {
  return pruningPolicyFor(doc).mode;
}
function isGenericMemoryDocument(doc: { frontmatter: { description: string }; body: string }): boolean {
  const description = normalizeMemoryText(doc.frontmatter.description);
  const body = normalizeMemoryText(doc.body);
  const combined = `${description}\n${body}`;
  // 规则维护只清理明确模板化、没有实体信息的垃圾记忆；主题判断和语义合并交给 DreamMemoryPruning。
  return GENERIC_MEMORY_PHRASES.some((phrase) => combined.includes(phrase));
}

function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const GENERIC_MEMORY_PHRASES = [
  "stable personal preference",
  "explicitly expressed liking",
  "用户明确表达",
  "稳定个人偏好",
  "某事物",
  "某个事物",
  "用户习惯或偏好某事物",
];

export class MemoryManager {
  private readonly logger = getModuleLogger("memory");
  private readonly repository: MemoryRepository;
  private readonly pipeline: MemoryPipeline;
  private readonly pruner: DreamMemoryPrunerRunner | undefined;
  private readonly observationPruner: DreamObservationPrunerRunner | undefined;
  private readonly retriever: MemoryRetriever;
  private readonly extractionEveryTurns: number;
  private turnSinceExtraction = 0;
  private readonly userMessageBuffer: Array<{ text: string; sessionId?: string; requestId?: string; userId?: string; workspaceRoot?: string }> = [];
  private readonly debugEvents: MemoryManagerDebugEvent[] = [];

  constructor(options: MemoryManagerOptions = {}) {
    this.repository = options.repository ?? new InMemoryMemoryRepository();
    this.pipeline = options.pipeline ?? new NoopMemoryPipeline();
    this.pruner = options.prunerRunner ?? (options.llmGateway ? new LlmDreamMemoryPruner(options.llmGateway) : undefined);
    this.observationPruner = options.observationPrunerRunner ?? (options.llmGateway ? new LlmDreamObservationPruner(options.llmGateway) : undefined);
    this.retriever = new MemoryRetriever(this.repository);
    this.extractionEveryTurns = Math.max(1, options.extractionEveryTurns ?? 8);
  }

  async recall(query: MemoryQuery): Promise<MemoryRecord[]> {
    const records = await this.repository.query(query);
    this.pushDebug({ type: "memory.recall", at: Date.now(), payload: { count: records.length, query } });
    this.logger.debug({ count: records.length, query }, "memory recall");
    return records;
  }


  async retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult> {
    const result = await this.retriever.retrieve(input);
    this.pushDebug({
      type: "memory.recall",
      at: Date.now(),
      payload: {
        query: result.query,
        count: result.memories.length,
        diagnostics: result.diagnostics,
        memories: result.memories.map((item) => ({
          id: item.record.id,
          scope: item.record.scope,
          title: item.record.title,
          score: Number(item.score.toFixed(3)),
          reason: item.reason,
          requiresVerification: item.requiresVerification,
        })),
      },
    });
    return result;
  }

  async write(req: MemoryWriteRequest): Promise<MemoryRecord[]> {
    const records = await this.repository.write(req);
    this.pushDebug({
      type: "memory.write",
      at: Date.now(),
      payload: {
        count: records.length,
        requestId: req.requestId,
        records: records.map((record) => ({ id: record.id, scope: record.scope, title: record.title, status: record.status })),
      },
    });
    this.logger.info({ count: records.length, requestId: req.requestId }, "memory write");
    return records;
  }

  submitForExtraction(kind: MemoryExtractionInput["kind"], payload: unknown, options: Partial<Omit<MemoryExtractionInput, "kind" | "payload">> = {}): void {
    this.pipeline.submit({ kind, payload, priority: options.priority ?? "normal", ...options });
  }

  async observeUserMessage(payload: { text: string; sessionId?: string; requestId?: string; userId?: string; workspaceRoot?: string; skipStrongSignalExtraction?: boolean; skipObservation?: boolean }): Promise<MemoryPipelineResult | undefined> {
    const text = payload.text.trim();
    if (!text) return undefined;
    this.userMessageBuffer.push(payload);
    if (this.userMessageBuffer.length > 200) this.userMessageBuffer.splice(0, this.userMessageBuffer.length - 200);
    const explicitMemory = !payload.skipStrongSignalExtraction && isExplicitMemorySignal(text);
    const input: MemoryExtractionInput = {
      kind: "message",
      payload: { text, source: explicitMemory ? "explicit_user_memory_signal" : "user_message_observation", ...(payload.skipStrongSignalExtraction ? { skipStrongSignalExtraction: true } : {}), ...(payload.skipObservation ? { skipObservation: true } : {}) },
      priority: explicitMemory ? "high" : "normal",
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.userId ? { userId: payload.userId } : {}),
      ...(payload.workspaceRoot ? { workspaceRoot: payload.workspaceRoot } : {}),
    };
    const result = await this.pipeline.process(input);
    this.turnSinceExtraction += 1;
    if (this.turnSinceExtraction >= this.extractionEveryTurns) {
      this.submitBufferedExtraction("periodic");
    }
    return result;
  }

  submitBufferedExtraction(reason: "periodic" | "exit" | "manual" = "manual"): boolean {
    if (this.userMessageBuffer.length === 0) return false;
    const batch = this.userMessageBuffer.splice(0, this.userMessageBuffer.length);
    this.turnSinceExtraction = 0;
    const last = batch.at(-1);
    const text = renderBufferedExtractionText(batch, this.readMemoryIndexes(last?.workspaceRoot));
    this.pipeline.submit({
      kind: "session_summary",
      payload: { text, source: `memory_${reason}_extraction`, userMessageCount: batch.length },
      priority: "low",
      ...(last?.requestId ? { requestId: last.requestId } : {}),
      ...(last?.sessionId ? { sessionId: last.sessionId } : {}),
      ...(last?.userId ? { userId: last.userId } : {}),
      ...(last?.workspaceRoot ? { workspaceRoot: last.workspaceRoot } : {}),
    });
    this.pushDebug({
      type: "memory.extract",
      at: Date.now(),
      payload: { queued: true, reason, userMessageCount: batch.length },
    });
    return true;
  }

  getObservationPromptHints(limit = 1): string[] {
    const repositoryAny = this.repository as unknown as { globalJueDir?: string };
    const globalJueDir = repositoryAny.globalJueDir;
    if (!globalJueDir) return [];
    const path = join(globalJueDir, "user", "memory", "style-observation-pool.json");
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { candidates?: Array<Record<string, unknown>> };
      const candidates = (parsed.candidates ?? [])
        .filter((item) => item.status === "candidate" && typeof item.candidate === "string")
        .filter((item) => typeof item.confidence === "number" && item.confidence > 0 && typeof item.occurrences === "number" && item.occurrences > 0);
      return shuffleObservationCandidates(candidates)
        .slice(0, limit)
        .map((item) => `可验证的用户假设: ${String(item.candidate)} (occurrences=${String(item.occurrences)}, confidence=${Number(item.confidence).toFixed(2)}). 只有当用户当前话题明显偏向这个主题、且没有明确不相干任务时，才可以自然确认；如果任务完全不相关，不要提起这条假设。`);
    } catch {
      return [];
    }
  }
  async extractNow(kind: MemoryExtractionInput["kind"], payload: unknown, options: Partial<Omit<MemoryExtractionInput, "kind" | "payload">> = {}): Promise<MemoryPipelineResult> {
    const input: MemoryExtractionInput = { kind, payload, priority: options.priority ?? "normal", ...options };
    const result = await this.pipeline.process(input);
    this.pushDebug({
      type: result.action === "forget" ? "memory.forget" : "memory.extract",
      at: Date.now(),
      payload: {
        action: result.action,
        text: result.text.slice(0, 240),
        written: result.written.map((record) => ({ id: record.id, scope: record.scope, title: record.title, status: record.status })),
        removed: result.removed,
        rejectedReasons: result.rejectedReasons,
      },
    });
    return result;
  }

  async flush(): Promise<void> {
    await this.pipeline.flush();
  }

  async forget(input: { idOrName: string; scope?: MemoryQuery["scope"]; workspaceRoot?: string }): Promise<boolean> {
    if (this.repository.removeByName) {
      const removed = await this.repository.removeByName({
        name: input.idOrName,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (removed) return true;
    }
    await this.repository.remove(input.idOrName);
    this.pushDebug({ type: "memory.forget", at: Date.now(), payload: { idOrName: input.idOrName, scope: input.scope } });
    return true;
  }

  pushMemoryDebug(event: MemoryManagerDebugEvent): void {
    this.pushDebug(event);
  }

  getDebugSnapshot(): MemoryDebugSnapshot {
    return { recentEvents: [...this.debugEvents] };
  }

  async maintain(context?: DreamMemoryPruningContext): Promise<MemoryMaintenanceResult> {
    const result: MemoryMaintenanceResult = { checked: 0, removed: 0, compacted: 0, rewrittenIndexes: 0, diagnostics: [] };
    if (!this.repository.listDocuments) return result;
    const docs = await this.repository.listDocuments({
      scopes: ["user", "global", "project"],
      kinds: [],
      tags: [],
      documentTypes: [],
      includeIndexOnly: false,
      limit: 200,
      ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    } as MemoryQuery);
    result.checked = docs.length;

    const touchedDirs = new Set<string>();
    const globalJueDirForObservations = this.getGlobalJueDir();
    const observationCandidates = globalJueDirForObservations
      ? new StyleObserver({ globalJueDir: globalJueDirForObservations }).listCandidates(160)
      : (context?.observationPool ?? []);

    // The observation pruner turns accumulated style observations into durable memory documents.
    // This keeps the short-lived observation pool small and prevents duplicate long-term records.
    if (this.observationPruner && observationCandidates.length > 0) {
      try {
        const observationPlan = await this.observationPruner.plan(observationCandidates, docs, context);
        if (!globalJueDirForObservations) {
          result.diagnostics.push("LLM observation maintenance skipped: globalJueDir unavailable.");
        } else {
          const observationResult = new StyleObserver({ globalJueDir: globalJueDirForObservations }).applyMaintenancePlan({
            mergeGroups: observationPlan.mergeGroups,
            archiveKeys: observationPlan.archiveKeys,
            rejectKeys: observationPlan.rejectKeys,
          });
          result.checked += observationResult.checked;
          result.removed += observationResult.removed;
          result.compacted += observationResult.merged;
          result.diagnostics.push(...observationResult.diagnostics, ...observationPlan.diagnostics);
          if (observationResult.archived > 0) result.diagnostics.push(`LLM archived ${observationResult.archived} observation candidates already covered by formal memory.`);
          if (observationResult.rejected > 0) result.diagnostics.push(`LLM rejected ${observationResult.rejected} contradicted observation candidates.`);
        }
      } catch (error) {
        result.diagnostics.push(`LLM DreamObservationPruning failed; observation pool kept unchanged: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.pruner && docs.length > 0) {
      try {
        const plan = await this.pruner.plan(docs, context);
        for (const name of plan.removeNames) {
          const matches = docs.filter((item) => item.frontmatter.name === name && existsSync(item.path));
          if (matches.length === 0) {
            result.diagnostics.push(`LLM prune skipped ${name}: memory not found.`);
            continue;
          }
          if (matches.length > 1) {
            result.diagnostics.push(`LLM prune skipped ${name}: ambiguous name across scopes.`);
            continue;
          }
          const doc = matches[0];
          if (!doc) continue;
          const validation = validateLlmDelete(doc);
          if (!validation.ok) {
            result.diagnostics.push(`LLM prune skipped ${name}: ${validation.reason}.`);
            continue;
          }
          rmSync(doc.path, { force: true });
          touchedDirs.add(dirname(doc.path));
          result.removed += 1;
          result.diagnostics.push(`LLM pruned ${name} under ${scopeModeLabel(doc)}.`);
        }
        for (const group of plan.mergeGroups) {
          const validation = validateMergeGroup({
            docs,
            keepName: group.keepName,
            removeNames: group.removeNames,
            reason: group.reason,
            ...(group.mergedDescription ? { mergedDescription: group.mergedDescription } : {}),
            ...(group.mergedBody ? { mergedBody: group.mergedBody } : {}),
            ...(group.tags ? { tags: group.tags } : {}),
          });
          if (!validation.ok) {
            result.diagnostics.push(`LLM merge skipped ${group.keepName}: ${validation.reason}.`);
            continue;
          }
          const merged = await this.mergeMemoryGroup({
            ...validation.group,
            ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
          });
          if (!merged) continue;
          result.removed += validation.group.removeNames.length;
          result.compacted += 1;
          result.diagnostics.push(`LLM merged ${validation.group.removeNames.join(", ")} into ${validation.group.keepName}: ${validation.group.reason}`);
        }
        result.diagnostics.push(...plan.diagnostics);
      } catch (error) {
        result.diagnostics.push(`LLM DreamMemoryPruning failed; fallback to rules: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const now = Date.now();
    const seenExactKeys = new Set<string>();
    const activeDocs = docs.filter((doc) => existsSync(doc.path));
    for (const doc of activeDocs) {
      if (isGenericMemoryDocument(doc)) {
        const validation = validateRuleDelete(doc);
        if (!validation.ok) {
          result.diagnostics.push(`Rule generic prune skipped ${doc.frontmatter.name}: ${validation.reason}.`);
          continue;
        }
        rmSync(doc.path, { force: true });
        touchedDirs.add(dirname(doc.path));
        result.removed += 1;
        result.diagnostics.push(`Rule removed generic memory ${doc.frontmatter.name} under ${scopeModeLabel(doc)}.`);
        continue;
      }

      if ((doc.frontmatter.expiresAt && doc.frontmatter.expiresAt <= now) || doc.body.trim().length === 0) {
        const validation = validateRuleDelete(doc);
        if (!validation.ok) {
          result.diagnostics.push(`Rule delete skipped ${doc.frontmatter.name}: ${validation.reason}.`);
          continue;
        }
        rmSync(doc.path, { force: true });
        touchedDirs.add(dirname(doc.path));
        result.removed += 1;
        result.diagnostics.push(`Rule removed expired or empty memory ${doc.frontmatter.name} under ${scopeModeLabel(doc)}.`);
        continue;
      }

      const exactKey = [
        doc.frontmatter.scope,
        doc.frontmatter.type,
        normalizeMemoryText(doc.frontmatter.description),
        normalizeMemoryText(doc.body),
      ].join("\u0000");
      if (seenExactKeys.has(exactKey)) {
        const validation = validateRuleDelete(doc);
        if (!validation.ok) {
          result.diagnostics.push(`Rule exact duplicate prune skipped ${doc.frontmatter.name}: ${validation.reason}.`);
          continue;
        }
        rmSync(doc.path, { force: true });
        touchedDirs.add(dirname(doc.path));
        result.removed += 1;
        result.compacted += 1;
        result.diagnostics.push(`Rule removed exact duplicate memory ${doc.frontmatter.name}; semantic merge is delegated to DreamMemoryPruning.`);
        continue;
      }
      seenExactKeys.add(exactKey);
    }

    if (this.repository.rewriteIndexes) {
      result.rewrittenIndexes += await this.repository.rewriteIndexes();
    } else {
      for (const dir of touchedDirs) {
        if (!existsSync(dir)) continue;
        const count = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile() && basename(name).toLowerCase().endsWith(".md")).length;
        if (count > 0) result.rewrittenIndexes += 1;
      }
    }
    this.pushDebug({ type: "memory.maintain", at: Date.now(), payload: result as unknown as Record<string, unknown> });
    return result;
  }


  private readMemoryIndexes(workspaceRoot?: string): string {
    const repositoryAny = this.repository as unknown as { globalJueDir?: string };
    const globalJueDir = repositoryAny.globalJueDir;
    if (!globalJueDir) return "";
    const paths = [
      join(globalJueDir, "user", "memory", "MEMORY.md"),
      join(globalJueDir, "global", "memory", "MEMORY.md"),
      ...(workspaceRoot ? [join(globalJueDir, "projects", workspacePathSlug(workspaceRoot), "memory", "MEMORY.md")] : []),
    ];
    return paths
      .map((path) => {
        try {
          if (!existsSync(path)) return "";
          return `## ${path}\n${readFileSync(path, "utf8").slice(0, 12_000)}`;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");
  }
  private async mergeMemoryGroup(input: { keepName: string; removeNames: string[]; reason?: string; mergedDescription?: string; mergedBody?: string; tags?: string[]; workspaceRoot?: string }): Promise<boolean> {
    if (!this.repository.mergeDocuments) return false;
    const merged = await this.repository.mergeDocuments(input);
    this.pushDebug({
      type: "memory.prune",
      at: Date.now(),
      payload: { action: "merge", merged, ...input },
    });
    return merged;
  }

  private getGlobalJueDir(): string | undefined {
    const repository = this.repository as unknown as { globalJueDir?: string };
    return repository.globalJueDir;
  }

  private pushDebug(event: MemoryManagerDebugEvent): void {
    this.debugEvents.push(event);
    if (this.debugEvents.length > 50) this.debugEvents.splice(0, this.debugEvents.length - 50);
  }
}

export function isExplicitMemorySignal(text: string): boolean {
  return /(?:\u8bb0\u4f4f|\u8bf7\u8bb0\u4f4f|\u5e2e\u6211\u8bb0\u4f4f|\u4ee5\u540e\u8bb0\u5f97|\u5fd8\u6389|\u5220\u9664\u8bb0\u5fc6|\u4e0d\u8981\u518d\u8bb0|remember(?: that)?|forget)/i.test(text);
}









function renderBufferedExtractionText(
  batch: Array<{ text: string; sessionId?: string; requestId?: string; userId?: string; workspaceRoot?: string }>,
  memoryIndexes: string,
): string {
  const messages = batch.map((item, index) => {
    const sid = item.sessionId ?? "unknown-session";
    return `${index + 1}. [session=${sid}] ${item.text}`;
  }).join("\n");
  return [
    "MemoryExtractorAgent background batch.",
    "Only inspect the user messages below and the existing MEMORY.md indexes.",
    "Extract stable user/global/project facts that are missing from the indexes. Do not duplicate indexed memories.",
    "Prefer no candidates when unsure.",
    "",
    "# User messages",
    messages,
    "",
    "# Existing MEMORY.md indexes",
    memoryIndexes || "(no index available)",
  ].join("\n");
}




function shuffleObservationCandidates<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j] as T;
    out[j] = tmp as T;
  }
  return out;
}
