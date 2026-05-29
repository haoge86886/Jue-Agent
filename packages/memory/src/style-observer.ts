import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryExtractionInput, MemoryRecord } from "@jue/shared-types";

const OBSERVATION_POOL_FILE = "style-observation-pool.json";
const REJECTED_FILE = "user-rejected-observations.json";
const MIN_PROMOTE_OCCURRENCES = 3;
const MIN_PROMOTE_CONFIDENCE = 0.5;
const HALF_LIFE_MS = 15 * 24 * 60 * 60 * 1000;
const STALE_DROP_MS = 30 * 24 * 60 * 60 * 1000;
const SILENT_ARCHIVE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE = 8;
const MAX_CANDIDATES = 500;

export interface StyleObservationEvidence {
  sid: string;
  quote: string;
  at: string;
}

export interface StyleObservationCandidate {
  candidate: string;
  type: "user";
  key: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  evidence: StyleObservationEvidence[];
  confidence: number;
  contradicted_by: StyleObservationEvidence[];
  status: "candidate" | "promoted" | "archived" | "rejected";
  promotedMemoryName?: string;
  lastPromotedAt?: string;
  lastAccessedAt?: string;
  accessCount: number;
}

export interface StyleObservationMergeGroup {
  keepKey: string;
  removeKeys: string[];
  reason?: string;
  mergedCandidate?: string;
}

export interface StyleObservationMaintenanceResult {
  checked: number;
  merged: number;
  removed: number;
  archived: number;
  rejected: number;
  diagnostics: string[];
}

export interface StyleObservationMaintenancePlan {
  mergeGroups?: StyleObservationMergeGroup[];
  archiveKeys?: string[];
  rejectKeys?: string[];
}

export interface StyleObservationResult {
  matched: boolean;
  observed: StyleObservationCandidate[];
  promotedCandidates: Array<Partial<MemoryRecord>>;
  promptHints: string[];
  rejected: string[];
}

interface StyleObservationPoolFile {
  version: 2;
  updatedAt: string;
  candidates: StyleObservationCandidate[];
}

interface RejectedFile {
  version: 1;
  rejectedKeys: string[];
  rejectedTexts: string[];
}

type ObservationSignalCategory = "frequency" | "preference" | "identity" | "schedule" | "personality" | "mood" | "goal" | "relationship" | "ability" | "collaboration" | "freeform";

interface ObservationSignal {
  candidate: string;
  key: string;
  category: ObservationSignalCategory;
  strength: number;
  ttlDays?: number;
  promotionOccurrences?: number;
  tags: string[];
}

export interface StyleObserverOptions {
  globalJueDir: string;
  now?: () => number;
  minPromoteOccurrences?: number;
  minPromoteConfidence?: number;
}

export class StyleObserver {
  private readonly poolPath: string;
  private readonly rejectedPath: string;
  private readonly now: () => number;
  private readonly minPromoteOccurrences: number;
  private readonly minPromoteConfidence: number;

  constructor(options: StyleObserverOptions) {
    this.poolPath = join(options.globalJueDir, "user", "memory", OBSERVATION_POOL_FILE);
    this.rejectedPath = join(options.globalJueDir, "user", "memory", REJECTED_FILE);
    this.now = options.now ?? Date.now;
    this.minPromoteOccurrences = options.minPromoteOccurrences ?? MIN_PROMOTE_OCCURRENCES;
    this.minPromoteConfidence = options.minPromoteConfidence ?? MIN_PROMOTE_CONFIDENCE;
  }

  observe(text: string, input: MemoryExtractionInput): StyleObservationResult {
    const signals = extractObservationSignals(text);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const rejectedFile = readRejectedFile(this.rejectedPath);

    if (detectUserRejection(text)) {
      const pool = readPool(this.poolPath);
      const rejected = markContradictions(pool, text, input.sessionId ?? "unknown-session", nowIso, rejectedFile);
      writeRejectedFile(this.rejectedPath, rejectedFile);
      writePool(this.poolPath, cleanupPool(pool, nowMs));
      return { matched: false, observed: [], promotedCandidates: [], promptHints: [], rejected };
    }

    if (signals.length === 0) {
      this.maintain();
      return { matched: false, observed: [], promotedCandidates: [], promptHints: [], rejected: [] };
    }

    const pool = readPool(this.poolPath);
    const byKey = new Map(pool.candidates.map((item) => [item.key, item]));
    const observed: StyleObservationCandidate[] = [];
    const promotedCandidates: Array<Partial<MemoryRecord>> = [];

    for (const signal of signals) {
      if (rejectedFile.rejectedKeys.includes(signal.key)) continue;
      const existing = byKey.get(signal.key);
      const record = existing ?? newObservation(signal, nowIso);
      record.last_seen = nowIso;
      record.occurrences += 1;
      record.status = record.status === "archived" ? "candidate" : record.status;
      addEvidence(record, {
        sid: input.sessionId ?? "unknown-session",
        quote: text.slice(0, 220),
        at: nowIso,
      });
      record.confidence = nextConfidence(record, nowMs, signal.strength);
      byKey.set(record.key, record);
      observed.push(record);

      if (shouldPromote(record, signal.promotionOccurrences ?? this.minPromoteOccurrences, this.minPromoteConfidence)) {
        record.status = "promoted";
        record.lastPromotedAt = nowIso;
        promotedCandidates.push(toObservedMemory(record, input));
      }
    }

    const nextPool = cleanupPool({ version: 2, updatedAt: nowIso, candidates: [...byKey.values()] }, nowMs);
    writePool(this.poolPath, nextPool);
    return {
      matched: true,
      observed,
      promotedCandidates,
      promptHints: observed.map(renderPromptHint).slice(0, 3),
      rejected: [],
    };
  }

  getPromptHints(limit = 1): string[] {
    const nowMs = this.now();
    const pool = cleanupPool(readPool(this.poolPath), nowMs);
    writePool(this.poolPath, pool);
    return shuffle(pool.candidates
      .filter((item) => item.status === "candidate" && item.confidence > 0 && item.occurrences > 0))
      .slice(0, limit)
      .map(renderHypothesisHint);
  }

