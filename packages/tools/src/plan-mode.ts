import type { ToolSpec } from "@jue/shared-types";

export interface PlanModeState {
  active: boolean;
  enteredAt?: number;
  reason?: string;
  plan?: string;
}

/**
 * 计划模式的运行态开关。进入后 executor 会统一阻止写入、shell、网络等非只读工具。
 */
export class PlanModeStore {
  private state: PlanModeState = { active: false };

  enter(reason?: string): PlanModeState {
    this.state = { active: true, enteredAt: Date.now(), ...(reason ? { reason } : {}) };
    return this.get();
  }

  exit(plan: string): PlanModeState {
    this.state = { active: false, plan, ...(this.state.enteredAt ? { enteredAt: this.state.enteredAt } : {}), ...(this.state.reason ? { reason: this.state.reason } : {}) };
    return this.get();
  }

  get(): PlanModeState {
    return { ...this.state };
  }
}

export function isToolAllowedInPlanMode(spec: ToolSpec): boolean {
  if (spec.name === "plan.exit") return true;
  if (spec.name === "ask_user_question") return true;
  if (spec.name.startsWith("todo.")) return true;
  if (spec.sideEffectLevel !== "none" && spec.sideEffectLevel !== "read") return false;
  return ["file", "search", "system"].includes(spec.category);
}
