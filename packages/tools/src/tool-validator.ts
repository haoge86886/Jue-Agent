import { ToolCallSchema, ToolResultSchema, ToolSpecSchema, type ToolCall, type ToolResult, type ToolSpec } from "@jue/shared-types";
import { JsonSchemaValidator, type ValidationIssue } from "./json-schema-validator.js";

export interface ToolValidationFailure {
  code: string;
  message: string;
  issues: ValidationIssue[];
  nextStep: string;
}

export type ToolValidationResult =
  | { ok: true }
  | { ok: false; failure: ToolValidationFailure };

/**
 * 工具协议校验层。注册前校验 ToolSpec，执行前校验 ToolCall 与 inputSchema，
 * 执行后校验 outputSchema，保证所有工具都走同一套边界检查。
 */
export class ToolValidator {
  private readonly schemaValidator: JsonSchemaValidator;

  constructor(schemaValidator: JsonSchemaValidator = new JsonSchemaValidator()) {
    this.schemaValidator = schemaValidator;
  }

  validateSpec(spec: ToolSpec): ToolValidationResult {
    const parsed = ToolSpecSchema.safeParse(spec);
    if (!parsed.success) {
      return failure("TOOL_SPEC_INVALID", "工具协议不符合 ToolSpec", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "修正工具定义后再注册；外部工具应先通过 ToolAdapter 转换。");
    }
    return { ok: true };
  }

  validateCall(call: ToolCall): ToolValidationResult {
    const parsed = ToolCallSchema.safeParse(call);
    if (!parsed.success) {
      return failure("TOOL_CALL_INVALID", "工具调用对象不符合 ToolCall", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "重新生成合法的工具调用参数。");
    }
    return { ok: true };
  }

  validateInput(spec: ToolSpec, args: Record<string, unknown>): ToolValidationResult {
    const result = this.schemaValidator.validate(args, spec.inputSchema, "$.");
    if (!result.ok) {
      return failure("TOOL_INPUT_INVALID", `工具 ${spec.name} 的输入参数不合法`, result.issues, "根据 inputSchema 修正参数后重试。");
    }
    return { ok: true };
  }

  validateOutput(spec: ToolSpec, output: unknown): ToolValidationResult {
    const result = this.schemaValidator.validate(output, spec.outputSchema, "$.");
    if (!result.ok) {
      return failure("TOOL_OUTPUT_INVALID", `工具 ${spec.name} 的输出不符合 outputSchema`, result.issues, "不要直接依赖该工具结果；尝试换用其他工具或向用户说明工具实现异常。");
    }
    return { ok: true };
  }

  validateResult(result: ToolResult): ToolValidationResult {
    const parsed = ToolResultSchema.safeParse(result);
    if (!parsed.success) {
      return failure("TOOL_RESULT_INVALID", "工具结果不符合 ToolResult", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "检查 ToolResultNormalizer 或 handler 返回值。");
    }
    return { ok: true };
  }
}

function failure(
  code: string,
  message: string,
  issues: ValidationIssue[],
  nextStep: string,
): ToolValidationResult {
  return { ok: false, failure: { code, message, issues, nextStep } };
}
