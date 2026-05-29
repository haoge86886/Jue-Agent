/**
 * @file pipeline.ts
 * @module @jue/memory/pipeline
 *
 * 寮傛璁板繂绠＄嚎銆備富鍥炲瀹屾垚鍚庡彧鎶婂師濮嬫潗鏂欐彁浜ゅ埌闃熷垪锛岀湡姝ｇ殑鎻愬彇銆佸幓閲嶃€佹晱鎰熷害
 * 妫€鏌ュ拰鍐欏叆鍦ㄥ悗鍙版墽琛屻€傚綋鍓嶅疄鐜伴噰鐢ㄤ繚瀹堣鍒欐彁鍙栵細鍙湁鏄惧紡鈥滆浣?蹇樻帀鈥濅俊鍙?
 * 鎴栨槑鏄惧亸濂藉彞寮忔墠浼氳惤鐩橈紝閬垮厤鎶婁换鍔℃€佸拰鍙粠浠ｇ爜鎺ㄥ鐨勪俊鎭薄鏌撻暱鏈熻蹇嗐€?
 */

import type { MemoryExtractionInput, MemoryRecord, MemoryWriteRequest } from "@jue/shared-types";
import { newId } from "@jue/utils";
import type { MemoryRepository } from "./repository.js";
import { LlmMemoryExtractor, llmCandidateToRecord, type MemoryExtractorRunner, type MemoryLlmGateway } from "./llm-memory-agents.js";
import { StyleObserver } from "./style-observer.js";

export interface MemoryPipelineResult {
  input: MemoryExtractionInput;
  action: "none" | "write" | "forget";
  text: string;
  candidates: Array<Partial<MemoryRecord>>;
  written: MemoryRecord[];
  removed: number;
  rejectedReasons: string[];
}

export interface MemoryPipeline {
  submit(input: MemoryExtractionInput): void;
  process(input: MemoryExtractionInput): Promise<MemoryPipelineResult>;
  flush(): Promise<void>;
}

export interface AsyncMemoryPipelineOptions {
  repository: MemoryRepository;
  defaultUserId?: string;
  maxQueueSize?: number;
  llmGateway?: MemoryLlmGateway;
  extractorRunner?: MemoryExtractorRunner;
  debugSink?: MemoryDebugSink;
  globalJueDir?: string;
}

export interface MemoryDebugSink {
  pushMemoryDebug(event: MemoryDebugEvent): void;
}

export interface MemoryDebugEvent {
  type: "memory.extract" | "memory.forget" | "memory.observe";
  at: number;
  payload: Record<string, unknown>;
}

export class NoopMemoryPipeline implements MemoryPipeline {
  submit(): void {
    /* no-op */
  }

  async process(input: MemoryExtractionInput): Promise<MemoryPipelineResult> {
    return emptyPipelineResult(input, extractText(input.payload));
  }

  async flush(): Promise<void> {
    /* no-op */
  }
}

export class AsyncMemoryPipeline implements MemoryPipeline {
  private readonly repository: MemoryRepository;
  private readonly defaultUserId: string;
  private readonly maxQueueSize: number;
  private readonly queue: MemoryExtractionInput[] = [];
  private readonly extractor: MemoryExtractorRunner | undefined;
  private readonly debugSink: MemoryDebugSink | undefined;
  private readonly styleObserver: StyleObserver | undefined;
  private draining = false;

  constructor(options: AsyncMemoryPipelineOptions) {
    this.repository = options.repository;
    this.defaultUserId = options.defaultUserId ?? "local-user";
    this.maxQueueSize = options.maxQueueSize ?? 200;
    this.extractor = options.extractorRunner ?? (options.llmGateway ? new LlmMemoryExtractor(options.llmGateway) : undefined);
    this.debugSink = options.debugSink;
    this.styleObserver = options.globalJueDir ? new StyleObserver({ globalJueDir: options.globalJueDir }) : undefined;
  }

