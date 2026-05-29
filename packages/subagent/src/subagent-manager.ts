import type { Id, SubAgentBudget, SubAgentRegistration, SubAgentResult, SubAgentTask } from "@jue/shared-types";
import { newId } from "@jue/utils";
import type { SubAgentLoopRunner, SubAgentLoopEvent } from "./subagent-loop-runner.js";
import { SubAgentRegistry } from "./subagent-registry.js";
import type {
  SubAgentInvocationRequest,
  SubAgentMemoryProvider,
  SubAgentNotification,
  SubAgentPlanBuilder,
  SubAgentRuntimeEvent,
  SubAgentTranscriptSink,
} from "./types.js";

export interface SubAgentFailureState {
  consecutiveFailures: number;
  lastFailureAt?: number;
  openUntil?: number;
}

export interface SubAgentManagerOptions {
  registry: SubAgentRegistry;
  planBuilder: SubAgentPlanBuilder;
  runnerFactory: (registration: SubAgentRegistration) => SubAgentLoopRunner;
  defaultBudget?: SubAgentBudget;
  onResult?: (result: SubAgentResult) => void;
  onNotification?: (notification: SubAgentNotification) => void;
  transcriptSink?: SubAgentTranscriptSink;
  memoryProvider?: SubAgentMemoryProvider;
  now?: () => number;
  circuitOpenMs?: number;
}

export interface SubAgentDispatchResult {
  task: SubAgentTask;
  result: Promise<SubAgentResult>;
}

export class SubAgentManager {
  private readonly registry: SubAgentRegistry;
  private readonly planBuilder: SubAgentPlanBuilder;
  private readonly runnerFactory: (registration: SubAgentRegistration) => SubAgentLoopRunner;
  private readonly defaultBudget: SubAgentBudget;
  private readonly onResult: ((result: SubAgentResult) => void) | undefined;
  private readonly onNotification: ((notification: SubAgentNotification) => void) | undefined;
  private readonly transcriptSink: SubAgentTranscriptSink | undefined;
  private readonly memoryProvider: SubAgentMemoryProvider | undefined;
  private readonly now: () => number;
  private readonly circuitOpenMs: number;
  private readonly failureStates = new Map<string, SubAgentFailureState>();
  private readonly pendingNotifications = new Map<Id, SubAgentNotification[]>();

  constructor(options: SubAgentManagerOptions) {
    this.registry = options.registry;
    this.planBuilder = options.planBuilder;
    this.runnerFactory = options.runnerFactory;
    this.defaultBudget = options.defaultBudget ?? { maxTokens: 8_000, maxToolCalls: 8, maxDurationMs: 120_000, maxRecursionDepth: 0 };
    this.onResult = options.onResult;
    this.onNotification = options.onNotification;
    this.transcriptSink = options.transcriptSink;
    this.memoryProvider = options.memoryProvider;
    this.now = options.now ?? (() => Date.now());
    this.circuitOpenMs = options.circuitOpenMs ?? 5 * 60 * 1000;
  }

  listPublicSubAgents(): SubAgentRegistration[] {
    return this.registry.listPublicEnabled();
  }

  resolve(name: string): SubAgentRegistration | undefined {
    return this.registry.findByInvocationName(name);
  }

  isCooledDown(name: string): boolean {
    const state = this.failureStates.get(normalizeName(name));
    if (!state?.openUntil) return true;
    return state.openUntil <= this.now();
  }

  drainNotifications(sessionId: Id): SubAgentNotification[] {
    const items = this.pendingNotifications.get(sessionId) ?? [];
    this.pendingNotifications.delete(sessionId);
    return items;
  }

  dispatchAsync(request: SubAgentInvocationRequest): SubAgentDispatchResult {
    const registration = this.resolve(request.subagentName);
    const task = registration ? this.buildTask(request, registration) : this.buildRejectedTask(request);
    const result = this.dispatch({ ...request, title: task.title }).then((res) => res);
    return { task, result };
  }

  async dispatch(request: SubAgentInvocationRequest): Promise<SubAgentResult> {
    return this.dispatchWithVisibility(request, false);
  }

  async dispatchInternal(request: SubAgentInvocationRequest): Promise<SubAgentResult> {
    return this.dispatchWithVisibility(request, true);
  }

