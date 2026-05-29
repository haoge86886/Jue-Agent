import type { MemoryDocumentType, MemoryQuery, MemoryRecord, MemoryScope } from "@jue/shared-types";

export interface MemoryRetrievalInput {
  text: string;
  scopes?: MemoryScope[];
  workspaceRoot?: string;
  limit?: number;
  minScore?: number;
  subagentType?: string;
  documentTypes?: MemoryDocumentType[];
  tags?: string[];
  minWeight?: number;
  minConfidence?: number;
}

export interface RetrievedMemory {
  record: MemoryRecord;
  score: number;
  matchedTerms: string[];
  reason: string;
  requiresVerification: boolean;
  ageDays: number;
}

export interface MemoryRetrievalResult {
  query: string;
  memories: RetrievedMemory[];
  diagnostics: string[];
}

export interface MemoryRetrieverSource {
  query(q: MemoryQuery): Promise<MemoryRecord[]>;
}

export class MemoryRetriever {
  constructor(private readonly source: MemoryRetrieverSource) {}

  async retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult> {
    const query = input.text.trim();
    if (!query) return { query, memories: [], diagnostics: ["empty query"] };
    const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : ["user", "global", "project"] as MemoryScope[];
    const intent = inferRetrievalIntent(query);
    const candidates = await this.source.query({
      scopes,
      kinds: [],
      tags: input.tags ?? [],
      documentTypes: input.documentTypes ?? [],
      includeIndexOnly: false,
      status: "active",
      ...(shouldPrefilterByText(query, intent) ? { text: query } : {}),
      ...(input.minWeight !== undefined ? { minWeight: input.minWeight } : {}),
      ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
      limit: Math.max(50, (input.limit ?? 8) * 8),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    });
    const ranked = candidates
      .map((record) => scoreMemory(record, query, input.subagentType))
      .filter((item) => item.score >= (input.minScore ?? 0.18))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 8);
    return {
      query,
      memories: ranked,
      diagnostics: [`candidates=${candidates.length} selected=${ranked.length} scopes=${scopes.join(",")} intent=${intent}`],
    };
  }
}

function shouldPrefilterByText(query: string, intent: RetrievalIntent): boolean {
  if (intent === "personal" || intent === "workflow") return false;
  return !/(?:\u8bb0\u5fc6|\u8bb0\u5f97|\u7528\u6237\u753b\u50cf|memory|remember|profile|preference)/iu.test(query);
}

function scoreMemory(record: MemoryRecord, query: string, subagentType?: string): RetrievedMemory {
  const haystack = [record.title, record.summary ?? "", record.content, record.tags.join(" ")].join(" ").toLowerCase();
  const terms = tokenize(query);
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  const titleTerms = terms.filter((term) => record.title.toLowerCase().includes(term));
  const summaryTerms = terms.filter((term) => (record.summary ?? "").toLowerCase().includes(term));
  const lexical = terms.length === 0 ? 0 : matchedTerms.length / terms.length;
  const titleBoost = terms.length === 0 ? 0 : titleTerms.length / terms.length * 0.12;
  const summaryBoost = terms.length === 0 ? 0 : summaryTerms.length / terms.length * 0.08;
  const intent = inferRetrievalIntent(query);
  const scopeBoost = scoreScope(record.scope, intent);
  const kindBoost = scoreKind(record, query, intent);
  const memoryRequestBoost = scoreGenericMemoryRequest(record, query, intent);
  const ageDays = Math.max(0, Math.floor((Date.now() - record.createdAt) / 86400000));
  const freshness = Math.max(0, 1 - ageDays / 365) * 0.08;
  const weight = record.weight * 0.25 + record.confidence * 0.16;
  const verificationPenalty = requiresVerification(record) ? 0.03 : 0;
  const sharingPenalty = subagentType && !canShareWithSubAgent(record, subagentType) ? 1 : 0;
  const score = Math.max(0, lexical * 0.34 + titleBoost + summaryBoost + weight + scopeBoost + kindBoost + memoryRequestBoost + freshness - verificationPenalty - sharingPenalty);
  return {
    record,
    score,
    matchedTerms,
    reason: buildReason({ matchedTerms, intent, scope: record.scope, kind: record.kind, requiresVerification: requiresVerification(record) }),
    requiresVerification: requiresVerification(record),
    ageDays,
  };
}

type RetrievalIntent = "personal" | "project" | "reference" | "workflow" | "general";

