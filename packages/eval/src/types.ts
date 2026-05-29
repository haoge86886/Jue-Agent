import type { StreamEvent } from "@jue/shared-types";

export type EvalTaskFormat = "jue-smoke" | "terminal-bench" | "swe-bench" | "multi-swe-bench" | "swe-polybench" | "custom";
export type EvalExitReason = "completed" | "timeout" | "error" | "interrupted";
export type EvalAskUserPolicy = "approve" | "deny";

export interface EvalSuite {
  name: string;
  version?: string;
  format?: EvalTaskFormat;
  tasks: EvalTask[];
}

export interface EvalTask {
  id: string;
  title?: string;
  benchmark?: EvalTaskFormat;
  instruction: string;
  workspace?: string;
  repo?: string;
  baseCommit?: string;
  timeoutMs?: number;
  configFile?: string;
  model?: string;
  askUserPolicy?: EvalAskUserPolicy;
  tags?: string[];
  checks?: EvalCheck[];
  metadata?: Record<string, unknown>;
}

export type EvalCheck =
  | { type: "file_exists"; path: string }
  | { type: "file_not_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_not_contains"; path: string; text: string }
  | { type: "command"; command: string; timeoutMs?: number; expectedExitCode?: number; stdoutContains?: string; stderrContains?: string }
  | { type: "transcript_contains"; text: string }
  | { type: "tool_called"; name: string; minCount?: number; maxCount?: number }
  | { type: "json_path_equals"; path: string; value: unknown };

export interface EvalRunOptions {
  suitePath: string;
  outDir: string;
  benchmark?: EvalTaskFormat;
  rangeStart?: number;
  rangeEnd?: number;
  limit?: number;
  workspaceRoot?: string;
  prepareRepos?: boolean;
  repoCacheDir?: string;
  exportPredictions?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  dryRun?: boolean;
  model?: string;
  configFile?: string;
  askUserPolicy?: EvalAskUserPolicy;
}

export interface EvalToolTrace {
  name: string;
  status: "started" | "completed" | "failed" | "unknown";
  callId?: string;
  durationMs?: number;
  args?: unknown;
  summary?: string;
  error?: string;
}

export interface EvalAgentRunResult {
  taskId: string;
  sessionId?: string;
  finalText: string;
  events: StreamEvent[];
  toolCalls: EvalToolTrace[];
  startedAt: number;
  finishedAt: number;
  exitReason: EvalExitReason;
  error?: string;
}

export interface EvalCheckResult {
  check: EvalCheck;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface EvalTaskResult {
  task: EvalTask;
  workspacePath: string;
  run: EvalAgentRunResult;
  checks: EvalCheckResult[];
  passed: boolean;
}

export interface EvalReport {
  suiteName: string;
  startedAt: number;
  finishedAt: number;
  total: number;
  passed: number;
  failed: number;
  results: EvalTaskResult[];
}
