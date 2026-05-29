/**
 * @file file-audit-logger.ts
 * @module @jue/audit/file-audit-logger
 *
 * 审计事件文件落盘实现。
 *
 * 设计要点:
 *   - 与应用日志(pino)**独立通道**:文件路径独立、写入栈独立、序列化格式独立
 *   - 行式 JSON(NDJSON):便于后续被 `tail -f` / `jq` / 日志采集器消费
 *   - 同步写入:审计的写入失败应当被立刻发现,而不是被异步队列吞掉
 *   - 文件目录不存在自动创建一次,避免开发期手动 `mkdir`
 *   - 字段补齐:id / occurredAt / severity / sensitivity 缺失时给默认值
 *
 * 后续如需高吞吐场景(API 大流量),可在不变更接口的前提下:
 *   - 增加批量写入 + flush 周期
 *   - 增加 `BufferedFileAuditLogger`,内部用 worker_thread 写
 *   - 替换为 `SqliteAuditLogger` / `PostgresAuditLogger`
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  newId,
  type AuditLogger,
  type PartialAuditEvent,
} from "@jue/utils";
import type { AuditEvent } from "@jue/shared-types";

export interface FileAuditLoggerOptions {
  /** 审计日志文件绝对路径(调用方负责把相对路径解析好) */
  path: string;
  /**
   * 写入失败时的回调。默认行为:把错误打印到 stderr。
   *
   * 故意不抛出 — 审计落盘失败不应影响主请求,但必须可见。
   */
  onError?: (err: unknown) => void;
}

/**
 * 文件型审计 logger。`log()` 同步写一行 JSON 到目标文件。
 *
 * 注意:同步写入的代价是阻塞,适合中低频场景(单进程 CLI / 后台任务)。
 * 高频场景请配合后续的 `BufferedFileAuditLogger`(本阶段未实现)。
 */
export class FileAuditLogger implements AuditLogger {
  private readonly path: string;
  private readonly onError: (err: unknown) => void;
  /** 缓存的 fd。第一次写入时打开,生命周期内复用 */
  private fd: number | undefined;

  constructor(options: FileAuditLoggerOptions) {
    this.path = options.path;
    this.onError =
      options.onError ??
      ((err) => {
        process.stderr.write(
          `[audit] write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  }

  log(event: PartialAuditEvent): void {
    const filled: AuditEvent = {
      ...event,
      id: event.id ?? newId("audit"),
      occurredAt: event.occurredAt ?? Date.now(),
      severity: event.severity ?? "info",
      sensitivity: event.sensitivity ?? "internal",
    } as AuditEvent;

    try {
      if (this.fd === undefined) {
        mkdirSync(dirname(this.path), { recursive: true });
        // 'a' 模式:不存在则创建,存在则追加。多个进程并发追加在大多数 OS 下都是安全的
        this.fd = openSync(this.path, "a");
      }
      writeSync(this.fd, `${JSON.stringify(filled)}\n`);
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * 关闭底层 fd。CLI 退出前可调用,但不强制 — Node 会在进程结束时统一回收。
   */
  close(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // 关闭失败忽略,Node 进程退出会兜底
      }
      this.fd = undefined;
    }
  }
}
