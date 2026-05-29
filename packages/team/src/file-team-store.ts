import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { newId } from "@jue/utils";
import type { LeadDispatchTaskSpec, TeamArtifactRecord, TeamArtifactType, TeamCleanupResult, TeamInboxDelivery, TeamMemberRunState, TeamMemberRunStatus, TeamMemberSpec, TeamMessageRecord, TeamRunRecord, TeamRunStatus, TeamSessionRecord, TeamSnapshot, TeamTaskNodeRecord, TeamTaskNodeStatus, TeamTaskRecord } from "./types.js";
import { normalizeTeamName } from "./types.js";

const SESSION_FILE = "team.json";
const TASKS_FILE = "tasks.json";
const MESSAGES_FILE = "messages.jsonl";
const RUN_STATES_FILE = "run-states.json";
const RUNS_FILE = "runs.json";
const ARTIFACTS_FILE = "artifacts.jsonl";
const TASK_NODES_FILE = "task-nodes.json";
const LOCK_DIR = "locks";

export interface FileTeamStoreOptions {
  teamName: string;
  globalJueDir?: string;
  projectKey?: string;
}

export class FileTeamStore {
  readonly teamName: string;
  readonly teamDir: string;

  constructor(options: FileTeamStoreOptions) {
    this.teamName = normalizeTeamName(options.teamName);
    const globalJueDir = resolve(options.globalJueDir ?? join(homedir(), ".jue"));
    this.teamDir = options.projectKey ? join(globalJueDir, "projects", options.projectKey, "tasks", this.teamName) : join(globalJueDir, "tasks", this.teamName);
    ensureDir(this.teamDir);
    ensureDir(join(this.teamDir, LOCK_DIR));
  }

  loadOrCreateSession(input: { leaderName?: string; members?: Array<Partial<TeamMemberSpec> & { name: string }> }): TeamSessionRecord {
    const existing = readJson<TeamSessionRecord>(this.sessionPath());
    if (existing) return existing;
    const now = Date.now();
    const leaderName = normalizeMemberName(input.leaderName ?? "lead");
    const memberSpecs = input.members && input.members.length > 0 ? input.members : [{ name: "explorer" }, { name: "worker" }, { name: "reviewer" }];
    const members = uniqueMembers([
      { name: leaderName, role: "leader" as const, description: "Team leader", createdAt: now, lastActiveAt: now, active: true },
      ...memberSpecs.map((member) => createMember({
        name: normalizeMemberName(member.name),
        role: member.role ?? "teammate",
        description: member.description,
        sessionId: member.sessionId,
        createdAt: member.createdAt ?? now,
        lastActiveAt: member.lastActiveAt ?? now,
        active: member.active ?? true,
      })),
    ]);
    const session: TeamSessionRecord = { teamName: this.teamName, leaderName, createdAt: now, updatedAt: now, members, activeMemberName: leaderName };
    this.saveSession(session);
    if (!existsSync(this.tasksPath())) writeJson(this.tasksPath(), [] satisfies TeamTaskRecord[]);
    if (!existsSync(this.runStatesPath())) writeJson(this.runStatesPath(), [] satisfies TeamMemberRunState[]);
    if (!existsSync(this.runsPath())) writeJson(this.runsPath(), [] satisfies TeamRunRecord[]);
    if (!existsSync(this.taskNodesPath())) writeJson(this.taskNodesPath(), [] satisfies TeamTaskNodeRecord[]);
    if (!existsSync(this.artifactsPath())) writeFileSync(this.artifactsPath(), "", "utf8");
    if (!existsSync(this.messagesPath())) writeFileSync(this.messagesPath(), "", "utf8");
    return session;
  }

  saveSession(session: TeamSessionRecord): void {
    writeJson(this.sessionPath(), { ...session, updatedAt: Date.now() });
  }

  addOrUpdateMember(input: Partial<TeamMemberSpec> & { name: string; role?: TeamMemberSpec["role"] }): TeamSessionRecord {
    const session = this.loadOrCreateSession({});
    const now = Date.now();
    const name = normalizeMemberName(input.name);
    const existing = session.members.find((member) => member.name === name);
    if (existing) {
      existing.role = input.role ?? existing.role;
      if (input.description !== undefined) existing.description = input.description;
      if (input.profileName !== undefined) existing.profileName = input.profileName;
      if (input.allowedToolNames !== undefined) existing.allowedToolNames = input.allowedToolNames;
      if (input.sessionId !== undefined) existing.sessionId = input.sessionId;
      existing.active = input.active ?? existing.active ?? true;
      existing.lastActiveAt = now;
    } else {
      session.members.push(createMember({
        name,
        role: input.role ?? "teammate",
        description: input.description,
        profileName: input.profileName,
        allowedToolNames: input.allowedToolNames,
        sessionId: input.sessionId,
        active: input.active ?? true,
        createdAt: now,
        lastActiveAt: now,
      }));
    }
    session.updatedAt = now;
    this.saveSession(session);
    return session;
  }

