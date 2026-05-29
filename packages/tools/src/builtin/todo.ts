import type { JsonSchemaLike, ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureOptionalString, ensureString } from "../path-utils.js";

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type TodoPriority = "low" | "normal" | "high";

export interface TodoItem {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  order: number;
  createdAt: number;
  updatedAt: number;
  note?: string;
  priority?: TodoPriority;
}

/** 会话内待办存储：只管理 agent 当前任务计划，不写项目文件。 */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextOrder = 1;

  create(input: { title: string; description: string; status?: TodoStatus; note?: string; priority?: TodoPriority; id?: string }): TodoItem[] {
    const now = Date.now();
    this.items.push({
      id: input.id?.trim() || `todo_${now}_${Math.random().toString(16).slice(2, 8)}`,
      title: input.title,
      description: input.description,
      status: input.status ?? "pending",
      order: this.nextOrder++,
      createdAt: now,
      updatedAt: now,
      ...(input.note ? { note: input.note } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    });
    return this.read();
  }

  update(id: string, patch: { status?: TodoStatus; note?: string; title?: string; description?: string; priority?: TodoPriority }): TodoItem[] {
    const index = this.items.findIndex((item) => item.id === id);
    const current = this.items[index];
    if (index < 0 || !current) throw new ToolExecutionError({ code: "TODO_NOT_FOUND", message: `未找到待办项 ${id}`, nextStep: "先调用 todo.list 查看当前待办 id，再调用 todo.update。" });
    this.items[index] = { ...current, ...patch, updatedAt: Date.now() };
    return this.read();
  }

  read(): TodoItem[] {
    return [...this.items].sort((a, b) => a.order - b.order).map((item) => ({ ...item }));
  }

  summary(): Array<Pick<TodoItem, "id" | "title" | "status" | "order" | "priority" | "note">> {
    return this.read().map((item) => ({ id: item.id, title: item.title, status: item.status, order: item.order, ...(item.priority ? { priority: item.priority } : {}), ...(item.note ? { note: item.note } : {}) }));
  }
}

const statuses = ["pending", "in_progress", "done", "blocked"];
const priorities = ["low", "normal", "high"];

export const todoCreateToolSpec: ToolSpec = makeTodoSpec({
  name: "todo.create",
  displayName: "新建待办项",
  description: "新建一个待办项。仅在任务能拆成三步以上、跨文件/跨轮执行、需要持续状态追踪或计划模式退出后使用；一两步的小任务不要创建 todo。每个待办必须有清晰标题、具体描述和可验证完成标准。",
  required: ["title", "description"],
  properties: commonInputProperties(),
  outputSchema: todoArraySchema(),
});

export const todoUpdateToolSpec: ToolSpec = makeTodoSpec({
  name: "todo.update",
  displayName: "更新待办状态",
  description: "更新已有待办项的执行状态。开始某项前标 in_progress，完成且验证通过后标 done，遇到外部阻碍或需要用户决策时标 blocked，并用 note 写明简短原因或完成说明。",
  required: ["id"],
  properties: { id: { type: "string" }, ...commonInputProperties() },
  outputSchema: todoArraySchema(),
});

export const todoListToolSpec: ToolSpec = makeTodoSpec({
  name: "todo.list",
  displayName: "列出待办概要",
  description: "列出当前所有待办概要，包括已完成、进行中、阻塞和未完成项，并按创建顺序排序。完成一项后用它选择下一项，避免跳步或重复执行。",
  properties: {},
  outputSchema: todoListSchema(),
});

export const todoReadToolSpec: ToolSpec = makeTodoSpec({
  name: "todo.read",
  displayName: "读取待办详情",
  description: "读取完整待办详情，包括描述、备注和时间戳。只有需要查看某项完整验收标准或阻塞原因时使用；只需要下一步时优先用 todo.list。",
  properties: {},
  outputSchema: todoArraySchema(),
});

export function createTodoHandlers(store: TodoStore = new TodoStore()): Map<string, ToolHandler> {
  return new Map<string, ToolHandler>([
    [todoCreateToolSpec.name, (args: Record<string, unknown>) => createTodo(args, store)],
    [todoUpdateToolSpec.name, (args: Record<string, unknown>) => updateTodo(args, store)],
    [todoListToolSpec.name, () => listTodo(store)],
    [todoReadToolSpec.name, () => readTodo(store)],
  ]);
}

