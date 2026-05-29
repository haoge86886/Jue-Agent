import type { LeadDecision, LeadDispatchTaskSpec, TeamArtifactType, TeamTaskPriority } from "./types.js";

export interface LeadDecisionParseResult {
  decision: LeadDecision | undefined;
  source: "lead_decision" | "none";
  error?: string;
}

export function extractLeadDecision(text: string): LeadDecisionParseResult {
  const candidates = extractJsonCandidates(text, "LEAD_DECISION");
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = normalizeLeadDecision(parsed);
      if (decision) return { decision, source: "lead_decision" };
    } catch (error) {
      return { decision: undefined, source: "none", error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { decision: undefined, source: "none" };
}

function normalizeLeadDecision(value: unknown): LeadDecision | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "dispatch_agents") {
    const tasks = Array.isArray(value.tasks) ? value.tasks.flatMap((task) => normalizeDispatchTask(task)) : [];
    if (tasks.length === 0) return undefined;
    return {
      type: "dispatch_agents",
      reason: asString(value.reason, "Need teammate work."),
      userVisibleStatus: asString(value.userVisibleStatus, "Dispatching teammates."),
      tasks,
      autoResume: value.autoResume !== false,
    };
  }
  if (value.type === "continue_self") {
    return { type: "continue_self", reason: asString(value.reason, "Continue in lead."), instruction: asString(value.instruction, "Continue the current task.") };
  }
  if (value.type === "ask_user") {
    return {
      type: "ask_user",
      question: asString(value.question, "Please clarify the next step."),
      reason: asString(value.reason, "The task needs user clarification."),
      ...(Array.isArray(value.options) ? { options: value.options.flatMap((option) => normalizeOption(option)) } : {}),
    };
  }
  if (value.type === "stage_summary") {
    return {
      type: "stage_summary",
      summary: asString(value.summary, "Current stage completed."),
      needsUserInput: value.needsUserInput === true,
      ...(Array.isArray(value.findings) ? { findings: value.findings.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof value.nextStep === "string" ? { nextStep: value.nextStep } : {}),
    };
  }
  if (value.type === "final") {
    return {
      type: "final",
      answer: asString(value.answer, "Task completed."),
      usedArtifactIds: Array.isArray(value.usedArtifactIds) ? value.usedArtifactIds.filter((item): item is string => typeof item === "string") : [],
    };
  }
  if (value.type === "abort") {
    return { type: "abort", reason: asString(value.reason, "Team run aborted."), recoverable: value.recoverable !== false };
  }
  return undefined;
}

function normalizeDispatchTask(value: unknown): LeadDispatchTaskSpec[] {
  if (!isRecord(value)) return [];
  const title = asString(value.title, "Team task");
  const description = asString(value.description, title);
  const agent = asString(value.agent, "general");
  return [{
    title,
    description,
    agent,
    priority: normalizePriority(value.priority),
    ...(Array.isArray(value.dependsOn) ? { dependsOn: value.dependsOn.filter((item): item is string => typeof item === "string") } : {}),
    ...(isArtifactType(value.expectedArtifactType) ? { expectedArtifactType: value.expectedArtifactType } : {}),
    ...(Array.isArray(value.contextHints) ? { contextHints: value.contextHints.filter((item): item is string => typeof item === "string") } : {}),
  }];
}

function normalizeOption(value: unknown): Array<{ id: string; label: string; effect: string }> {
  if (!isRecord(value)) return [];
  return [{ id: asString(value.id, "option"), label: asString(value.label, "Option"), effect: asString(value.effect, "") }];
}

function extractJsonCandidates(text: string, markerName: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  const markerPattern = new RegExp(`${markerName}\\s*:?\\s*(\\{[\\s\\S]*?\\})(?=\\s*(?:$|TEAM_ACTIONS|LEAD_DECISION|\\n\\n))`, "i");
  const marker = text.match(markerPattern);
  if (marker?.[1]) candidates.push(marker[1].trim());
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fenced.exec(text); match; match = fenced.exec(text)) {
    if (match[1]?.includes('"type"')) candidates.push(match[1].trim());
  }
  return candidates;
}

function normalizePriority(value: unknown): TeamTaskPriority {
  return value === "low" || value === "high" || value === "normal" ? value : "normal";
}

function isArtifactType(value: unknown): value is TeamArtifactType {
  return value === "subagent_result" || value === "code_fact_report" || value === "implementation_result" || value === "review_finding" || value === "plan" || value === "stage_summary" || value === "final_answer" || value === "generic";
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
