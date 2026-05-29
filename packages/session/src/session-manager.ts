import { getModuleLogger, newId } from "@jue/utils";
import type {
  FrontendCapabilities,
  ContextBlock,
  FrontendKind,
  Id,
  Message,
  MessageDraft,
  SessionMode,
  SessionRequest,
  SessionResponse,
  StreamEvent,
} from "@jue/shared-types";
import type { AgentEngine, ContextCompressionDebugResult } from "@jue/engine";
import { InMemoryConversationState } from "./conversation-state.js";
import type {
  ContextCompressionTranscriptPayload,
  LoadedSessionTranscript,
  PersistedSessionSummary,
  SessionRepository,
  ToolResultPersistedPayload,
  SubAgentTranscriptPayload,
  TranscriptEvent,
} from "./transcript.js";
import { SessionSearch } from "./session-search.js";
import { messageTextPreview, titleFromMessage } from "./transcript.js";

export interface SessionManagerOptions {
  engine: SessionSummaryEngine;
  state?: InMemoryConversationState;
  repository?: SessionRepository;
  workspaceRoot?: string;
}

export interface InboundTurn {
  sessionId?: Id;
  userId: Id;
  frontend: FrontendKind;
  mode?: SessionMode;
  capabilities?: FrontendCapabilities;
  message: MessageDraft;
  flags?: Record<string, string | boolean | number>;
  signal?: AbortSignal;
}

export interface HandleOutput {
  request: SessionRequest;
  events: AsyncIterable<StreamEvent>;
  done: Promise<SessionResponse>;
}

export interface ResumeSessionResult {
  summary: PersistedSessionSummary;
  messages: Message[];
  compressionEvents: LoadedSessionTranscript["compressionEvents"];
  diagnostics: string[];
}

export interface SessionSummaryRequest {
  sessionId: Id;
  userId: Id;
  frontend: FrontendKind;
  mode?: SessionMode;
  history?: Message[];
  previousSummary?: string;
  trigger: "agent_close" | "manual_compressor" | "auto_compressor";
}

export interface SessionSummaryWriteResult {
  sessionId: Id;
  requestId: Id;
  trigger: SessionSummaryRequest["trigger"];
  markdown: string;
  sourceBlockIds: Id[];
  status: "succeeded" | "fallback";
  summaryPath?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };
}

type SessionSummaryEngine = AgentEngine & {
  summarizeSessionForStorage(input: SessionSummaryRequest): Promise<SessionSummaryWriteResult>;
};

export interface SessionTranscriptSink {
  appendToolResultPersisted(input: {
    sessionId: Id;
    requestId: Id;
    payload: ToolResultPersistedPayload;
  }): void;
  appendDurableCompression(input: {
    sessionId: Id;
    requestId: Id;
    payload: ContextCompressionTranscriptPayload;
  }): void;
  appendSubAgentEvent(input: {
    sessionId: Id;
    requestId: Id;
    payload: SubAgentTranscriptPayload;
  }): void;
}

/**
 * 濞村吋淇洪惁鐣屼沪閸屾艾寮抽柛娆欑祷閳?
 *
 * SessionManager 閻犳劗鍠曢惌妤呭箮婵犱胶鐟濋柛姘嫰婢х姷绮╅婊勭暠閺夊牊鎸搁崣鍡欑磼閻斿墎顏遍柟?SessionRequest闁挎稑鐬煎ǎ顕€骞庨妶鍛Ъ闁告挸绉风换妯肩矙?
 * 闁汇劌瀚崕褰掑储閸℃钑夐柨娑樿嫰閼荤喖骞庢繝鍐暡闁哄牆顦崣褔鏌ㄩ鑽ょ殤閻庡湱鍋涢崯鎾诲礂閵夆斂鈧秹鎯?.jue/sessions 濞戞挸顑囧▓?append-only transcript闁?
 * Engine 濞寸姴绉堕崝褔宕ｉ鍛闁衡偓?request + history闁挎稑濂旂粭澶愬礂閸愯尙濡囧ù鍏间亢閻﹁姤绂?CLI闁靛棔绠榚b 閺夆晜蓱濡?Mobile 闁哄鍎埀?
 */
export class SessionManager {
  private readonly logger = getModuleLogger("session");
  private readonly engine: SessionSummaryEngine;
  private readonly state: InMemoryConversationState;
  private readonly repository: SessionRepository | undefined;
  private readonly sessionSearch: SessionSearch;
  private readonly workspaceRoot: string | undefined;

  constructor(options: SessionManagerOptions) {
    this.engine = options.engine;
    this.state = options.state ?? new InMemoryConversationState();
    this.repository = options.repository;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionSearch = new SessionSearch(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {});
  }

