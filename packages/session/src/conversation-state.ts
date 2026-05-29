import type { ContextBlock, Id, Message, SessionMode, SessionSnapshot, Timestamp } from "@jue/shared-types";

interface InternalSessionState {
  sessionId: Id;
  userId: Id;
  frontend: SessionSnapshot["frontend"];
  mode: SessionMode;
  startedAt: Timestamp;
  lastActiveAt: Timestamp;
  messages: Message[];
  persistedContextBlocks: ContextBlock[];
}

export interface EnsureSessionOptions {
  frontend?: SessionSnapshot["frontend"];
  startedAt?: Timestamp;
  lastActiveAt?: Timestamp;
  messages?: Message[];
  persistedContextBlocks?: ContextBlock[];
}

/**
 * 进程内会话热状态。
 *
 * ConversationState 不负责跨进程持久化；持久化和恢复由 SessionRepository
 * 处理。这样前端只和 SessionManager 交互，核心引擎仍保持无状态。
 */
export class InMemoryConversationState {
  private readonly bucket = new Map<Id, InternalSessionState>();

  ensure(sessionId: Id, userId: Id, mode: SessionMode, options: EnsureSessionOptions = {}): InternalSessionState {
    let s = this.bucket.get(sessionId);
    if (!s) {
      const now = Date.now();
      s = {
        sessionId,
        userId,
        frontend: options.frontend ?? "cli",
        mode,
        startedAt: options.startedAt ?? now,
        lastActiveAt: options.lastActiveAt ?? now,
        messages: options.messages ? [...options.messages] : [],
        persistedContextBlocks: options.persistedContextBlocks ? [...options.persistedContextBlocks] : [],
      };
      this.bucket.set(sessionId, s);
    }
    return s;
  }

  hydrate(input: {
    sessionId: Id;
    userId: Id;
    frontend: SessionSnapshot["frontend"];
    mode: SessionMode;
    startedAt: Timestamp;
    lastActiveAt: Timestamp;
    messages: Message[];
    persistedContextBlocks?: ContextBlock[];
  }): void {
    this.bucket.set(input.sessionId, {
      sessionId: input.sessionId,
      userId: input.userId,
      frontend: input.frontend,
      mode: input.mode,
      startedAt: input.startedAt,
      lastActiveAt: input.lastActiveAt,
      messages: [...input.messages].sort((left, right) => left.createdAt - right.createdAt),
      persistedContextBlocks: input.persistedContextBlocks ? [...input.persistedContextBlocks] : [],
    });
  }

  appendMessage(sessionId: Id, message: Message): void {
    const s = this.bucket.get(sessionId);
    if (!s) return;
    s.messages.push(message);
    s.lastActiveAt = Date.now();
  }

  getMessages(sessionId: Id): Message[] {
    return this.bucket.get(sessionId)?.messages ?? [];
  }

  setPersistedContextBlocks(sessionId: Id, blocks: ContextBlock[]): void {
    const s = this.bucket.get(sessionId);
    if (!s) return;
    s.persistedContextBlocks = [...blocks];
    s.lastActiveAt = Date.now();
  }

  getPersistedContextBlocks(sessionId: Id): ContextBlock[] {
    return this.bucket.get(sessionId)?.persistedContextBlocks ?? [];
  }

  snapshot(sessionId: Id): SessionSnapshot | undefined {
    const s = this.bucket.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      userId: s.userId,
      frontend: s.frontend,
      mode: s.mode,
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
      messageCount: s.messages.length,
    };
  }

  /** 只清理热状态；append-only transcript 不会被物理删除。 */
  drop(sessionId: Id): void {
    this.bucket.delete(sessionId);
  }
}
