import type { ErrorInfo, ToolCall, ToolResult } from "@jue/shared-types";
import { newId } from "@jue/utils";

/**
 * 工具层统一错误。handler / adapter 只需要抛出它或带 code 的 Error，
 * executor 会把它转换成稳定的 ToolResult，避免模型只看到 false/null。
 */
export class ToolExecutionError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly details?: Record<string, unknown>;
  readonly nextStep?: string;

  constructor(options: {
    code: string;
    message: string;
    retriable?: boolean;
    details?: Record<string, unknown>;
    nextStep?: string;
  }) {
    super(options.message);
    this.name = "ToolExecutionError";
    this.code = options.code;
    this.retriable = options.retriable ?? false;
    if (options.details !== undefined) this.details = options.details;
    if (options.nextStep !== undefined) this.nextStep = options.nextStep;
  }
}

export function errorInfoFromUnknown(
  err: unknown,
  fallbackCode = "TOOL_HANDLER_EXCEPTION",
): ErrorInfo {
  if (err instanceof ToolExecutionError) {
    return {
      code: err.code,
      message: err.message,
      retriable: err.retriable,
      ...(err.details || err.nextStep
        ? { details: { ...(err.details ?? {}), ...(err.nextStep ? { nextStep: err.nextStep } : {}) } }
        : {}),
    };
  }
  const code = typeof (err as { code?: unknown })?.code === "string"
    ? (err as { code: string }).code
    : fallbackCode;
  const message = err instanceof Error ? err.message : String(err);
  return { code, message, retriable: false };
}

export function createRejectedToolResult(
  call: ToolCall,
  startedAt: number,
  code: string,
  message: string,
  nextStep?: string,
): ToolResult {
  const error: ErrorInfo = {
    code,
    message,
    retriable: false,
    ...(nextStep ? { details: { nextStep } } : {}),
  };
  return {
    id: newId("tres"),
    callId: call.id,
    toolName: call.toolName,
    status: "rejected",
    relevanceScore: call.relevanceScore,
    tokenEstimate: 0,
    durationMs: 0,
    error,
    startedAt,
    finishedAt: startedAt,
    truncated: false,
  };
}
