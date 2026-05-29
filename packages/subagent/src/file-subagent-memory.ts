import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextBlock, MemoryRecord, SubAgentResult } from "@jue/shared-types";
import { newId } from "@jue/utils";
import type { SubAgentMemoryProvider } from "./types.js";

export interface FileSubAgentMemoryProviderOptions {
  globalJueDir: string;
  maxLines?: number;
}

interface RecordDecision {
  shouldRecord: boolean;
  reason: string;
  category: "failure_lesson" | "project_navigation" | "quality_standard" | "planning_preference" | "reusable_workflow" | "none";
}

interface SubAgentExperiencePolicy {
  recordFailures: "never" | "reusable_only" | "always";
  categories: RecordDecision["category"][];
  minSignals: number;
}

const DEFAULT_POLICY: SubAgentExperiencePolicy = { recordFailures: "reusable_only", categories: ["reusable_workflow", "failure_lesson"], minSignals: 2 };

const POLICIES: Record<string, SubAgentExperiencePolicy> = {
  explorer: { recordFailures: "reusable_only", categories: ["project_navigation", "failure_lesson"], minSignals: 2 },
  verification: { recordFailures: "reusable_only", categories: ["quality_standard", "failure_lesson"], minSignals: 2 },
  plan: { recordFailures: "reusable_only", categories: ["planning_preference", "reusable_workflow", "failure_lesson"], minSignals: 2 },
  general: { recordFailures: "reusable_only", categories: ["reusable_workflow", "failure_lesson"], minSignals: 2 },
};

const INTERNAL_NO_WRITE_TYPES = new Set(["compaction", "memory_extractor", "dream_memory_pruning", "dream_observation_pruning", "session_search"]);

export class FileSubAgentMemoryProvider implements SubAgentMemoryProvider {
  private readonly rootDir: string;
  private readonly maxLines: number;

  constructor(options: FileSubAgentMemoryProviderOptions) {
    this.rootDir = join(options.globalJueDir, "subagents");
    this.maxLines = options.maxLines ?? 100;
  }

  loadForSubAgent(input: Parameters<SubAgentMemoryProvider["loadForSubAgent"]>[0]): { records: MemoryRecord[]; blocks: ContextBlock[] } {
    const now = Date.now();
    const file = this.memoryFile(input.registration.displayName, input.registration.type);
    ensureFile(file, input.registration.displayName);
    const content = trimToLineBudget(readFileSync(file, "utf8"), this.maxLines);
    if (!content.trim()) return { records: [], blocks: [] };
    return {
      records: [],
      blocks: [{
        id: newId("ctxb"),
        type: "subagent_memory",
        source: "memory",
        priority: 55,
        tokenEstimate: Math.ceil(content.length / 4),
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        relevance: 0.65,
        pinned: false,
        compressible: true,
        compressionStrategy: "summary",
        sensitivity: "internal",
        content: "[SubAgent memory: " + input.registration.displayName + "]\n" + content,
        rawRef: { kind: "file", id: file },
        tags: ["subagent_memory", input.registration.type],
      }],
    };
  }

  recordAfterRun(input: Parameters<NonNullable<SubAgentMemoryProvider["recordAfterRun"]>>[0]): void {
    const decision = shouldRecordRun(input.registration.type, input.result);
    if (!decision.shouldRecord) return;

    const file = this.memoryFile(input.registration.displayName, input.registration.type);
    ensureFile(file, input.registration.displayName);
    const content = readFileSync(file, "utf8");
    const entry = renderExperienceEntry(input, decision);
    if (isDuplicateExperience(content, entry)) return;

    appendFileSync(file, entry + "\n", "utf8");
    compactIfNeeded(file, this.maxLines);
  }

  private memoryFile(displayName: string, type: string): string {
    return join(this.rootDir, type, safeFileName(displayName || type) + ".md");
  }
}

function ensureFile(file: string, displayName: string): void {
  const dir = file.slice(0, file.lastIndexOf("\\") > -1 ? file.lastIndexOf("\\") : file.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, "# " + displayName + " memory\n\nOnly durable, reusable subagent lessons are recorded here. Do not record ordinary task summaries.\n", "utf8");
  }
}

function compactIfNeeded(file: string, maxLines: number): void {
  const content = readFileSync(file, "utf8");
  const compacted = trimToLineBudget(content, maxLines);
  if (compacted === content) return;
  writeFileSync(file, compacted, "utf8");
}

function trimToLineBudget(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const header = lines.slice(0, 3);
  const tail = lines.slice(Math.max(3, lines.length - Math.max(0, maxLines - header.length)));
  return [...header, "", "<!-- older subagent experience entries compacted by line budget -->", ...tail].join("\n");
}

