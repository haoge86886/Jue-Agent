import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { JsonSchemaLike, ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureOptionalString, ensurePositiveInt, ensureString, resolveToolPath } from "../path-utils.js";

export interface BackgroundTaskEvent {
  seq: number;
  at: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface BackgroundTaskSnapshot {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited" | "stopped" | "failed";
  exitCode?: number | null;
  signal?: string | null;
  startedAt: number;
  finishedAt?: number;
}

interface BackgroundTaskRecord extends BackgroundTaskSnapshot {
  process: ChildProcessWithoutNullStreams;
  events: BackgroundTaskEvent[];
  nextSeq: number;
}

/**
 * 后台任务存储。Monitor 启动长任务后只保存有限事件流，TaskOutput 按 seq 增量读取。
 */
export class BackgroundTaskStore {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly maxEventsPerTask: number;

  constructor(options: { maxEventsPerTask?: number } = {}) {
    this.maxEventsPerTask = options.maxEventsPerTask ?? 1000;
  }

  start(input: { command: string; args: string[]; cwd: string; env?: Record<string, string> }): BackgroundTaskSnapshot {
    const taskId = `task_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      shell: false,
      windowsHide: true,
    });
    const record: BackgroundTaskRecord = {
      taskId,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      status: "running",
      startedAt: Date.now(),
      process: child,
      events: [],
      nextSeq: 1,
    };
    this.tasks.set(taskId, record);
    this.pushEvent(record, "system", `started pid=${child.pid ?? "unknown"}`);
    child.stdout.on("data", (chunk) => this.pushEvent(record, "stdout", String(chunk)));
    child.stderr.on("data", (chunk) => this.pushEvent(record, "stderr", String(chunk)));
    child.on("error", (err) => {
      record.status = "failed";
      record.finishedAt = Date.now();
      this.pushEvent(record, "system", `error: ${err.message}`);
    });
    child.on("close", (exitCode, signal) => {
      if (record.status === "running") record.status = "exited";
      record.exitCode = exitCode;
      record.signal = signal;
      record.finishedAt = Date.now();
      this.pushEvent(record, "system", `closed exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}`);
    });
    return snapshot(record);
  }

  output(taskId: string, sinceSeq = 0, maxEvents = 100): { task: BackgroundTaskSnapshot; events: BackgroundTaskEvent[]; nextSeq: number } {
    const record = this.require(taskId);
    const events = record.events.filter((event) => event.seq > sinceSeq).slice(0, maxEvents);
    const nextSeq = events.length > 0 ? (events.at(-1)?.seq ?? sinceSeq) : sinceSeq;
    return { task: snapshot(record), events, nextSeq };
  }

  stop(taskId: string, signal: NodeJS.Signals = "SIGTERM"): BackgroundTaskSnapshot {
    const record = this.require(taskId);
    if (record.status !== "running") return snapshot(record);
    record.status = "stopped";
    record.process.kill(signal);
    this.pushEvent(record, "system", `stop requested signal=${signal}`);
    return snapshot(record);
  }

  private require(taskId: string): BackgroundTaskRecord {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new ToolExecutionError({
        code: "BACKGROUND_TASK_NOT_FOUND",
        message: `未找到后台任务: ${taskId}`,
        nextStep: "先调用 monitor.start 获取 taskId，或用 task.output 查询已有任务。",
      });
    }
    return record;
  }

  private pushEvent(record: BackgroundTaskRecord, stream: BackgroundTaskEvent["stream"], text: string): void {
    record.events.push({ seq: record.nextSeq, at: Date.now(), stream, text });
    record.nextSeq += 1;
    if (record.events.length > this.maxEventsPerTask) record.events.splice(0, record.events.length - this.maxEventsPerTask);
  }
}

export const monitorStartToolSpec: ToolSpec = {
  name: "monitor.start",
  displayName: "后台监控任务",
  description: "启动长时间运行脚本并持续收集 stdout/stderr 事件流，返回 taskId。",
  version: "0.1.0",
  kind: "builtin",
  category: "shell",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string" },
      args: { type: "array", items: { type: "string" }, default: [] },
      cwd: { type: "string", default: "." },
    },
  },
  outputSchema: taskSnapshotOutputSchema(),
  sideEffectLevel: "external",
  timeoutMs: 5_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "workspace",
  confirmation: { required: true, reason: "后台任务可能长期运行并读写本地环境", autoApproveScopes: [] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "monitor", "background-task"],
  sensitivity: "internal",
};

export const taskOutputToolSpec: ToolSpec = {
  name: "task.output",
  displayName: "读取后台任务输出",
  description: "按 taskId 获取后台任务 stdout/stderr/system 事件流，可用 sinceSeq 增量读取。",
  version: "0.1.0",
  kind: "builtin",
  category: "shell",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
      sinceSeq: { type: "integer", minimum: 0, default: 0 },
      maxEvents: { type: "integer", minimum: 1, default: 100 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "events", "nextSeq"],
    properties: {
      task: { type: "object" },
      events: { type: "array", items: { type: "object" } },
      nextSeq: { type: "integer" },
    },
  },
  sideEffectLevel: "none",
  timeoutMs: 5_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "task", "output"],
  sensitivity: "internal",
};

export const taskStopToolSpec: ToolSpec = {
  name: "task.stop",
  displayName: "停止后台任务",
  description: "停止 monitor.start 启动的后台任务。",
  version: "0.1.0",
  kind: "builtin",
  category: "shell",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: { type: "string" },
      signal: { type: "string", default: "SIGTERM" },
    },
  },
  outputSchema: taskSnapshotOutputSchema(),
  sideEffectLevel: "none",
  timeoutMs: 5_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "task", "stop"],
  sensitivity: "internal",
};

export interface BackgroundTaskHandlerOptions {
  workspaceRoot: string;
  store?: BackgroundTaskStore;
  pathPermissions?: PathPermissionStore;
}

export function createBackgroundTaskHandlers(options: BackgroundTaskHandlerOptions): Map<string, ToolHandler> {
  const root = resolvePath(options.workspaceRoot);
  const store = options.store ?? new BackgroundTaskStore();
  return new Map<string, ToolHandler>([
    [monitorStartToolSpec.name, (args) => startMonitor(args, root, store, options.pathPermissions)],
    [taskOutputToolSpec.name, (args) => readOutput(args, store)],
    [taskStopToolSpec.name, (args) => stopTask(args, store)],
  ]);
}

function startMonitor(args: Record<string, unknown>, root: string, store: BackgroundTaskStore, pathPermissions?: PathPermissionStore): ToolHandlerResult {
  const command = ensureString(args.command, "command");
  const rawArgs = Array.isArray(args.args) ? args.args.map((item) => ensureString(item, "args[]")) : [];
  const cwd = resolveToolPath({ workspaceRoot: root, reqPath: ensureOptionalString(args.cwd, "cwd") ?? ".", operation: "execute", ...(pathPermissions ? { permissions: pathPermissions } : {}), suggestedRootKind: "path" });
  const output = store.start({ command, args: rawArgs, cwd });
  return { output, summary: `后台任务已启动 ${output.taskId}: ${command}`, tokenEstimate: 64 };
}

function readOutput(args: Record<string, unknown>, store: BackgroundTaskStore): ToolHandlerResult {
  const taskId = ensureString(args.taskId, "taskId");
  const sinceSeq = typeof args.sinceSeq === "number" && Number.isInteger(args.sinceSeq) && args.sinceSeq >= 0 ? args.sinceSeq : 0;
  const maxEvents = ensurePositiveInt(args.maxEvents, "maxEvents", 100);
  const output = store.output(taskId, sinceSeq, maxEvents);
  return { output, summary: `读取后台任务 ${taskId} 输出 ${output.events.length} 条`, tokenEstimate: output.events.reduce((sum, event) => sum + Math.ceil(event.text.length / 4), 32) };
}

function stopTask(args: Record<string, unknown>, store: BackgroundTaskStore): ToolHandlerResult {
  const taskId = ensureString(args.taskId, "taskId");
  const signal = (ensureOptionalString(args.signal, "signal") ?? "SIGTERM") as NodeJS.Signals;
  const output = store.stop(taskId, signal);
  return { output, summary: `已请求停止后台任务 ${taskId}`, tokenEstimate: 48 };
}

function snapshot(record: BackgroundTaskRecord): BackgroundTaskSnapshot {
  return {
    taskId: record.taskId,
    command: record.command,
    args: record.args,
    cwd: record.cwd,
    status: record.status,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
  };
}

function taskSnapshotOutputSchema(): JsonSchemaLike {
  return {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "command", "args", "cwd", "status", "startedAt"],
    properties: {
      taskId: { type: "string" },
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      status: { type: "string", enum: ["running", "exited", "stopped", "failed"] },
      exitCode: { type: ["integer", "null"] },
      signal: { type: ["string", "null"] },
      startedAt: { type: "integer" },
      finishedAt: { type: "integer" },
    },
  };
}
