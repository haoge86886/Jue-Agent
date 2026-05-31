import type { ToolCall, ToolResult } from "@jue/shared-types";
import { estimateTokens, newId } from "@jue/utils";
import type { ToolHandlerResult } from "./tool-executor.js";
import { type ToolValidationFailure } from "./tool-validator.js";

export interface NormalizerOptions {
  maxOutputChars?: number;
}

/**
 * ToolResult 标准化器。所有成功、失败、拒绝、超时结果都经这里生成，
 * 保证模型总能拿到 status/error/nextStep，而不是裸异常或不稳定结构。
 */
export class ToolResultNormalizer {
  private readonly maxOutputChars: number;

  constructor(options: NormalizerOptions = {}) {
    this.maxOutputChars = options.maxOutputChars ?? 32_000;
  }

  succeeded(call: ToolCall, startedAt: number, handlerResult: ToolHandlerResult): ToolResult {
    const finishedAt = Date.now();
    const normalizedOutput = this.truncateLargeOutput(handlerResult.output);
    return {
      id: newId("tres"),
      callId: call.id,
      toolName: call.toolName,
      status: "succeeded",
      output: normalizedOutput.output,
      ...(handlerResult.summary !== undefined ? { summary: handlerResult.summary } : {}),
      relevanceScore: call.relevanceScore,
      tokenEstimate: handlerResult.tokenEstimate ?? estimateTokens(stringifyOutput(normalizedOutput.output)),
      durationMs: finishedAt - startedAt,
      startedAt,
      finishedAt,
      truncated: handlerResult.truncated ?? normalizedOutput.truncated,
    };
  }

  failedFromHandlerFailure(call: ToolCall, startedAt: number, handlerResult: ToolHandlerResult): ToolResult {
    const finishedAt = Date.now();
    const failure = handlerResult.failure ?? { code: "TOOL_FAILED", message: "工具执行失败" };
    const normalizedOutput = handlerResult.output === undefined
      ? { output: undefined, truncated: false }
      : this.truncateLargeOutput(handlerResult.output);
    return {
      id: newId("tres"),
      callId: call.id,
      toolName: call.toolName,
      status: "failed",
      ...(normalizedOutput.output !== undefined ? { output: normalizedOutput.output } : {}),
      ...(handlerResult.summary !== undefined ? { summary: handlerResult.summary } : {}),
      relevanceScore: call.relevanceScore,
      tokenEstimate: handlerResult.tokenEstimate ?? estimateTokens(stringifyOutput(normalizedOutput.output)),
      durationMs: finishedAt - startedAt,
      error: {
        code: failure.code,
        message: failure.message,
        retriable: failure.retriable ?? false,
        details: { nextStep: "根据错误信息修正参数，或换用更合适的工具。" },
      },
      startedAt,
      finishedAt,
      truncated: handlerResult.truncated ?? normalizedOutput.truncated,
    };
  }

  failed(call: ToolCall, startedAt: number, error: { code: string; message: string; retriable?: boolean; details?: Record<string, unknown> }): ToolResult {
    const finishedAt = Date.now();
    return {
      id: newId("tres"),
      callId: call.id,
      toolName: call.toolName,
      status: "failed",
      relevanceScore: call.relevanceScore,
      tokenEstimate: 0,
      durationMs: finishedAt - startedAt,
      error: {
        code: error.code,
        message: error.message,
        retriable: error.retriable ?? false,
        ...(error.details ? { details: error.details } : {}),
      },
      startedAt,
      finishedAt,
      truncated: false,
    };
  }

  timeout(call: ToolCall, startedAt: number, timeoutMs: number): ToolResult {
    return this.failed(call, startedAt, {
      code: "TOOL_TIMEOUT",
      message: `工具执行超过 ${timeoutMs}ms`,
      retriable: true,
      details: { nextStep: "缩小输入范围或分批调用该工具。" },
    });
  }

  rejected(call: ToolCall, startedAt: number, code: string, message: string, nextStep: string): ToolResult {
    return {
      id: newId("tres"),
      callId: call.id,
      toolName: call.toolName,
      status: "rejected",
      relevanceScore: call.relevanceScore,
      tokenEstimate: 0,
      durationMs: 0,
      error: { code, message, retriable: false, details: { nextStep } },
      startedAt,
      finishedAt: startedAt,
      truncated: false,
    };
  }

  validationRejected(call: ToolCall, startedAt: number, failure: ToolValidationFailure): ToolResult {
    const finishedAt = Date.now();
    return {
      id: newId("tres"),
      callId: call.id,
      toolName: call.toolName,
      status: "rejected",
      relevanceScore: call.relevanceScore,
      tokenEstimate: 0,
      durationMs: finishedAt - startedAt,
      error: {
        code: failure.code,
        message: failure.message,
        retriable: false,
        details: { nextStep: failure.nextStep, issues: failure.issues, ...(failure.details ?? {}) },
      },
      startedAt,
      finishedAt,
      truncated: false,
    };
  }

  private truncateLargeOutput(output: unknown): { output: unknown; truncated: boolean } {
    const text = stringifyOutput(output);
    if (text.length <= this.maxOutputChars) return { output, truncated: false };
    return {
      output: {
        truncated: true,
        contentPreview: text.slice(0, this.maxOutputChars),
        originalCharLength: text.length,
      },
      truncated: true,
    };
  }
}

function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
