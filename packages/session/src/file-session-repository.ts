import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "@jue/utils";
import type { FrontendKind, Id, Message, SessionMode, SessionResponse, StreamEvent } from "@jue/shared-types";
import type {
  ContextCompressionTranscriptPayload,
  LoadedSessionTranscript,
  PersistedSessionSummary,
  SessionCreatedPayload,
  SessionRepository,
  ToolResultPersistedPayload,
  TranscriptEvent,
} from "./transcript.js";

const INDEX_FILE = "sessions.index.json";
const TRANSCRIPT_FILE = "transcript.json";
const SUMMARY_FILE = "summary.md";

interface SessionIndexFile {
  version: 1;
  sessions: PersistedSessionSummary[];
}

export interface FileSessionRepositoryOptions {
  /** User-level .jue directory. Sessions should not be written into the project repo. */
  globalJueDir: string;
  /** Startup cwd/workspace root. It is converted to a stable project bucket slug. */
  workspaceRoot: string;
}

/**
 * User-level append-only session repository.
 *
 * Each cwd maps to .jue/projects/<cwd-slug>/sessions under the user's home.
 * transcript.json is written as NDJSON even though the product-facing extension
 * is json, so every transcript event is appended without rewriting history.
 */
export class FileSessionRepository implements SessionRepository {
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(options: FileSessionRepositoryOptions) {
    this.sessionsDir = join(options.globalJueDir, "projects", workspacePathSlug(options.workspaceRoot), "sessions");
    this.indexPath = join(this.sessionsDir, INDEX_FILE);
    ensureDir(this.sessionsDir);
    if (!existsSync(this.indexPath)) this.writeIndex({ version: 1, sessions: [] });
  }

  appendEvent(event: TranscriptEvent): void {
    const transcriptPath = this.transcriptPath(event.sessionId);
    ensureDir(dirname(transcriptPath));
    writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    this.updateIndexFromEvent(event, transcriptPath);
  }

  listSessions(options: { frontend?: FrontendKind; limit?: number } = {}): PersistedSessionSummary[] {
    const index = this.readIndex();
    const sessions = index.sessions
      .filter((item) => item.status !== "dropped")
      .filter((item) => !options.frontend || item.frontend === options.frontend)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    return typeof options.limit === "number" ? sessions.slice(0, options.limit) : sessions;
  }

  loadSession(sessionId: Id): LoadedSessionTranscript | undefined {
    const summary = this.readIndex().sessions.find((item) => item.sessionId === sessionId);
    const transcriptPath = summary?.transcriptPath ?? this.transcriptPath(sessionId);
    if (!existsSync(transcriptPath)) return undefined;

    const diagnostics: string[] = [];
    const events = readTranscriptEvents(transcriptPath, diagnostics).filter((event) => event.sessionId === sessionId);
    if (events.length === 0 && !summary) return undefined;

    const rebuilt = rebuildTranscript(sessionId, events, summary, transcriptPath, diagnostics);
    return rebuilt;
  }

  markDropped(sessionId: Id, reason?: string): void {
    this.appendEvent({
      eventId: newId("tev"),
      type: "session.dropped",
      sessionId,
      at: Date.now(),
      payload: reason ? { reason } : {},
    });
  }

  readSessionSummary(sessionId: Id): string | undefined {
    const path = this.summaryPath(sessionId);
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : undefined;
  }

  appendSessionSummary(sessionId: Id, entry: string): string {
    const path = this.summaryPath(sessionId);
    ensureDir(dirname(path));
    const cleaned = entry.trim();
    if (!cleaned) return path;
    const prefix = existsSync(path) && readFileSync(path, "utf8").trim().length > 0 ? "\n\n---\n\n" : "";
    writeFileSync(path, `${prefix}${cleaned}\n`, { encoding: "utf8", flag: "a" });
    return path;
  }

  listSessionSummaries(options: { excludeSessionId?: Id; limit?: number } = {}): Array<{ session: PersistedSessionSummary; summary: string }> {
    const sessions = this.listSessions(options.limit === undefined ? {} : { limit: options.limit });
    const summaries: Array<{ session: PersistedSessionSummary; summary: string }> = [];
    for (const session of sessions) {
      if (options.excludeSessionId && session.sessionId === options.excludeSessionId) continue;
      const summary = this.readSessionSummary(session.sessionId);
      if (summary) summaries.push({ session, summary });
    }
    return summaries;
  }