  maintain(): void {
    const nowMs = this.now();
    const pool = cleanupPool(readPool(this.poolPath), nowMs);
    writePool(this.poolPath, pool);
  }

  listCandidates(limit = 120): StyleObservationCandidate[] {
    const nowMs = this.now();
    const pool = cleanupPool(readPool(this.poolPath), nowMs);
    writePool(this.poolPath, pool);
    return pool.candidates.filter((item) => item.status === "candidate" || item.status === "promoted").slice(0, limit);
  }

  applyMergeGroups(groups: StyleObservationMergeGroup[]): StyleObservationMaintenanceResult {
    return this.applyMaintenancePlan({ mergeGroups: groups });
  }


  removePromotedKeys(keys: string[], reason = "formal memory write succeeded"): StyleObservationMaintenanceResult {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const pool = cleanupPool(readPool(this.poolPath), nowMs);
    const byKey = new Map(pool.candidates.map((item) => [item.key, item]));
    const diagnostics: string[] = [];
    let removed = 0;

    for (const rawKey of keys) {
      const item = byKey.get(canonicalKey(rawKey)) ?? findObservationByLooseKey(byKey, rawKey);
      if (!item) {
        diagnostics.push(`Observation promoted cleanup skipped ${rawKey}: key not found.`);
        continue;
      }
      byKey.delete(item.key);
      removed += 1;
      diagnostics.push(`Observation removed after formal memory write ${item.key}: ${reason}.`);
    }

    writePool(this.poolPath, cleanupPool({ version: 2, updatedAt: nowIso, candidates: [...byKey.values()] }, nowMs));
    return { checked: pool.candidates.length, merged: 0, removed, archived: 0, rejected: 0, diagnostics };
  }

  applyMaintenancePlan(plan: StyleObservationMaintenancePlan): StyleObservationMaintenanceResult {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const pool = cleanupPool(readPool(this.poolPath), nowMs);
    const byKey = new Map(pool.candidates.map((item) => [item.key, item]));
    const diagnostics: string[] = [];
    let merged = 0;
    let removed = 0;
    let archived = 0;
    let rejected = 0;

    for (const group of plan.mergeGroups ?? []) {
      const keepKey = canonicalKey(group.keepKey);
      const keep = byKey.get(keepKey);
      if (!keep) {
        diagnostics.push(`Observation merge skipped ${group.keepKey}: keepKey not found.`);
        continue;
      }
      for (const rawRemoveKey of group.removeKeys) {
        const removeKey = canonicalKey(rawRemoveKey);
        if (removeKey === keepKey) continue;
        const duplicate = byKey.get(removeKey);
        if (!duplicate) {
          diagnostics.push(`Observation merge skipped ${rawRemoveKey}: removeKey not found.`);
          continue;
        }
        keep.candidate = group.mergedCandidate?.trim() || betterCandidateLabel(keep.candidate, duplicate.candidate);
        keep.first_seen = earlierIso(keep.first_seen, duplicate.first_seen);
        keep.last_seen = laterIso(keep.last_seen, duplicate.last_seen);
        keep.occurrences = Math.max(keep.occurrences, 0) + Math.max(duplicate.occurrences, 0);
        keep.evidence = mergeEvidence(keep.evidence, duplicate.evidence);
        keep.contradicted_by = mergeEvidence(keep.contradicted_by, duplicate.contradicted_by);
        keep.confidence = Math.max(keep.confidence, duplicate.confidence);
        keep.accessCount += duplicate.accessCount;
        keep.status = preferredStatus(keep.status, duplicate.status);
        if (!keep.promotedMemoryName && duplicate.promotedMemoryName) keep.promotedMemoryName = duplicate.promotedMemoryName;
        setOptionalIso(keep, "lastPromotedAt", laterOptionalIso(keep.lastPromotedAt, duplicate.lastPromotedAt));
        setOptionalIso(keep, "lastAccessedAt", laterOptionalIso(keep.lastAccessedAt, duplicate.lastAccessedAt));
        byKey.delete(removeKey);
        merged += 1;
        removed += 1;
      }
      diagnostics.push(`Observation merged into ${keep.key}: ${group.reason ?? "same observed user signal"}`);
    }

    for (const rawKey of plan.archiveKeys ?? []) {
      const key = canonicalKey(rawKey);
      const item = byKey.get(key);
      if (!item) {
        diagnostics.push(`Observation archive skipped ${rawKey}: key not found.`);
        continue;
      }
      if (item.status !== "archived") {
        item.status = "archived";
        item.lastAccessedAt = item.lastAccessedAt ?? nowIso;
        archived += 1;
      }
    }

    for (const rawKey of plan.rejectKeys ?? []) {
      const key = canonicalKey(rawKey);
      const item = byKey.get(key) ?? findObservationByLooseKey(byKey, rawKey);
      if (!item) {
        diagnostics.push(`Observation reject skipped ${rawKey}: key not found.`);
        continue;
      }
      byKey.delete(item.key);
      rejected += 1;
      removed += 1;
      diagnostics.push(`Observation rejected and removed ${item.key}: weak observation cleanup.`);
    }

    writePool(this.poolPath, cleanupPool({ version: 2, updatedAt: nowIso, candidates: [...byKey.values()] }, nowMs));
    return { checked: pool.candidates.length, merged, removed, archived, rejected, diagnostics };
  }
}

