import type { Id } from "@jue/shared-types";
import { newId } from "@jue/utils";
import { FileTeamStore, normalizeMemberName } from "./file-team-store.js";
import type { LeadDispatchTaskSpec, TeamArtifactRecord, TeamCleanupResult, TeamLeadAction, TeamLeadActionResult, TeamMemberProfile, TeamMemberRunInput, TeamMemberRunner, TeamMemberRunOutput, TeamRunRecord, TeamRunStatus, TeamSnapshot, TeamTaskNodeRecord } from "./types.js";
import { normalizeTeamName } from "./types.js";

export interface TeamOrchestratorOptions {
  teamName?: string;
  globalJueDir?: string;
  projectKey?: string;
  runner: TeamMemberRunner;
  profiles?: TeamMemberProfile[];
  promptProvider?: TeamPromptProvider;
}

export interface TeamPromptProvider {
  loadTemplate(profileName: string): string | undefined;
}

export interface StartTeamOptions {
  teamName?: string;
  members?: string[];
  leaderName?: string;
}

export class TeamOrchestrator {
  readonly teamName: string;
  readonly store: FileTeamStore;
  private readonly runner: TeamMemberRunner;
  private readonly profiles: Map<string, TeamMemberProfile>;
  private readonly promptProvider: TeamPromptProvider | undefined;

  constructor(options: TeamOrchestratorOptions) {
    this.teamName = normalizeTeamName(options.teamName);
    this.store = new FileTeamStore({ teamName: this.teamName, ...(options.globalJueDir ? { globalJueDir: options.globalJueDir } : {}), ...(options.projectKey ? { projectKey: options.projectKey } : {}) });
    this.runner = options.runner;
    this.profiles = new Map((options.profiles ?? defaultTeamMemberProfiles()).map((profile) => [normalizeMemberName(profile.name), profile]));
    this.promptProvider = options.promptProvider;
  }

  start(options: StartTeamOptions = {}): TeamSnapshot {
    const members = (options.members ?? ["explorer", "worker", "reviewer"]).map((name) => this.memberSpecFromProfile(name));
    this.store.loadOrCreateSession({ leaderName: options.leaderName ?? "lead", members });
    return this.snapshot();
  }

  snapshot(memberName?: string): TeamSnapshot {
    return this.store.snapshot(memberName);
  }

  setActiveMember(memberName: string): TeamSnapshot {
    const session = this.store.setActiveMember(memberName);
    return this.store.snapshot(session.activeMemberName);
  }

  addMember(memberName: string, description?: string): TeamSnapshot {
    this.store.addOrUpdateMember({ ...this.memberSpecFromProfile(memberName), active: true, ...(description ? { description } : {}) });
    return this.snapshot(memberName);
  }

  cleanupLegacyState(options: { purgeArchivedLegacyTasks?: boolean } = {}): TeamCleanupResult {
    return this.store.cleanupLegacyState(options);
  }

  pendingInboxMembers(): string[] {
    return this.store.listPendingInboxMembers();
  }

  createTask(input: { title: string; description?: string; createdBy: string; assignedTo?: string }): TeamSnapshot {
    this.store.createTask(input);
    if (input.assignedTo) {
      this.store.appendMessage({
        from: input.createdBy,
        to: input.assignedTo,
        body: `New task: ${input.title}${input.description ? `\n${input.description}` : ""}`,
      });
    }
    return this.snapshot(input.assignedTo);
  }

  claimTask(taskId: string, memberName: string): TeamSnapshot {
    this.store.claimTask(taskId, memberName);
    return this.snapshot(memberName);
  }

  completeTask(input: { taskId: string; memberName: string; result: string; notify?: string }): TeamSnapshot {
    this.store.completeTask(input.taskId, input.memberName, input.result);
    if (input.notify) this.store.appendMessage({ from: input.memberName, to: input.notify, body: input.result, relatedTaskId: input.taskId });
    return this.snapshot(input.memberName);
  }

  sendMessage(input: { from: string; to: string; body: string; relatedTaskId?: string }): TeamSnapshot {
    this.store.appendMessage(input);
    return this.snapshot(input.to);
  }