  setActiveMember(memberName: string): TeamSessionRecord {
    const session = this.loadOrCreateSession({});
    const name = normalizeMemberName(memberName);
    if (!session.members.some((member) => member.name === name)) {
      throw new Error(`Team member not found: ${name}`);
    }
    session.activeMemberName = name;
    session.updatedAt = Date.now();
    this.saveSession(session);
    return session;
  }

  setMemberSession(memberName: string, sessionId: string): TeamSessionRecord {
    return this.addOrUpdateMember({ name: memberName, sessionId });
  }

  cleanupLegacyState(options: { archivePendingLegacyTasks?: boolean; removeInvalidMembers?: boolean; purgeArchivedLegacyTasks?: boolean } = {}): TeamCleanupResult {
    const session = this.loadOrCreateSession({});
    const removeInvalidMembers = options.removeInvalidMembers !== false;
    const invalidMembers = new Set(["__lead_decision_dispatch__"]);
    const result: TeamCleanupResult = { removedMembers: [], removedRunStates: [], archivedLegacyTaskCount: 0, purgedLegacyTaskCount: 0, removedPendingMessageCount: 0 };

    if (removeInvalidMembers) {
      const nextMembers = session.members.filter((member) => {
        if (!invalidMembers.has(member.name)) return true;
        result.removedMembers.push(member.name);
        return false;
      });
      if (nextMembers.length !== session.members.length) {
        session.members = nextMembers;
        if (!session.members.some((member) => member.name === session.activeMemberName)) {
          session.activeMemberName = session.leaderName;
          result.resetActiveMember = session.leaderName;
        }
        this.saveSession(session);
      }

      const runStates = this.listRunStates();
      const nextStates = runStates.filter((state) => {
        if (!invalidMembers.has(state.memberName)) return true;
        result.removedRunStates.push(state.memberName);
        return false;
      });
      if (nextStates.length !== runStates.length) writeJson(this.runStatesPath(), nextStates);

      const messages = this.readMessages();
      const nextMessages = messages.filter((message) => {
        const remove = invalidMembers.has(message.from) || invalidMembers.has(message.to);
        if (remove && message.status === "pending") result.removedPendingMessageCount += 1;
        return !remove;
      });
      if (nextMessages.length !== messages.length) this.rewriteMessages(nextMessages);
    }

    if (options.archivePendingLegacyTasks !== false) {
      const tasks = this.listTasks();
      const now = Date.now();
      let changed = false;
      for (const task of tasks) {
        if (task.status !== "pending") continue;
        task.status = "completed";
        task.completedAt = now;
        task.updatedAt = now;
        task.result = task.result ?? "Archived by team cleanup after migration to TeamTaskNode.";
        task.metadata = { ...(task.metadata ?? {}), archivedByCleanup: true, archivedAt: now };
        result.archivedLegacyTaskCount += 1;
        changed = true;
      }
      if (changed) this.writeTasks(tasks);
    }

    if (options.purgeArchivedLegacyTasks) {
      const tasks = this.listTasks();
      const nextTasks = tasks.filter((task) => {
        const purge = task.metadata?.archivedByCleanup === true;
        if (purge) result.purgedLegacyTaskCount += 1;
        return !purge;
      });
      if (nextTasks.length !== tasks.length) this.writeTasks(nextTasks);
    }

    return result;
  }

  listTasks(): TeamTaskRecord[] {
    return readJson<TeamTaskRecord[]>(this.tasksPath()) ?? [];
  }

