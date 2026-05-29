import type { Id, SessionResponse, StreamEvent, Timestamp } from "@jue/shared-types";

export type TeamMemberRole = "leader" | "teammate";
export type TeamTaskStatus = "pending" | "in_progress" | "completed";
export type TeamTaskNodeStatus = "pending" | "ready" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type TeamTaskPriority = "low" | "normal" | "high";
export type TeamMessageStatus = "pending" | "delivered";
export type TeamRunStatus = "idle" | "lead_running" | "subagents_running" | "lead_resume_required" | "waiting_user" | "completed" | "failed" | "cancelled";
export type TeamArtifactType = "subagent_result" | "code_fact_report" | "implementation_result" | "review_finding" | "plan" | "stage_summary" | "final_answer" | "generic";

export interface TeamMemberSpec {
  name: string;
  role: TeamMemberRole;
  description?: string;
  profileName?: string;
  allowedToolNames?: string[];
  sessionId?: Id;
  active?: boolean;
  createdAt: Timestamp;
  lastActiveAt: Timestamp;
}

export type TeamMemberRunStatus = "idle" | "running" | "completed" | "failed";

export interface TeamMemberRunState {
  memberName: string;
  status: TeamMemberRunStatus;
  updatedAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  sessionId?: Id;
  consecutiveFailures: number;
  lastError?: string;
}

export interface TeamMemberProfile {
  name: string;
  description: string;
  allowedToolNames: string[];
  promptTemplate?: string;
  autoRunOnInbox?: boolean;
  maxConsecutiveFailures?: number;
}

export interface TeamTaskRecord {
  id: Id;
  title: string;
  description: string;
  status: TeamTaskStatus;
  assignedTo?: string;
  claimedBy?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamTaskNodeRecord {
  id: Id;
  runId: Id;
  title: string;
  description: string;
  agent: string;
  status: TeamTaskNodeStatus;
  priority: TeamTaskPriority;
  dependsOn: Id[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  artifactId?: Id;
  error?: string;
  expectedArtifactType?: TeamArtifactType;
  contextHints?: string[];
}

export type LeadDecisionType = "dispatch_agents" | "continue_self" | "ask_user" | "stage_summary" | "final" | "abort";

export interface LeadDispatchTaskSpec {
  title: string;
  description: string;
  agent: string;
  priority: TeamTaskPriority;
  dependsOn?: string[];
  expectedArtifactType?: TeamArtifactType;
  contextHints?: string[];
}

export type LeadDecision =
  | { type: "dispatch_agents"; reason: string; userVisibleStatus: string; tasks: LeadDispatchTaskSpec[]; autoResume: boolean }
  | { type: "continue_self"; reason: string; instruction: string }
  | { type: "ask_user"; question: string; reason: string; options?: Array<{ id: string; label: string; effect: string }> }
  | { type: "stage_summary"; summary: string; findings?: string[]; nextStep?: string; needsUserInput: boolean }
  | { type: "final"; answer: string; usedArtifactIds: string[] }
  | { type: "abort"; reason: string; recoverable: boolean };

export interface TeamMessageRecord {
  id: Id;
  teamName: string;
  from: string;
  to: string;
  body: string;
  status: TeamMessageStatus;
  createdAt: Timestamp;
  deliveredAt?: Timestamp;
  relatedTaskId?: Id;
  metadata?: Record<string, unknown>;
}

export interface TeamSessionRecord {
  teamName: string;
  leaderName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  members: TeamMemberSpec[];
  activeMemberName: string;
}

export interface TeamRunRecord {
  id: Id;
  teamName: string;
  userInstruction: string;
  status: TeamRunStatus;
  round: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLeadRunAt?: Timestamp;
  completedAt?: Timestamp;
  failureReason?: string;
}

export interface TeamArtifactRecord {
  id: Id;
  runId: Id;
  type: TeamArtifactType;
  producerAgent: string;
  taskId?: Id;
  title: string;
  summary: string;
  content: string;
  confidence?: number;
  consumedByLead: boolean;
  createdAt: Timestamp;
  consumedAt?: Timestamp;
  metadata?: Record<string, unknown>;
}

export interface TeamInboxDelivery {
  messages: TeamMessageRecord[];
  injectedText: string;
}

export interface TeamSnapshot {
  session: TeamSessionRecord;
  activeRun?: TeamRunRecord;
  tasks: TeamTaskRecord[];
  taskNodes: TeamTaskNodeRecord[];
  inbox: TeamMessageRecord[];
  runStates: TeamMemberRunState[];
  artifacts: TeamArtifactRecord[];
  dirtyArtifactCount: number;
}

export interface TeamCleanupResult {
  removedMembers: string[];
  removedRunStates: string[];
  archivedLegacyTaskCount: number;
  purgedLegacyTaskCount: number;
  removedPendingMessageCount: number;
  resetActiveMember?: string;
}


export type TeamLeadActionType = "create_task" | "send_message" | "switch_member" | "claim_task" | "complete_task";

export interface TeamLeadAction {
  type: TeamLeadActionType;
  to?: string;
  title?: string;
  description?: string;
  message?: string;
  result?: string;
  taskId?: Id;
}

export interface TeamLeadActionResult {
  action: TeamLeadAction;
  status: "applied" | "failed";
  message: string;
}
export interface TeamMemberRunInput {
  memberName: string;
  userText: string;
  userId?: Id;
  signal?: AbortSignal;
  leaderMode?: boolean;
}

export interface TeamMemberRunOutput {
  sessionId: Id;
  events: AsyncIterable<StreamEvent>;
  done: Promise<SessionResponse>;
}

export interface TeamMemberSessionRequest {
  memberName: string;
  userId: Id;
  prompt: string;
  sessionId?: Id;
  teamName: string;
  leaderName: string;
  role: TeamMemberRole;
  allowedToolNames: string[];
  signal?: AbortSignal;
}

export interface TeamMemberRunner {
  run(input: TeamMemberSessionRequest): TeamMemberRunOutput;
}

export function normalizeTeamName(input: string | undefined): string {
  const trimmed = (input ?? "default").trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

