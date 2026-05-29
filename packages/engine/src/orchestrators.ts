import type { ToolCall, ToolResult } from "@jue/shared-types";
import type { ToolExecutor } from "@jue/tools";

export interface ToolOrchestrator {
  dispatch(call: ToolCall): Promise<ToolResult>;
}

export class DefaultToolOrchestrator implements ToolOrchestrator {
  constructor(private readonly executor: ToolExecutor) {}

  async dispatch(call: ToolCall): Promise<ToolResult> {
    return this.executor.execute(call);
  }
}

export class MissingToolOrchestrator implements ToolOrchestrator {
  async dispatch(call: ToolCall): Promise<ToolResult> {
    throw new Error(`Tool orchestration is not configured. Cannot execute tool: ${call.toolName}`);
  }
}

export interface PolicyGuard {
  checkToolCall(call: ToolCall): Promise<{ allowed: boolean; reason?: string }>;
}

export class DefaultPolicyGuard implements PolicyGuard {
  async checkToolCall(): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }
}