function extractObservationSignals(text: string): ObservationSignal[] {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact || looksUnsafe(compact) || isHardBlockedPrivacy(compact) || isMemoryQueryPollution(compact) || isPreferenceDiscussionRequest(compact)) return [];
  const trigger = triggerProfile(compact);
  if (!trigger.matched || shouldRejectObservation(compact, trigger.hasFrequency)) return [];

  const modifier = signalModifier(compact);
  const signals: ObservationSignal[] = [];
  for (const rule of OBSERVATION_RULES) {
    const match = compact.match(rule.pattern);
    if (!match?.[1]) continue;
    const value = cleanValue(match[1]);
    if (!value || isNonEvidenceObservationValue(value)) continue;
    if (rule.requireFrequency && !trigger.hasFrequency) continue;
    const candidate = rule.render(value, compact);
    const strength = clamp01(rule.baseStrength * modifier);
    signals.push({
      candidate,
      key: canonicalKey(candidate),
      category: rule.category,
      strength,
      ...(rule.ttlDays ? { ttlDays: rule.ttlDays } : {}),
      ...(rule.promotionOccurrences ? { promotionOccurrences: rule.promotionOccurrences } : {}),
      tags: rule.tags,
    });
  }

  if (signals.length === 0 && compact.length <= 80) {
    const candidate = normalizeFreeformCandidate(compact);
    if (candidate && !isNonEvidenceObservationValue(candidate)) {
      signals.push({
        candidate,
        key: canonicalKey(candidate),
        category: "freeform",
        strength: clamp01(0.26 * modifier),
        promotionOccurrences: 3,
        tags: ["observed", "freeform"],
      });
    }
  }
  return dedupeSignals(signals).slice(0, 3);
}

function detectUserRejection(text: string): boolean {
  return /(?:不是这样|不对|别这么记|不要这样记|撤回|不是这个意思|并不是|no[, ]+not|wrong)/iu.test(text);
}

function markContradictions(pool: StyleObservationPoolFile, text: string, sid: string, at: string, rejectedFile: RejectedFile): string[] {
  const normalized = canonicalKey(text);
  const rejected: string[] = [];
  for (const item of pool.candidates) {
    if (overlaps(normalized, item.key) || overlaps(canonicalKey(item.candidate), normalized)) {
      item.status = "rejected";
      item.contradicted_by.push({ sid, quote: text.slice(0, 220), at });
      item.confidence = 0;
      if (!rejectedFile.rejectedKeys.includes(item.key)) rejectedFile.rejectedKeys.push(item.key);
      if (!rejectedFile.rejectedTexts.includes(item.candidate)) rejectedFile.rejectedTexts.push(item.candidate);
      rejected.push(item.candidate);
    }
  }
  return rejected;
}

function newObservation(signal: ObservationSignal, nowIso: string): StyleObservationCandidate {
  return {
    candidate: signal.candidate,
    type: "user",
    key: signal.key,
    first_seen: nowIso,
    last_seen: nowIso,
    occurrences: 0,
    evidence: [],
    confidence: signal.strength,
    contradicted_by: [],
    status: "candidate",
    accessCount: 0,
  };
}

function addEvidence(record: StyleObservationCandidate, evidence: StyleObservationEvidence): void {
  if (record.evidence.some((item) => item.quote === evidence.quote && item.sid === evidence.sid)) return;
  record.evidence.push(evidence);
  if (record.evidence.length > MAX_EVIDENCE) record.evidence.splice(0, record.evidence.length - MAX_EVIDENCE);
}

function nextConfidence(record: StyleObservationCandidate, nowMs: number, signalStrength = 0.28): number {
  const lastSeenMs = Date.parse(record.last_seen);
  const stalePenalty = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs >= HALF_LIFE_MS ? 0.7 : 1;
  const occurrenceScore = Math.min(0.38, record.occurrences * 0.11);
  const sessionScore = Math.min(0.18, new Set(record.evidence.map((item) => item.sid)).size * 0.06);
  const contradictionPenalty = Math.min(0.4, record.contradicted_by.length * 0.2);
  return clamp01((Math.max(0.18, signalStrength) + occurrenceScore + sessionScore - contradictionPenalty) * stalePenalty);
}

function shouldPromote(record: StyleObservationCandidate, minOccurrences: number, minConfidence: number): boolean {
  if (record.status === "rejected") return false;
      if (record.status === "promoted" && record.promotedMemoryName) return false;
      return record.occurrences >= minOccurrences && record.confidence >= minConfidence;
}

function toObservedMemory(record: StyleObservationCandidate, input: MemoryExtractionInput): Partial<MemoryRecord> {
  const ttlMs = 120 * 24 * 60 * 60 * 1000;
  return {
    scope: "user",
    ownerId: input.userId ?? "local-user",
    kind: "preference",
    origin: "auto_extracted",
    provenance: "observed",
    status: "active",
    title: record.candidate.slice(0, 60),
    summary: record.candidate.slice(0, 120),
    content: `${record.candidate}\n\n**Evidence:** 观察池累计 ${record.occurrences} 次，置信度 ${record.confidence.toFixed(2)}。\n\n**How to apply:** 这是观察推断，不是用户显式承诺；引用时降权，若当前用户说法冲突，以当前说法为准。`,
    weight: Math.max(0.42, Math.min(0.62, record.confidence)),
    confidence: record.confidence,
    sensitivity: "internal",
    ttlMs,
    originSessionId: input.sessionId ?? record.evidence.at(-1)?.sid ?? "unknown-session",
    tags: ["observed", "user", "style-observation"],
    metadata: {
      memoryDocumentType: "user",
      projectRelated: false,
      extractedBy: "StyleObserver",
      observationKey: record.key,
      evidence: record.evidence,
    },
  };
}