  private transcriptPath(sessionId: Id): string {
    return join(this.sessionsDir, safeSegment(sessionId), TRANSCRIPT_FILE);
  }

  private summaryPath(sessionId: Id): string {
    return join(this.sessionsDir, safeSegment(sessionId), SUMMARY_FILE);
  }

  private updateIndexFromEvent(event: TranscriptEvent, transcriptPath: string): void {
    const index = this.readIndex();
    const now = event.at;
    const existingIndex = index.sessions.findIndex((item) => item.sessionId === event.sessionId);
    const existing = existingIndex >= 0 ? index.sessions[existingIndex] : undefined;
    const created = event.type === "session.created" ? event.payload : undefined;
    const next = mergeSummary(existing, event, transcriptPath, now, created);
    if (!next) return;
    if (existingIndex >= 0) index.sessions[existingIndex] = next;
    else index.sessions.push(next);
    this.writeIndex(index);
  }

  private readIndex(): SessionIndexFile {
    try {
      const raw = readFileSync(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionIndexFile>;
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) return { version: 1, sessions: parsed.sessions };
    } catch {
      // A broken index must not make transcript recovery fail. Future append events can rebuild it gradually.
    }
    return { version: 1, sessions: [] };
  }

  private writeIndex(index: SessionIndexFile): void {
    ensureDir(dirname(this.indexPath));
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

function mergeSummary(
  existing: PersistedSessionSummary | undefined,
  event: TranscriptEvent,
  transcriptPath: string,
  now: number,
  created?: SessionCreatedPayload,
): PersistedSessionSummary | undefined {
  if (!existing && !created) return undefined;
  const base: PersistedSessionSummary = existing ?? {
    sessionId: event.sessionId,
    userId: created?.userId ?? "unknown",
    frontend: created?.frontend ?? "cli",
    mode: created?.mode ?? "chat",
    title: created?.title ?? "New session",
    startedAt: created?.createdAt ?? now,
    lastActiveAt: now,
    messageCount: 0,
    transcriptPath,
    status: "active",
  };
  const next: PersistedSessionSummary = { ...base, transcriptPath, lastActiveAt: now };
  if (created) {
    next.userId = created.userId;
    next.frontend = created.frontend;
    next.mode = created.mode;
    next.title = created.title;
    next.startedAt = created.createdAt;
    next.status = "active";
  } else if (event.type === "message.appended") {
    next.messageCount = base.messageCount + 1;
  } else if (event.type === "response.completed") {
    next.status = event.payload.response.error ? "active" : "completed";
  } else if (event.type === "request.received") {
    next.status = "active";
    const flags = event.payload.request.flags;
    if (flags.teamMode === true) {
      next.metadata = {
        ...(base.metadata ?? {}),
        teamMode: true,
        teamName: typeof flags.teamName === "string" ? flags.teamName : undefined,
        teamMember: typeof flags.teamMember === "string" ? flags.teamMember : undefined,
        teamLeader: typeof flags.teamLeader === "string" ? flags.teamLeader : undefined,
      };
    }
  } else if (event.type === "session.dropped") {
    next.status = "dropped";
  }
  return next;
}

function rebuildTranscript(
  sessionId: Id,
  events: TranscriptEvent[],
  indexed: PersistedSessionSummary | undefined,
  transcriptPath: string,
  diagnostics: string[],
): LoadedSessionTranscript {
  const messages: Message[] = [];
  const seenMessages = new Set<Id>();
  const compressionEvents: ContextCompressionTranscriptPayload[] = [];
  const toolResultRefs: ToolResultPersistedPayload[] = [];
  let persistedContextBlocks: ContextCompressionTranscriptPayload["persistedBlocks"] = [];
  let created: SessionCreatedPayload | undefined;
  let lastActiveAt = 0;
  let status: PersistedSessionSummary["status"] = indexed?.status ?? "active";

  const assistantToolMessages = new Map<Id, Message>();
  for (const event of events) {
    lastActiveAt = Math.max(lastActiveAt, event.at);
    if (event.type === "session.created") created = event.payload;
    if (event.type === "message.appended" && !seenMessages.has(event.payload.message.id)) {
      seenMessages.add(event.payload.message.id);
      messages.push(event.payload.message);
    }
    if (event.type === "request.received" && event.payload.request.persistedContextBlocks.length > 0) {
      persistedContextBlocks = event.payload.request.persistedContextBlocks;
    }
    if (event.type === "context.compression") {
      compressionEvents.push(event.payload);
      if (event.payload.persisted && event.payload.persistedBlocks) persistedContextBlocks = event.payload.persistedBlocks;
    }
    if (event.type === "tool.result.persisted") toolResultRefs.push(event.payload);
    if (event.type === "response.completed") {
      for (const message of rebuildMessagesFromResponse(event.payload.response)) {
        if (!seenMessages.has(message.id) && !assistantToolMessages.has(message.id)) {
          assistantToolMessages.set(message.id, message);
        }
      }
    }
    if (event.type === "response.completed") status = event.payload.response.error ? "active" : "completed";
    if (event.type === "session.dropped") status = "dropped";
  }

  const summary: PersistedSessionSummary = indexed ?? {
    sessionId,
    userId: created?.userId ?? "unknown",
    frontend: created?.frontend ?? "cli",
    mode: created?.mode ?? "chat",
    title: created?.title ?? "New session",
    startedAt: created?.createdAt ?? events[0]?.at ?? Date.now(),
    lastActiveAt: lastActiveAt || Date.now(),
    messageCount: messages.length,
    transcriptPath,
    status,
  };

  return {
    summary: { ...summary, lastActiveAt: lastActiveAt || summary.lastActiveAt, messageCount: messages.length, status },
    events,
    messages: [...messages, ...assistantToolMessages.values()].sort((left, right) => left.createdAt - right.createdAt),
    compressionEvents,
    persistedContextBlocks: persistedContextBlocks ?? [],
    toolResultRefs,
    diagnostics,
  };
}

function rebuildMessagesFromResponse(response: SessionResponse): Message[] {
  const messages: Message[] = [];
  const assistantParts: Array<{ type: "tool_call"; callId: string; toolName: string; arguments: string }> = [];
  const events: StreamEvent[] = response.events;
  for (const event of events) {
    if (event.type === "tool.invocation.started" && isRecord(event.payload)) {
      const callId = typeof event.payload.callId === "string" ? event.payload.callId : undefined;
      const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : undefined;
      if (callId && toolName) {
        assistantParts.push({
          type: "tool_call",
          callId,
          toolName,
          arguments: JSON.stringify(event.payload.arguments ?? {}),
        });
      }
    }
    if (event.type === "tool.invocation.completed" && isRecord(event.payload)) {
      const callId = typeof event.payload.callId === "string" ? event.payload.callId : undefined;
      const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : undefined;
      if (callId && toolName) {
        messages.push({
          id: stableMessageId("tool", response.sessionId, callId),
          sessionId: response.sessionId,
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId,
              toolName,
              content: JSON.stringify(event.payload),
              isError: event.payload.status !== "succeeded",
            },
          ],
          createdAt: event.at,
        });
      }
    }
  }
  if (assistantParts.length > 0) {
    messages.push({
      id: stableMessageId("assistant_tools", response.sessionId, assistantParts.map((part) => part.callId).join("_")),
      sessionId: response.sessionId,
      role: "assistant",
      parts: assistantParts,
      createdAt: events[0]?.at ?? response.finalMessage?.createdAt ?? Date.now(),
    });
  }
  return messages;
}

function readTranscriptEvents(path: string, diagnostics: string[]): TranscriptEvent[] {
  const raw = readFileSync(path, "utf8");
  const events: TranscriptEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptEvent;
      if (typeof parsed.type === "string" && typeof parsed.sessionId === "string") events.push(parsed);
      else diagnostics.push(`line ${i + 1}: invalid transcript event`);
    } catch (err) {
      diagnostics.push(`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return events;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Convert a cwd into a Claude/Codex-like user-level project bucket.
 * Do not collapse repeated dashes: every non [A-Za-z0-9_] char becomes '-'.
 */
export function workspacePathSlug(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9_]/g, "-");
  return slug.length > 0 ? slug : "workspace";
}

function stableMessageId(prefix: string, sessionId: Id, key: string): Id {
  return `msg_${safeSegment(prefix)}_${safeSegment(sessionId)}_${safeSegment(key)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

