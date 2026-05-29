import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { MemoryDocument, MemoryMaintenanceResult, MemoryQuery } from "@jue/shared-types";
import { workspacePathSlug, type MemoryRepository } from "./repository.js";
import { StyleObserver, type StyleObservationCandidate } from "./style-observer.js";

const DREAM_STATE_FILE = "dream-state.json";
const DREAM_EVENTS_FILE = "dream-events.jsonl";
const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DREAM_MIN_NEW_MEMORY_SESSIONS = 5;

export interface DreamSessionSummary {
  sessionId: string;
  title?: string;
  lastActiveAt?: number;
  summary: string;
}

export interface DreamRepositorySignal {
  cwd: string;
  gitBranch?: string;
  gitStatus?: string;
  recentGitCommits?: string[];
  collectedAt: string;
}

export interface DreamMemoryPruningContext {
  nowIso: string;
  workspaceRoot: string;
  memoryIndexes: Array<{ scope: "user" | "global" | "project"; path: string; content: string }>;
  recentSessionSummaries: DreamSessionSummary[];
  repositorySignal: DreamRepositorySignal;
  observationPool: StyleObservationCandidate[];
  gate: DreamMemoryGateDecision;
}

export interface DreamMemoryGateDecision {
  shouldRun: boolean;
  reason: string;
  hoursSinceLastRun: number | null;
  newMemorySessionCount: number;
  newMemorySessionIds: string[];
  lastRunAt?: number;
  lastProcessedMemoryUpdatedAt?: number;
}

export interface DreamMemoryRunResult {
  gate: DreamMemoryGateDecision;
  maintenance?: MemoryMaintenanceResult;
  statePath: string;
}

interface DreamMemoryState {
  version: 1;
  lastRunAt?: number;
  lastProcessedMemoryUpdatedAt?: number;
  lastProcessedEventAt?: number;
  processedSessionIds: string[];
  lastResult?: {
    at: number;
    checked: number;
    removed: number;
    compacted: number;
    rewrittenIndexes: number;
    diagnostics: string[];
  };
}

export interface DreamMemoryMaintenanceServiceOptions {
  globalJueDir: string;
  workspaceRoot: string;
  repository: MemoryRepository;
  maintain: (context: DreamMemoryPruningContext) => Promise<MemoryMaintenanceResult>;
  now?: () => number;
  minIntervalMs?: number;
  minNewMemorySessions?: number;
}

export class DreamMemoryMaintenanceService {
  private readonly globalJueDir: string;
  private readonly workspaceRoot: string;
  private readonly repository: MemoryRepository;
  private readonly maintainFn: (context: DreamMemoryPruningContext) => Promise<MemoryMaintenanceResult>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly minNewMemorySessions: number;

  constructor(options: DreamMemoryMaintenanceServiceOptions) {
    this.globalJueDir = options.globalJueDir;
    this.workspaceRoot = options.workspaceRoot;
    this.repository = options.repository;
    this.maintainFn = options.maintain;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? DREAM_MIN_INTERVAL_MS;
    this.minNewMemorySessions = options.minNewMemorySessions ?? DREAM_MIN_NEW_MEMORY_SESSIONS;
  }

  async runIfDue(): Promise<DreamMemoryRunResult> {
    const statePath = this.statePath();
    const state = readDreamState(statePath);
    const docs = await this.listDocuments();
    const gate = this.evaluateGate(state, docs);
    if (!gate.shouldRun) {
      writeDreamState(statePath, state);
      return { gate, statePath };
    }

    const maintenance = await this.maintainFn(this.buildContext(gate));
    const updatedState: DreamMemoryState = {
      version: 1,
      lastRunAt: this.now(),
      lastProcessedMemoryUpdatedAt: maxMemoryUpdatedAt(docs),
      lastProcessedEventAt: this.now(),
      processedSessionIds: Array.from(new Set([...state.processedSessionIds, ...gate.newMemorySessionIds])).slice(-500),
      lastResult: {
        at: this.now(),
        checked: maintenance.checked,
        removed: maintenance.removed,
        compacted: maintenance.compacted,
        rewrittenIndexes: maintenance.rewrittenIndexes,
        diagnostics: maintenance.diagnostics,
      },
    };
    writeDreamState(statePath, updatedState);
    return { gate, maintenance, statePath };
  }