function cleanupPool(pool: StyleObservationPoolFile, nowMs: number): StyleObservationPoolFile {
  // Rule cleanup is intentionally conservative; the LLM observation pruner handles semantic merges.
  // Keep recent or frequently seen candidates so later maintenance can promote them to durable memory.
  const candidates = mergeEquivalentCandidates(pool.candidates)
    .map((item) => applyDecay(item, nowMs))
    .filter((item) => {
      if (item.status === "rejected") return false;
      const lastSeenMs = Date.parse(item.last_seen);
      const lastAccessedMs = item.lastAccessedAt ? Date.parse(item.lastAccessedAt) : 0;
      if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs > STALE_DROP_MS && item.status === "candidate") return false;
      if (item.accessCount === 0 && item.lastAccessedAt && nowMs - lastAccessedMs > SILENT_ARCHIVE_MS && item.status === "promoted") {
        item.status = "archived";
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence || Date.parse(b.last_seen) - Date.parse(a.last_seen))
    .slice(0, MAX_CANDIDATES);
  return { version: 2, updatedAt: new Date(nowMs).toISOString(), candidates };
}

function mergeEquivalentCandidates(candidates: StyleObservationCandidate[]): StyleObservationCandidate[] {
  const byKey = new Map<string, StyleObservationCandidate>();
  for (const item of candidates) {
    const key = canonicalKey(item.candidate || item.key);
    item.key = key || item.key;
    const existing = byKey.get(item.key);
    if (!existing) {
      byKey.set(item.key, item);
      continue;
    }
    existing.candidate = betterCandidateLabel(existing.candidate, item.candidate);
    existing.first_seen = earlierIso(existing.first_seen, item.first_seen);
    existing.last_seen = laterIso(existing.last_seen, item.last_seen);
    existing.occurrences = Math.max(existing.occurrences, 0) + Math.max(item.occurrences, 0);
    existing.evidence = mergeEvidence(existing.evidence, item.evidence);
    existing.contradicted_by = mergeEvidence(existing.contradicted_by, item.contradicted_by);
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.accessCount += item.accessCount;
    existing.status = preferredStatus(existing.status, item.status);
    if (!existing.promotedMemoryName && item.promotedMemoryName) existing.promotedMemoryName = item.promotedMemoryName;
    setOptionalIso(existing, "lastPromotedAt", laterOptionalIso(existing.lastPromotedAt, item.lastPromotedAt));
    setOptionalIso(existing, "lastAccessedAt", laterOptionalIso(existing.lastAccessedAt, item.lastAccessedAt));
  }
  return [...byKey.values()];
}

function betterCandidateLabel(left: string, right: string): string {
  if (right.length < left.length && canonicalKey(left) === canonicalKey(right)) return right;
  if (/^用户偏好/.test(left) && /^用户偏好/.test(right)) return left.length <= right.length ? left : right;
  return left;
}

function mergeEvidence(left: StyleObservationEvidence[], right: StyleObservationEvidence[]): StyleObservationEvidence[] {
  const seen = new Set<string>();
  const out: StyleObservationEvidence[] = [];
  for (const item of [...left, ...right]) {
    const key = `${item.sid}\n${item.quote}\n${item.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-MAX_EVIDENCE);
}

function preferredStatus(left: StyleObservationCandidate["status"], right: StyleObservationCandidate["status"]): StyleObservationCandidate["status"] {
  const rank: Record<StyleObservationCandidate["status"], number> = { rejected: 4, promoted: 3, candidate: 2, archived: 1 };
  return rank[right] > rank[left] ? right : left;
}

function earlierIso(left: string, right: string): string {
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function laterIso(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function laterOptionalIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return laterIso(left, right);
}

function setOptionalIso(target: StyleObservationCandidate, key: "lastPromotedAt" | "lastAccessedAt", value: string | undefined): void {
  if (value) target[key] = value;
}

function applyDecay(item: StyleObservationCandidate, nowMs: number): StyleObservationCandidate {
  if (item.status !== "candidate" && item.status !== "promoted") return item;
  const lastSeenMs = Date.parse(item.last_seen);
  if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs < HALF_LIFE_MS) return item;
  const periods = Math.floor((nowMs - lastSeenMs) / HALF_LIFE_MS);
  item.confidence = clamp01(item.confidence * Math.pow(0.7, periods));
  return item;
}

function renderPromptHint(item: StyleObservationCandidate): string {
  return `观察池命中: ${item.candidate} (occurrences=${item.occurrences}, confidence=${item.confidence.toFixed(2)}). 如果这是用户当前表达的稳定偏好，可按 user/observed 规则写入或等待更多证据。`;
}

function renderHypothesisHint(item: StyleObservationCandidate): string {
  return `可验证的用户假设: ${item.candidate} (occurrences=${item.occurrences}, confidence=${item.confidence.toFixed(2)}). 只有当用户当前话题明显偏向这个主题、且没有明确不相干任务时，才可以自然确认；如果任务完全不相关，不要提起这条假设。`;
}

function normalizeFreeformCandidate(text: string): string | undefined {
  const sleep = text.match(/(?:又|老是|经常|总是)?\s*(熬夜|晚睡|通宵)(?:到)?\s*([^，,。.!！?？]{0,20})/u);
  if (sleep?.[1]) return `用户可能${sleep[1]}${sleep[2]?.trim() ? `到${sleep[2].trim()}` : ""}`;
  const cleaned = cleanValue(text);
  if (!cleaned || cleaned.length < 3 || cleaned.length > 60) return undefined;
  if (/^(你好|谢谢|好的|继续|可以|嗯|哦)$/u.test(cleaned)) return undefined;
  if (OBSERVATION_KEYWORDS.some((keyword) => cleaned.includes(keyword))) return `用户可能${cleaned}`;
  return undefined;
}

function cleanValue(value: string): string {
  return stripTrailingContext(value)
    .replace(/[。.!！?？].*$/u, "")
    .replace(/^[：:\s"'“”]+|[：:\s"'“”]+$/gu, "")
    .trim()
    .slice(0, 80);
}

function cleanIdentityValue(value: string): string {
  return stripTrailingContext(value)
    .replace(/^(?:是|做|读|学|搞|干)\s*/u, "")
    .replace(/[。.!！?？].*$/u, "")
    .replace(/^[：:\s"'“”]+|[：:\s"'“”]+$/gu, "")
    .trim()
    .slice(0, 60);
}

function stripTrailingContext(value: string): string {
  return value.split(/(?:，|,|；|;|但|不过|只是|然后|结果|所以|最近|今天|昨天|刚刚|这次|这回)/u)[0]?.trim() ?? value.trim();
}

function canonicalKey(value: string): string {
  return normalizePreferenceObjectKey(value)
    .toLowerCase()
    .replace(/^用户/u, "")
    .replace(/[\s"'“”《》<>，,。.!！?？：:；;、的了呢吧啊呀]/gu, "")
    .replace(/东方project/giu, "东方project")
    .trim();
}

function normalizePreferenceObjectKey(value: string): string {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!/(偏好|喜欢|最爱|爱好|钟爱|中意)/u.test(compact)) return value;
  const object = extractPreferenceObject(compact);
  return object ? `偏好${object}` : value;
}

function extractPreferenceObject(compact: string): string | undefined {
  const normalized = compact
    .replace(/^用户/u, "")
    .replace(/^(最喜欢的?|喜欢的?|偏好的?|最爱的?|爱好的?|钟爱的?|中意的?)/u, "")
    .replace(/^(ip|作品|游戏|曲子|音乐|角色|系列|东西|内容|题材|类型)(是|为|叫)?/u, "")
    .replace(/^(是|为|叫)/u, "")
    .replace(/^(偏好|喜欢|最爱|爱好|钟爱|中意)/u, "")
    .replace(/^(ip|作品|游戏|曲子|音乐|角色|系列|东西|内容|题材|类型)(是|为|叫)?/u, "")
    .replace(/^(是|为|叫)/u, "")
    .replace(/[\s"'“”《》<>，,。.!！?？：:；;、的了呢吧啊呀]/gu, "")
    .trim();
  if (isNonEvidenceObservationValue(normalized)) return undefined;
  return normalized.length >= 2 ? normalized : undefined;
}

const MEMORY_QUERY_SUBJECT_WORDS = ["\u6211", "\u7528\u6237", "\u672c\u4eba"];
const MEMORY_QUERY_TRIGGER_WORDS = ["\u559c\u6b22", "\u504f\u597d", "\u7231\u597d", "\u8ba8\u538c", "\u6392\u65a5", "\u4e60\u60ef", "\u8bb0\u5f97"];
const MEMORY_QUERY_PLACEHOLDER_WORDS = ["\u4ec0\u4e48", "\u5565", "\u54ea\u4e9b", "\u54ea\u4e2a", "\u54ea\u79cd", "\u8c01", "\u5417", "\u5462", "\u6709\u5565", "\u662f\u4ec0\u4e48", "\u6709\u4ec0\u4e48"];
const GENERIC_OBSERVATION_OBJECT_WORDS = ["\u8bdd\u9898", "\u4e3b\u9898", "\u4e1c\u897f", "\u5185\u5bb9", "\u4e8b\u7269"];

function isPreferenceDiscussionRequest(text: string): boolean {
  const compact = text.replace(/\s+/g, "").toLowerCase();
  const hasDiscussionVerb = ["\u804a\u804a", "\u804a\u4e00\u804a", "\u8c08\u8c08", "\u8bf4\u8bf4", "\u8bb2\u8bb2", "\u8ba8\u8bba", "\u5c55\u5f00\u804a", "\u804a\u4e0b"].some((word) => compact.includes(word));
  const hasSubject = MEMORY_QUERY_SUBJECT_WORDS.some((word) => compact.includes(word));
  const hasPreferenceTopic = ["\u559c\u6b22", "\u504f\u597d", "\u7231\u597d", "\u5174\u8da3", "\u8ba8\u538c", "\u4e60\u60ef"].some((word) => compact.includes(word));
  const english = /(?:talk|chat|discuss).{0,24}(?:my|user).{0,24}(?:likes?|preferences?|interests?|habits?)/iu.test(text);
  return english || (hasDiscussionVerb && hasSubject && hasPreferenceTopic);
}

function isMemoryQueryPollution(text: string): boolean {
  const compact = text.replace(/\s+/g, "").toLowerCase();
  const hasQuestionMark = text.includes("?") || text.includes("\uff1f");
  const hasSubject = MEMORY_QUERY_SUBJECT_WORDS.some((word) => compact.includes(word));
  const hasTrigger = MEMORY_QUERY_TRIGGER_WORDS.some((word) => compact.includes(word));
  const hasPlaceholder = MEMORY_QUERY_PLACEHOLDER_WORDS.some((word) => compact.includes(word));
  return hasSubject && hasTrigger && (hasQuestionMark || hasPlaceholder);
}

function isNonEvidenceObservationValue(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!compact) return true;
  if (isPreferencePlaceholder(compact)) return true;
  if (value.includes("?") || value.includes("\uff1f")) return true;
  if (MEMORY_QUERY_PLACEHOLDER_WORDS.includes(compact)) return true;
  if (isMemoryQueryPollution(value)) return true;
  const withoutPrefix = compact
    .replace(/^\u7528\u6237/u, "")
    .replace(/^\u53ef\u80fd/u, "")
    .replace(/^(\u559c\u6b22|\u504f\u597d|\u7231\u597d|\u8ba8\u538c|\u6392\u65a5|\u4e60\u60ef)/u, "")
    .replace(/^\u7684/u, "");
  if (MEMORY_QUERY_PLACEHOLDER_WORDS.includes(withoutPrefix)) return true;
  if (GENERIC_OBSERVATION_OBJECT_WORDS.includes(withoutPrefix)) return true;
  return false;
}

function markPollutedObservation(item: StyleObservationCandidate): StyleObservationCandidate {
  if (item.status === "rejected") return item;
  if (!isPollutedObservation(item)) return item;
  item.status = "rejected";
  item.confidence = 0;
  item.contradicted_by = mergeEvidence(item.contradicted_by, [{ sid: "rule_observation_cleanup", quote: "Rejected non-evidence question/placeholder observation.", at: new Date().toISOString() }]);
  return item;
}


function isPollutedObservation(item: StyleObservationCandidate): boolean {
  if (isNonEvidenceObservationValue(item.candidate) || isNonEvidenceObservationValue(item.key)) return true;
  return item.evidence.some((entry) => isMemoryQueryPollution(entry.quote) || isPreferenceDiscussionRequest(entry.quote));
}

function isPreferencePlaceholder(compact: string): boolean {
  const normalized = compact
    .replace(/^\u7528\u6237/u, "")
    .replace(/^\u53ef\u80fd/u, "")
    .replace(/^(\u559c\u6b22|\u504f\u597d|\u7231\u597d|\u8ba8\u538c|\u6392\u65a5|\u4e60\u60ef)/u, "")
    .replace(/^\u7684/u, "");
  return normalized.length === 0
    || normalized === "\u559c\u6b22"
    || normalized === "\u504f\u597d"
    || normalized === "\u7231\u597d"
    || normalized === "\u559c\u597d"
    || normalized === "\u5174\u8da3"
    || normalized === "preference"
    || normalized === "preferences"
    || normalized === "interest"
    || normalized === "interests";
}

function findObservationByLooseKey(items: Map<string, StyleObservationCandidate>, rawKey: string): StyleObservationCandidate | undefined {
  const wanted = canonicalKey(rawKey);
  for (const item of items.values()) {
    if (item.key === wanted) return item;
    if (canonicalKey(item.candidate) === wanted) return item;
    if (item.candidate === rawKey || item.key === rawKey) return item;
  }
  return undefined;
}

function overlaps(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function dedupeSignals(signals: ObservationSignal[]): ObservationSignal[] {
  const seen = new Set<string>();
  const out: ObservationSignal[] = [];
  const hasHabitForBase = new Set(
    signals
      .filter((signal) => signal.category === "frequency")
      .map((signal) => normalizeSignalBase(signal.key)),
  );
  for (const signal of signals) {
    if (!signal.key || seen.has(signal.key)) continue;
    if (signal.category === "schedule" && hasHabitForBase.has(normalizeSignalBase(signal.key))) continue;
    seen.add(signal.key);
    out.push(signal);
  }
  return out;
}

function normalizeSignalBase(key: string): string {
  return key
    .replace(/^(习惯|作息倾向|可能|频率|偏好|排斥)/u, "")
    .replace(/(早上起不来|越刷越精神|脑子有点钝)$/u, "")
    .trim();
}

function looksUnsafe(text: string): boolean {
  return /https?:\/\//i.test(text) || /```/.test(text) || /\b(import|export|function|class|interface|type|git|pnpm|npm|node)\b/i.test(text) || /[A-Za-z]:\\/.test(text);
}

function triggerProfile(text: string): { matched: boolean; hasFrequency: boolean } {
  const keywordMatched = OBSERVATION_KEYWORDS.some((keyword) => text.includes(keyword)) || OBSERVATION_ENGLISH_TRIGGER.test(text);
  const hasFrequency = FREQUENCY_PATTERN.test(text) || /\b(?:usually|generally|always|never|often|every\s+(?:day|week|time)|tend\s+to|used\s+to)\b/i.test(text);
  return { matched: keywordMatched, hasFrequency };
}

function shouldRejectObservation(text: string, hasFrequency: boolean): boolean {
  if (isMemoryQueryPollution(text) || isPreferenceDiscussionRequest(text)) return true;
  if (HISTORICAL_PATTERN.test(text)) return true;
  if (HYPOTHETICAL_PATTERN.test(text)) return true;
  if (THIRD_PERSON_PATTERN.test(text) && !RELATIONSHIP_PATTERN.test(text)) return true;
  if (META_MEMORY_PATTERN.test(text)) return true;
  if (ONE_OFF_EVENT_PATTERN.test(text) && !hasFrequency && !/又/u.test(text) && !RELATIONSHIP_PATTERN.test(text)) return true;
  return false;
}

function isHardBlockedPrivacy(text: string): boolean {
  return PRIVACY_BLOCK_PATTERN.test(text);
}

function signalModifier(text: string): number {
  let modifier = 1;
  if (WEAKEN_PATTERN.test(text)) modifier *= 0.65;
  if (BOOST_PATTERN.test(text)) modifier *= 1.18;
  if (STRONG_NEGATION_PATTERN.test(text)) modifier *= 1.12;
  return modifier;
}

function readPool(path: string): StyleObservationPoolFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StyleObservationPoolFile>;
    if (parsed.version === 2 && Array.isArray(parsed.candidates)) {
      return {
        version: 2,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        candidates: parsed.candidates.map(normalizeCandidate).filter((item): item is StyleObservationCandidate => Boolean(item)),
      };
    }
  } catch {
    // 观察池损坏或缺失时不影响主流程，后续写入会自动重建。
  }
  return { version: 2, updatedAt: new Date().toISOString(), candidates: [] };
}

