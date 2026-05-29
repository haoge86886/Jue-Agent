/**
 * @file audit-logger.ts
 * @module @jue/utils/audit-logger
 *
 * 审计事件落盘。
 *
 * 当前阶段为简化实现:把 AuditEvent 直接写到 logger 的 `info`/`warn` 通道,
 * 不落独立审计存储。这层提供了 {@link AuditLogger} 接口,后续 `packages/audit`
 * 可以提供独立的实现(写文件/写 SQLite/写 Postgres)替换 default 实现。
 *
 * 调用方拿到的是 {@link AuditLogger} 接口而非具体实现,便于未来无痛替换。
 */

import type { AuditEvent } from "@jue/shared-types";
import { newId } from "./ids.js";
import { getModuleLogger, type Logger } from "./logger.js";

/**
 * 审计 logger 接口。Engine / SubAgent / ToolExecutor 等都通过此接口写审计,
 * 不直接依赖具体实现。
 */
export interface AuditLogger {
  /**
   * 写一条审计事件。同步接口便于在大多数地方使用,具体实现可在内部异步落盘。
   *
   * 入参 `event` 中的 `id` 与 `occurredAt` 可选,缺省时实现层自动补齐。
   */
  log(event: PartialAuditEvent): void;
}

/**
 * 写入时允许省略 id / occurredAt / severity / sensitivity。
 *
 * 后两者在 Zod schema 上有 default,但 `z.infer` 输出类型仍标记为必填——
 * 这里通过 `Partial<Pick<...>>` 让调用方可以省略,实现层兜底默认值。
 */
export type PartialAuditEvent = Omit<
  AuditEvent,
  "id" | "occurredAt" | "severity" | "sensitivity"
> &
  Partial<Pick<AuditEvent, "id" | "occurredAt" | "severity" | "sensitivity">>;

class PinoAuditLogger implements AuditLogger {
  private readonly logger: Logger;

  constructor(logger: Logger = getModuleLogger("audit")) {
    this.logger = logger;
  }

  log(event: PartialAuditEvent): void {
    const filled: AuditEvent = {
      ...event,
      id: event.id ?? newId("audit"),
      occurredAt: event.occurredAt ?? Date.now(),
      severity: event.severity ?? "info",
      sensitivity: event.sensitivity ?? "internal",
    } as AuditEvent;
    const level =
      filled.outcome === "denied" || filled.outcome === "failure"
        ? "warn"
        : "info";
    this.logger[level]({ audit: filled }, `[audit] ${filled.category}.${filled.action}`);
  }
}

let globalAuditLogger: AuditLogger | undefined;

export function getAuditLogger(): AuditLogger {
  if (!globalAuditLogger) globalAuditLogger = new PinoAuditLogger();
  return globalAuditLogger;
}

/**
 * 替换全局审计实现,主要给 `packages/audit` 后续提供更完整的落盘实现使用。
 */
export function setAuditLogger(impl: AuditLogger): void {
  globalAuditLogger = impl;
}