  private async dispatchWithVisibility(request: SubAgentInvocationRequest, allowInternal: boolean): Promise<SubAgentResult> {
    const registration = this.resolve(request.subagentName);
    if (!registration) {
      return this.reject(request, "SUBAGENT_NOT_REGISTERED", `Subagent ${request.subagentName} is not registered.`);
    }
    if (!allowInternal && (registration.visibility ?? "public") !== "public") {
      return this.reject(request, "SUBAGENT_NOT_PUBLIC", `Subagent ${request.subagentName} is internal and cannot be called by the main agent.`);
    }
    if (registration.executionMode === "placeholder") {
      return this.reject(request, "SUBAGENT_PLACEHOLDER", `Subagent ${request.subagentName} is a placeholder and has no implementation.`);
    }
    const fuseName = registration.invocationName ?? registration.type;
    if (!this.isCooledDown(fuseName)) {
      return this.reject(request, "SUBAGENT_CIRCUIT_OPEN", `Subagent ${request.subagentName} recently failed repeatedly. The circuit is open.`);
    }

    const task = this.buildTask(request, registration);
    this.emit(task, registration, "subagent.started", { title: task.title, goal: task.input.goal });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.budget?.maxDurationMs ?? this.defaultBudget.maxDurationMs);
    const abortForwarder = () => controller.abort();
    request.signal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const plan = await this.planBuilder.build(request, registration, task);
      const runner = this.runnerFactory(registration);
      const result = await runner.run(plan, task, controller.signal);
      const finalResult = controller.signal.aborted && result.status !== "cancelled" ? this.timeoutResult(task, result.startedAt) : result;
      await this.memoryProvider?.recordAfterRun?.({ registration, task, result: finalResult });
      this.updateCircuit(fuseName, registration, finalResult);
      this.onResult?.(finalResult);
      this.enqueueNotification(request.sessionId, request.requestId, task.id, request.subagentName, finalResult);
      this.emit(task, registration, finalResult.status === "timeout" ? "subagent.timeout" : finalResult.status === "succeeded" ? "subagent.completed" : "subagent.failed", {
        status: finalResult.status,
        conclusion: finalResult.conclusion,
        resultId: finalResult.id,
      });
      return finalResult;
    } catch (err) {
      const result = this.exceptionResult(task, err);
      this.updateCircuit(fuseName, registration, result);
      this.onResult?.(result);
      this.enqueueNotification(request.sessionId, request.requestId, task.id, request.subagentName, result);
      this.emit(task, registration, "subagent.failed", { status: result.status, conclusion: result.conclusion, error: result.error });
      return result;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortForwarder);
    }
  }

  createLoopEventSink(registration: SubAgentRegistration, task: SubAgentTask): (event: SubAgentLoopEvent) => void {
    return (event) => {
      if (event.type === "model.delta") {
        this.emit(task, registration, "subagent.progress", { delta: event.delta });
      } else if (event.type === "tool.started") {
        this.emit(task, registration, "subagent.tool.started", { callId: event.callId, toolName: event.toolName });
      } else if (event.type === "tool.completed") {
        this.emit(task, registration, "subagent.tool.completed", { callId: event.callId, toolName: event.toolName, status: event.status });
      }
    };
  }

  recordFailure(name: string, threshold: number): void {
    const key = normalizeName(name);
    const state = this.failureStates.get(key) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    state.lastFailureAt = this.now();
    if (state.consecutiveFailures >= threshold) {
      state.openUntil = this.now() + this.circuitOpenMs;
    }
    this.failureStates.set(key, state);
  }

  recordSuccess(name: string): void {
    this.failureStates.delete(normalizeName(name));
  }

  private updateCircuit(name: string, registration: SubAgentRegistration, result: SubAgentResult): void {
    if (result.status === "succeeded") this.recordSuccess(name);
    else this.recordFailure(name, registration.maxFailureCount ?? 3);
  }

  private buildTask(request: SubAgentInvocationRequest, registration: SubAgentRegistration): SubAgentTask {
    const now = this.now();
    const mergedBudget = { ...this.defaultBudget, ...(registration.defaultBudget ?? {}), ...(request.budget ?? {} as Partial<SubAgentBudget>) };
    return {
      id: newId("satask"),
      parentSessionId: request.sessionId,
      parentRequestId: request.requestId,
      ...(request.parentTaskId ?? request.parentCallId ? { parentAgentId: request.parentTaskId ?? request.parentCallId } : {}),
      type: registration.type,
      title: request.title ?? registration.displayName,
      input: {
        goal: request.goal,
        successCriteria: request.successCriteria ?? [],
        constraints: [...(request.constraints ?? []), "Do not call subagent.invoke. Nested subagents are forbidden."],
        inputs: request.inputs ?? {},
        contextBlocks: request.contextBlocks ?? [],
        memorySnapshot: request.memoryRecords ?? [],
      },
      ...(registration.defaultPolicy ? { policy: registration.defaultPolicy } : {}),
      budget: mergedBudget,
      createdAt: now,
      status: "running",
      metadata: { requestedSubagentName: request.subagentName, dispatchMode: request.dispatchMode ?? "sync" },
    };
  }

  private buildRejectedTask(request: SubAgentInvocationRequest): SubAgentTask {
    const now = this.now();
    return {
      id: newId("satask"),
      parentSessionId: request.sessionId,
      parentRequestId: request.requestId,
      type: "custom",
      title: request.title ?? request.subagentName,
      input: { goal: request.goal, successCriteria: [], constraints: [], inputs: {}, contextBlocks: [], memorySnapshot: [] },
      budget: this.defaultBudget,
      createdAt: now,
      status: "failed",
      metadata: { requestedSubagentName: request.subagentName },
    };
  }

  private reject(request: SubAgentInvocationRequest, code: string, message: string): SubAgentResult {
    const now = this.now();
    return {
      id: newId("sares"),
      taskId: newId("satask"),
      type: "custom",
      status: "failed",
      conclusion: message,
      evidence: [],
      risks: [{ level: "medium", description: message }],
      suggestedActions: [{ id: newId("act"), label: "Handle in main agent", description: "Do not retry this subagent until registration or availability changes." }],
      outputs: { requestedSubagentName: request.subagentName },
      error: { code, message, retriable: false },
      startedAt: now,
      finishedAt: now,
    };
  }

  private timeoutResult(task: SubAgentTask, startedAt: number): SubAgentResult {
    const finishedAt = this.now();
    const message = `Subagent timed out after ${task.budget?.maxDurationMs ?? this.defaultBudget.maxDurationMs}ms.`;
    return {
      id: newId("sares"),
      taskId: task.id,
      type: task.type,
      status: "timeout",
      conclusion: message,
      evidence: [],
      risks: [{ level: "medium", description: message, mitigation: "Reduce task scope or let the main agent continue directly." }],
      suggestedActions: [],
      outputs: {},
      error: { code: "SUBAGENT_TIMEOUT", message, retriable: true },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCallCount: 0, durationMs: finishedAt - startedAt },
      startedAt,
      finishedAt,
    };
  }

  private exceptionResult(task: SubAgentTask, err: unknown): SubAgentResult {
    const now = this.now();
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: newId("sares"),
      taskId: task.id,
      type: task.type,
      status: "failed",
      conclusion: `Subagent failed: ${message}`,
      evidence: [],
      risks: [{ level: "medium", description: message }],
      suggestedActions: [],
      outputs: {},
      error: { code: "SUBAGENT_EXCEPTION", message, retriable: true },
      startedAt: now,
      finishedAt: now,
    };
  }

  private enqueueNotification(sessionId: Id, requestId: Id, taskId: Id, subagentName: string, result: SubAgentResult): void {
    const notification: SubAgentNotification = {
      id: newId("sanote"),
      sessionId,
      requestId,
      taskId,
      subagentName,
      status: result.status,
      conclusion: result.conclusion,
      result,
      createdAt: this.now(),
    };
    const list = this.pendingNotifications.get(sessionId) ?? [];
    list.push(notification);
    this.pendingNotifications.set(sessionId, list);
    this.onNotification?.(notification);
  }

  private emit(task: SubAgentTask, registration: SubAgentRegistration, type: SubAgentRuntimeEvent["type"], payload: Record<string, unknown>): void {
    this.transcriptSink?.appendSubAgentEvent({
      eventId: newId("saev"),
      sessionId: task.parentSessionId,
      requestId: task.parentRequestId,
      taskId: task.id,
      subagentName: registration.invocationName ?? registration.type,
      type,
      at: this.now(),
      payload,
    });
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