  async runManual(): Promise<DreamMemoryRunResult> {
    const statePath = this.statePath();
    const state = readDreamState(statePath);
    const docs = await this.listDocuments();
    const now = this.now();
    const lastRunAt = state.lastRunAt;
    const gate: DreamMemoryGateDecision = {
      shouldRun: true,
      reason: "manual /dream command",
      hoursSinceLastRun: lastRunAt ? (now - lastRunAt) / (60 * 60 * 1000) : null,
      newMemorySessionCount: 0,
      newMemorySessionIds: [],
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(state.lastProcessedMemoryUpdatedAt ? { lastProcessedMemoryUpdatedAt: state.lastProcessedMemoryUpdatedAt } : {}),
    };
    const context = this.buildContext(gate);
    const maintenance = await this.maintainFn(context);
    const updatedState: DreamMemoryState = {
      version: 1,
      lastRunAt: now,
      lastProcessedMemoryUpdatedAt: maxMemoryUpdatedAt(docs),
      lastProcessedEventAt: now,
      processedSessionIds: state.processedSessionIds.slice(-500),
      lastResult: {
        at: now,
        checked: maintenance.checked,
        removed: maintenance.removed,
        compacted: maintenance.compacted,
        rewrittenIndexes: maintenance.rewrittenIndexes,
        diagnostics: maintenance.diagnostics,
      },
    };
    writeDreamState(statePath, updatedState);
    return { gate, maintenance, statePath };
  }

  async inspectGate(): Promise<DreamMemoryGateDecision> {
    return this.evaluateGate(readDreamState(this.statePath()), await this.listDocuments());
  }


  private buildContext(gate: DreamMemoryGateDecision): DreamMemoryPruningContext {
    return {
      nowIso: new Date(this.now()).toISOString(),
      workspaceRoot: this.workspaceRoot,
      memoryIndexes: this.readMemoryIndexes(),
      recentSessionSummaries: this.readRecentSessionSummaries(gate.newMemorySessionIds),
      repositorySignal: collectRepositorySignal(this.workspaceRoot),
      observationPool: new StyleObserver({ globalJueDir: this.globalJueDir }).listCandidates(120),
      gate,
    };
  }

  private async listDocuments(): Promise<MemoryDocument[]> {
    if (!this.repository.listDocuments) return [];
    return this.repository.listDocuments({
      scopes: ["user", "global", "project"],
      kinds: [],
      tags: [],
      documentTypes: [],
      includeIndexOnly: false,
      limit: 500,
      workspaceRoot: this.workspaceRoot,
    } as MemoryQuery);
  }

  private evaluateGate(state: DreamMemoryState, docs: MemoryDocument[]): DreamMemoryGateDecision {
    const now = this.now();
    const lastRunAt = state.lastRunAt;
    const hoursSinceLastRun = lastRunAt ? (now - lastRunAt) / (60 * 60 * 1000) : null;
    const intervalReady = !lastRunAt || now - lastRunAt >= this.minIntervalMs;
    const eventBaseline = state.lastProcessedEventAt ?? state.lastRunAt ?? 0;
    const eventSessionIds = this.readDreamEventsAfter(eventBaseline);
    const docBaseline = Math.max(state.lastProcessedMemoryUpdatedAt ?? 0, lastRunAt ?? 0);
    const docSessionIds = docs
      .filter((doc) => (doc.frontmatter.updatedAt ?? doc.frontmatter.createdAt) > docBaseline)
      .map((doc) => doc.frontmatter.originSessionId)
      .filter((id) => id && id !== "unknown-session");
    const newSessionIds = Array.from(new Set([...eventSessionIds, ...docSessionIds]
      .filter((id) => !state.processedSessionIds.includes(id))));
    const sessionReady = newSessionIds.length >= this.minNewMemorySessions;
    const reason = !intervalReady
      ? `skip: last dream run was ${hoursSinceLastRun?.toFixed(2)} hours ago; need 24 hours`
      : !sessionReady
        ? `skip: ${newSessionIds.length} new memory sessions; need ${this.minNewMemorySessions}`
        : "run: dream memory gate passed";
    return {
      shouldRun: intervalReady && sessionReady,
      reason,
      hoursSinceLastRun,
      newMemorySessionCount: newSessionIds.length,
      newMemorySessionIds: newSessionIds,
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(state.lastProcessedMemoryUpdatedAt ? { lastProcessedMemoryUpdatedAt: state.lastProcessedMemoryUpdatedAt } : {}),
    };
  }

