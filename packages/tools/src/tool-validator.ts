import type { JsonSchemaLike } from "@jue/shared-types";
import { ToolCallSchema, ToolResultSchema, ToolSpecSchema, type ToolCall, type ToolResult, type ToolSpec } from "@jue/shared-types";
import { JsonSchemaValidator, type ValidationIssue } from "./json-schema-validator.js";

export interface ToolValidationFailure {
  code: string;
  message: string;
  issues: ValidationIssue[];
  nextStep: string;
  details?: Record<string, unknown>;
}

export type ToolValidationResult =
  | { ok: true }
  | { ok: false; failure: ToolValidationFailure };

export class ToolValidator {
  private readonly schemaValidator: JsonSchemaValidator;

  constructor(schemaValidator: JsonSchemaValidator = new JsonSchemaValidator()) {
    this.schemaValidator = schemaValidator;
  }

  validateSpec(spec: ToolSpec): ToolValidationResult {
    const parsed = ToolSpecSchema.safeParse(spec);
    if (!parsed.success) {
      return failure("TOOL_SPEC_INVALID", "ToolSpec is invalid", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "Fix the tool definition before registering it.");
    }
    return { ok: true };
  }

  validateCall(call: ToolCall): ToolValidationResult {
    const parsed = ToolCallSchema.safeParse(call);
    if (!parsed.success) {
      return failure("TOOL_CALL_INVALID", "ToolCall object is invalid", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "Regenerate a valid tool call object.", { receivedKeys: Object.keys(call as Record<string, unknown>) });
    }
    return { ok: true };
  }

  validateInput(spec: ToolSpec, args: Record<string, unknown>): ToolValidationResult {
    const result = this.schemaValidator.validate(args, spec.inputSchema, "$");
    if (!result.ok) {
      const details = schemaFailureDetails(spec.inputSchema, args, result.issues);
      return failure(
        "TOOL_INPUT_INVALID",
        `Tool ${spec.name} input is invalid: ${formatIssues(result.issues)}`,
        result.issues,
        `Fix the tool arguments, not the target file content. Required args: ${details.requiredKeys.join(", ") || "none"}. Received args: ${details.receivedKeys.join(", ") || "none"}.`,
        details,
      );
    }
    return { ok: true };
  }

  validateOutput(spec: ToolSpec, output: unknown): ToolValidationResult {
    const result = this.schemaValidator.validate(output, spec.outputSchema, "$");
    if (!result.ok) {
      return failure("TOOL_OUTPUT_INVALID", `Tool ${spec.name} output does not match outputSchema: ${formatIssues(result.issues)}`, result.issues, "Do not rely on this malformed tool result; try another tool or report the tool implementation issue.");
    }
    return { ok: true };
  }

  validateResult(result: ToolResult): ToolValidationResult {
    const parsed = ToolResultSchema.safeParse(result);
    if (!parsed.success) {
      return failure("TOOL_RESULT_INVALID", "ToolResult object is invalid", parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })), "Check ToolResultNormalizer or handler return value.");
    }
    return { ok: true };
  }
}

function failure(
  code: string,
  message: string,
  issues: ValidationIssue[],
  nextStep: string,
  details?: Record<string, unknown>,
): ToolValidationResult {
  return { ok: false, failure: { code, message, issues, nextStep, ...(details ? { details } : {}) } };
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

interface SchemaFailureDetails extends Record<string, unknown> {
  issues: ValidationIssue[];
  requiredKeys: string[];
  allowedKeys: string[];
  receivedKeys: string[];
  missingKeys: string[];
  unexpectedKeys: string[];
}

function schemaFailureDetails(schema: JsonSchemaLike, args: Record<string, unknown>, issues: ValidationIssue[]): SchemaFailureDetails {
  const objectSchema = typeof schema === "object" && schema !== null && !Array.isArray(schema) ? schema : undefined;
  const requiredKeys = Array.isArray(objectSchema?.required) ? objectSchema.required : [];
  const allowedKeys = objectSchema?.properties && typeof objectSchema.properties === "object" ? Object.keys(objectSchema.properties) : [];
  const receivedKeys = Object.keys(args);
  return {
    issues,
    requiredKeys,
    allowedKeys,
    receivedKeys,
    missingKeys: requiredKeys.filter((key) => !(key in args)),
    unexpectedKeys: allowedKeys.length > 0 ? receivedKeys.filter((key) => !allowedKeys.includes(key)) : [],
  };
}
