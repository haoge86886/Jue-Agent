import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Id, ToolCall, ToolResult } from "@jue/shared-types";
import { workspacePathSlug } from "./file-session-repository.js";

export interface PersistToolResultInput {
  sessionId: Id;
  requestId: Id;
  call: ToolCall;
  result: ToolResult;
  contextContent: string;
  modelContent: string;
}

export interface PersistedToolResultRecord {
  version: 1;
  sessionId: Id;
  requestId: Id;
  callId: Id;
  toolName: string;
  call: ToolCall;
  result: ToolResult;
  contextContent: string;
  modelContent: string;
  persistedAt: number;
}

export interface PersistedToolResultSummary {
  callId: Id;
  toolName: string;
  status: ToolResult["status"];
  resultRef: string;
  summary?: string;
  tokenEstimate: number;
  durationMs: number;
  persistedAt: number;
}

export interface ToolResultRepository {
  persist(input: PersistToolResultInput): PersistedToolResultSummary;
  load(resultRef: string): PersistedToolResultRecord | undefined;
}

/**
 * File-backed tool result store.
 * Transcript keeps only resultRef and summary; full call/result payloads live in JSON.
 */
export class FileToolResultRepository implements ToolResultRepository {
  private readonly rootDir: string;

  constructor(options: { globalJueDir: string; workspaceRoot: string }) {
    this.rootDir = join(options.globalJueDir, "projects", workspacePathSlug(options.workspaceRoot), "tool-results");
    ensureDir(this.rootDir);
  }

  persist(input: PersistToolResultInput): PersistedToolResultSummary {
    const persistedAt = Date.now();
    const resultRef = this.resultRef(input.sessionId, input.call.id);
    const record: PersistedToolResultRecord = {
      version: 1,
      sessionId: input.sessionId,
      requestId: input.requestId,
      callId: input.call.id,
      toolName: input.call.toolName,
      call: input.call,
      result: input.result,
      contextContent: input.contextContent,
      modelContent: input.modelContent,
      persistedAt,
    };
    const path = this.refToPath(resultRef);
    ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return {
      callId: input.call.id,
      toolName: input.call.toolName,
      status: input.result.status,
      resultRef,
      ...(input.result.summary ? { summary: input.result.summary } : {}),
      tokenEstimate: input.result.tokenEstimate,
      durationMs: input.result.durationMs,
      persistedAt,
    };
  }

  load(resultRef: string): PersistedToolResultRecord | undefined {
    const path = this.refToPath(resultRef);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedToolResultRecord;
      return parsed.version === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private resultRef(sessionId: Id, callId: Id): string {
    return `tool-results/${safeSegment(sessionId)}/${safeSegment(callId)}.json`;
  }

  private refToPath(resultRef: string): string {
    return join(this.rootDir, ...resultRef.replace(/^tool-results[\\/]/, "").split(/[\\/]/).map(safeSegment));
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}