  startRun(userInstruction: string): TeamRunRecord {
    return this.store.startRun(userInstruction);
  }

  updateRunStatus(status: TeamRunStatus, options: { incrementRound?: boolean; failureReason?: string } = {}): TeamRunRecord | undefined {
    const run = this.store.activeRun();
    if (!run) return undefined;
    return this.store.updateRun(run.id, { status, ...(options.incrementRound ? { incrementRound: true } : {}), ...(options.failureReason ? { failureReason: options.failureReason } : {}) });
  }

  recordArtifact(input: { producerAgent: string; title: string; summary: string; content: string; taskId?: string; confidence?: number; metadata?: Record<string, unknown> }): TeamArtifactRecord | undefined {
    const run = this.store.activeRun();
    if (!run) return undefined;
    return this.store.appendArtifact({ runId: run.id, type: "subagent_result", ...input });
  }

  createTaskNodes(tasks: readonly LeadDispatchTaskSpec[]): TeamTaskNodeRecord[] {
    const run = this.store.activeRun();
    if (!run) throw new Error("Cannot create team task nodes without an active TeamRun.");
    return this.store.createTaskNodes(run.id, tasks);
  }

  readyTaskNodes(): TeamTaskNodeRecord[] {
    const run = this.store.activeRun();
    return run ? this.store.readyTaskNodes(run.id) : [];
  }

  markTaskNodeRunning(nodeId: string): TeamTaskNodeRecord {
    return this.store.updateTaskNode(nodeId, { status: "running" });
  }

  markTaskNodeCompleted(nodeId: string, artifactId?: string): TeamTaskNodeRecord {
    return this.store.updateTaskNode(nodeId, { status: "completed", ...(artifactId ? { artifactId } : {}) });
  }

  markTaskNodeFailed(nodeId: string, error: string): TeamTaskNodeRecord {
    return this.store.updateTaskNode(nodeId, { status: "failed", error });
  }

  consumeLeadArtifacts(): TeamArtifactRecord[] {
    const run = this.store.activeRun();
    return run ? this.store.markArtifactsConsumedByLead(run.id) : [];
  }

  buildLeadResumeInstruction(): string | undefined {
    const run = this.store.activeRun();
    if (!run) return undefined;
    const dirtyArtifacts = this.store.listArtifacts(run.id).filter((artifact) => !artifact.consumedByLead);
    if (dirtyArtifacts.length === 0) return undefined;
    const artifactLines = dirtyArtifacts.map((artifact) => [
      `- ${artifact.id} from ${artifact.producerAgent}: ${artifact.title}`,
      `  Summary: ${artifact.summary}`,
      artifact.content ? `  Output content: ${compactText(artifact.content, 3000)}` : "",
    ].filter(Boolean).join("\n"));
    return [
      "Subagent results are ready. You are the lead and must continue the same user task without waiting for another user message.",
      "Consume these artifacts, summarize the current stage for the user, and decide whether to dispatch more teammates, ask the user, or provide the final answer.",
      "Do not end silently. If no further action is needed, provide a concise stage summary or final answer.",
      "Original user instruction:",
      run.userInstruction,
      "Unconsumed artifacts:",
      artifactLines.join("\n"),
    ].join("\n\n");
  }

