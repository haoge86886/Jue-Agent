import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureString } from "../path-utils.js";

export interface SkillInvocation {
  skillName: string;
  input: Record<string, unknown>;
  reason?: string;
}

export interface SkillInvocationResult {
  skillName: string;
  status: "succeeded" | "failed" | "unavailable";
  output?: unknown;
  message: string;
}

export type SkillProvider = (invocation: SkillInvocation) => Promise<SkillInvocationResult> | SkillInvocationResult;

export const skillInvokeToolSpec: ToolSpec = {
  name: "skill.invoke",
  displayName: "调用 Skill",
  description: "调用当前环境中可用的 skill。用于把专门能力交给 skill 处理；没有 skill provider 时会明确返回不可用。",
  version: "0.1.0",
  kind: "builtin",
  category: "system",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["skillName"],
    properties: {
      skillName: { type: "string", description: "要调用的 skill 名称" },
      input: { type: "object", additionalProperties: true, description: "传给 skill 的结构化输入" },
      reason: { type: "string", description: "为什么需要调用该 skill" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["skillName", "status", "message"],
    properties: {
      skillName: { type: "string" },
      status: { type: "string", enum: ["succeeded", "failed", "unavailable"] },
      output: true,
      message: { type: "string" },
    },
  },
  sideEffectLevel: "external",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "skill"],
  sensitivity: "internal",
};

export interface SkillHandlerOptions {
  provider?: SkillProvider;
}

export function createSkillInvokeHandler(options: SkillHandlerOptions = {}): ToolHandler {
  return async (args): Promise<ToolHandlerResult> => {
    const skillName = ensureString(args.skillName, "skillName");
    const input = typeof args.input === "object" && args.input !== null && !Array.isArray(args.input)
      ? args.input as Record<string, unknown>
      : {};
    const reason = typeof args.reason === "string" ? args.reason : undefined;
    if (!options.provider) {
      throw new ToolExecutionError({
        code: "SKILL_PROVIDER_MISSING",
        message: "当前 runtime 未注入 skill provider，无法调用 skill",
        nextStep: "向用户说明需要先在 runtime/launcher 中接入 skill registry。",
      });
    }
    const output = await options.provider({ skillName, input, ...(reason ? { reason } : {}) });
    return {
      output,
      summary: `skill ${skillName} -> ${output.status}: ${output.message}`,
      tokenEstimate: Math.ceil(JSON.stringify(output).length / 4),
      ...(output.status === "succeeded" ? {} : { failure: { code: "SKILL_INVOCATION_FAILED", message: output.message, retriable: false } }),
    };
  };
}
