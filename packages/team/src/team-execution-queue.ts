import type { StreamEvent } from "@jue/shared-types";
import type { TeamLeadActionResult, TeamSnapshot } from "./types.js";
import { TeamOrchestrator } from "./team-orchestrator.js";

export interface TeamQueueJob {
  memberName: string;
  text: string;
  taskNodeId?: string;
}

export interface TeamQueueRunSummary {
  memberName: string;
  sessionId: string;
  finalText: string;
  toolCallCount: number;
  actionCount: number;
  actionResults: TeamLeadActionResult[];
  artifactId?: string;
  error?: { code?: string; message?: string };
}

export type TeamQueueEvent =
  | { type: "queued"; job: TeamQueueJob; snapshot: TeamSnapshot; queuedCount: number; runningCount: number }
  | { type: "started"; job: TeamQueueJob; sessionId: string; snapshot: TeamSnapshot; queuedCount: number; runningCount: number }
  | { type: "stream"; job: TeamQueueJob; event: StreamEvent }
  | { type: "completed"; job: TeamQueueJob; summary: TeamQueueRunSummary; snapshot: TeamSnapshot; queuedCount: number; runningCount: number }
  | { type: "interrupted"; job: TeamQueueJob; snapshot: TeamSnapshot; queuedCount: number; runningCount: number }
  | { type: "failed"; job: TeamQueueJob; error: string; snapshot: TeamSnapshot; queuedCount: number; runningCount: number }
  | { type: "status"; snapshot: TeamSnapshot; queuedCount: number; runningCount: number; idle: boolean }
  | { type: "stopped"; snapshot: TeamSnapshot | undefined; queuedCount: number; runningCount: number };

export interface TeamExecutionQueueOptions {
  team: TeamOrchestrator;
  concurrency?: number;
  defaultText?: string;
  onEvent?: (event: TeamQueueEvent) => void;
  applyActions: (team: TeamOrchestrator, memberName: string, finalText: string) => { actionCount: number; results: TeamLeadActionResult[] };
}

