import type { ToolCall, ToolSpec } from "@jue/shared-types";

export interface ToolPermissionDecision {
  allowed: boolean;
  code?: string;
  message?: string;
  nextStep?: string;
}

export interface ToolPermissionPrompt {
  toolName: string;
  displayName: string;
  reason: string;
  sideEffectLevel: string;
  permissionScope: string;
  arguments: Record<string, unknown>;
}

export type ToolPermissionProvider = (prompt: ToolPermissionPrompt, call: ToolCall) => Promise<boolean> | boolean;

export interface ToolPolicyOptions {
  permissionProvider?: ToolPermissionProvider;
  allowHighRiskWithoutProvider?: boolean;
}

/**
 * 工具权限与确认检查。真实 UI 确认以后可以通过 permissionProvider 注入；
 * 没有确认能力时，高风险工具默认拒绝，避免静默执行写入/外部访问。
 */
export class ToolPolicyGuard {
  private readonly permissionProvider: ToolPermissionProvider | undefined;
  private readonly allowHighRiskWithoutProvider: boolean;

  constructor(options: ToolPolicyOptions = {}) {
    this.permissionProvider = options.permissionProvider;
    this.allowHighRiskWithoutProvider = options.allowHighRiskWithoutProvider ?? false;
  }

  async check(spec: ToolSpec, call: ToolCall): Promise<ToolPermissionDecision> {
    if (!requiresConfirmation(spec)) return { allowed: true };
    if (!this.permissionProvider) {
      if (this.allowHighRiskWithoutProvider) return { allowed: true };
      return {
        allowed: false,
        code: "TOOL_CONFIRMATION_REQUIRED",
        message: `工具 ${spec.name} 具有 ${spec.sideEffectLevel} 副作用，需要用户确认`,
        nextStep: "向用户说明要执行的操作和风险，获得确认后重试。",
      };
    }
    const approved = await this.permissionProvider({
      toolName: spec.name,
      displayName: spec.displayName,
      reason: spec.confirmation?.reason ?? "该工具可能修改本地或外部状态",
      sideEffectLevel: spec.sideEffectLevel,
      permissionScope: spec.permissionScope,
      arguments: call.arguments,
    }, call);
    return approved
      ? { allowed: true }
      : {
          allowed: false,
          code: "TOOL_PERMISSION_DENIED",
          message: `用户拒绝执行工具 ${spec.name}`,
          nextStep: "不要继续执行该工具；询问用户是否采用只读替代方案。",
        };
  }
}

function requiresConfirmation(spec: ToolSpec): boolean {
  if (spec.confirmation?.required === true) return true;
  if (spec.confirmation?.required === false) return false;
  return spec.sideEffectLevel === "write" || spec.sideEffectLevel === "external" || spec.sideEffectLevel === "destructive";
}
