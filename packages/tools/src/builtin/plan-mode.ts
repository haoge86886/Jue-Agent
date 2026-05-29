import type { JsonSchemaLike, ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { PlanModeStore } from "../plan-mode.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureOptionalString, ensureString } from "../path-utils.js";

export const planEnterToolSpec: ToolSpec = {
  name: "plan.enter",
  displayName: "EnterPlanMode",
  description: "进入计划模式。进入后 agent 只能探索仓库、询问用户和编写计划，不能写文件、执行 shell、发起网络请求或启动后台任务。",
  version: "0.1.0",
  kind: "builtin",
  category: "system",
  inputSchema: { type: "object", additionalProperties: false, properties: { reason: { type: "string", description: "进入计划模式的原因。" } } },
  outputSchema: planModeOutputSchema(),
  sideEffectLevel: "none",
  timeoutMs: 5_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "plan", "readonly"],
  sensitivity: "internal",
};

export const planExitToolSpec: ToolSpec = {
  name: "plan.exit",
  displayName: "ExitPlanMode",
  description: "退出计划模式。必须传入已经写好的计划；退出后应调用 todo.create 将计划拆成待办项，再逐项执行。",
  version: "0.1.0",
  kind: "builtin",
  category: "system",
  inputSchema: { type: "object", additionalProperties: false, required: ["plan"], properties: { plan: { type: "string", description: "完整计划，包含步骤、风险和验收方式。" } } },
  outputSchema: planModeOutputSchema(),
  sideEffectLevel: "none",
  timeoutMs: 5_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "plan"],
  sensitivity: "internal",
};

export function createPlanModeHandlers(store: PlanModeStore): Map<string, ToolHandler> {
  return new Map([
    [planEnterToolSpec.name, (args) => enterPlanMode(args, store)],
    [planExitToolSpec.name, (args) => exitPlanMode(args, store)],
  ]);
}

function enterPlanMode(args: Record<string, unknown>, store: PlanModeStore): ToolHandlerResult {
  const reason = ensureOptionalString(args.reason, "reason");
  const output = store.enter(reason);
  return { output, summary: "已进入计划模式：当前只能执行只读探索、询问用户和编写计划。", tokenEstimate: 48 };
}

function exitPlanMode(args: Record<string, unknown>, store: PlanModeStore): ToolHandlerResult {
  const plan = ensureString(args.plan, "plan").trim();
  if (!plan) throw new ToolExecutionError({ code: "PLAN_REQUIRED", message: "退出计划模式必须提供非空计划。", nextStep: "先完成计划，再调用 plan.exit。" });
  const output = store.exit(plan);
  return { output, summary: "已退出计划模式。下一步应调用 todo.create 将计划拆成待办项。", tokenEstimate: Math.ceil(plan.length / 4) };
}

function planModeOutputSchema(): JsonSchemaLike {
  return {
    type: "object",
    additionalProperties: false,
    required: ["active"],
    properties: {
      active: { type: "boolean" },
      enteredAt: { type: "integer" },
      reason: { type: "string" },
      plan: { type: "string" },
    },
  };
}