  submit(input: MemoryExtractionInput): void {
    if (this.queue.length >= this.maxQueueSize) this.queue.shift();
    this.queue.push(input);
    queueMicrotask(() => {
      void this.drain();
    });
  }

  async flush(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        await this.process(item);
      }
    } finally {
      this.draining = false;
    }
  }

  async process(input: MemoryExtractionInput): Promise<MemoryPipelineResult> {
    const text = extractText(input.payload);
    if (!text.trim()) return emptyPipelineResult(input, text);

    const forget = detectForget(text);
    if (forget) {
      const removed = await this.removeMatching(forget, input);
      const result: MemoryPipelineResult = { ...emptyPipelineResult(input, text), action: "forget", removed };
      this.debugSink?.pushMemoryDebug({
        type: "memory.forget",
        at: Date.now(),
        payload: { sessionId: input.sessionId, needle: forget, removed },
      });
      return result;
    }

    const skipStrongSignalExtraction = isSkipStrongSignalExtraction(input);
    const strongSignal = skipStrongSignalExtraction ? undefined : classifyStrongMemorySignal(text, input);
    if (strongSignal) {
      const extractedCandidates = await this.extractWithLlmOrRules(text, input);
      return this.writeCandidates(input, text, extractedCandidates, "strong_signal");
    }

    const skipObservation = isSkipObservation(input);
    const styleObservation = input.kind === "message" && !skipObservation ? this.styleObserver?.observe(text, input) : undefined;
    if (styleObservation && (styleObservation.observed.length > 0 || styleObservation.rejected.length > 0)) {
      this.debugSink?.pushMemoryDebug({
        type: "memory.observe",
        at: Date.now(),
        payload: {
          sessionId: input.sessionId,
          observedCount: styleObservation.observed.length,
          promotedCount: styleObservation.promotedCandidates.length,
          rejected: styleObservation.rejected,
          hints: styleObservation.promptHints,
          observed: styleObservation.observed.map((item) => ({ candidate: item.candidate, occurrences: item.occurrences, confidence: Number(item.confidence.toFixed(3)), status: item.status })),
        },
      });
    }

    const shouldRunExtractor = input.kind !== "message" || input.priority === "low";
    const extractedCandidates = shouldRunExtractor ? await this.extractWithLlmOrRules(text, input) : [];
    return this.writeCandidates(input, text, [...extractedCandidates, ...(styleObservation?.promotedCandidates ?? [])], "weak_signal");
  }

  private async writeCandidates(input: MemoryExtractionInput, text: string, rawCandidates: Array<Partial<MemoryRecord>>, reason: "strong_signal" | "weak_signal"): Promise<MemoryPipelineResult> {
    const candidates = rawCandidates.map(normalizeMemoryCandidateCategory);
    if (candidates.length === 0) return { ...emptyPipelineResult(input, text), rejectedReasons: ["no candidates"] };
    const request: MemoryWriteRequest = {
      requestId: input.requestId ?? newId("memreq"),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      source: reason === "strong_signal" || input.priority === "high" ? "explicit_user" : "auto_extracted",
      records: candidates,
    };
    const written = await this.repository.write(request);
    const promotedObservationKeys = observationKeysFromWrittenRecords(written);
    if (promotedObservationKeys.length > 0) {
      const cleanup = this.styleObserver?.removePromotedKeys(promotedObservationKeys);
      if (cleanup && (cleanup.removed > 0 || cleanup.diagnostics.length > 0)) {
        this.debugSink?.pushMemoryDebug({
          type: "memory.observe",
          at: Date.now(),
          payload: {
            sessionId: input.sessionId,
            action: "remove_promoted_observations",
            keys: promotedObservationKeys,
            removed: cleanup.removed,
            diagnostics: cleanup.diagnostics,
          },
        });
      }
    }
    this.debugSink?.pushMemoryDebug({
      type: "memory.extract",
      at: Date.now(),
      payload: {
        sessionId: input.sessionId,
        sourceKind: input.kind,
        priority: input.priority,
        reason,
        candidateCount: candidates.length,
        writtenCount: written.length,
        written: written.map((record) => ({ id: record.id, scope: record.scope, title: record.title, status: record.status })),
      },
    });
    return { input, action: "write", text, candidates, written, removed: 0, rejectedReasons: [] };
  }

  private async extractWithLlmOrRules(text: string, input: MemoryExtractionInput): Promise<Array<Partial<MemoryRecord>>> {
    if (this.extractor) {
      try {
        const output = await this.extractor.extract(input, text);
        const records = output.candidates.map((candidate) => llmCandidateToRecord(candidate, input));
        if (records.length > 0 || output.rejectedReasons.length > 0) {
          this.debugSink?.pushMemoryDebug({
            type: "memory.extract",
            at: Date.now(),
            payload: {
              sessionId: input.sessionId,
              sourceKind: input.kind,
              runner: "llm",
              candidateCount: records.length,
              rejectedReasons: output.rejectedReasons,
            },
          });
        }
        if (records.length > 0) return records;
      } catch (error) {
        this.debugSink?.pushMemoryDebug({
          type: "memory.extract",
          at: Date.now(),
          payload: { sessionId: input.sessionId, runner: "llm", error: error instanceof Error ? error.message : String(error), fallback: "rules" },
        });
      }
    }
    const records = extractCandidates(text, input);
    if (records.length > 0) {
      this.debugSink?.pushMemoryDebug({
        type: "memory.extract",
        at: Date.now(),
        payload: { sessionId: input.sessionId, sourceKind: input.kind, runner: "rules", candidateCount: records.length },
      });
    }
    return records;
  }

  private async removeMatching(needle: string, input: MemoryExtractionInput): Promise<number> {
    if (this.repository.removeByName) {
      const removed = await this.repository.removeByName({
        name: needle,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (removed) return 1;
    }
    const hits = await this.repository.query({
      text: needle,
      scopes: ["user", "global", "project"],
      kinds: [],
      tags: [],
      documentTypes: [],
      includeIndexOnly: false,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      limit: 20,
    });
    for (const hit of hits) await this.repository.remove(hit.id);
    return hits.length;
  }
}

function emptyPipelineResult(input: MemoryExtractionInput, text: string): MemoryPipelineResult {
  return { input, action: "none", text, candidates: [], written: [], removed: 0, rejectedReasons: [] };
}

function extractCandidates(text: string, input: MemoryExtractionInput): Array<Partial<MemoryRecord>> {
  if (input.priority === "high") return [explicitCandidate(text, input)];
  const explicit = detectRemember(text);
  if (explicit) return [explicitCandidate(explicit, { ...input, priority: "high" })];

  const automatic = [
    autoUserProfileCandidate(text, input),
    autoUserHabitCandidate(text, input),
    autoUserCatchphraseCandidate(text, input),
  ].filter((candidate): candidate is Partial<MemoryRecord> => Boolean(candidate));
  return automatic.slice(0, 3);
}

function autoUserProfileCandidate(text: string, input: MemoryExtractionInput): Partial<MemoryRecord> | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/(?:^|\s)(?:\u6211|\u672c\u4eba)(?:\u662f|\u6765\u81ea|\u51fa\u8eab\u4e8e|\u751f\u5728|\u957f\u5728|\u5e38\u4f4f|\u76ee\u524d\u5728)\s*([^\r\n]{2,40})/i);
  if (!match?.[1]) return undefined;
  const value = cleanAutoMemoryValue(match[1], 40);
  if (!value) return undefined;
  const content = `\u7528\u6237\u81ea\u6211\u63cf\u8ff0\u4e3a${value}`;
  if (looksForbidden(content) || isExternalKnowledgeClaim(compact) || looksLikeTaskOrProjectState(compact)) return undefined;
  return autoUserCandidate({
    input,
    content,
    kind: "fact",
    tags: ["auto", "user-profile", "profile"],
    weight: 0.58,
    confidence: 0.72,
  });
}