  createTask(input: { title: string; description?: string; createdBy: string; assignedTo?: string; metadata?: Record<string, unknown> }): TeamTaskRecord {
    const now = Date.now();
    const task: TeamTaskRecord = {
      id: newId("teamtask"),
      title: input.title,
      description: input.description ?? "",
      status: "pending",
      createdBy: normalizeMemberName(input.createdBy),
      createdAt: now,
      updatedAt: now,
      ...(input.assignedTo ? { assignedTo: normalizeMemberName(input.assignedTo) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.writeTasks([...this.listTasks(), task]);
    return task;
  }

  claimTask(taskId: string, memberName: string): TeamTaskRecord {
    const lockPath = join(this.teamDir, LOCK_DIR, `${safeFileName(taskId)}.lock`);
    acquireLock(lockPath, memberName);
    try {
      const tasks = this.listTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Team task not found: ${taskId}`);
      if (task.status !== "pending") throw new Error(`Team task is not pending: ${taskId}`);
      const now = Date.now();
      task.status = "in_progress";
      task.claimedBy = normalizeMemberName(memberName);
      task.assignedTo = task.assignedTo ?? normalizeMemberName(memberName);
      task.updatedAt = now;
      this.writeTasks(tasks);
      return task;
    } finally {
      releaseLock(lockPath);
    }
  }

  completeTask(taskId: string, memberName: string, result: string): TeamTaskRecord {
    const tasks = this.listTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Team task not found: ${taskId}`);
    const now = Date.now();
    task.status = "completed";
    task.claimedBy = task.claimedBy ?? normalizeMemberName(memberName);
    task.completedAt = now;
    task.updatedAt = now;
    task.result = result;
    this.writeTasks(tasks);
    return task;
  }

  appendMessage(input: { from: string; to: string; body: string; relatedTaskId?: string; metadata?: Record<string, unknown> }): TeamMessageRecord {
    const now = Date.now();
    const message: TeamMessageRecord = {
      id: newId("teammsg"),
      teamName: this.teamName,
      from: normalizeMemberName(input.from),
      to: normalizeMemberName(input.to),
      body: input.body,
      status: "pending",
      createdAt: now,
      ...(input.relatedTaskId ? { relatedTaskId: input.relatedTaskId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    writeFileSync(this.messagesPath(), `${JSON.stringify(message)}\n`, { encoding: "utf8", flag: "a" });
    return message;
  }

  listPendingInboxMembers(): string[] {
    const seen = new Set<string>();
    for (const message of this.readMessages()) {
      if (message.status === "pending") seen.add(message.to);
    }
    return [...seen];
  }

  listRunStates(): TeamMemberRunState[] {
    return readJson<TeamMemberRunState[]>(this.runStatesPath()) ?? [];
  }

  listRuns(): TeamRunRecord[] {
    return readJson<TeamRunRecord[]>(this.runsPath()) ?? [];
  }

  activeRun(): TeamRunRecord | undefined {
    return this.listRuns()
      .filter((run) => run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  startRun(userInstruction: string): TeamRunRecord {
    const existing = this.activeRun();
    if (existing) return this.updateRun(existing.id, { userInstruction, status: "lead_running" });
    const now = Date.now();
    const run: TeamRunRecord = {
      id: newId("teamrun"),
      teamName: this.teamName,
      userInstruction,
      status: "lead_running",
      round: 1,
      createdAt: now,
      updatedAt: now,
      lastLeadRunAt: now,
    };
    this.writeRuns([...this.listRuns(), run]);
    return run;
  }

  updateRun(runId: string, patch: Partial<Pick<TeamRunRecord, "userInstruction" | "status" | "failureReason">> & { incrementRound?: boolean }): TeamRunRecord {
    const runs = this.listRuns();
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Team run not found: ${runId}`);
    const now = Date.now();
    if (patch.userInstruction !== undefined) run.userInstruction = patch.userInstruction;
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.failureReason !== undefined) run.failureReason = patch.failureReason;
    if (patch.incrementRound) run.round += 1;
    if (patch.status === "lead_running") run.lastLeadRunAt = now;
    if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") run.completedAt = now;
    run.updatedAt = now;
    this.writeRuns(runs);
    return run;
  }

  appendArtifact(input: { runId: string; type?: TeamArtifactType; producerAgent: string; title: string; summary: string; content: string; taskId?: string; confidence?: number; metadata?: Record<string, unknown> }): TeamArtifactRecord {
    const now = Date.now();
    const artifact: TeamArtifactRecord = {
      id: newId("teamart"),
      runId: input.runId,
      type: input.type ?? "generic",
      producerAgent: normalizeMemberName(input.producerAgent),
      title: input.title,
      summary: input.summary,
      content: input.content,
      consumedByLead: false,
      createdAt: now,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    writeFileSync(this.artifactsPath(), `${JSON.stringify(artifact)}\n`, { encoding: "utf8", flag: "a" });
    return artifact;
  }

  listArtifacts(runId?: string): TeamArtifactRecord[] {
    const artifacts = this.readArtifacts();
    return runId ? artifacts.filter((artifact) => artifact.runId === runId) : artifacts;
  }

  listTaskNodes(runId?: string): TeamTaskNodeRecord[] {
    const nodes = readJson<TeamTaskNodeRecord[]>(this.taskNodesPath()) ?? [];
    return runId ? nodes.filter((node) => node.runId === runId) : nodes;
  }

  createTaskNodes(runId: string, tasks: readonly LeadDispatchTaskSpec[]): TeamTaskNodeRecord[] {
    const now = Date.now();
    const existing = this.listTaskNodes();
    const nodes = tasks.map((task) => ({
      id: newId("teamnode"),
      runId,
      title: task.title,
      description: task.description,
      agent: normalizeMemberName(task.agent),
      status: task.dependsOn && task.dependsOn.length > 0 ? "pending" as const : "ready" as const,
      priority: task.priority,
      dependsOn: task.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
      ...(task.expectedArtifactType ? { expectedArtifactType: task.expectedArtifactType } : {}),
      ...(task.contextHints ? { contextHints: task.contextHints } : {}),
    }));
    writeJson(this.taskNodesPath(), [...existing, ...nodes]);
    return nodes;
  }

  updateTaskNode(nodeId: string, patch: Partial<Pick<TeamTaskNodeRecord, "status" | "artifactId" | "error">>): TeamTaskNodeRecord {
    const nodes = this.listTaskNodes();
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Team task node not found: ${nodeId}`);
    const now = Date.now();
    if (patch.status !== undefined) node.status = patch.status;
    if (patch.artifactId !== undefined) node.artifactId = patch.artifactId;
    if (patch.error !== undefined) node.error = patch.error;
    if (patch.status === "running") node.startedAt = now;
    if (patch.status === "completed" || patch.status === "failed" || patch.status === "blocked" || patch.status === "cancelled") node.completedAt = now;
    node.updatedAt = now;
    writeJson(this.taskNodesPath(), unlockReadyTaskNodes(nodes));
    return node;
  }

  readyTaskNodes(runId: string): TeamTaskNodeRecord[] {
    const nodes = unlockReadyTaskNodes(this.listTaskNodes());
    writeJson(this.taskNodesPath(), nodes);
    return nodes.filter((node) => node.runId === runId && node.status === "ready").sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.createdAt - b.createdAt);
  }

  markArtifactsConsumedByLead(runId: string): TeamArtifactRecord[] {
    const now = Date.now();
    const artifacts = this.readArtifacts();
    const next = artifacts.map((artifact) => artifact.runId === runId && !artifact.consumedByLead ? { ...artifact, consumedByLead: true, consumedAt: now } : artifact);
    this.rewriteArtifacts(next);
    return next.filter((artifact) => artifact.runId === runId);
  }

  setMemberRunState(input: { memberName: string; status: TeamMemberRunStatus; sessionId?: string; error?: string }): TeamMemberRunState {
    const now = Date.now();
    const memberName = normalizeMemberName(input.memberName);
    const states = this.listRunStates();
    const existing = states.find((state) => state.memberName === memberName);
    const previousFailures = existing?.consecutiveFailures ?? 0;
    const next: TeamMemberRunState = {
      memberName,
      status: input.status,
      updatedAt: now,
      consecutiveFailures: input.status === "failed" ? previousFailures + 1 : input.status === "completed" ? 0 : previousFailures,
      ...(input.status === "running" ? { startedAt: now } : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(input.status === "completed" || input.status === "failed" ? { completedAt: now } : existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(input.error ? { lastError: input.error } : existing?.lastError && input.status !== "completed" ? { lastError: existing.lastError } : {}),
    };
    const nextStates = existing ? states.map((state) => state.memberName === memberName ? next : state) : [...states, next];
    writeJson(this.runStatesPath(), nextStates);
    return next;
  }

  drainInbox(memberName: string): TeamInboxDelivery {
    const name = normalizeMemberName(memberName);
    const messages = this.readMessages();
    const now = Date.now();
    const drained: TeamMessageRecord[] = [];
    const next = messages.map((message) => {
      if (message.to === name && message.status === "pending") {
        drained.push(message);
        return { ...message, status: "delivered" as const, deliveredAt: now };
      }
      return message;
    });
    if (drained.length > 0) this.rewriteMessages(next);
    return { messages: drained, injectedText: formatInboxForPrompt(drained) };
  }

  snapshot(memberName?: string): TeamSnapshot {
    const session = this.loadOrCreateSession({});
    const activeRun = this.activeRun();
    const artifacts = activeRun ? this.listArtifacts(activeRun.id) : [];
    return {
      session,
      ...(activeRun ? { activeRun } : {}),
      tasks: this.listTasks(),
      taskNodes: activeRun ? this.listTaskNodes(activeRun.id) : [],
      inbox: this.readMessages().filter((message) => message.status === "pending" && (!memberName || message.to === normalizeMemberName(memberName))),
      runStates: this.listRunStates(),
      artifacts,
      dirtyArtifactCount: artifacts.filter((artifact) => !artifact.consumedByLead).length,
    };
  }

  private writeTasks(tasks: TeamTaskRecord[]): void {
    writeJson(this.tasksPath(), tasks);
  }

  private writeRuns(runs: TeamRunRecord[]): void {
    writeJson(this.runsPath(), runs);
  }

  private readMessages(): TeamMessageRecord[] {
    const path = this.messagesPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TeamMessageRecord];
        } catch {
          return [];
        }
      });
  }

  private rewriteMessages(messages: TeamMessageRecord[]): void {
    writeFileSync(this.messagesPath(), messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length > 0 ? "\n" : ""), "utf8");
  }

  private readArtifacts(): TeamArtifactRecord[] {
    const path = this.artifactsPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TeamArtifactRecord];
        } catch {
          return [];
        }
      });
  }

  private rewriteArtifacts(artifacts: TeamArtifactRecord[]): void {
    writeFileSync(this.artifactsPath(), artifacts.map((artifact) => JSON.stringify(artifact)).join("\n") + (artifacts.length > 0 ? "\n" : ""), "utf8");
  }

  private sessionPath(): string {
    return join(this.teamDir, SESSION_FILE);
  }

  private tasksPath(): string {
    return join(this.teamDir, TASKS_FILE);
  }

  private messagesPath(): string {
    return join(this.teamDir, MESSAGES_FILE);
  }

  private runStatesPath(): string {
    return join(this.teamDir, RUN_STATES_FILE);
  }

  private taskNodesPath(): string {
    return join(this.teamDir, TASK_NODES_FILE);
  }

  private runsPath(): string {
    return join(this.teamDir, RUNS_FILE);
  }

  private artifactsPath(): string {
    return join(this.teamDir, ARTIFACTS_FILE);
  }
}