  asTranscriptSink(): SessionTranscriptSink {
    return {
      appendToolResultPersisted: (input) => this.appendToolResultPersisted(input),
      appendDurableCompression: (input) => this.appendDurableCompression(input),
      appendSubAgentEvent: (input) => this.appendSubAgentEvent(input),
    };
  }
  getConversationTurnStats(sessionId: Id): { userMessages: number; assistantMessages: number; totalMessages: number; turns: number } {
    const messages = this.state.getMessages(sessionId);
    let userMessages = 0;
    let assistantMessages = 0;
    for (const message of messages) {
      if (message.role === "user") userMessages += 1;
      if (message.role === "assistant") assistantMessages += 1;
    }
    return {
      userMessages,
      assistantMessages,
      totalMessages: messages.length,
      turns: Math.max(userMessages, assistantMessages),
    };
  }

  getConversationHistory(sessionId: Id): Message[] {
    return [...this.state.getMessages(sessionId)];
  }
  loadPersistedSession(sessionId: Id): LoadedSessionTranscript | undefined {
    return this.repository?.loadSession(sessionId);
  }



  handle(turn: InboundTurn): HandleOutput {
    const sessionId = turn.sessionId ?? newId("sess");
    const requestId = newId("req");
    const mode: SessionMode = turn.mode ?? "chat";

    this.state.ensure(sessionId, turn.userId, mode, { frontend: turn.frontend });
    const history = [...this.state.getMessages(sessionId)];
    const isNewSession = history.length === 0 && !turn.sessionId;

    const req: SessionRequest = {
      requestId,
      sessionId,
      userId: turn.userId,
      frontend: turn.frontend,
      mode,
      message: turn.message,
      attachments: [],
      flags: turn.flags ?? {},
      persistedContextBlocks: this.state.getPersistedContextBlocks(sessionId),
      createdAt: Date.now(),
      ...(turn.capabilities ? { capabilities: turn.capabilities } : {}),
    };
    const userMsg = messageFromDraft(req);

    if (isNewSession) {
      const searchBlocks = this.buildSessionSearchBlocks(sessionId, userMsg, req.createdAt);
      if (searchBlocks.length > 0) {
        req.persistedContextBlocks = [...req.persistedContextBlocks, ...searchBlocks];
        this.state.setPersistedContextBlocks(sessionId, req.persistedContextBlocks);
      }
    }

    if (isNewSession) {
      this.appendTranscript({
        eventId: newId("tev"),
        type: "session.created",
        sessionId,
        requestId,
        at: req.createdAt,
        payload: {
          userId: turn.userId,
          frontend: turn.frontend,
          mode,
          title: titleFromMessage(userMsg),
          createdAt: req.createdAt,
        },
      });
    }
    this.appendTranscript({
      eventId: newId("tev"),
      type: "request.received",
      sessionId,
      requestId,
      at: req.createdAt,
      payload: { request: req },
    });

    this.logger.info({ sessionId, requestId, frontend: turn.frontend, mode }, "session request accepted");

    const runtimeReq = turn.signal ? Object.assign(req, { signal: turn.signal }) : req;
    const { events, done } = this.engine.handle(runtimeReq, history);
    const persistedEvents = this.persistStreamEvents(req, events);

    const finalize = done.then((resp) => {
      this.state.appendMessage(sessionId, userMsg);
      this.appendMessage(userMsg, requestId, "user");
      if (resp.finalMessage) {
        this.state.appendMessage(sessionId, resp.finalMessage);
        this.appendMessage(resp.finalMessage, requestId, "assistant");
      }
      this.appendTranscript({
        eventId: newId("tev"),
        type: "response.completed",
        sessionId,
        requestId,
        at: resp.finishedAt ?? Date.now(),
        payload: { response: resp },
      });
      return resp;
    });

    return { request: req, events: persistedEvents, done: finalize };
  }

  listSessions(options: { frontend?: FrontendKind; limit?: number; includeTeamSessions?: boolean } = {}): PersistedSessionSummary[] {
    const sessions = this.repository?.listSessions(options) ?? [];
    if (options.includeTeamSessions === true) return sessions;
    return sessions.filter((session) => session.metadata?.teamMode !== true);
  }