function autoUserHabitCandidate(text: string, input: MemoryExtractionInput): Partial<MemoryRecord> | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/(?:\u6211|\u7528\u6237)(?:\u4e60\u60ef|\u901a\u5e38|\u4e00\u822c|\u5e38\u5e38|\u7ecf\u5e38|\u559c\u6b22|\u504f\u597d|\u7231\u7528|\u5e38\u7528|\u503e\u5411|\u66f4\u559c\u6b22)\s*([^\r\n]{3,80})/i);
  if (!match?.[1]) return undefined;
  const value = cleanAutoMemoryValue(match[1], 80);
  if (!value) return undefined;
  const content = `\u7528\u6237\u4e60\u60ef\u6216\u504f\u597d${value}`;
  if (looksForbidden(content) || isExternalKnowledgeClaim(compact) || looksLikeTaskOrProjectState(compact)) return undefined;
  return autoUserCandidate({
    input,
    content,
    kind: "preference",
    tags: ["auto", "habit", "preference"],
    weight: 0.6,
    confidence: 0.74,
  });
}

function autoUserCatchphraseCandidate(text: string, input: MemoryExtractionInput): Partial<MemoryRecord> | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/(?:\u6211(?:\u7684)?|\u7528\u6237(?:\u7684)?)(?:\u53e3\u5934\u7985|\u60ef\u7528\u8bed|\u5e38\u8bf4|\u559c\u6b22\u8bf4|\u5e38\u7528\u8868\u8fbe)(?:\u662f|\u53eb|:)?\s*["']?([^"'\r\n]{2,40})/i);
  if (!match?.[1]) return undefined;
  const value = cleanAutoMemoryValue(match[1], 40);
  if (!value) return undefined;
  const content = `\u7528\u6237\u5e38\u7528\u8868\u8fbe\u6216\u53e3\u5934\u7985: ${value}`;
  if (looksForbidden(content)) return undefined;
  return autoUserCandidate({
    input,
    content,
    kind: "preference",
    tags: ["auto", "catchphrase", "style"],
    weight: 0.57,
    confidence: 0.7,
  });
}