function writePool(path: string, pool: StyleObservationPoolFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
  const legacy = join(dirname(path), "style-observations.json");
  if (existsSync(legacy)) {
    try { rmSync(legacy, { force: true }); } catch { /* ignore legacy cleanup */ }
  }
}

function readRejectedFile(path: string): RejectedFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RejectedFile>;
    return {
      version: 1,
      rejectedKeys: Array.isArray(parsed.rejectedKeys) ? parsed.rejectedKeys.filter((item): item is string => typeof item === "string") : [],
      rejectedTexts: Array.isArray(parsed.rejectedTexts) ? parsed.rejectedTexts.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { version: 1, rejectedKeys: [], rejectedTexts: [] };
  }
}

function writeRejectedFile(path: string, file: RejectedFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function normalizeCandidate(value: unknown): StyleObservationCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.candidate !== "string") return undefined;
  const key = typeof item.key === "string" ? item.key : canonicalKey(item.candidate);
  return {
    candidate: item.candidate,
    type: "user",
    key,
    first_seen: typeof item.first_seen === "string" ? item.first_seen : new Date().toISOString(),
    last_seen: typeof item.last_seen === "string" ? item.last_seen : new Date().toISOString(),
    occurrences: typeof item.occurrences === "number" ? item.occurrences : 1,
    evidence: Array.isArray(item.evidence) ? item.evidence.map(normalizeEvidence).filter((entry): entry is StyleObservationEvidence => Boolean(entry)) : [],
    confidence: typeof item.confidence === "number" ? clamp01(item.confidence) : 0.3,
    contradicted_by: Array.isArray(item.contradicted_by) ? item.contradicted_by.map(normalizeEvidence).filter((entry): entry is StyleObservationEvidence => Boolean(entry)) : [],
    status: item.status === "promoted" || item.status === "archived" || item.status === "rejected" ? item.status : "candidate",
    ...(typeof item.promotedMemoryName === "string" ? { promotedMemoryName: item.promotedMemoryName } : {}),
    ...(typeof item.lastPromotedAt === "string" ? { lastPromotedAt: item.lastPromotedAt } : {}),
    ...(typeof item.lastAccessedAt === "string" ? { lastAccessedAt: item.lastAccessedAt } : {}),
    accessCount: typeof item.accessCount === "number" ? item.accessCount : 0,
  };
}

