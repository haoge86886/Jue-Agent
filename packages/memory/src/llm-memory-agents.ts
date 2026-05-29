import type { MemoryDocument, MemoryExtractionInput, MemoryRecord } from "@jue/shared-types";
import type { DreamMemoryPruningContext } from "./dream-memory-service.js";
import type { StyleObservationCandidate, StyleObservationMergeGroup } from "./style-observer.js";

export interface MemoryLlmMessage {
  role: "system" | "user";
  content: string;
}

export interface MemoryLlmGateway {
  completeJson(input: {
    messages: MemoryLlmMessage[];
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface MemoryExtractionCandidate {
  scope: "user" | "global" | "project";
  type: "user" | "global" | "feedback" | "project" | "reference";
  title: string;
  summary: string;
  content: string;
  weight?: number;
  sensitivity?: "public" | "internal" | "private" | "secret";
  ttlMs?: number;
  tags?: string[];
  confidence?: number;
  reason?: string;
}

export interface MemoryExtractionOutput {
  candidates: MemoryExtractionCandidate[];
  rejectedReasons: string[];
  raw?: unknown;
}

export interface MemoryExtractorRunner {
  extract(input: MemoryExtractionInput, text: string): Promise<MemoryExtractionOutput>;
}

export class LlmMemoryExtractor {
  constructor(private readonly gateway: MemoryLlmGateway) {}

  async extract(input: MemoryExtractionInput, text: string): Promise<MemoryExtractionOutput> {
    const raw = await this.gateway.completeJson({
      messages: [
        { role: "system", content: MEMORY_EXTRACTOR_SYSTEM_PROMPT },
        { role: "user", content: renderExtractionInput(input, text) },
      ],
    });
    return normalizeMemoryExtractionOutput(raw, input);
  }
}

export interface MemoryPruningOutput {
  removeNames: string[];
  mergeGroups: Array<{
    keepName: string;
    removeNames: string[];
    reason: string;
    mergedDescription?: string;
    mergedBody?: string;
    tags?: string[];
  }>;
  diagnostics: string[];
  raw?: unknown;
}

export interface ObservationPruningOutput {
  mergeGroups: StyleObservationMergeGroup[];
  archiveKeys: string[];
  rejectKeys: string[];
  diagnostics: string[];
  raw?: unknown;
}

export interface DreamMemoryPrunerRunner {
  plan(documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<MemoryPruningOutput>;
}

export interface DreamObservationPrunerRunner {
  plan(candidates: StyleObservationCandidate[], documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<ObservationPruningOutput>;
}

export class LlmDreamMemoryPruner {
  constructor(private readonly gateway: MemoryLlmGateway) {}

  async plan(documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<MemoryPruningOutput> {
    const raw = await this.gateway.completeJson({
      messages: [
        { role: "system", content: DREAM_MEMORY_PRUNING_SYSTEM_PROMPT },
        { role: "user", content: renderPruningInput(documents, context) },
      ],
    });
    return normalizeMemoryPruningOutput(raw);
  }
}

export class LlmDreamObservationPruner {
  constructor(private readonly gateway: MemoryLlmGateway) {}

  async plan(candidates: StyleObservationCandidate[], documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<ObservationPruningOutput> {
    const raw = await this.gateway.completeJson({
      messages: [
        { role: "system", content: DREAM_OBSERVATION_PRUNING_SYSTEM_PROMPT },
        { role: "user", content: renderObservationPruningInput(candidates, documents, context) },
      ],
    });
    return normalizeObservationPruningOutput(raw);
  }
}

const MEMORY_EXTRACTOR_SYSTEM_PROMPT = [
  "You are MemoryExtractorAgent, an internal long-term memory extraction subagent.",
  "Extract only stable long-term information that cannot be derived from the current repository, code, or git history.",
  "This extractor is no longer called every turn. It runs periodically or on background exit to find durable signals missing from MEMORY.md indexes.",
  "Auto-extract stable user profile facts, habits, recurring style preferences, preferred wording, catchphrases, dialect/region clues, hobbies, learning goals, tool/language preferences, and repeated collaboration patterns when they are likely useful later.",
  "Do not auto-extract one-off emotions, temporary task state, external world facts, trend/news claims, or statements that can be recovered by reading the repository or searching the web.",
  "Never store code structure, file paths, git history, debugging recipes, current task state, temporary conversation state, or content already written in JUE.md.",
  "Classify semantically. Project in a work/game/community name does not mean current software project. Example: Touhou Project is a user interest, not project memory.",
  "User profile, interests, hobbies, habits, recurring phrases, dialect/region clues, explanation-depth preferences => scope=user/type=user.",
  "Cross-project collaboration preferences, environment constraints, global workflow rules => scope=global/type=global.",
  "Current repository decision reasons, deadlines, feedback, external dashboards/links => scope=project/type=project|feedback|reference.",
  "feedback/project content must include **Why:** and **How to apply:**.",
  "Input contains only user messages plus existing MEMORY.md indexes. Do not duplicate anything already indexed.",
  "Set provenance conceptually as inferred: these are medium-weight memories that can be reviewed or pruned later.",
  "Return exactly one JSON object, no Markdown.",
].join("\n");

const DREAM_OBSERVATION_PRUNING_SYSTEM_PROMPT = [
  "You are DreamObservationPruning, an internal background observation-pool consolidation subagent.",
  "You only handle style-observation-pool.json candidates. Do not propose formal memory markdown edits here.",
  "Your job is to merge semantically equivalent user observation candidates, archive observations already covered by formal user memories, and delete weak polluted observations by placing their keys in rejectKeys.",
  "Observation candidates are weak, non-user-approved evidence. Prefer high precision for merges, but be assertive when deleting meaningless, question-derived, placeholder, unsafe, or contradicted candidates.",
  "Diagnostics are audit logs only. If you decide a candidate is invalid, diagnostics alone are not enough: the candidate key must appear in rejectKeys.",
  "Archive, rather than delete, candidates that are already represented by a formal memory document. Reject user questions and placeholders such as what do I like, talk about my preferences, chat about my interests, or remember what I like; these are retrieval requests, not evidence.",
  "Return exactly one JSON object, no Markdown.",
].join("\n");

const DREAM_MEMORY_PRUNING_SYSTEM_PROMPT = [
  "You are DreamMemoryPruning, an internal background memory consolidation subagent.",
  "You run only after the host gate says at least 24 hours passed and at least 5 sessions produced new memories.",
  "Follow this workflow: inspect MEMORY.md indexes, inspect detailed memory documents, compare recent session summaries and repository status hints, then propose safe deletion or merge actions.",
  "You only output deletion and merge plans. Do not invent unsupported memories or store code structure, file paths, git history, debugging recipes, current task state, or content already in JUE.md.",
  "Convert relative dates in mergedBody to absolute dates using nowIso from the input. If an old fact is contradicted by newer evidence, delete or merge it into the newer fact instead of keeping both.",
  "Use scope-specific modes. user memories are conservative: merge clear duplicates, but do not propose direct deletion unless the text is empty/expired or explicitly contradicted by newer user statements.",
  "global memories are guarded: never delete directly; only merge very high-confidence duplicates in the same scope/type, or diagnose that a memory should be manually downgraded to user/project.",
  "project memories are active: delete expired, contradicted, empty, or clearly obsolete project facts, after considering session summaries and repository status hints.",
  "For duplicate topics, keep the more specific entry with higher weight, newer evidence, and better Why/How-to-apply boundaries.",
  "Strict non-merge rule: do not merge different semantic categories. Identity, preference, dislike, ability, relationship, collaboration style, goal, reference, project decision, and global rule are separate categories.",
  "If memories are merely both about the same user but describe different facts, return no mergeGroup. Example: user is male and user likes Touhou Project are unrelated and must not be merged.",
  "Only merge when the memories share the same category and the same concrete entity or fact target.",
  "When merging, never generalize away concrete entities. If sources say the user likes Touhou Project, the mergedDescription must still name Touhou Project; do not replace it with generic phrases like user preferred topic.",
  "Only include mergedDescription or mergedBody when the rewrite preserves every important concrete object, name, preference target, constraint, and Why/How boundary from the source memories. Otherwise omit these fields and let the host concatenate the originals.",
  "removeNames must contain only real document names from the input and must not include keepName. A merge that does not delete at least one duplicate is invalid.",
  "Return exactly one JSON object, no Markdown.",
].join("\n");

function renderExtractionInput(input: MemoryExtractionInput, text: string): string {
  return JSON.stringify({
    agent: "MemoryExtractorAgent",
    kind: input.kind,
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceRoot: input.workspaceRoot,
    priority: input.priority,
    text,
    schema: {
      candidates: [{
        scope: "user|global|project",
        type: "user|global|feedback|project|reference",
        title: "short semantic title",
        summary: "one sentence retrieval summary",
        content: "full markdown body",
        reason: "classification and write reason; explain why this is durable and useful later",
        weight: 0.8,
        confidence: 0.8,
        sensitivity: "internal",
        ttlMs: 31536000000,
        tags: ["preference"],
      }],
      rejectedReasons: ["why no memory was written"],
    },
  });
}

function renderPruningInput(documents: MemoryDocument[], context?: DreamMemoryPruningContext): string {
  return JSON.stringify({
    agent: "DreamMemoryPruning",
    nowIso: context?.nowIso,
    workspaceRoot: context?.workspaceRoot,
    gate: context?.gate,
    memoryIndexes: context?.memoryIndexes.map((item) => ({
      scope: item.scope,
      path: item.path,
      content: item.content.slice(0, 6000),
    })) ?? [],
    recentSessionSummaries: context?.recentSessionSummaries.map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      lastActiveAt: item.lastActiveAt,
      summary: item.summary.slice(0, 3000),
    })) ?? [],
    repositorySignal: context?.repositorySignal,
    pruningPolicies: {
      user: "conservative: same-scope/type duplicate merge only; direct deletion is normally blocked by host policy",
      global: "guarded: very high-confidence same-scope/type merge only; direct deletion is blocked by host policy",
      project: "active: same-scope/type merge and safe deletion are allowed when evidence is clear",
    },
    documents: documents.slice(0, 120).map((doc) => ({
      name: doc.frontmatter.name,
      description: doc.frontmatter.description,
      type: doc.frontmatter.type,
      scope: doc.frontmatter.scope,
      weight: doc.frontmatter.weight,
      status: doc.frontmatter.status,
      createdAt: doc.frontmatter.createdAt,
      updatedAt: doc.frontmatter.updatedAt,
      expiresAt: doc.frontmatter.expiresAt,
      tags: doc.frontmatter.tags,
      bodyPreview: doc.body.slice(0, 1200),
    })),
    schema: {
      removeNames: ["memory-name"],
      mergeGroups: [{
        keepName: "memory-name",
        removeNames: ["duplicate-name"],
        reason: "same durable fact or preference",
        mergedDescription: "optional; must preserve concrete entities from all source memories, otherwise omit",
        mergedBody: "optional; must preserve all concrete facts and Why/How boundaries, otherwise omit",
        tags: ["optional", "merged", "tags"],
      }],
      diagnostics: ["short explanation"],
    },
  });
}

function renderObservationPruningInput(candidates: StyleObservationCandidate[], documents: MemoryDocument[], context?: DreamMemoryPruningContext): string {
  return JSON.stringify({
    agent: "DreamObservationPruning",
    nowIso: context?.nowIso,
    workspaceRoot: context?.workspaceRoot,
    gate: context?.gate,
    actionSemantics: {
      mergeGroups: "Use only for semantically equivalent candidates with the same concrete fact target. This keeps keepKey and removes removeKeys.",
      archiveKeys: "Use when a weak observation is already covered by formal user memory. It remains for audit but will not be used as an active hint.",
      rejectKeys: "Use for polluted, meaningless, question-derived, placeholder, unsafe, or contradicted candidates. This physically removes the weak observation from the pool.",
      diagnostics: "Audit notes only. Diagnostics do not change files, so every intended deletion must also be listed in rejectKeys.",
    },
    deletionRubric: [
      "Reject when evidence quote is a question or request to recall/discuss preferences rather than a declarative user fact.",
      "Reject when candidate lacks a concrete object, e.g. user preference, user preferred topic, user likes things, user interest is unknown.",
      "Reject when candidate is derived from phrases like talk about my preferences, chat about my interests, what do I like, remember what I like.",
      "Reject when candidate only restates the memory system interaction rather than a user trait.",
    ],
    formalUserMemories: documents
      .filter((doc) => doc.frontmatter.scope === "user" || doc.frontmatter.type === "user")
      .slice(0, 120)
      .map((doc) => ({
        name: doc.frontmatter.name,
        description: doc.frontmatter.description,
        type: doc.frontmatter.type,
        scope: doc.frontmatter.scope,
        provenance: doc.frontmatter.provenance,
        weight: doc.frontmatter.weight,
        tags: doc.frontmatter.tags,
        bodyPreview: doc.body.slice(0, 1000),
      })),
    observationCandidates: candidates.slice(0, 160).map((item) => ({
      key: item.key,
      candidate: item.candidate,
      status: item.status,
      occurrences: item.occurrences,
      confidence: item.confidence,
      promotedMemoryName: item.promotedMemoryName,
      evidence: item.evidence.slice(-6).map((entry) => ({ quote: entry.quote, at: entry.at, sid: entry.sid })),
      contradictedBy: item.contradicted_by.slice(-4).map((entry) => ({ quote: entry.quote, at: entry.at, sid: entry.sid })),
    })),
    schema: {
      mergeGroups: [{
        keepKey: "observation-key-to-keep",
        removeKeys: ["duplicate-observation-key"],
        reason: "same observed user preference or habit phrased differently",
        mergedCandidate: "optional concise candidate label",
      }],
      archiveKeys: ["covered-by-formal-memory-key"],
      rejectKeys: ["polluted-or-contradicted-key-to-delete"],
      diagnostics: ["audit explanation; not executable"],
    },
  });
}


export function normalizeMemoryExtractionOutput(raw: unknown, input: MemoryExtractionInput): MemoryExtractionOutput {
  const obj = unwrapSubAgentOutputs(raw);
  const candidates = Array.isArray(obj.candidates)
    ? obj.candidates.map((item) => asCandidate(item, input)).filter((item): item is MemoryExtractionCandidate => Boolean(item))
    : [];
  const rejectedReasons = Array.isArray(obj.rejectedReasons) ? obj.rejectedReasons.filter((item): item is string => typeof item === "string") : [];
  return { candidates, rejectedReasons, raw };
}

function asCandidate(value: unknown, input: MemoryExtractionInput): MemoryExtractionCandidate | undefined {
  const obj = asRecord(value);
  const scope = obj.scope === "user" || obj.scope === "global" || obj.scope === "project" ? obj.scope : undefined;
  const type = obj.type === "user" || obj.type === "global" || obj.type === "feedback" || obj.type === "project" || obj.type === "reference" ? obj.type : undefined;
  if (!scope || !type || typeof obj.title !== "string" || typeof obj.content !== "string") return undefined;
  if (type === "user" && scope !== "user") return undefined;
  if (type === "global" && scope !== "global") return undefined;
  if ((type === "feedback" || type === "project" || type === "reference") && scope !== "project") return undefined;

  const title = cleanOneLine(obj.title, 80);
  const content = String(obj.content).trim();
  const summary = cleanOneLine(typeof obj.summary === "string" ? obj.summary : title, 160);
  const confidence = typeof obj.confidence === "number" ? clamp01(obj.confidence) : undefined;
  if (!title || !content || !summary) return undefined;
  if (isForbiddenCandidateText(title + "\n" + summary + "\n" + content)) return undefined;
  if (input.priority !== "high" && (confidence ?? 0.7) < 0.6) return undefined;

  const normalizedContent = type === "feedback" || type === "project" ? ensureWhyHow(content) : content;
  return {
    scope,
    type,
    title,
    summary,
    content: normalizedContent,
    ...(typeof obj.weight === "number" ? { weight: clamp01(obj.weight) } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(obj.sensitivity === "public" || obj.sensitivity === "internal" || obj.sensitivity === "private" || obj.sensitivity === "secret" ? { sensitivity: obj.sensitivity } : {}),
    ...(typeof obj.ttlMs === "number" ? { ttlMs: Math.max(0, Math.floor(obj.ttlMs)) } : {}),
    ...(Array.isArray(obj.tags) ? { tags: normalizeTags(obj.tags) } : {}),
    ...(typeof obj.reason === "string" ? { reason: cleanOneLine(obj.reason, 180) } : {}),
  };
}

export function normalizeMemoryPruningOutput(raw: unknown): MemoryPruningOutput {
  const obj = unwrapSubAgentOutputs(raw);
  const removeNames = Array.isArray(obj.removeNames) ? obj.removeNames.filter((item): item is string => typeof item === "string") : [];
  const mergeGroups = Array.isArray(obj.mergeGroups)
    ? obj.mergeGroups.map((item) => {
        const group = asRecord(item);
        if (typeof group.keepName !== "string" || !Array.isArray(group.removeNames)) return undefined;
        return {
          keepName: group.keepName,
          removeNames: group.removeNames.filter((name): name is string => typeof name === "string"),
          reason: typeof group.reason === "string" ? group.reason : "duplicate memory",
          ...(typeof group.mergedDescription === "string" ? { mergedDescription: cleanOneLine(group.mergedDescription, 200) } : {}),
          ...(typeof group.mergedBody === "string" ? { mergedBody: group.mergedBody.trim() } : {}),
          ...(Array.isArray(group.tags) ? { tags: normalizeTags(group.tags) } : {}),
        };
      }).filter((item): item is MemoryPruningOutput["mergeGroups"][number] => Boolean(item))
    : [];
  const diagnostics = Array.isArray(obj.diagnostics) ? obj.diagnostics.filter((item): item is string => typeof item === "string") : [];
  return { removeNames, mergeGroups, diagnostics, raw };
}

export function normalizeObservationPruningOutput(raw: unknown): ObservationPruningOutput {
  const obj = unwrapSubAgentOutputs(raw);
  const mergeGroups = Array.isArray(obj.mergeGroups)
    ? obj.mergeGroups.map((item): StyleObservationMergeGroup | undefined => {
        const group = asRecord(item);
        if (typeof group.keepKey !== "string" || !Array.isArray(group.removeKeys)) return undefined;
        return {
          keepKey: group.keepKey,
          removeKeys: group.removeKeys.filter((key): key is string => typeof key === "string"),
          reason: typeof group.reason === "string" ? group.reason : "duplicate observation",
          ...(typeof group.mergedCandidate === "string" ? { mergedCandidate: cleanOneLine(group.mergedCandidate, 160) } : {}),
        };
      }).filter((item): item is ObservationPruningOutput["mergeGroups"][number] => Boolean(item))
    : [];
  const archiveKeys = Array.isArray(obj.archiveKeys) ? obj.archiveKeys.filter((item): item is string => typeof item === "string") : [];
  const rejectKeys = Array.isArray(obj.rejectKeys) ? obj.rejectKeys.filter((item): item is string => typeof item === "string") : [];
  const diagnostics = Array.isArray(obj.diagnostics) ? obj.diagnostics.filter((item): item is string => typeof item === "string") : [];
  return { mergeGroups, archiveKeys, rejectKeys, diagnostics, raw };
}



function unwrapSubAgentOutputs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value);
  const outputs = asRecord(obj.outputs);
  // Direct LLM runners may receive a full SubAgentResult, while runtime
  // wrappers pass result.outputs directly. Support both shapes so Dream plans
  // are not lost when the model follows the SubAgentResult contract.
  return Object.keys(outputs).length > 0 ? outputs : obj;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanOneLine(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function normalizeTags(value: unknown[]): string[] {
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean))).slice(0, 12);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ensureWhyHow(content: string): string {
  if (/\*\*Why:\*\*/i.test(content) && /\*\*How to apply:\*\*/i.test(content)) return content;
  return content.trim() + "\n\n**Why:** MemoryExtractorAgent did not receive an explicit reason; verify applicability before using.\n\n**How to apply:** Use only when the current task clearly matches this memory.";
}

function isForbiddenCandidateText(text: string): boolean {
  return [
    /git\s+(log|blame|history)/i,
    /file:\d+/i,
    /JUE\.md/i,
    /code structure|file path|debugging recipe|fix recipe|current task state|temporary conversation state/i,
  ].some((pattern) => pattern.test(text));
}

export function llmCandidateToRecord(candidate: MemoryExtractionCandidate, input: MemoryExtractionInput): Partial<MemoryRecord> {
  return {
    scope: candidate.scope,
    ownerId: input.userId ?? "local-user",
    kind: candidate.type === "feedback" ? "rule" : candidate.type === "project" || candidate.type === "reference" ? "fact" : "preference",
    origin: input.priority === "high" ? "explicit_user" : "auto_extracted",
    provenance: input.priority === "high" ? "explicit" : "inferred",
    status: input.priority === "high" || (candidate.confidence ?? 0.7) >= 0.68 ? "active" : "candidate",
    title: candidate.title,
    content: candidate.content,
    summary: candidate.summary,
    weight: candidate.weight ?? (input.priority === "high" ? 0.9 : 0.6),
    confidence: candidate.confidence ?? (input.priority === "high" ? 0.9 : 0.7),
    sensitivity: candidate.sensitivity ?? "internal",
    ttlMs: candidate.ttlMs ?? 365 * 24 * 60 * 60 * 1000,
    originSessionId: input.sessionId ?? "unknown-session",
    tags: candidate.tags ?? [candidate.type],
    metadata: {
      memoryDocumentType: candidate.type,
      extractedBy: "MemoryExtractorAgent",
      projectRelated: candidate.scope === "project",
      ...(candidate.reason ? { extractionReason: candidate.reason } : {}),
    },
  };
}