  runMember(input: TeamMemberRunInput): TeamMemberRunOutput {
    const memberName = normalizeMemberName(input.memberName);
    const session = this.store.addOrUpdateMember({ name: memberName, active: true });
    const member = session.members.find((item) => item.name === memberName);
    const isLeader = input.leaderMode === true || memberName === session.leaderName;
    const profile = this.resolveProfile(memberName, isLeader);
    const inbox = this.store.drainInbox(memberName);
    const template = this.promptProvider?.loadTemplate(profile.name) ?? profile.promptTemplate;
    const dirtyArtifacts = isLeader ? this.store.listArtifacts(this.store.activeRun()?.id).filter((artifact) => !artifact.consumedByLead) : [];
    const prompt = renderTeamMemberPrompt({
      teamName: this.teamName,
      memberName,
      profile,
      ...(template ? { template } : {}),
      userText: input.userText,
      snapshot: this.snapshot(memberName),
      inboxText: inbox.injectedText,
      artifactsText: formatArtifactsForPrompt(dirtyArtifacts),
      leaderMode: isLeader,
    });

    this.store.setMemberRunState({ memberName, status: "running" });
    const handle = this.runner.run({
      memberName,
      userId: input.userId ?? `team_${memberName}`,
      prompt,
      ...(member?.sessionId ? { sessionId: member.sessionId } : {}),
      teamName: this.teamName,
      leaderName: session.leaderName,
      role: isLeader ? "leader" : "teammate",
      allowedToolNames: profile.allowedToolNames,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!member?.sessionId) this.store.setMemberSession(memberName, handle.sessionId);
    this.store.setMemberRunState({ memberName, status: "running", sessionId: handle.sessionId });
    return {
      ...handle,
      done: handle.done.then((response) => {
        this.store.setMemberRunState({
          memberName,
          status: response.error ? "failed" : "completed",
          sessionId: handle.sessionId,
          ...(response.error?.message ? { error: response.error.message } : {}),
        });
        return response;
      }, (error: unknown) => {
        this.store.setMemberRunState({ memberName, status: "failed", sessionId: handle.sessionId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }),
    };
  }

  private memberSpecFromProfile(memberName: string): { name: string; role: "teammate"; description?: string; profileName: string; allowedToolNames: string[] } {
    const name = normalizeMemberName(memberName);
    const profile = this.resolveProfile(name, false);
    return { name, role: "teammate", description: profile.description, profileName: profile.name, allowedToolNames: profile.allowedToolNames };
  }

  private resolveProfile(memberName: string, leaderMode: boolean): TeamMemberProfile {
    if (leaderMode) return this.profiles.get("lead") ?? defaultLeaderProfile();
    const name = normalizeMemberName(memberName);
    return this.profiles.get(name) ?? this.profiles.get("general") ?? defaultGeneralProfile();
  }
}

function renderTeamMemberPrompt(input: {
  teamName: string;
  memberName: string;
  profile: TeamMemberProfile;
  template?: string;
  userText: string;
  snapshot: TeamSnapshot;
  inboxText: string;
  artifactsText: string;
  leaderMode: boolean;
}): string {
  const tasks = input.snapshot.tasks.length > 0
    ? input.snapshot.tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}${task.assignedTo ? ` assigned=${task.assignedTo}` : ""}${task.claimedBy ? ` claimed=${task.claimedBy}` : ""}`).join("\n")
    : "- no shared tasks yet";
  const members = input.snapshot.session.members.map((member) => `- ${member.name} (${member.role})${member.sessionId ? ` session=${member.sessionId}` : ""}`).join("\n");
  const inbox = input.inboxText || "[Team inbox]\n- no new messages";
  const artifacts = input.artifactsText || "[Team artifacts]\n- no unconsumed artifacts";
  const roleInstructions = input.leaderMode ? renderLeaderInstructions() : renderTeammateInstructions();
  return [
    `You are Team member ${input.memberName} in team ${input.teamName}.`,
    `Member profile: ${input.profile.name} - ${input.profile.description}`,
    `Allowed tools for this member: ${input.profile.allowedToolNames.length > 0 ? input.profile.allowedToolNames.join(", ") : "none"}`,
    input.template ? `[Team member template]\n${input.template}` : "",
    "This is an independent agent instance with its own context window. Do not assume you can see the leader's private chat history.",
    ...roleInstructions,
    "Team members:",
    members,
    "Shared tasks:",
    tasks,
    inbox,
    input.leaderMode ? artifacts : "",
    "User / leader instruction for this turn:",
    input.userText,
  ].filter(Boolean).join("\n\n");
}

export function defaultTeamMemberProfiles(): TeamMemberProfile[] {
  return [defaultLeaderProfile(), defaultExplorerProfile(), defaultWorkerProfile(), defaultReviewerProfile(), defaultGeneralProfile()];
}

function defaultLeaderProfile(): TeamMemberProfile {
  return { name: "lead", description: "Coordination-only leader that decomposes work and routes messages.", allowedToolNames: [], autoRunOnInbox: false, maxConsecutiveFailures: 2 };
}

function defaultExplorerProfile(): TeamMemberProfile {
  return { name: "explorer", description: "Read-only code and file explorer for locating definitions, references, and relevant files.", allowedToolNames: ["file.read", "fs.tree", "fs.find", "search.text", "todo.list", "todo.read"], autoRunOnInbox: true, maxConsecutiveFailures: 2 };
}

function defaultWorkerProfile(): TeamMemberProfile {
  return { name: "worker", description: "Implementation teammate for bounded code changes and command execution.", allowedToolNames: ["file.read", "file.write", "file.edit", "fs.tree", "fs.find", "search.text", "shell.run", "todo.create", "todo.update", "todo.list", "todo.read", "ask_user_question"], autoRunOnInbox: true, maxConsecutiveFailures: 2 };
}

function defaultReviewerProfile(): TeamMemberProfile {
  return { name: "reviewer", description: "Read-only verification teammate focused on bugs, regressions, and missing tests.", allowedToolNames: ["file.read", "fs.tree", "fs.find", "search.text", "shell.run", "todo.list", "todo.read"], autoRunOnInbox: true, maxConsecutiveFailures: 2 };
}

function defaultGeneralProfile(): TeamMemberProfile {
  return { name: "general", description: "General teammate for tasks that do not fit a specialized profile.", allowedToolNames: ["file.read", "file.write", "file.edit", "fs.tree", "fs.find", "search.text", "shell.run", "todo.create", "todo.update", "todo.list", "todo.read", "ask_user_question", "skill.invoke"], autoRunOnInbox: true, maxConsecutiveFailures: 2 };
}

function renderLeaderInstructions(): string[] {
  return [
    "You are the Team lead. Your job is coordination, not execution.",
    "Do not inspect files, run commands, or solve the task yourself unless the answer can be produced from teammate artifacts already available.",
    "This is a dynamic multi-agent loop, not a fixed workflow. Dispatch only the teammates needed for the current state.",
    "When teammate artifacts are available, you must consume them and produce a visible stage summary, final answer, or another dispatch decision. Never end silently after a teammate completes.",
    "Prefer ending with a LEAD_DECISION JSON block. The host will parse it before legacy TEAM_ACTIONS.",
    "Do not use legacy TEAM_ACTIONS create_task or switch_member to dispatch new work. They are legacy compatibility only and may be ignored. Use LEAD_DECISION dispatch_agents instead.",
    "Do not output both LEAD_DECISION and TEAM_ACTIONS in the same response. Use exactly one control block.",
    "If you output stage_summary with needsUserInput=false, the host will immediately resume you. Do not repeat the same summary; execute nextStep by dispatching more agents or producing final.",
    "If a teammate artifact already contains enough information, do not say you need to view the report. Use the artifact preview and summarize it, or dispatch a targeted follow-up task.",
    "Never output placeholder final answers such as [content], TBD, empty bullet fields, or claims that a report exists without including the actual report content.",
    "For final answers, include concrete details from artifacts. If artifacts are insufficient, dispatch a targeted follow-up task instead of inventing or using placeholders.",
    "LEAD_DECISION dispatch format:",
    "```json\n{\"type\":\"dispatch_agents\",\"reason\":\"...\",\"userVisibleStatus\":\"...\",\"autoResume\":true,\"tasks\":[{\"agent\":\"explorer\",\"title\":\"...\",\"description\":\"...\",\"priority\":\"normal\",\"expectedArtifactType\":\"code_fact_report\"}]}\n```",
    "LEAD_DECISION summary/final format:",
    "```json\n{\"type\":\"stage_summary\",\"summary\":\"...\",\"findings\":[\"...\"],\"nextStep\":\"...\",\"needsUserInput\":true}\n```",
    "```json\n{\"type\":\"final\",\"answer\":\"...\",\"usedArtifactIds\":[\"teamart_...\"]}\n```",
    "End your reply with a TEAM_ACTIONS JSON block. The host will apply it to the shared task list and teammate inboxes. Use switch_member when a teammate should run next.",
    "TEAM_ACTIONS format:",
    "```json\n{\"actions\":[{\"type\":\"create_task\",\"to\":\"explorer\",\"title\":\"...\",\"description\":\"...\"},{\"type\":\"send_message\",\"to\":\"explorer\",\"message\":\"...\"},{\"type\":\"switch_member\",\"to\":\"explorer\"}]}\n```",
  ];
}

function renderTeammateInstructions(): string[] {
  return [
    "You are a teammate. Do the assigned work directly with the file, search, shell, and other tools available to this independent agent instance.",
    "If you need to report progress, ask another teammate for help, claim a task, or finish a task, end with a TEAM_ACTIONS JSON block.",
    "Allowed teammate actions: send_message, claim_task, complete_task, switch_member.",
    "TEAM_ACTIONS format:",
    "```json\n{\"actions\":[{\"type\":\"claim_task\",\"taskId\":\"teamtask_...\"},{\"type\":\"complete_task\",\"taskId\":\"teamtask_...\",\"result\":\"...\"},{\"type\":\"send_message\",\"to\":\"lead\",\"message\":\"...\"}]}\n```",
    "Team mode does not use subagent.invoke.",
  ];
}

function formatArtifactsForPrompt(artifacts: TeamArtifactRecord[]): string {
  if (artifacts.length === 0) return "";
  return `[Team artifacts]\n${artifacts.map((artifact) => [
    `- ${artifact.id} from ${artifact.producerAgent}: ${artifact.title}`,
    `  Summary: ${artifact.summary}`,
      artifact.content ? `  Output content: ${compactText(artifact.content, 2500)}` : "",
  ].filter(Boolean).join("\n")).join("\n")}`;
}

function compactText(input: string, maxLength: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 3))}...` : compact;
}

export function extractTeamLeadActions(text: string): TeamLeadAction[] {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.actions)) continue;
      return parsed.actions.flatMap((item) => normalizeLeadAction(item));
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

export function applyTeamLeadActions(team: TeamOrchestrator, from: string, actions: readonly TeamLeadAction[]): TeamLeadActionResult[] {
  const results: TeamLeadActionResult[] = [];
  for (const action of actions) {
    try {
      if (action.type === "create_task") {
        results.push({ action, status: "failed", message: "legacy create_task is disabled for lead automation; use LEAD_DECISION dispatch_agents" });
      } else if (action.type === "send_message") {
        if (!action.to || !action.message) throw new Error("send_message requires to and message");
        team.sendMessage({ from, to: action.to, body: action.message, ...(action.taskId ? { relatedTaskId: action.taskId } : {}) });
        results.push({ action, status: "applied", message: `sent message to ${action.to}` });
      } else if (action.type === "switch_member") {
        if (!action.to) throw new Error("switch_member requires to");
        team.setActiveMember(action.to);
        results.push({ action, status: "applied", message: `switched active member to ${action.to}` });
      } else if (action.type === "claim_task") {
        results.push({ action, status: "failed", message: "legacy claim_task is disabled for lead automation; task nodes are claimed by the scheduler" });
      } else if (action.type === "complete_task") {
        results.push({ action, status: "failed", message: "legacy complete_task is disabled for lead automation; task nodes complete from queue artifacts" });
      }
    } catch (error) {
      results.push({ action, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function createTeamNameFromSession(sessionId: Id | undefined): string {
  return normalizeTeamName(sessionId ? `team-${sessionId.slice(0, 8)}` : `team-${newId("run").slice(0, 8)}`);
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fenced.exec(text); match; match = fenced.exec(text)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const marker = text.match(/TEAM_ACTIONS\s*:?\s*(\{[\s\S]*\})/i);
  if (marker?.[1]) candidates.push(marker[1].trim());
  return candidates;
}

function normalizeLeadAction(value: unknown): TeamLeadAction[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  if (value.type !== "create_task" && value.type !== "send_message" && value.type !== "switch_member" && value.type !== "claim_task" && value.type !== "complete_task") return [];
  return [{
    type: value.type,
    ...(typeof value.to === "string" ? { to: value.to } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.result === "string" ? { result: value.result } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
