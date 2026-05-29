import type {
  ContextBlock,
  FrontendKind,
  Id,
  Message,
  SessionMode,
  SessionRequest,
  SessionResponse,
  StreamEvent,
  SubAgentResult,
  Timestamp,
} from "@jue/shared-types";

export type TranscriptEventType =
  | "session.created"
  | "request.received"
  | "message.appended"
  | "stream.event"
  | "tool.result.persisted"
  | "context.compression"
  | "subagent.event"
  | "response.completed"
  | "session.restored"
  | "session.dropped";

export interface TranscriptEventBase<TType extends TranscriptEventType, TPayload> {
  eventId: Id;
  type: TType;
  sessionId: Id;
  requestId?: Id;
  at: Timestamp;
  payload: TPayload;
}

export type TranscriptEvent =
  | TranscriptEventBase<"session.created", SessionCreatedPayload>
  | TranscriptEventBase<"request.received", { request: SessionRequest }>
  | TranscriptEventBase<"message.appended", { message: Message; source: "user" | "assistant" | "tool" | "subagent" | "system" }>
  | TranscriptEventBase<"stream.event", { event: StreamEvent }>
  | TranscriptEventBase<"tool.result.persisted", ToolResultPersistedPayload>
  | TranscriptEventBase<"context.compression", ContextCompressionTranscriptPayload>
  | TranscriptEventBase<"subagent.event", SubAgentTranscriptPayload>
  | TranscriptEventBase<"response.completed", { response: SessionResponse }>
  | TranscriptEventBase<"session.restored", { frontend: FrontendKind; restoredMessageCount: number }>
  | TranscriptEventBase<"session.dropped", { reason?: string }>;

export interface SessionCreatedPayload {
  userId: Id;
  frontend: FrontendKind;
  mode: SessionMode;
  title: string;
  createdAt: Timestamp;
}

export interface ContextCompressionTranscriptPayload {
  streamEvent?: StreamEvent;
  pressure?: string;
  totalTokens?: number;
  blockCount?: number;
  compressedBlockIds: Id[];
  droppedBlockIds: Id[];
  cacheHitKeys: string[];
  summaryRefs?: Array<{ blockId: Id; summaryRef: Id }>;
  strategyVersion?: string;
  note?: string;
  persisted?: boolean;
  persistedBlocks?: ContextBlock[];
}

export interface SubAgentTranscriptPayload {
  eventId: Id;
  taskId: Id;
  subagentName: string;
  type: string;
  at: Timestamp;
  payload: Record<string, unknown>;
  result?: SubAgentResult;
}

export interface ToolResultPersistedPayload {
  callId: Id;
  toolName: string;
  status: string;
  resultRef: string;
  summary?: string;
  tokenEstimate: number;
  durationMs: number;
  persistedAt: Timestamp;
}

export interface PersistedSessionSummary {
  sessionId: Id;
  userId: Id;
  frontend: FrontendKind;
  mode: SessionMode;
  title: string;
  startedAt: Timestamp;
  lastActiveAt: Timestamp;
  messageCount: number;
  transcriptPath: string;
  status: "active" | "completed" | "archived" | "dropped";
  metadata?: Record<string, unknown>;
}

export interface LoadedSessionTranscript {
  summary: PersistedSessionSummary;
  events: TranscriptEvent[];
  messages: Message[];
  compressionEvents: ContextCompressionTranscriptPayload[];
  persistedContextBlocks: ContextBlock[];
  toolResultRefs: ToolResultPersistedPayload[];
  diagnostics: string[];
}

export interface SessionRepository {
  appendEvent(event: TranscriptEvent): void;
  listSessions(options?: { frontend?: FrontendKind; limit?: number }): PersistedSessionSummary[];
  loadSession(sessionId: Id): LoadedSessionTranscript | undefined;
  markDropped(sessionId: Id, reason?: string): void;
  readSessionSummary?(sessionId: Id): string | undefined;
  appendSessionSummary?(sessionId: Id, entry: string): string;
  listSessionSummaries?(options?: { excludeSessionId?: Id; limit?: number }): Array<{ session: PersistedSessionSummary; summary: string }>;
}

export function messageTextPreview(message: Message, maxChars = 80): string {
  const text = message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool_call") return `[tool_call:${part.toolName}]`;
      if (part.type === "tool_result") return `[tool_result:${part.toolName}] ${part.content}`;
      if (part.type === "file") return `[file:${part.name ?? part.path ?? part.url ?? "attachment"}]`;
      if (part.type === "image") return `[image:${part.mimeType}]`;
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function titleFromMessage(message: Message): string {
  const preview = messageTextPreview(message, 20);
  return preview || "New session";
}
