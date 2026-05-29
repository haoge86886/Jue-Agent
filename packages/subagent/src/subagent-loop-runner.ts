import { SubAgentResultSchema, type SubAgentResult, type SubAgentTask, type ToolCall, type ToolResult } from "@jue/shared-types";
import { newId } from "@jue/utils";
import type { SubAgentChatMessage, SubAgentModelGateway, SubAgentPlan, SubAgentToolExecutor } from "./types.js";

export interface SubAgentLoopRunnerOptions {
  gateway: SubAgentModelGateway;
  toolExecutor: SubAgentToolExecutor;
  maxIterations?: number;
  onEvent?: (event: SubAgentLoopEvent) => void;
}

export type SubAgentLoopEvent =
  | { type: "started"; taskId: string; subagent: string }
  | { type: "model.delta"; taskId: string; delta: string }
  | { type: "tool.started"; taskId: string; callId: string; toolName: string }
  | { type: "tool.completed"; taskId: string; callId: string; toolName: string; status: ToolResult["status"] }
  | { type: "completed"; taskId: string; status: SubAgentResult["status"] };

export class SubAgentLoopRunner {
  private readonly gateway: SubAgentModelGateway;
  private readonly toolExecutor: SubAgentToolExecutor;
  private readonly maxIterations: number;
  private readonly onEvent: ((event: SubAgentLoopEvent) => void) | undefined;

  constructor(options: SubAgentLoopRunnerOptions) {
    this.gateway = options.gateway;
    this.toolExecutor = options.toolExecutor;
    this.maxIterations = options.maxIterations ?? 8;
    this.onEvent = options.onEvent;
  }

  async run(plan: SubAgentPlan, task: SubAgentTask, signal?: AbortSignal): Promise<SubAgentResult> {
    const startedAt = Date.now();
    this.onEvent?.({ type: "started", taskId: task.id, subagent: plan.registration.type });

    const messages: SubAgentChatMessage[] = [...plan.messages];
    let finalText = "";
    let lastUsage: SubAgentResult["usage"] | undefined;
    let lastFinishReason: string | undefined;
    let toolCallCount = 0;

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (signal?.aborted) return cancelledResult(task, startedAt, "Subagent run was aborted before model invocation.");
      let assembled = "";
      let toolCalls: ToolCall[] = [];

      for await (const chunk of this.gateway.invoke({
        messages,
        stream: true,
        ...(plan.toolDefinitions.length > 0 ? { tools: plan.toolDefinitions, toolChoice: "auto" as const } : {}),
        providerOptions: { response_format: { type: "json_object" } },
        ...(signal ? { signal } : {}),
      })) {
        if (signal?.aborted) return cancelledResult(task, startedAt, "Subagent run was aborted during model invocation.");
        if (chunk.type === "delta" && chunk.delta) {
          assembled += chunk.delta;
          this.onEvent?.({ type: "model.delta", taskId: task.id, delta: chunk.delta });
        } else if (chunk.type === "finish") {
          lastFinishReason = chunk.finishReason;
          if (chunk.usage) {
            lastUsage = {
              promptTokens: chunk.usage.promptTokens ?? 0,
              completionTokens: chunk.usage.completionTokens ?? 0,
              totalTokens: chunk.usage.totalTokens ?? 0,
              toolCallCount,
              durationMs: Date.now() - startedAt,
            };
          }
          if (chunk.toolCalls?.length) {
            toolCalls = chunk.toolCalls.map((call) => this.toToolCall(call, plan.toolNameMap, task));
          }
        }
      }

      if (assembled.trim()) finalText = assembled;
      if (toolCalls.length === 0) break;

      messages.push({ role: "assistant", content: assembled || "" });
      for (const call of toolCalls) {
        if (signal?.aborted) return cancelledResult(task, startedAt, "Subagent run was aborted before tool execution.");
        const maxToolCalls = task.budget?.maxToolCalls ?? 8;
        if (toolCallCount >= maxToolCalls) {
          return failedResult(task, startedAt, "SUBAGENT_TOOL_BUDGET_EXCEEDED", `Subagent exceeded max tool calls (${maxToolCalls}).`);
        }
        toolCallCount += 1;
        this.onEvent?.({ type: "tool.started", taskId: task.id, callId: call.id, toolName: call.toolName });
        const result = await this.toolExecutor.execute(call);
        this.onEvent?.({ type: "tool.completed", taskId: task.id, callId: call.id, toolName: call.toolName, status: result.status });
        messages.push({ role: "tool", content: serializeToolResult(result), toolCallId: call.id, name: call.toolName });
      }
    }

    const finishedAt = Date.now();
    const parsed = parseFinalResult(finalText);
    const result = buildResultFromParsed(parsed, task, startedAt, finishedAt, {
      promptTokens: lastUsage?.promptTokens ?? 0,
      completionTokens: lastUsage?.completionTokens ?? 0,
      totalTokens: lastUsage?.totalTokens ?? 0,
      toolCallCount,
      durationMs: finishedAt - startedAt,
    }, lastFinishReason, plan.registration.type, finalText);
    this.onEvent?.({ type: "completed", taskId: task.id, status: result.status });
    return result;
  }

  private toToolCall(call: { id: string; function: { name: string; arguments: string } }, toolNameMap: Record<string, string>, task: SubAgentTask): ToolCall {
    const internalName = toolNameMap[call.function.name] ?? call.function.name;
    return {
      id: call.id || newId("tcall"),
      toolName: internalName,
      arguments: parseArguments(call.function.arguments),
      relevanceScore: 0.5,
      invokedBy: "subagent",
      sessionId: task.parentSessionId,
      requestId: task.parentRequestId,
      parentCallId: task.id,
      createdAt: Date.now(),
    };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const { relevanceScore: _ignored, ...args } = parsed as Record<string, unknown>;
      return args;
    }
  } catch {
    return { raw };
  }
  return {};
}

