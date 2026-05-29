import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureString } from "../path-utils.js";

export interface SubAgentInvokeRequest {
  subagentName: string;
  goal: string;
  title?: string;
  successCriteria?: string[];
  constraints?: string[];
  inputs?: Record<string, unknown>;
  contextBlocks?: Array<Record<string, unknown>>;
  memoryRecords?: Array<Record<string, unknown>>;
  budget?: Record<string, unknown>;
}

export interface SubAgentInvokeResult {
  taskId: string;
  subagentName: string;
  status: string;
  conclusion: string;
  details?: string;
  outputs?: Record<string, unknown>;
}

export type SubAgentInvokeProvider = (request: SubAgentInvokeRequest, ctx?: import("../tool-executor.js").ToolHandlerContext) => Promise<SubAgentInvokeResult> | SubAgentInvokeResult;

export const subagentInvokeToolSpec: ToolSpec = {
  name: "subagent.invoke",
  displayName: "调用子智能体",
  description: "根据子智能体名称启动一个独立的子 Agent Loop。主 Agent 通过它调用 Explorer、Plan、verification、General-purpose 等公开子智能体；禁止在子智能体内部再次调用该工具。",
  version: "0.1.0",
  kind: "builtin",
  category: "system",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["subagentName", "goal"],
    properties: {
      subagentName: { type: "string", description: "要调用的子智能体名称，例如 ExplorerAgent、PlanAgent、verification、General-purpose" },
      goal: { type: "string", description: "这次委派给子智能体的任务目标" },
      title: { type: "string", description: "任务标题" },
      successCriteria: { type: "array", items: { type: "string" }, description: "完成标准" },
      constraints: { type: "array", items: { type: "string" }, description: "约束条件" },
      inputs: { type: "object", additionalProperties: true, description: "结构化输入" },
      contextBlocks: { type: "array", items: { type: "object", additionalProperties: true }, description: "额外上下文块" },
      memoryRecords: { type: "array", items: { type: "object", additionalProperties: true }, description: "必要记忆快照" },
      budget: { type: "object", additionalProperties: true, description: "预算覆盖值" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "subagentName", "status", "conclusion"],
    properties: {
      taskId: { type: "string" },
      subagentName: { type: "string" },
      status: { type: "string" },
      conclusion: { type: "string" },
      details: { type: "string" },
      outputs: { type: "object", additionalProperties: true },
    },
  },
  sideEffectLevel: "external",
  timeoutMs: 240_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "workspace",
  confirmation: { required: false, autoApproveScopes: ["workspace"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "subagent", "delegation"],
  sensitivity: "internal",
};

export interface SubAgentInvokeHandlerOptions {
  provider?: SubAgentInvokeProvider;
}

export function createSubAgentInvokeHandler(options: SubAgentInvokeHandlerOptions = {}): ToolHandler {
  return async (args, ctx): Promise<ToolHandlerResult> => {
    const subagentName = ensureString(args.subagentName, "subagentName");
    const goal = ensureString(args.goal, "goal");
    if (!options.provider) {
      throw new ToolExecutionError({
        code: "SUBAGENT_PROVIDER_MISSING",
        message: "当前 runtime 未注入 subagent provider，无法派发子智能体",
        nextStep: "在 runtime 中注入 SubAgentManager 后重试，或直接让主 Agent 自己完成该任务。",
      });
    }

    const output = await options.provider({
      subagentName,
      goal,
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(Array.isArray(args.successCriteria) ? { successCriteria: args.successCriteria.filter((item): item is string => typeof item === "string") } : {}),
      ...(Array.isArray(args.constraints) ? { constraints: args.constraints.filter((item): item is string => typeof item === "string") } : {}),
      ...(isRecord(args.inputs) ? { inputs: args.inputs } : {}),
      ...(Array.isArray(args.contextBlocks) ? { contextBlocks: args.contextBlocks.filter(isRecord) } : {}),
      ...(Array.isArray(args.memoryRecords) ? { memoryRecords: args.memoryRecords.filter(isRecord) } : {}),
      ...(isRecord(args.budget) ? { budget: args.budget } : {}),
    });

    return {
      output,
      summary: `subagent ${output.subagentName} -> ${output.status}: ${output.conclusion}`,
      tokenEstimate: Math.ceil(JSON.stringify(output).length / 4),
      ...(output.status === "succeeded" ? {} : { failure: { code: "SUBAGENT_INVOCATION_FAILED", message: output.conclusion, retriable: false } }),
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