  private buildSessionSearchBlocks(sessionId: Id, firstUserMessage: Message, now: number): ContextBlock[] {
    const summaries = this.repository?.listSessionSummaries?.({ excludeSessionId: sessionId, limit: 80 }) ?? [];
    if (summaries.length === 0) return [];
    try {
      const result = this.sessionSearch.search({
        currentSessionId: sessionId,
        firstUserMessage,
        summaries,
        now,
        ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      });
      if (!result.block) return [];
      this.logger.info(
        { sessionId, keywordCount: result.keywords.length, matchCount: result.matches.length },
        "session search injected historical summary context",
      );
      return [result.block];
    } catch (error) {
      this.logger.warn({ sessionId, error }, "session search failed; continue without historical context");
      return [];
    }
  }
  resumeSession(input: { sessionId: Id; frontend: FrontendKind; includeTeamSessions?: boolean }): ResumeSessionResult | undefined {
    const loaded = this.repository?.loadSession(input.sessionId);
    if (!loaded) return undefined;
    if (loaded.summary.metadata?.teamMode === true && input.includeTeamSessions !== true) return undefined;
    this.state.hydrate({
      sessionId: loaded.summary.sessionId,
      userId: loaded.summary.userId,
      frontend: loaded.summary.frontend,
      mode: loaded.summary.mode,
      startedAt: loaded.summary.startedAt,
      lastActiveAt: loaded.summary.lastActiveAt,
      messages: loaded.messages,
      persistedContextBlocks: loaded.persistedContextBlocks,
    });
    this.appendTranscript({
      eventId: newId("tev"),
      type: "session.restored",
      sessionId: loaded.summary.sessionId,
      at: Date.now(),
      payload: { frontend: input.frontend, restoredMessageCount: loaded.messages.length },
    });
    return {
      summary: loaded.summary,
      messages: loaded.messages,
      compressionEvents: loaded.compressionEvents,
      diagnostics: loaded.diagnostics,
    };
  }
  dropSession(sessionId: Id): void {
    this.state.drop(sessionId);
    this.repository?.markDropped(sessionId, "session reset");
    this.logger.info({ sessionId }, "session dropped");
  }
  async compressContextForDebug(input: {
    sessionId: Id;
    userId: Id;
    frontend: FrontendKind;
    mode?: SessionMode;
    flags?: Record<string, string | boolean | number>;
  }): Promise<ContextCompressionDebugResult> {
    const requestId = newId("req");
    const history = [...this.state.getMessages(input.sessionId)];
    const result = await this.engine.compressContextForDebug({
      sessionId: input.sessionId,
      requestId,
      userId: input.userId,
      frontend: input.frontend,
      history,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.flags ? { flags: input.flags } : {}),
    });
    const persistedBlocks = extractPersistedCompressionBlocks(result);
    this.state.setPersistedContextBlocks(input.sessionId, persistedBlocks);
    this.appendTranscript({
      eventId: newId("tev"),
      type: "context.compression",
      sessionId: input.sessionId,
      requestId,
      at: Date.now(),
      payload: {
        pressure: result.pressure,
        totalTokens: result.totalTokens,
        blockCount: result.blockCount,
        compressedBlockIds: result.compressedBlockIds,
        droppedBlockIds: result.droppedBlockIds,
        cacheHitKeys: result.cacheHitKeys,
        persisted: true,
        persistedBlocks,
        note: "manual /compressor debug run",
      },
    });
    await this.summarizeSessionToFile({
      sessionId: input.sessionId,
      userId: input.userId,
      frontend: input.frontend,
      history,
      ...(input.mode ? { mode: input.mode } : {}),
      trigger: "manual_compressor",
    });
    return markPersistedCompressionResult(result, persistedBlocks);
  }

  async summarizeSessionToFile(input: SessionSummaryRequest): Promise<SessionSummaryWriteResult | undefined> {
    const history = input.history ? [...input.history] : [...this.state.getMessages(input.sessionId)];
    if (history.length === 0) return undefined;
    const previousSummary = this.repository?.readSessionSummary?.(input.sessionId);
    const result = await this.engine.summarizeSessionForStorage({
      sessionId: input.sessionId,
      userId: input.userId,
      frontend: input.frontend,
      history,
      ...(previousSummary ? { previousSummary } : {}),
      trigger: input.trigger,
      ...(input.mode ? { mode: input.mode } : {}),
    });
    const summaryPath = this.repository?.appendSessionSummary?.(input.sessionId, result.markdown);
    this.appendTranscript({
      eventId: newId("tev"),
      type: "context.compression",
      sessionId: input.sessionId,
      requestId: result.requestId,
      at: Date.now(),
      payload: {
        compressedBlockIds: result.sourceBlockIds,
        droppedBlockIds: [],
        cacheHitKeys: [],
        persisted: true,
        note: `session summary written by ${input.trigger}${summaryPath ? ` to ${summaryPath}` : ""}`,
      },
    });
    return { ...result, ...(summaryPath ? { summaryPath } : {}) };
  }

  private async *persistStreamEvents(req: SessionRequest, events: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
    for await (const event of events) {
      this.appendTranscript({
        eventId: newId("tev"),
        type: "stream.event",
        sessionId: req.sessionId,
        requestId: req.requestId,
        at: event.at,
        payload: { event },
      });
      if (event.type === "context.compressed") {
        this.appendTranscript({
          eventId: newId("tev"),
          type: "context.compression",
          sessionId: req.sessionId,
          requestId: req.requestId,
          at: event.at,
          payload: compressionPayloadFromStreamEvent(event),
        });
      }
      yield event;
    }
  }

  private appendMessage(message: Message, requestId: Id, source: "user" | "assistant" | "tool" | "subagent" | "system"): void {
    this.appendTranscript({
      eventId: newId("tev"),
      type: "message.appended",
      sessionId: message.sessionId,
      requestId,
      at: message.createdAt,
      payload: { message, source },
    });
  }

  private appendToolResultPersisted(input: { sessionId: Id; requestId: Id; payload: ToolResultPersistedPayload }): void {
    this.appendTranscript({
      eventId: newId("tev"),
      type: "tool.result.persisted",
      sessionId: input.sessionId,
      requestId: input.requestId,
      at: input.payload.persistedAt,
      payload: input.payload,
    });
  }

  private appendSubAgentEvent(input: { sessionId: Id; requestId: Id; payload: SubAgentTranscriptPayload }): void {
    this.appendTranscript({
      eventId: newId("tev"),
      type: "subagent.event",
      sessionId: input.sessionId,
      requestId: input.requestId,
      at: input.payload.at,
      payload: input.payload,
    });
  }

  private appendDurableCompression(input: { sessionId: Id; requestId: Id; payload: ContextCompressionTranscriptPayload }): void {
    if (input.payload.persistedBlocks) this.state.setPersistedContextBlocks(input.sessionId, input.payload.persistedBlocks);
    this.appendTranscript({
      eventId: newId("tev"),
      type: "context.compression",
      sessionId: input.sessionId,
      requestId: input.requestId,
      at: Date.now(),
      payload: input.payload,
    });
  }

  private appendTranscript(event: TranscriptEvent): void {
    try {
      this.repository?.appendEvent(event);
    } catch (err) {
      this.logger.warn({ err, sessionId: event.sessionId, type: event.type }, "failed to append transcript event");
    }
  }
}

