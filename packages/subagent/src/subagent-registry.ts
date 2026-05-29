/**
 * @file subagent-registry.ts
 * @module @jue/subagent/subagent-registry
 *
 * SubAgent 注册表(对应 design.md §10)。
 *
 * 当前阶段(MVP)只提供最小 register/get/list,后续会扩展按 capability 检索。
 */

import type {
  SubAgentRegistration,
  SubAgentType,
} from "@jue/shared-types";
import { getModuleLogger } from "@jue/utils";

export class SubAgentRegistry {
  private readonly logger = getModuleLogger("subagent-registry");
  private readonly registrations = new Map<SubAgentType, SubAgentRegistration>();

  register(reg: SubAgentRegistration): void {
    this.registrations.set(reg.type, reg);
    this.logger.debug({ type: reg.type }, "subagent registered");
  }

  unregister(type: SubAgentType): void {
    this.registrations.delete(type);
  }

  get(type: SubAgentType): SubAgentRegistration | undefined {
    return this.registrations.get(type);
  }

  list(): SubAgentRegistration[] {
    return Array.from(this.registrations.values());
  }

  listEnabled(): SubAgentRegistration[] {
    return this.list().filter((r) => r.enabled);
  }

  listPublicEnabled(): SubAgentRegistration[] {
    return this.listEnabled().filter((r) => (r.visibility ?? "public") === "public");
  }

  findByInvocationName(name: string): SubAgentRegistration | undefined {
    const normalized = name.trim().toLowerCase();
    return this.listEnabled().find((reg) => {
      const invocationName = (reg.invocationName ?? reg.type).toLowerCase();
      return invocationName === normalized || reg.type.toLowerCase() === normalized;
    });
  }
}
