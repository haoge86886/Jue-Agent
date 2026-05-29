import { resolve } from "node:path";
import { prepareStartup } from "@jue/infra";
import { createRuntime } from "@jue/runtime";
import type { AskUserQuestionProvider } from "@jue/tools";
import type { StreamEvent } from "@jue/shared-types";
import type { EvalAgentRunResult, EvalAskUserPolicy, EvalTask, EvalToolTrace } from "./types.js";

export interface JueEvalAdapterOptions {
  configFile?: string;
  model?: string;
  askUserPolicy?: EvalAskUserPolicy;
}

export interface RunEvalAgentInput {
  task: EvalTask;
  workspacePath: string;
  timeoutMs: number;
  configFile?: string;
  model?: string;
  dryRun?: boolean;
  askUserPolicy?: EvalAskUserPolicy;
}

export class JueRuntimeEvalAdapter {
  constructor(private readonly defaults: JueEvalAdapterOptions = {}) {}

  async run(input: RunEvalAgentInput): Promise<EvalAgentRunResult> {
    const startedAt = Date.now();
    if (input.dryRun) {
      return {
        taskId: input.task.id,
        finalText: "dry run",
        events: [],
        toolCalls: [],
        startedAt,
        finishedAt: Date.now(),
        exitReason: "completed",
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), input.timeoutMs);
    const events: StreamEvent[] = [];
    const toolCalls: EvalToolTrace[] = [];
    let finalText = "";
    try {
      const startupContext = prepareStartup({
        cwd: input.workspacePath,
        args: ["ask", input.task.instruction, "--json", "--no-stream"],
        stdinIsTTY: true,
      });
      const runtime = createRuntime({
        startupContext,
        cwd: input.workspacePath,
        configFile: input.configFile ?? input.task.configFile ?? this.defaults.configFile ?? startupContext.env.configFile,
        askUserQuestionProvider: createEvalAskUserProvider(input.askUserPolicy ?? input.task.askUserPolicy ?? this.defaults.askUserPolicy ?? "approve"),
        consoleLogging: false,
        ...((input.model ?? input.task.model ?? this.defaults.model) ? { modelOverride: input.model ?? input.task.model ?? this.defaults.model } : {}),
      });
      const handle = runtime.sessionManager.handle({
        userId: "eval_user",
        frontend: "cli",
        mode: "task",
        capabilities: {
          streaming: true,
          markdown: true,
          images: false,
          files: true,
          tools: true,
          confirmDialog: false,
          notifications: false,
        },
        message: { role: "user", parts: [{ type: "text", text: input.task.instruction }] },
        flags: { eval: true, evalTaskId: input.task.id },
        signal: abortController.signal,
      });
      for await (const event of handle.events) {
        events.push(event);
        collectEvent(event, toolCalls);
        if (event.type === "model.delta") {
          const payload = event.payload as { delta?: unknown; text?: unknown };
          if (typeof payload.delta === "string") finalText += payload.delta;
          else if (typeof payload.text === "string") finalText += payload.text;
        }
      }
      const response = await handle.done;
      clearTimeout(timeout);
      return {
        taskId: input.task.id,
        sessionId: handle.request.sessionId,
        finalText,
        events,
        toolCalls,
        startedAt,
        finishedAt: Date.now(),
        exitReason: response.error ? "error" : "completed",
        ...(response.error ? { error: response.error.message } : {}),
      };
    } catch (error) {
      clearTimeout(timeout);
      return {
        taskId: input.task.id,
        finalText,
        events,
        toolCalls,
        startedAt,
        finishedAt: Date.now(),
        exitReason: abortController.signal.aborted ? "timeout" : "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function createEvalAskUserProvider(policy: EvalAskUserPolicy): AskUserQuestionProvider {
  return (request) => {
    const approve = policy === "approve";
    return {
      selectedOptionId: request.options[0]?.id ?? (approve ? "approve_once" : "reject"),
      approved: approve,
      approveSimilarFutureRequests: approve,
      instruction: approve ? "Approved by eval policy." : "Rejected by eval policy.",
      metadata: { evalPolicy: policy },
    };
  };
}

function collectEvent(event: StreamEvent, traces: EvalToolTrace[]): void {
  if (event.type === "tool.invocation.started") {
    const payload = event.payload as Record<string, unknown>;
    traces.push({
      name: typeof payload.toolName === "string" ? payload.toolName : "unknown",
      status: "started",
      ...(typeof payload.callId === "string" ? { callId: payload.callId } : {}),
      ...(payload.arguments !== undefined ? { args: payload.arguments } : {}),
    });
  }
  if (event.type === "tool.invocation.completed") {
    const payload = event.payload as Record<string, unknown>;
    const callId = typeof payload.callId === "string" ? payload.callId : undefined;
    const existing = callId ? traces.findLast((item) => item.callId === callId) : undefined;
    const target = existing ?? { name: typeof payload.toolName === "string" ? payload.toolName : "unknown", status: "unknown" as const };
    target.status = payload.error ? "failed" : "completed";
    if (typeof payload.durationMs === "number") target.durationMs = payload.durationMs;
    if (typeof payload.summary === "string") target.summary = payload.summary;
    if (payload.error) target.error = JSON.stringify(payload.error);
    if (!existing) traces.push(target);
  }
}

export function resolveMaybePath(path: string | undefined): string | undefined {
  return path ? resolve(path) : undefined;
}
