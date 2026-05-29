/**
 * @file logger.ts
 * @module @jue/utils/logger
 *
 * Minimal process-wide logger.
 *
 * Design rules:
 * - Application logs live under the user-level .jue/logs directory.
 * - Terminal UIs stay clean by default; console logging is opt-in.
 * - Log cleanup runs at startup and is based on file modification time.
 * - Audit logs keep their own writer, but use the same logs directory.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  pino,
  destination as pinoDestination,
  multistream,
  type Level,
  type Logger as PinoLogger,
  type LoggerOptions,
  type StreamEntry,
} from "pino";

export type Logger = PinoLogger;

export interface LoggerInitOptions {
  /** Whether application logging is enabled at all. */
  enabled?: boolean;
  /** pino level: trace/debug/info/warn/error/fatal. */
  level?: Level;
  /** Fields attached to every log line. */
  base?: Record<string, unknown>;
  /** Absolute path to the application log file, normally <home>/.jue/logs/app.log. */
  logFile: string;
  /** Keep terminal UIs clean by default; enable only for explicit debug runs. */
  console?: boolean;
  /** stdout is useful for scripts, stderr is safer for diagnostics. */
  consoleDestination?: "stdout" | "stderr";
  /** pino redact paths. */
  redactPaths?: string[];
  /** Delete .log/.jsonl files in the log directory older than this many days. */
  retainDays?: number;
}

export interface LogCleanupOptions {
  logDir: string;
  retainDays: number;
  now?: number;
}

let globalLogger: Logger | undefined;

export function initLogger(options: LoggerInitOptions): Logger {
  const enabled = options.enabled ?? true;
  const level: Level = (options.level ?? (process.env.LOG_LEVEL as Level | undefined) ?? "info") as Level;
  const logFile = options.logFile;

  if (options.retainDays && options.retainDays > 0) {
    cleanupOldLogs({ logDir: dirname(logFile), retainDays: options.retainDays });
  }

  const opts: LoggerOptions = {
    enabled,
    level,
    base: options.base ?? null,
    ...(options.redactPaths
      ? { redact: { paths: options.redactPaths, censor: "***REDACTED***" } }
      : {}),
  };

  const streams: StreamEntry[] = [];
  if (enabled) {
    mkdirSync(dirname(logFile), { recursive: true });
    streams.push({ level, stream: pinoDestination({ dest: logFile, append: true, sync: false }) });
  }

  if (enabled && options.console) {
    streams.push({
      level,
      stream: options.consoleDestination === "stdout" ? pinoDestination(1) : pinoDestination(2),
    });
  }

  globalLogger = streams.length > 1
    ? pino(opts, multistream(streams, { dedupe: false }))
    : pino(opts, streams[0]?.stream);

  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    const fallbackLogFile = join(process.cwd(), ".jue", "logs", "app.log");
    globalLogger = initLogger({ enabled: false, logFile: fallbackLogFile });
  }
  return globalLogger;
}

export function getModuleLogger(module: string): Logger {
  return getLogger().child({ module });
}

export function cleanupOldLogs(options: LogCleanupOptions): void {
  if (!Number.isFinite(options.retainDays) || options.retainDays <= 0) return;
  if (!existsSync(options.logDir)) return;

  const cutoff = (options.now ?? Date.now()) - options.retainDays * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(options.logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".log" && ext !== ".jsonl") continue;

    const filePath = join(options.logDir, entry.name);
    try {
      if (statSync(filePath).mtimeMs < cutoff) rmSync(filePath, { force: true });
    } catch {
      // Cleanup must never block startup.
    }
  }
}
