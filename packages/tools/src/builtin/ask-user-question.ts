import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureString } from "../path-utils.js";

export interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserQuestionRequest {
  reason: string;
  question: string;
  options: AskUserQuestionOption[];
  allowFreeform: boolean;
  metadata?: Record<string, unknown>;
}

export interface AskUserQuestionResponse {
  selectedOptionId?: string;
  freeform?: string;
  approved: boolean;
  approveSimilarFutureRequests: boolean;
  instruction?: string;
  metadata?: Record<string, unknown>;
}

export interface AskUserQuestionContext {
  signal?: AbortSignal;
}

export type AskUserQuestionProvider = (
  request: AskUserQuestionRequest,
  context?: AskUserQuestionContext,
) => Promise<AskUserQuestionResponse> | AskUserQuestionResponse;

export const askUserQuestionToolSpec: ToolSpec = {
  name: "ask_user_question",
  displayName: "Ask User Question",
  description: "Use this tool whenever the task goal, path scope, permission, safety risk, destructive operation, or mutually exclusive choice is unclear. This is a hard workflow rule: if user confirmation is needed, call ask_user_question first; do not replace it with a normal natural-language reply asking the user to answer yes/no.",
  version: "0.1.0",
  kind: "builtin",
  category: "system",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reason", "question"],
    properties: {
      reason: { type: "string", description: "Why user input is required, such as ambiguous path, destructive action, long-term approval, permission issue, or mutually exclusive choices." },
      question: { type: "string", description: "The exact question shown to the user. It must be specific enough for the user to choose an action." },
      options: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      allowFreeform: { type: "boolean", default: true },
      metadata: { type: "object", additionalProperties: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["approved", "approveSimilarFutureRequests"],
    properties: {
      selectedOptionId: { type: "string" },
      freeform: { type: "string" },
      approved: { type: "boolean" },
      approveSimilarFutureRequests: { type: "boolean" },
      instruction: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
    },
  },
  sideEffectLevel: "none",
  timeoutMs: 120_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "user-interaction", "confirmation", "clarification"],
  sensitivity: "internal",
};

export interface AskUserQuestionHandlerOptions {
  provider?: AskUserQuestionProvider;
}

export function createAskUserQuestionHandler(options: AskUserQuestionHandlerOptions = {}): ToolHandler {
  return async (args, ctx): Promise<ToolHandlerResult> => {
    const request: AskUserQuestionRequest = {
      reason: ensureString(args.reason, "reason"),
      question: ensureString(args.question, "question"),
      options: parseOptions(args.options),
      allowFreeform: typeof args.allowFreeform === "boolean" ? args.allowFreeform : true,
      ...(isRecord(args.metadata) ? { metadata: args.metadata } : {}),
    };
    if (!options.provider) {
      throw new ToolExecutionError({
        code: "ASK_USER_PROVIDER_MISSING",
        message: "The current frontend/runtime has no user confirmation provider, so the agent cannot wait for a structured user choice.",
        nextStep: "Do not execute the operation that requires confirmation. Explain the question to the user in the final response and wait for the next user turn.",
        details: { request },
      });
    }
    const output = await options.provider(request, ctx.signal ? { signal: ctx.signal } : undefined);
    return {
      output,
      summary: `User confirmation result: ${output.approved ? "approved" : "rejected"}${output.approveSimilarFutureRequests ? ", future similar approved" : ""}`,
      tokenEstimate: 64,
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptions(value: unknown): AskUserQuestionOption[] {
  const fallback: AskUserQuestionOption[] = [
    { id: "approve_once", label: "Approve once" },
    { id: "approve_future", label: "Approve future similar requests" },
    { id: "reject", label: "Reject and provide instruction" },
  ];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) {
    throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: "options must be an array", nextStep: "Pass 2 to 3 structured options, or omit options to use the defaults." });
  }
  const parsed = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: `options[${index}] must be an object`, nextStep: "Each option must include id and label." });
    }
    const option: AskUserQuestionOption = {
      id: ensureString(item.id, `options[${index}].id`),
      label: ensureString(item.label, `options[${index}].label`),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    };
    return option;
  });
  if (parsed.length === 0) return fallback;
  return parsed;
}