function inferRetrievalIntent(query: string): RetrievalIntent {
  if (/like|prefer|interest|profile|user|me|my|\u559c\u6b22|\u504f\u597d|\u5174\u8da3|\u6211|\u7528\u6237/u.test(query)) return "personal";
  if (/project|decision|deadline|architecture|\u9879\u76ee|\u51b3\u7b56|\u67b6\u6784|\u622a\u6b62/u.test(query)) return "project";
  if (/link|url|dashboard|linear|grafana|reference|\u94fe\u63a5|\u5916\u90e8|\u5f15\u7528|\u4eea\u8868\u76d8/u.test(query)) return "reference";
  if (/workflow|rule|always|never|\u6d41\u7a0b|\u89c4\u5219|\u6bcf\u6b21|\u4e0d\u8981/u.test(query)) return "workflow";
  return "general";
}

function scoreScope(scope: MemoryScope, intent: RetrievalIntent): number {
  if (intent === "personal") return scope === "user" ? 0.14 : scope === "global" ? 0.05 : 0;
  if (intent === "project") return scope === "project" ? 0.14 : scope === "global" ? 0.04 : 0;
  if (intent === "workflow") return scope === "global" ? 0.12 : scope === "project" ? 0.08 : 0;
  if (intent === "reference") return scope === "project" ? 0.1 : 0.02;
  return scope === "project" ? 0.08 : scope === "user" ? 0.06 : scope === "global" ? 0.04 : 0;
}

function scoreKind(record: MemoryRecord, query: string, intent: RetrievalIntent): number {
  if (record.kind === "preference" && intent === "personal") return 0.12;
  if (record.kind === "rule" && intent === "workflow") return 0.12;
  if (record.kind === "fact" && (intent === "project" || intent === "reference")) return 0.08;
  if (record.kind === "goal" && /goal|plan|\u76ee\u6807|\u8ba1\u5212/u.test(query)) return 0.08;
  return 0;
}

function scoreGenericMemoryRequest(record: MemoryRecord, query: string, intent: RetrievalIntent): number {
  const asksForMemory = /(?:\u8bb0\u5fc6|\u8bb0\u5f97|memory|remember)/iu.test(query);
  if (!asksForMemory) return 0;
  if (intent === "personal" && record.scope === "user") return 0.16;
  if (record.scope === "user" && (record.kind === "preference" || record.kind === "fact")) return 0.12;
  if (record.scope === "global" && record.kind === "rule") return 0.08;
  return 0.03;
}

function buildReason(input: { matchedTerms: string[]; intent: RetrievalIntent; scope: MemoryScope; kind: string; requiresVerification: boolean }): string {
  const parts = [
    input.matchedTerms.length > 0 ? `matched terms: ${input.matchedTerms.join(", ")}` : "selected by weight/scope/freshness",
    `intent=${input.intent}`,
    `scope=${input.scope}`,
    `kind=${input.kind}`,
  ];
  if (input.requiresVerification) parts.push("verify-before-use");
  return parts.join("; ");
}

function canShareWithSubAgent(record: MemoryRecord, subagentType: string): boolean {
  if (record.sensitivity === "secret" || record.sensitivity === "private") return false;
  const sharing = record.sharing;
  if (!sharing) return true;
  if (!sharing.shareWithSubAgents) return false;
  return sharing.allowedSubAgentTypes.length === 0 || sharing.allowedSubAgentTypes.includes(subagentType);
}

function requiresVerification(record: MemoryRecord): boolean {
  const text = [record.title, record.summary ?? "", record.content].join(" ");
  return /(?:[A-Za-z]:\\|\/|\.ts\b|\.tsx\b|\.js\b|function\s+|class\s+|flag|version|dependency|\u6587\u4ef6|\u51fd\u6570|\u4f9d\u8d56|\u7248\u672c)/u.test(text);
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const ascii = normalized.split(/[^a-z0-9_\-]+/).filter((term) => term.length >= 2);
  const cjk = Array.from(new Set((normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []).flatMap((chunk) => cjkNgrams(chunk))));
  return Array.from(new Set([...ascii, ...cjk])).slice(0, 64);
}

function cjkNgrams(text: string): string[] {
  if (text.length <= 4) return [text];
  const out = [text];
  for (let i = 0; i <= text.length - 2; i++) out.push(text.slice(i, i + 2));
  for (let i = 0; i <= text.length - 3; i++) out.push(text.slice(i, i + 3));
  return out;
}