function makeTodoSpec(input: { name: string; displayName: string; description: string; properties: Record<string, JsonSchemaLike>; outputSchema: JsonSchemaLike; required?: string[] }): ToolSpec {
  return {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    version: "0.1.0",
    kind: "builtin",
    category: "system",
    inputSchema: { type: "object", additionalProperties: false, required: input.required ?? [], properties: input.properties },
    outputSchema: input.outputSchema,
    sideEffectLevel: "none",
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
    permissionScope: "user",
    confirmation: { required: false, autoApproveScopes: ["user"] },
    availabilityCheck: { kind: "always", envKeys: [] },
    errorMapping: [],
    tags: ["builtin", "todo", "planning"],
    sensitivity: "internal",
  };
}

function createTodo(args: Record<string, unknown>, store: TodoStore): ToolHandlerResult {
  const title = ensureString(args.title, "title");
  const description = ensureString(args.description, "description");
  const id = ensureOptionalString(args.id, "id");
  const status = parseStatus(args.status, "pending");
  const priority = parsePriority(args.priority);
  const note = ensureOptionalString(args.note, "note");
  const output = store.create({ title, description, status, ...(id ? { id } : {}), ...(priority ? { priority } : {}), ...(note ? { note } : {}) });
  return { output, summary: `已新建待办项：${title}`, tokenEstimate: estimateTokens(output) };
}

function updateTodo(args: Record<string, unknown>, store: TodoStore): ToolHandlerResult {
  const id = ensureString(args.id, "id");
  const status = args.status === undefined ? undefined : parseStatus(args.status);
  const title = ensureOptionalString(args.title, "title");
  const description = ensureOptionalString(args.description, "description");
  const priority = parsePriority(args.priority);
  const note = ensureOptionalString(args.note, "note");
  if (!status && !title && !description && !priority && !note) {
    throw new ToolExecutionError({ code: "TODO_UPDATE_EMPTY", message: "todo.update 至少需要一个要更新的字段。", nextStep: "传入 status、title、description、priority 或 note。" });
  }
  const output = store.update(id, { ...(status ? { status } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(priority ? { priority } : {}), ...(note ? { note } : {}) });
  return { output, summary: `已更新待办项 ${id}${status ? ` 为 ${status}` : ""}`, tokenEstimate: estimateTokens(output) };
}

function listTodo(store: TodoStore): ToolHandlerResult {
  const items = store.summary();
  const output = { items, total: items.length };
  return { output, summary: `当前共有 ${items.length} 个待办项`, tokenEstimate: estimateTokens(output) };
}

function readTodo(store: TodoStore): ToolHandlerResult {
  const output = store.read();
  return { output, summary: `当前共有 ${output.length} 个待办项`, tokenEstimate: estimateTokens(output) };
}

function parseStatus(value: unknown, fallback?: TodoStatus): TodoStatus {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw invalidEnum("status", statuses.join("、"));
  }
  if (value === "pending" || value === "in_progress" || value === "done" || value === "blocked") return value;
  throw invalidEnum("status", statuses.join("、"));
}

function parsePriority(value: unknown): TodoPriority | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "low" || value === "normal" || value === "high") return value;
  throw invalidEnum("priority", priorities.join("、"));
}

function invalidEnum(field: string, allowed: string): ToolExecutionError {
  return new ToolExecutionError({ code: "INVALID_ARGUMENT", message: `参数 ${field} 不合法，允许值：${allowed}`, nextStep: "按工具 inputSchema 修正参数后重试。" });
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function commonInputProperties(): Record<string, JsonSchemaLike> {
  return {
    title: { type: "string", description: "简短标题，描述这一项要完成什么。" },
    description: { type: "string", description: "具体说明、验收标准或执行细节。" },
    id: { type: "string", description: "可选稳定 id；通常不用传，由系统生成。" },
    status: { type: "string", enum: statuses, default: "pending" },
    priority: { type: "string", enum: priorities, default: "normal" },
    note: { type: "string", description: "可选备注，记录完成说明或阻碍原因。" },
  };
}

function todoArraySchema(): JsonSchemaLike {
  return { type: "array", items: todoItemSchema() };
}

function todoListSchema(): JsonSchemaLike {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "total"],
    properties: {
      total: { type: "integer" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "status", "order"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: statuses },
            order: { type: "integer" },
            priority: { type: "string", enum: priorities },
            note: { type: "string" },
          },
        },
      },
    },
  };
}

function todoItemSchema(): JsonSchemaLike {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "title", "description", "status", "order", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: statuses },
      order: { type: "integer" },
      createdAt: { type: "integer" },
      updatedAt: { type: "integer" },
      note: { type: "string" },
      priority: { type: "string", enum: priorities },
    },
  };
}