export function normalizeMemberName(input: string): string {
  const safe = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "member";
}

export function formatInboxForPrompt(messages: TeamMessageRecord[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map((message) => `- from ${message.from}${message.relatedTaskId ? ` task=${message.relatedTaskId}` : ""}: ${message.body}`);
  return `[Team inbox]\n${lines.join("\n")}`;
}

function createMember(input: {
  name: string;
  role: TeamMemberSpec["role"];
  createdAt: number;
  lastActiveAt: number;
  active?: boolean | undefined;
  description?: string | undefined;
  profileName?: string | undefined;
  allowedToolNames?: string[] | undefined;
  sessionId?: string | undefined;
}): TeamMemberSpec {
  return {
    name: input.name,
    role: input.role,
    createdAt: input.createdAt,
    lastActiveAt: input.lastActiveAt,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.profileName !== undefined ? { profileName: input.profileName } : {}),
    ...(input.allowedToolNames !== undefined ? { allowedToolNames: input.allowedToolNames } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
  };
}

function uniqueMembers(members: TeamMemberSpec[]): TeamMemberSpec[] {
  const seen = new Set<string>();
  return members.filter((member) => {
    if (seen.has(member.name)) return false;
    seen.add(member.name);
    return true;
  });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function unlockReadyTaskNodes(nodes: TeamTaskNodeRecord[]): TeamTaskNodeRecord[] {
  const completed = new Set(nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const now = Date.now();
  return nodes.map((node) => {
    if (node.status !== "pending") return node;
    if (!node.dependsOn.every((id) => completed.has(id))) return node;
    return { ...node, status: "ready" as TeamTaskNodeStatus, updatedAt: now };
  });
}

function priorityRank(priority: TeamTaskNodeRecord["priority"]): number {
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  return 1;
}

function acquireLock(path: string, owner: string): void {
  ensureDir(dirname(path));
  try {
    writeFileSync(path, `${owner}\n${Date.now()}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    throw new Error(`Task is locked by another team member: ${basename(path, ".lock")}`);
  }
}

function releaseLock(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort for stale lock cleanup
  }
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_");
}