function normalizeEvidence(value: unknown): StyleObservationEvidence | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.quote !== "string") return undefined;
  return {
    sid: typeof item.sid === "string" ? item.sid : "unknown-session",
    quote: item.quote.slice(0, 220),
    at: typeof item.at === "string" ? item.at : new Date().toISOString(),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const FREQUENCY_KEYWORDS = ["通常", "一般", "经常", "总是", "从来不", "从不", "老是", "老", "一直", "始终", "每天", "每周", "每月", "每次", "凡是", "但凡", "习惯于", "习惯", "已经习惯", "改不了"];
const PREFERENCE_KEYWORDS = ["喜欢", "爱", "偏爱", "偏好", "倾向于", "中意", "钟爱", "最爱", "上头", "讨厌", "烦", "受不了", "嫌", "怕", "抗拒", "排斥", "接受不了", "不喜欢", "没感觉"];
const IDENTITY_KEYWORDS = ["我是", "我是个", "我这人", "我属于", "我算是", "我在", "我做", "我从事", "我学", "我读", "我搞", "我干", "我之前做过", "我之前是", "我现在是", "我现在做"];
const SCHEDULE_KEYWORDS = ["早上", "上午", "中午", "下午", "晚上", "凌晨", "半夜", "周末", "工作日", "睡前", "起床", "醒来", "入睡", "熬夜", "早起", "早睡", "通宵"];
const PERSONALITY_KEYWORDS = ["急性子", "慢性子", "完美主义", "强迫症", "拖延", "社恐", "i人", "e人", "内向", "外向", "容易紧张", "容易焦虑", "心大", "想太多", "钻牛角尖", "玻璃心"];
const MOOD_KEYWORDS = ["最近很累", "最近有点累", "最近比较累", "最近很忙", "最近有点烦", "最近焦虑", "最近低落", "最近emo", "压力大"];
const GOAL_KEYWORDS = ["打算", "计划", "准备", "想要", "目标是", "在准备", "在考虑", "在学", "考研", "考公", "出国", "跳槽", "转行", "找工作", "读博", "副业"];
const RELATIONSHIP_KEYWORDS = ["我妈", "我爸", "我爷", "我奶", "我哥", "我姐", "我弟", "我妹", "我老婆", "我老公", "我对象", "我女朋友", "我男朋友", "我前任", "我室友", "我同事", "我老板", "我导师", "我导"];
const ABILITY_KEYWORDS = ["我懂", "我会", "我熟", "我精通", "我擅长", "我掌握", "我不会", "我不懂", "没接触过", "没学过", "不太熟", "一窍不通", "小白", "经验"];
const COLLABORATION_KEYWORDS = ["你直接说", "别废话", "简洁点", "别那么啰嗦", "长话短说", "给结论", "给步骤", "详细点", "展开讲", "多讲点", "一步一步", "我自己来", "你帮我", "你别管", "你别插手"];

const OBSERVATION_KEYWORDS = [
  ...FREQUENCY_KEYWORDS,
  ...PREFERENCE_KEYWORDS,
  ...IDENTITY_KEYWORDS,
  ...SCHEDULE_KEYWORDS,
  ...PERSONALITY_KEYWORDS,
  ...MOOD_KEYWORDS,
  ...GOAL_KEYWORDS,
  ...RELATIONSHIP_KEYWORDS,
  ...ABILITY_KEYWORDS,
  ...COLLABORATION_KEYWORDS,
];

const OBSERVATION_ENGLISH_TRIGGER = /\b(?:usually|generally|always|never|often|every\s+(?:day|week|time)|tend\s+to|used|like|love|prefer|fan\s+of|hate|dislike|can't\s+stand|annoyed\s+by|i'm\s+a|i\s+work\s+as|my\s+role\s+is|morning|night|weekend|bedtime|stay\s+up|wake\s+up|planning\s+to|preparing\s+for|goal\s+is|familiar\s+with|expert\s+in|step\s+by\s+step|tl;dr)\b/i;

interface ObservationRule {
  category: ObservationSignalCategory;
  pattern: RegExp;
  render: (value: string, fullText: string) => string;
  baseStrength: number;
  tags: string[];
  requireFrequency?: boolean;
  promotionOccurrences?: number;
  ttlDays?: number;
}

const OBSERVATION_RULES: ObservationRule[] = [
  {
    category: "frequency",
    pattern: /(?:我|本人|用户)?(?:通常|一般|经常|总是|老是|一直|始终|每天|每周|每月|每次|凡是|但凡|习惯于?|已经习惯|改不了)\s*([^\r\n]{2,80})/u,
    render: (value) => `用户习惯${value}`,
    baseStrength: 0.42,
    tags: ["observed", "frequency", "habit"],
    promotionOccurrences: 3,
  },
  {
    category: "frequency",
    pattern: /(?:我|本人|用户)?(?:从来不|从不|绝对不|永远不|死都不)\s*([^\r\n]{2,80})/u,
    render: (value) => `用户不${value}`,
    baseStrength: 0.48,
    tags: ["observed", "frequency", "negative-habit"],
    promotionOccurrences: 2,
  },
  {
    category: "preference",
    pattern: /(?:我|本人|用户)?(?:喜欢|爱|偏爱|偏好|倾向于|中意|钟爱|最爱|上头)\s*([^\r\n]{2,80})/u,
    render: (value) => `用户偏好${value}`,
    baseStrength: 0.38,
    tags: ["observed", "preference"],
    promotionOccurrences: 2,
  },
  {
    category: "preference",
    pattern: /(?:我|本人|用户)?(?:讨厌|烦|受不了|嫌|怕|抗拒|排斥|接受不了|不喜欢|没感觉)\s*([^\r\n]{2,80})/u,
    render: (value) => `用户排斥${value}`,
    baseStrength: 0.4,
    tags: ["observed", "preference", "dislike"],
    promotionOccurrences: 2,
  },
  {
    category: "identity",
    pattern: /(?:我是(?:个|名)?|我这人|我属于|我算是|我(?:在|做|从事|学|读|搞|干)|我之前(?:做过|是)|我现在(?:是|做))\s*([^\r\n]{2,60})/u,
    render: (value, fullText) => /之前|做过/u.test(fullText) ? `用户经历: ${cleanIdentityValue(value)}` : `用户身份或特质: ${cleanIdentityValue(value)}`,
    baseStrength: 0.52,
    tags: ["observed", "identity"],
    promotionOccurrences: 1,
  },
  {
    category: "schedule",
    pattern: /(?:我|本人|用户)?(?:通常|一般|经常|总是|每天|每周|每次|老是|又)?\s*((?:早上|上午|中午|下午|晚上|凌晨|半夜|周末|工作日|睡前|起床|醒来|入睡|熬夜|早起|早睡|通宵|\d{1,2}\s?点(?:才|就)?)[^\r\n]{0,60})/u,
    render: (value) => `用户作息倾向: ${value}`,
    baseStrength: 0.35,
    tags: ["observed", "schedule"],
    requireFrequency: true,
    promotionOccurrences: 3,
  },
  {
    category: "personality",
    pattern: /(急性子|慢性子|完美主义|强迫症|拖延|社恐|内向|外向|i人|e人|容易紧张|容易焦虑|心大|想太多|钻牛角尖|玻璃心)/iu,
    render: (value) => `用户性格倾向: ${value}`,
    baseStrength: 0.42,
    tags: ["observed", "personality"],
    promotionOccurrences: 2,
  },
  {
    category: "mood",
    pattern: /最近(?:很|有点|挺|比较)?\s*(累|忙|烦|焦虑|低落|emo|压力大|开心)/iu,
    render: (value) => `用户近期状态可能${value}`,
    baseStrength: 0.22,
    tags: ["observed", "mood", "temporary"],
    promotionOccurrences: 4,
    ttlDays: 30,
  },
  {
    category: "goal",
    pattern: /(?:我|本人|用户)?(?:打算|计划|准备|想要|目标是|在(?:准备|学|考虑))\s*([^\r\n]{2,80})/u,
    render: (value) => `用户中长期目标: ${value}`,
    baseStrength: 0.42,
    tags: ["observed", "goal"],
    promotionOccurrences: 2,
    ttlDays: 60,
  },
  {
    category: "relationship",
    pattern: /我(妈|爸|爷|奶|哥|姐|弟|妹|老婆|老公|对象|女朋友|男朋友|前任|室友|同事|老板|导师|导)/u,
    render: (value) => `用户存在关系: ${relationshipLabel(value)}`,
    baseStrength: 0.36,
    tags: ["observed", "relationship", "privacy-minimized"],
    promotionOccurrences: 3,
  },
  {
    category: "ability",
    pattern: /(?:我|本人|用户)(?:懂|会|熟|精通|擅长|掌握|不会|不懂|没用过|没学过|没接触过|不太熟)\s*([^\r\n]{2,60})/u,
    render: (value, fullText) => /不会|不懂|没用过|没学过|没接触过|不太熟/u.test(fullText) ? `用户不熟悉${value}` : `用户熟悉${value}`,
    baseStrength: 0.42,
    tags: ["observed", "ability"],
    promotionOccurrences: 2,
  },
  {
    category: "ability",
    pattern: /我有\s*([\d一二三四五六七八九十]+\s*年[^\r\n]{0,40}经验)/u,
    render: (value) => `用户经验: ${value}`,
    baseStrength: 0.48,
    tags: ["observed", "ability", "experience"],
    promotionOccurrences: 1,
  },
  {
    category: "collaboration",
    pattern: /(你直接说|别废话|简洁点|别那么啰嗦|长话短说|给结论|给步骤|详细点|展开讲|多讲点|一步一步|我自己来|你帮我|你别(?:管|插手))/u,
    render: (value) => `用户协作风格偏好: ${value}`,
    baseStrength: 0.45,
    tags: ["observed", "collaboration", "style"],
    promotionOccurrences: 2,
  },
];

const FREQUENCY_PATTERN = /(?:通常|一般|经常|总是|从来不|从不|老是|一直|始终|每[天周月次]|凡是|但凡|只要.*就|习惯于?|已经习惯|改不了)/u;
const HISTORICAL_PATTERN = /(?:小时候|以前|那时候|之前一直|上学时|几年前|used\s+to|back\s+when|years\s+ago)/iu;
const HYPOTHETICAL_PATTERN = /(?:如果|假如|要是|万一|就算|哪怕|\bif\b|suppose|what\s+if)/iu;
const RELATIONSHIP_PATTERN = /我(妈|爸|爷|奶|哥|姐|弟|妹|老婆|老公|对象|女朋友|男朋友|前任|室友|同事|老板|导师|导)/u;
const THIRD_PERSON_PATTERN = /(?:他|她|他们|她们|我朋友|我同学|我同事说|我看见有人|别人都)/u;
const ONE_OFF_EVENT_PATTERN = /(?:今天|昨天|刚刚|这次|这回|刚才)/u;
const META_MEMORY_PATTERN = /(?:你能记住|你之前说|我们刚才聊到|记忆系统|观察池|memory system)/iu;
const PRIVACY_BLOCK_PATTERN = /(?:身份证|手机号|银行卡|密码|住址|病史|政治倾向|宗教|ssn|phone|card|address|diagnosis|religion|political)/iu;
const WEAKEN_PATTERN = /(?:也许|可能|大概|估计|好像|似乎|偶尔|有时|不一定|maybe|probably|sometimes|occasionally)/iu;
const BOOST_PATTERN = /(?:确实|真的|一直都|必然|必须|死活|就是|偏|definitely|always|for\s+sure|really)/iu;
const STRONG_NEGATION_PATTERN = /(?:从不|从来不|绝对不|永远不|死都不|never)/iu;

function relationshipLabel(value: string): string {
  const map: Record<string, string> = {
    妈: "母亲",
    爸: "父亲",
    爷: "祖父",
    奶: "祖母",
    哥: "哥哥",
    姐: "姐姐",
    弟: "弟弟",
    妹: "妹妹",
    老婆: "伴侣",
    老公: "伴侣",
    对象: "伴侣",
    女朋友: "伴侣",
    男朋友: "伴侣",
    前任: "前任关系",
    室友: "室友",
    同事: "同事",
    老板: "上级",
    导师: "导师",
    导: "导师",
  };
  return map[value] ?? value;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j] as T;
    out[j] = tmp as T;
  }
  return out;
}