function messageFromDraft(req: SessionRequest): Message {
  return {
    id: newId("msg"),
    sessionId: req.sessionId,
    role: req.message.role,
    parts: req.message.parts,
    createdAt: req.createdAt,
    ...(req.message.parentId ? { parentId: req.message.parentId } : {}),
    ...(req.message.metadata ? { metadata: req.message.metadata } : {}),
  };
}


function markPersistedCompressionResult(
  result: ContextCompressionDebugResult,
  persistedBlocks: ContextBlock[],
): ContextCompressionDebugResult {
  const persistedIds = new Set(persistedBlocks.map((block) => block.id));
  return {
    ...result,
    blocks: result.blocks.map((block) => persistedIds.has(block.id) ? { ...block, persisted: true } : block),
  };
}
function extractPersistedCompressionBlocks(result: ContextCompressionDebugResult): ContextBlock[] {
  return result.persistedBlocks;
}
function compressionPayloadFromStreamEvent(event: StreamEvent): ContextCompressionTranscriptPayload {
  const payload = isRecord(event.payload) ? event.payload : {};
  const next: ContextCompressionTranscriptPayload = {
    streamEvent: event,
    compressedBlockIds: stringArray(payload.compressedBlockIds),
    droppedBlockIds: stringArray(payload.droppedBlockIds),
    cacheHitKeys: stringArray(payload.cacheHitKeys),
  };
  if (typeof payload.pressure === "string") next.pressure = payload.pressure;
  if (typeof payload.totalTokens === "number") next.totalTokens = payload.totalTokens;
  if (typeof payload.blockCount === "number") next.blockCount = payload.blockCount;
  if (typeof payload.strategyVersion === "string") next.strategyVersion = payload.strategyVersion;
  const summaryRefs = summaryRefArray(payload.summaryRefs);
  if (summaryRefs.length > 0) next.summaryRefs = summaryRefs;
  if (payload.persisted === true) next.persisted = true;
  const persistedBlocks = contextBlockArray(payload.persistedBlocks);
  if (persistedBlocks.length > 0) next.persistedBlocks = persistedBlocks;
  return next;
}

function contextBlockArray(value: unknown): ContextBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ContextBlock => isRecord(item) && typeof item.id === "string" && typeof item.content === "string");
}

function summaryRefArray(value: unknown): Array<{ blockId: Id; summaryRef: Id }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.blockId !== "string" || typeof item.summaryRef !== "string") return [];
    return [{ blockId: item.blockId, summaryRef: item.summaryRef }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export { messageTextPreview };