function shouldRecordRun(subagentType: string, result: SubAgentResult): RecordDecision {
  if (INTERNAL_NO_WRITE_TYPES.has(subagentType)) return { shouldRecord: false, reason: "internal subagent", category: "none" };
  const policy = POLICIES[subagentType] ?? DEFAULT_POLICY;
  const text = experienceText(result);
  const signals = durableSignals(text, result);
  const category = classifyCategory(subagentType, text, result);

  if (result.status !== "succeeded") {
    if (policy.recordFailures === "always") return { shouldRecord: true, reason: "failed run", category: "failure_lesson" };
    if (policy.recordFailures === "reusable_only" && category === "failure_lesson" && signals >= policy.minSignals) {
      return { shouldRecord: true, reason: "reusable failure lesson", category };
    }
    return { shouldRecord: false, reason: "failure without reusable lesson", category: "none" };
  }

  if (!policy.categories.includes(category)) return { shouldRecord: false, reason: "category not allowed for subagent", category: "none" };
  if (signals < policy.minSignals) return { shouldRecord: false, reason: "not enough durable signals", category: "none" };
  return { shouldRecord: true, reason: "durable reusable experience", category };
}

function durableSignals(text: string, result: SubAgentResult): number {
  let score = 0;
  if (/(user|human|operator).{0,40}(prefer|expects?|confirmed|corrected|asked|requires?)/i.test(text)) score += 2;
  if (/(lesson|pitfall|gotcha|avoid|must|always|never|reusable|future|repeat)/i.test(text)) score += 2;
  if (/(entry point|workspace|module|package|directory|root|monorepo|navigation)/i.test(text)) score += 1;
  if (/(quality|regression|test|risk|review|lint|typecheck|coverage)/i.test(text)) score += 1;
  if (/(architecture|plan|tradeoff|constraint|decision|design|migration)/i.test(text)) score += 1;
  if (result.risks.some((risk) => risk.level === "high" && /(repeat|future|always|must|avoid|reusable)/i.test(risk.description))) score += 2;
  if (result.evidence.some((item) => /(confirmed|user|preference|pitfall|lesson|reusable)/i.test(item.summary))) score += 1;
  return score;
}

function classifyCategory(subagentType: string, text: string, result: SubAgentResult): RecordDecision["category"] {
  if (result.status !== "succeeded" && /(lesson|pitfall|gotcha|avoid|reusable|future|repeat)/i.test(text)) return "failure_lesson";
  if (subagentType === "explorer" && /(entry point|workspace|module|package|directory|root|monorepo|navigation)/i.test(text)) return "project_navigation";
  if (subagentType === "verification" && /(quality|regression|test|risk|review|lint|typecheck|coverage)/i.test(text)) return "quality_standard";
  if (subagentType === "plan" && /(architecture|plan|tradeoff|constraint|decision|design|migration)/i.test(text)) return "planning_preference";
  if (/(workflow|process|reuse|reusable|future|always|never|must|avoid)/i.test(text)) return "reusable_workflow";
  return "none";
}

function renderExperienceEntry(input: Parameters<NonNullable<SubAgentMemoryProvider["recordAfterRun"]>>[0], decision: RecordDecision): string {
  const result = input.result;
  const lines = [
    "",
    "## " + new Date().toISOString() + " " + oneLine(input.task.title, 80),
    "- category: " + decision.category,
    "- reason: " + decision.reason,
    "- status: " + result.status,
    "- lesson: " + selectLesson(result),
  ];
  const risks = result.risks.filter((risk) => risk.level === "high").map((risk) => oneLine(risk.description, 220));
  if (risks.length > 0) lines.push("- highRisk: " + risks.join("; "));
  const actions = result.suggestedActions.filter((action) => /(always|never|must|avoid|prefer|reusable|future|workflow)/i.test(action.label + " " + (action.description ?? "")));
  if (actions.length > 0) lines.push("- reusableActions: " + actions.map((action) => oneLine(action.label, 160)).join("; "));
  return lines.join("\n");
}

function selectLesson(result: SubAgentResult): string {
  const candidates = [
    ...result.risks.map((risk) => risk.description),
    ...result.evidence.map((item) => item.summary),
    result.details,
    result.conclusion,
  ].filter((item): item is string => Boolean(item?.trim()));
  const reusable = candidates.find((item) => /(lesson|pitfall|gotcha|avoid|must|always|never|prefer|reusable|future|workflow)/i.test(item));
  return oneLine(reusable ?? result.conclusion, 320);
}

function isDuplicateExperience(existing: string, entry: string): boolean {
  const existingTokens = tokenSet(existing);
  const entryTokens = tokenSet(entry);
  if (entryTokens.size === 0) return true;
  let overlap = 0;
  for (const token of entryTokens) if (existingTokens.has(token)) overlap += 1;
  return overlap / entryTokens.size >= 0.72;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 3));
}

function experienceText(result: SubAgentResult): string {
  return [
    result.conclusion,
    result.details ?? "",
    ...result.evidence.map((item) => item.summary),
    ...result.risks.map((risk) => risk.description + " " + (risk.mitigation ?? "")),
    ...result.suggestedActions.map((action) => action.label + " " + (action.description ?? "")),
  ].join("\n");
}

function safeFileName(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "subagent";
}

function oneLine(text: string, maxChars = 500): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}
