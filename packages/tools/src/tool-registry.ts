/**
 * @file tool-registry.ts
 * @module @jue/tools/tool-registry
 *
 * 工具注册表(对应 design.md §9)。
 *
 * 当前阶段(MVP)只有最小可用 API:
 *   - register / unregister / get / list / listEnabled
 *
 * 后续会扩展:
 *   - 按 category / kind / tag 过滤
 *   - 按 ConfirmationPolicy 判定 needsConfirmation()
 *   - 与 ToolValidator 联动做 inputSchema 校验
 *
 * 工具协议(ToolSpec)在 `@jue/shared-types/tool`,本文件不重复定义。
 */

import type { ToolRegistration, ToolSpec } from "@jue/shared-types";
import { getModuleLogger } from "@jue/utils";
import { ToolValidator } from "./tool-validator.js";

export class ToolRegistry {
  private readonly logger = getModuleLogger("tool-registry");
  private readonly registrations = new Map<string, ToolRegistration>();
  private readonly validator: ToolValidator;

  constructor(options: { validator?: ToolValidator } = {}) {
    this.validator = options.validator ?? new ToolValidator();
  }

  register(spec: ToolSpec, options: { enabled?: boolean; reason?: string } = {}): void {
    const validation = this.validator.validateSpec(spec);
    if (!validation.ok) {
      const reason = `${validation.failure.message}: ${validation.failure.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
      const reg: ToolRegistration = {
        spec,
        enabled: false,
        registeredAt: Date.now(),
        unavailableReason: reason,
      };
      this.registrations.set(spec.name, reg);
      this.logger.warn({ tool: spec.name, reason }, "invalid tool registered as unavailable");
      return;
    }
    const reg: ToolRegistration = {
      spec,
      enabled: options.enabled ?? true,
      registeredAt: Date.now(),
      ...(options.reason ? { unavailableReason: options.reason } : {}),
    };
    this.registrations.set(spec.name, reg);
    this.logger.debug({ tool: spec.name, kind: spec.kind }, "tool registered");
  }

  unregister(name: string): void {
    this.registrations.delete(name);
  }

  get(name: string): ToolRegistration | undefined {
    return this.registrations.get(name);
  }

  list(): ToolRegistration[] {
    return Array.from(this.registrations.values());
  }

  listEnabled(): ToolRegistration[] {
    return this.list().filter((r) => r.enabled);
  }

  findByCategory(category: ToolSpec["category"]): ToolRegistration[] {
    return this.list().filter((r) => r.spec.category === category);
  }

  markUnavailable(name: string, reason: string): void {
    const existing = this.registrations.get(name);
    if (!existing) return;
    this.registrations.set(name, { ...existing, enabled: false, unavailableReason: reason });
  }

  /**
   * 当前已启用工具的名称列表,主要给 DynamicPromptBuilder 用作 `runtime_tools` 片段。
   */
  enabledNames(): string[] {
    return this.listEnabled().map((r) => r.spec.name);
  }
}
