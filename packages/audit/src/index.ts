/**
 * @file index.ts
 * @module @jue/audit
 *
 * 审计子系统入口。
 *
 * 当前阶段:
 *   - FileAuditLogger     : NDJSON 文件落盘(同步写)
 *
 * 后续可加(接口不变):
 *   - BufferedFileAuditLogger
 *   - SqliteAuditLogger
 *   - PostgresAuditLogger
 */

export * from "./file-audit-logger.js";