export class TeamExecutionQueue {
  private readonly team: TeamOrchestrator;
  private readonly concurrency: number;
  private readonly defaultText: string;
  private readonly applyActions: TeamExecutionQueueOptions["applyActions"];
  private readonly onEvent: TeamExecutionQueueOptions["onEvent"];
  private readonly queue: TeamQueueJob[] = [];
  private readonly runningMembers = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: TeamExecutionQueueOptions) {
    this.team = options.team;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.defaultText = options.defaultText ?? "Process your pending team inbox and continue the shared task.";
    this.applyActions = options.applyActions;
    this.onEvent = options.onEvent;
  }

  status(): { queuedCount: number; runningCount: number } {
    return { queuedCount: this.queue.length, runningCount: this.runningMembers.size };
  }

  enqueue(memberName: string, text = this.defaultText, metadata: { taskNodeId?: string } = {}): void {
    const normalized = this.team.store.constructor ? memberName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "member" : memberName;
    if (this.runningMembers.has(normalized)) return;
    if (this.queue.some((job) => job.memberName === normalized && job.taskNodeId === metadata.taskNodeId)) return;
    const job = { memberName: normalized, text, ...(metadata.taskNodeId ? { taskNodeId: metadata.taskNodeId } : {}) };
    this.queue.push(job);
    this.emit({ type: "queued", job, snapshot: this.team.snapshot(), ...this.status() });
    this.pump();
  }

  enqueuePending(excludeMember?: string): void {
    const snapshot = this.team.snapshot();
    const exclude = normalizeMemberNameLocal(excludeMember ?? snapshot.session.leaderName);
    const runStates = new Map(snapshot.runStates.map((state) => [state.memberName, state]));
    const pendingMembers = new Set(snapshot.inbox.map((message) => message.to));
    for (const member of snapshot.session.members) {
      if (member.name === exclude || member.name === snapshot.session.leaderName) continue;
      if (!pendingMembers.has(member.name)) continue;
      if (this.runningMembers.has(member.name) || this.queue.some((job) => job.memberName === member.name)) continue;
      const state = runStates.get(member.name);
      if (state?.status === "running") continue;
      if ((state?.consecutiveFailures ?? 0) >= 2) continue;
      this.enqueue(member.name, this.defaultText);
    }
  }

  stop(): void {
    this.queue.length = 0;
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    this.runningMembers.clear();
    this.emit({ type: "stopped", snapshot: safeSnapshot(this.team), ...this.status() });
  }

  private pump(): void {
    while (this.runningMembers.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job || this.runningMembers.has(job.memberName)) continue;
      const abortController = new AbortController();
      this.runningMembers.add(job.memberName);
      this.abortControllers.set(job.memberName, abortController);
      void this.runJob(job, abortController).finally(() => {
        this.runningMembers.delete(job.memberName);
        this.abortControllers.delete(job.memberName);
        this.enqueuePending(job.memberName);
        this.pump();
        this.emitStatus();
      });
    }
  }

  private emitStatus(): void {
    const status = this.status();
    this.emit({
      type: "status",
      snapshot: this.team.snapshot(),
      ...status,
      idle: status.queuedCount === 0 && status.runningCount === 0,
    });
  }

  private async runJob(job: TeamQueueJob, abortController: AbortController): Promise<void> {
    try {
      const leaderName = this.team.snapshot().session.leaderName;
      const { sessionId, events, done } = this.team.runMember({
        memberName: job.memberName,
        userText: job.text,
        userId: "user_local",
        signal: abortController.signal,
        leaderMode: leaderName === job.memberName,
      });
      this.emit({ type: "started", job, sessionId, snapshot: this.team.snapshot(), ...this.status() });
      let finalText = "";
      let toolCallCount = 0;
      for await (const event of events) {
        if (abortController.signal.aborted) break;
        if (event.type === "model.delta") {
          const payload = event.payload as { delta?: unknown; text?: unknown };
          if (typeof payload.delta === "string") finalText += payload.delta;
          else if (typeof payload.text === "string") finalText += payload.text;
        }
        if (event.type === "tool.invocation.started") toolCallCount += 1;
        this.emit({ type: "stream", job, event });
      }
      const response = await done;
      if (abortController.signal.aborted) {
        if (job.taskNodeId) this.team.markTaskNodeFailed(job.taskNodeId, "interrupted");
        this.emit({ type: "interrupted", job, snapshot: this.team.snapshot(), ...this.status() });
        return;
      }
      const actionResult = this.applyActions(this.team, job.memberName, finalText);
      const artifact = this.team.recordArtifact({
        producerAgent: job.memberName,
        title: `${job.memberName} result`,
        summary: summarizeText(finalText || response.error?.message || "No textual output."),
        content: finalText,
        ...(job.taskNodeId ? { taskId: job.taskNodeId } : {}),
        metadata: { toolCallCount, actionCount: actionResult.actionCount },
      });
      if (job.taskNodeId) this.team.markTaskNodeCompleted(job.taskNodeId, artifact?.id);
      this.team.updateRunStatus("lead_resume_required");
      this.emit({
        type: "completed",
        job,
        summary: {
          memberName: job.memberName,
          sessionId,
          finalText,
          toolCallCount,
          actionCount: actionResult.actionCount,
          actionResults: actionResult.results,
          ...(artifact ? { artifactId: artifact.id } : {}),
          ...(response.error ? { error: { code: response.error.code, message: response.error.message } } : {}),
        },
        snapshot: this.team.snapshot(),
        ...this.status(),
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        if (job.taskNodeId) this.team.markTaskNodeFailed(job.taskNodeId, "interrupted");
        this.emit({ type: "interrupted", job, snapshot: this.team.snapshot(), ...this.status() });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (job.taskNodeId) this.team.markTaskNodeFailed(job.taskNodeId, message);
      this.emit({ type: "failed", job, error: message, snapshot: this.team.snapshot(), ...this.status() });
    }
  }

  private emit(event: TeamQueueEvent): void {
    this.onEvent?.(event);
  }
}

function summarizeText(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) return "No textual output.";
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function normalizeMemberNameLocal(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
}

function safeSnapshot(team: TeamOrchestrator): TeamSnapshot | undefined {
  try {
    return team.snapshot();
  } catch {
    return undefined;
  }
}