function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    toolName: result.toolName,
    status: result.status,
    summary: result.summary,
    output: result.output,
    error: result.error,
    tokenEstimate: result.tokenEstimate,
  });
}

function parseFinalResult(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const direct = tryParseJson(trimmed);
  if (direct) return direct;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) return tryParseJson(match[0]) ?? {};
  return { conclusion: trimmed };
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function buildResultFromParsed(
  parsed: Record<string, unknown>,
  task: SubAgentTask,
  startedAt: number,
  finishedAt: number,
  usage: SubAgentResult["usage"],
  finishReason: string | undefined,
  agentType: SubAgentResult["type"],
  rawText: string,
): SubAgentResult {
  const result: SubAgentResult = {
    id: newId("sares"),
    taskId: task.id,
    type: agentType,
    status: inferStatus(parsed, finishReason),
    conclusion: readString(parsed.conclusion) ?? readString(parsed.summary) ?? fallbackConclusion(rawText),
    ...(readString(parsed.details) ? { details: readString(parsed.details) } : {}),
    evidence: readEvidence(parsed.evidence),
    risks: readRisks(parsed.risks),
    suggestedActions: readActions(parsed.suggestedActions),
    outputs: readRecord(parsed.outputs) ?? { rawText },
    ...(usage ? { usage } : {}),
    startedAt,
    finishedAt,
    metadata: { finishReason: finishReason ?? "unknown" },
  };
  const validated = SubAgentResultSchema.safeParse(result);
  if (validated.success) return validated.data;
  return {
    ...result,
    status: "failed",
    conclusion: result.conclusion || "Subagent returned invalid structured output.",
    error: {
      code: "SUBAGENT_OUTPUT_INVALID",
      message: validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      retriable: true,
    },
    outputs: { rawText, parsed, validationIssues: validated.error.issues },
  };
}

function inferStatus(parsed: Record<string, unknown>, finishReason: string | undefined): SubAgentResult["status"] {
  const status = readString(parsed.status);
  if (status === "succeeded" || status === "failed" || status === "cancelled" || status === "timeout" || status === "skipped") return status;
  if (finishReason === "length" || finishReason === "error" || finishReason === "content_filter") return "failed";
  return "succeeded";
}

function fallbackConclusion(rawText: string): string {
  return rawText.trim() || "Subagent completed without a textual conclusion.";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readEvidence(value: unknown): SubAgentResult["evidence"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
    id: readString(item.id) ?? newId("evi"),
    kind: readEvidenceKind(item.kind),
    ...(readString(item.ref) ? { ref: readString(item.ref) } : {}),
    summary: readString(item.summary) ?? "Evidence item without summary.",
  }));
}

function readEvidenceKind(value: unknown): "tool_result" | "memory" | "url" | "file" | "text" {
  return value === "tool_result" || value === "memory" || value === "url" || value === "file" || value === "text" ? value : "text";
}

function readRisks(value: unknown): SubAgentResult["risks"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
    level: item.level === "high" || item.level === "medium" || item.level === "low" ? item.level : "medium",
    description: readString(item.description) ?? "Risk item without description.",
    ...(readString(item.mitigation) ? { mitigation: readString(item.mitigation) } : {}),
  }));
}

function readActions(value: unknown): SubAgentResult["suggestedActions"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
    id: readString(item.id) ?? newId("act"),
    label: readString(item.label) ?? "Suggested action",
    ...(readString(item.description) ? { description: readString(item.description) } : {}),
    ...(readString(item.toolName) ? { toolName: readString(item.toolName) } : {}),
    ...(readRecord(item.arguments) ? { arguments: readRecord(item.arguments) } : {}),
  }));
}

function failedResult(task: SubAgentTask, startedAt: number, code: string, message: string): SubAgentResult {
  const finishedAt = Date.now();
  return {
    id: newId("sares"),
    taskId: task.id,
    type: task.type,
    status: "failed",
    conclusion: message,
    evidence: [],
    risks: [{ level: "medium", description: message }],
    suggestedActions: [],
    outputs: {},
    error: { code, message, retriable: true },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCallCount: 0, durationMs: finishedAt - startedAt },
    startedAt,
    finishedAt,
  };
}

function cancelledResult(task: SubAgentTask, startedAt: number, message: string): SubAgentResult {
  const finishedAt = Date.now();
  return {
    id: newId("sares"),
    taskId: task.id,
    type: task.type,
    status: "cancelled",
    conclusion: message,
    evidence: [],
    risks: [],
    suggestedActions: [],
    outputs: {},
    error: { code: "SUBAGENT_ABORTED", message, retriable: true },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCallCount: 0, durationMs: finishedAt - startedAt },
    startedAt,
    finishedAt,
  };
}