function cleanAutoMemoryValue(value: string, maxLength: number): string {
  return value.replace(/[\uFF0C\u3002,.!\uFF01?\uFF1F].*$/u, "").replace(/^[:\uFF1A\s"'\u201C\u201D]+|[:\uFF1A\s"'\u201C\u201D]+$/gu, "").trim().slice(0, maxLength);
}

function autoUserCandidate(input: { input: MemoryExtractionInput; content: string; kind: "fact" | "preference"; tags: string[]; weight: number; confidence: number }): Partial<MemoryRecord> {
  return {
    scope: "user",
    ownerId: input.input.userId ?? "local-user",
    kind: input.kind,
    origin: "auto_extracted",
    provenance: "inferred",
    status: "active",
    title: input.content.slice(0, 40),
    content: input.content,
    summary: input.content.slice(0, 96),
    weight: input.weight,
    confidence: input.confidence,
    sensitivity: "internal",
    ttlMs: 365 * 24 * 60 * 60 * 1000,
    originSessionId: input.input.sessionId ?? "unknown-session",
    tags: input.tags,
    metadata: { memoryDocumentType: "user", projectRelated: false, extractedBy: "rule_fallback" },
  };
}

function isExternalKnowledgeClaim(text: string): boolean {
  return /(?:\u6d41\u884c|\u6700\u65b0|\u65b0\u95fb|\u884c\u60c5|\u4ef7\u683c|trend|latest|news|popular)/i.test(text);
}

function looksLikeTaskOrProjectState(text: string): boolean {
  return containsAny(text, CURRENT_PROJECT_MARKERS)
    || /(?:\u6b63\u5728|\u8fd9\u6b21|\u672c\u8f6e|\u4eca\u5929|\u521a\u624d|todo|task|issue|PR|pull request)/i.test(text);
}

function explicitCandidate(text: string, input: MemoryExtractionInput): Partial<MemoryRecord> {
  const target = classifyExplicitMemory(text);
  return {
    scope: target.scope,
    ownerId: input.userId ?? "local-user",
    kind: target.kind,
    origin: "explicit_user",
    provenance: "explicit",
    status: "active",
    title: target.title,
    content: target.content,
    summary: target.summary,
    weight: 0.9,
    confidence: 0.95,
    sensitivity: "internal",
    ttlMs: 365 * 24 * 60 * 60 * 1000,
    originSessionId: input.sessionId ?? "unknown-session",
    tags: target.tags,
    metadata: { memoryDocumentType: target.documentType, projectRelated: target.scope === "project" },
  };
}

function normalizeMemoryCandidateCategory(candidate: Partial<MemoryRecord>): Partial<MemoryRecord> {
  if (!looksPersonalProfileMemory(candidate)) return candidate;
  const metadata = candidate.metadata && typeof candidate.metadata === "object" ? candidate.metadata : {};
  const tags = uniqueTags([...(candidate.tags ?? []), "user", "preference"].filter((tag) => !["project", "feedback", "reference"].includes(tag)));
  return {
    ...candidate,
    scope: "user",
    kind: "preference",
    tags,
    metadata: {
      ...metadata,
      memoryDocumentType: "user",
      projectRelated: false,
      normalizedCategory: "personal_preference",
    },
  };
}

function looksPersonalProfileMemory(candidate: Partial<MemoryRecord>): boolean {
  const text = `${candidate.title ?? ""}\n${candidate.summary ?? ""}\n${candidate.content ?? ""}`.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (looksLikeCurrentSoftwareProjectMemory(text)) return false;
  return containsAny(text, PERSONAL_PROFILE_MARKERS)
    || /(?:my|user).{0,24}(?:likes?|prefers?|is interested in|dislikes?)/i.test(text);
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

function classifyExplicitMemory(text: string): {
  scope: "user" | "global" | "project";
  kind: "preference" | "rule" | "fact";
  documentType: "user" | "global" | "feedback" | "project" | "reference";
  title: string;
  summary: string;
  content: string;
  tags: string[];
} {
  const content = stripRememberPrefix(text).trim();
  const title = memoryTitle(content);
  const lower = content.toLowerCase();
  if (looksLikeCurrentSoftwareProjectMemory(content)) {
    const documentType = /linear|grafana|slack|dashboard/i.test(content) || containsAny(content, REFERENCE_MARKERS) ? "reference" : "project";
    return {
      scope: "project",
      kind: "fact",
      documentType,
      title,
      summary: content.slice(0, 96),
      content: ensureWhyHow(content),
      tags: [documentType],
    };
  }
  if (containsAny(content, GLOBAL_MEMORY_MARKERS)) {
    return {
      scope: "global",
      kind: "preference",
      documentType: "global",
      title,
      summary: content.slice(0, 96),
      content,
      tags: ["global", "preference"],
    };
  }
  return {
    scope: "user",
    kind: "preference",
    documentType: "user",
    title,
    summary: content.slice(0, 96),
    content,
    tags: ["user", "preference"],
  };
}


function isSkipStrongSignalExtraction(input: MemoryExtractionInput): boolean {
  const payload = input.payload as { skipStrongSignalExtraction?: unknown } | undefined;
  return payload?.skipStrongSignalExtraction === true;
}

function isSkipObservation(input: MemoryExtractionInput): boolean {
  const payload = input.payload as { skipObservation?: unknown } | undefined;
  return payload?.skipObservation === true;
}

function classifyStrongMemorySignal(text: string, input: MemoryExtractionInput): "explicit" | "correction" | "confirmation" | "stable_fact" | undefined {
  if (input.priority === "high") return "explicit";
  const payload = input.payload as { source?: unknown } | undefined;
  if (payload?.source === "explicit_user_memory_signal") return "explicit";
  if (detectRemember(text)) return "explicit";
  if (isCorrectionSignal(text)) return "correction";
  if (isConfirmationSignal(text)) return "confirmation";
  if (isStableFactSignal(text)) return "stable_fact";
  return undefined;
}

function isCorrectionSignal(text: string): boolean {
  return /(?:\u4e0d\u8981|\u522b|stop|no,?\s+do|\u4e0d\u662f\u8fd9\u6837|\u4e0d\u5bf9|\u4ee5\u540e.*\u4e0d\u8981|\u4ee5\u540e.*\u522b)/iu.test(text);
}

function isConfirmationSignal(text: string): boolean {
  return /(?:\u5bf9|\u5c31\u662f\u8fd9\u6837|\u7ee7\u7eed\u8fd9\u4e48\u505a|\u4ee5\u540e\u4e5f\u8fd9\u6837|\u4fdd\u6301\u8fd9\u6837|\u8fd9\u6837\u5f88\u597d|yes,?\s+keep)/iu.test(text);
}

function isStableFactSignal(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (/^(?:\u6211|\u672c\u4eba)(?:\u662f|\u53eb|\u6765\u81ea|\u4f4f\u5728|\u4ece\u4e8b|\u505a|\u8bfb|\u5b66|\u5c5e\u4e8e)/u.test(compact)) return true;
  return /\b(?:i am|i'm|my role is|i work as|i live in)\b/i.test(text);
}

function memoryTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const preference = normalized.match(/^(?:\u6211|\u7528\u6237)?(?:\u559c\u6b22|\u7231\u597d|\u504f\u597d|\u5173\u6ce8|like|likes|prefer|prefers)\s*([^\u3002.!?\n]{2,80})/i);
  if (preference?.[1]) return preference[1].trim().slice(0, 40);
  const identity = normalized.match(/^(?:\u6211|\u7528\u6237)(?:\u662f|\u53eb)\s*([^\u3002.!?\n]{2,80})/i);
  if (identity?.[1]) return identity[1].trim().slice(0, 40);
  return normalized.slice(0, 40) || "memory";
}

function looksLikeCurrentSoftwareProjectMemory(text: string): boolean {
  const lower = text.toLowerCase();
  return /deadline|linear|grafana|slack/.test(lower) || containsAny(text, CURRENT_PROJECT_MARKERS) || containsAny(text, REFERENCE_MARKERS);
}

function ensureWhyHow(content: string): string {
  if (/\*\*Why:\*\*/i.test(content) && /\*\*How to apply:\*\*/i.test(content)) return content;
  return `${content}\n\n**Why:** ${PROJECT_MEMORY_DEFAULT_WHY}\n\n**How to apply:** ${PROJECT_MEMORY_DEFAULT_HOW}`;
}

function detectRemember(text: string): string | undefined {
  const match = text.match(/(?:\u8bb0\u4f4f|\u8bf7\u8bb0\u4f4f|\u5e2e\u6211\u8bb0\u4f4f|\u4ee5\u540e\u8bb0\u5f97|remember(?: that)?)([\s\S]{2,500})/i);
  return match?.[1]?.trim();
}

function detectForget(text: string): string | undefined {
  const match = text.match(/(?:\u5fd8\u6389|\u5220\u9664\u8bb0\u5fc6|\u4e0d\u8981\u518d\u8bb0|forget)([\s\S]{2,200})/i);
  return match?.[1]?.trim();
}

function stripRememberPrefix(text: string): string {
  return text.replace(/^(?:\u8bf7)?(?:\u5e2e\u6211)?(?:\u8bb0\u4f4f|\u4ee5\u540e\u8bb0\u5f97|remember(?: that)?)[\uff1a:\s]*/i, "");
}

function looksForbidden(text: string): boolean {
  return /git\s+(log|blame)|JUE\.md/i.test(text) || containsAny(text, FORBIDDEN_MEMORY_MARKERS);
}

function containsAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

const CURRENT_PROJECT_MARKERS = [
  "\u672c\u9879\u76ee",
  "\u5f53\u524d\u9879\u76ee",
  "\u8fd9\u4e2a\u9879\u76ee",
  "\u8be5\u9879\u76ee",
  "\u672c\u4ed3\u5e93",
  "\u5f53\u524d\u4ed3\u5e93",
  "\u8fd9\u4e2a\u4ed3\u5e93",
  "\u8be5\u4ed3\u5e93",
  "\u67b6\u6784\u51b3\u7b56",
  "\u622a\u6b62\u65e5\u671f",
  "\u622a\u6b62\u65f6\u95f4",
];

const REFERENCE_MARKERS = [
  "\u5916\u90e8\u94fe\u63a5",
  "\u94fe\u63a5",
  "\u4eea\u8868\u76d8",
  "\u9891\u9053",
];

const GLOBAL_MEMORY_MARKERS = [
  "\u5168\u5c40",
  "\u4efb\u4f55\u9879\u76ee",
  "\u6240\u6709\u9879\u76ee",
  "\u4ee5\u540e\u90fd",
  "\u59cb\u7ec8",
  "\u9ed8\u8ba4",
];

const PERSONAL_PROFILE_MARKERS = [
  "\u6211\u559c\u6b22",
  "\u6211\u4e0d\u559c\u6b22",
  "\u6211\u8ba8\u538c",
  "\u6211\u7231\u597d",
  "\u6211\u504f\u597d",
  "\u6211\u611f\u5174\u8da3",
  "\u6211\u5173\u6ce8",
  "\u6211\u5e0c\u671b",
  "\u6211\u901a\u5e38\u8981",
  "\u7528\u6237\u559c\u6b22",
  "\u7528\u6237\u4e0d\u559c\u6b22",
  "\u7528\u6237\u8ba8\u538c",
  "\u7528\u6237\u7231\u597d",
  "\u7528\u6237\u504f\u597d",
  "\u7528\u6237\u611f\u5174\u8da3",
  "\u7528\u6237\u5173\u6ce8",
  "\u7528\u6237\u5e0c\u671b",
  "\u7528\u6237\u901a\u5e38\u8981",
];

const FORBIDDEN_MEMORY_MARKERS = [
  "\u6587\u4ef6\u8def\u5f84",
  "\u4ee3\u7801\u7ed3\u6784",
  "\u4fee\u590d\u914d\u65b9",
  "\u8c03\u8bd5\u89e3\u51b3\u65b9\u6848",
  "\u5f53\u524d\u4f1a\u8bdd",
  "\u4efb\u52a1\u72b6\u6001",
];

const PROJECT_MEMORY_DEFAULT_WHY = "\u7528\u6237\u663e\u5f0f\u8981\u6c42\u8bb0\u4f4f\u8be5\u9879\u76ee\u80cc\u666f\u3002";
const PROJECT_MEMORY_DEFAULT_HOW = "\u5f53\u4efb\u52a1\u6d89\u53ca\u8be5\u9879\u76ee\u89c4\u5212\u3001\u51b3\u7b56\u539f\u56e0\u6216\u5916\u90e8\u5f15\u7528\u65f6\u4f7f\u7528\u3002";

function observationKeysFromWrittenRecords(records: MemoryRecord[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    const key = record.metadata?.observationKey;
    if (typeof key === "string" && key.trim()) keys.add(key.trim());
  }
  return [...keys];
}

function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.userText === "string") return record.userText;
  if (typeof record.memoryText === "string") return record.memoryText;
  if (Array.isArray(record.parts)) return partsToText(record.parts);
  if (typeof record.userMessage === "object" && record.userMessage !== null) return extractText(record.userMessage);
  if (typeof record.message === "object" && record.message !== null) return extractText(record.message);
  // Structured runtime envelopes are not memory material; engine must pass explicit text.
  return "";
}
function partsToText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}