  private readDreamEventsAfter(timestamp: number): string[] {
    const path = join(this.globalJueDir, "projects", workspacePathSlug(this.workspaceRoot), "memory", DREAM_EVENTS_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.at !== "number" || parsed.at <= timestamp) return [];
          if (typeof parsed.sessionId !== "string" || parsed.sessionId === "unknown-session") return [];
          return [parsed.sessionId];
        } catch {
          return [];
        }
      });
  }

  private readMemoryIndexes(): DreamMemoryPruningContext["memoryIndexes"] {
    const specs: Array<{ scope: "user" | "global" | "project"; path: string }> = [
      { scope: "user", path: join(this.globalJueDir, "user", "memory", "MEMORY.md") },
      { scope: "global", path: join(this.globalJueDir, "global", "memory", "MEMORY.md") },
      { scope: "project", path: join(this.globalJueDir, "projects", workspacePathSlug(this.workspaceRoot), "memory", "MEMORY.md") },
    ];
    return specs.flatMap((spec) => {
      if (!existsSync(spec.path)) return [];
      const content = readFileSync(spec.path, "utf8").split(/\r?\n/).slice(0, 220).join("\n").trim();
      return content ? [{ ...spec, content }] : [];
    });
  }

  private readRecentSessionSummaries(sessionIds: string[]): DreamSessionSummary[] {
    const sessionsDir = join(this.globalJueDir, "projects", workspacePathSlug(this.workspaceRoot), "sessions");
    const wanted = new Set(sessionIds);
    const indexPath = join(sessionsDir, "sessions.index.json");
    const indexed = readSessionIndex(indexPath);
    const ids = sessionIds.length > 0 ? sessionIds : indexed.map((item) => item.sessionId).slice(0, 10);
    return ids.flatMap((sessionId) => {
      const summaryPath = join(sessionsDir, safeSegment(sessionId), "summary.md");
      if (!existsSync(summaryPath)) return [];
      const summary = readFileSync(summaryPath, "utf8").trim();
      if (!summary) return [];
      const meta = indexed.find((item) => item.sessionId === sessionId);
      if (wanted.size > 0 && !wanted.has(sessionId)) return [];
      return [{
        sessionId,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(typeof meta?.lastActiveAt === "number" ? { lastActiveAt: meta.lastActiveAt } : {}),
        summary: summary.slice(0, 4000),
      }];
    }).slice(0, 20);
  }

  private statePath(): string {
    return join(this.globalJueDir, "projects", workspacePathSlug(this.workspaceRoot), "memory", DREAM_STATE_FILE);
  }
}

function readDreamState(path: string): DreamMemoryState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DreamMemoryState>;
    if (parsed.version === 1) {
      const state: DreamMemoryState = {
        version: 1,
        processedSessionIds: Array.isArray(parsed.processedSessionIds) ? parsed.processedSessionIds.filter((id): id is string => typeof id === "string") : [],
      };
      if (typeof parsed.lastRunAt === "number") state.lastRunAt = parsed.lastRunAt;
      if (typeof parsed.lastProcessedMemoryUpdatedAt === "number") state.lastProcessedMemoryUpdatedAt = parsed.lastProcessedMemoryUpdatedAt;
      if (typeof parsed.lastProcessedEventAt === "number") state.lastProcessedEventAt = parsed.lastProcessedEventAt;
      if (parsed.lastResult) {
        const lastResult = parsed.lastResult as NonNullable<DreamMemoryState["lastResult"]>;
        state.lastResult = lastResult;
      }
      return state;
    }
  } catch {
    // Missing or corrupt dream state means the next eligible run starts from current files.
  }
  return { version: 1, processedSessionIds: [] };
}

function writeDreamState(path: string, state: DreamMemoryState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function maxMemoryUpdatedAt(docs: MemoryDocument[]): number {
  return docs.reduce((max, doc) => Math.max(max, doc.frontmatter.updatedAt ?? doc.frontmatter.createdAt), 0);
}

function readSessionIndex(path: string): Array<{ sessionId: string; title?: string; lastActiveAt?: number }> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: unknown[] };
    if (!Array.isArray(parsed.sessions)) return [];
    return parsed.sessions
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as Record<string, unknown>).sessionId === "string")
      .map((item) => ({
        sessionId: String(item.sessionId),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.lastActiveAt === "number" ? { lastActiveAt: item.lastActiveAt } : {}),
      }))
      .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0));
  } catch {
    return [];
  }
}

function collectRepositorySignal(cwd: string): DreamRepositorySignal {
  const signal: DreamRepositorySignal = { cwd, collectedAt: new Date().toISOString() };
  try {
    signal.gitBranch = execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // Not every workspace is a git repository.
  }
  try {
    signal.gitStatus = execGit(cwd, ["status", "--short"]).slice(0, 4000);
  } catch {
    // Git status is a hint only; DreamMemory must not depend on it.
  }
  try {
    signal.recentGitCommits = execGit(cwd, ["log", "--oneline", "-5"]).split(/\r?\n/).filter(Boolean);
  } catch {
    // Commit history is used only to avoid trusting stale session summaries.
  }
  return signal;
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-") || "session";
}
