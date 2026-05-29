/**
 * @file types.ts
 * @module @jue/cli/ui/types
 *
 * Render-only item types used by the Ink UI.
 * These are intentionally separate from shared Message because UI state needs
 * presentation-specific shapes for text, tools, system notices, errors, and dev panels.
 */

export type ChatPhase = "idle" | "sending" | "exiting";

export interface ContextBudgetStatus {
  usedTokens: number;
  ceilingTokens: number;
  remainingTokens: number;
  remainingRatio: number;
  pressure: "normal" | "rule_compress" | "llm_compress" | "overflow";
  compressedBlockCount: number;
  droppedBlockCount: number;
  updatedAt: number;
}

export interface BaseChatItem {
  id: string;
  createdAt: number;
}

export interface UserChatItem extends BaseChatItem {
  kind: "user";
  text: string;
}

export interface AssistantTextChatItem extends BaseChatItem {
  kind: "assistant_text";
  text: string;
  /** True while streaming; false after the assistant message is finalized. */
  streaming: boolean;
}

export interface ToolCallChatItem extends BaseChatItem {
  kind: "tool_call";
  callId: string;
  toolName: string;
  arguments: unknown;
}

export interface ToolResultChatItem extends BaseChatItem {
  kind: "tool_result";
  callId: string;
  toolName: string;
  status: "succeeded" | "failed" | "rejected" | "timed_out" | "canceled";
  summary?: string;
  error?: { code: string; message: string };
}

/** Lightweight system or command feedback line. */
export interface SystemChatItem extends BaseChatItem {
  kind: "system";
  text: string;
  /** Visual style variant for the terminal renderer. */
  flavor?: "banner" | "info" | "ack" | "tip";
}

export interface ErrorChatItem extends BaseChatItem {
  kind: "error";
  text: string;
}

/** Developer diagnostics shown only in /dev mode. */
export interface DevChatItem extends BaseChatItem {
  kind: "dev";
  channel: "model.invoke" | "model.finish" | "context.compressor" | "memory.debug" | "memory.dream";
  data: unknown;
}

export interface ResumeChoiceItem extends BaseChatItem {
  kind: "resume_choice";
  sessions: Array<{
    sessionId: string;
    title: string;
    frontend: string;
    lastActiveAt: number;
    messageCount: number;
  }>;
}

export interface TeamStatus {
  teamName: string;
  runStatus?: string;
  runRound?: number;
  dirtyArtifactCount: number;
  activeMemberName: string;
  inputMemberName: string;
  members: Array<{ name: string; role: string; sessionId?: string }>;
  tasks: Array<{ id: string; title: string; status: string; assignedTo?: string; claimedBy?: string }>;
  pendingInboxCount: number;
  queuedCount: number;
  runningCount: number;
  runStates: Array<{ memberName: string; status: string; consecutiveFailures: number; lastError?: string }>;
}

export type TeamAgentActivityStatus = "queued" | "running" | "tool" | "completed" | "failed" | "interrupted";

export interface TeamAgentActivity {
  memberName: string;
  status: TeamAgentActivityStatus;
  task: string;
  outputPreview: string;
  currentAction?: string;
  toolName?: string;
  startedAt?: number;
  updatedAt: number;
}

export interface ResumeSelectorState {
  sessions: ResumeChoiceItem["sessions"];
  selectedIndex: number;
  pageIndex: number;
  pageSize: number;
}

export interface ModelStatusState {
  phase: "connecting" | "retrying";
  attempt: number;
  maxAttempts: number;
  message: string;
  baseURL?: string;
  model?: string;
  error?: string;
  updatedAt: number;
}

export type ChatItem =
  | UserChatItem
  | AssistantTextChatItem
  | ToolCallChatItem
  | ToolResultChatItem
  | SystemChatItem
  | ErrorChatItem
  | DevChatItem
  | ResumeChoiceItem;
