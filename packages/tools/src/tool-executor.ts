/**
 * @file tool-executor.ts
 * @module @jue/tools/tool-executor
 *
 * 工具执行器接口 + 默认实现(`DefaultToolExecutor`)。
 *
 * 职责拆分(对应 design.md §9):
 *   - **ToolSpec**     : 声明式协议(name / inputSchema / outputSchema / 安全策略 ...),给模型看
 *   - **ToolHandler**  : 实际执行函数,给执行器调
 *   - **ToolRegistry** : 注册 ToolSpec(供 prompt/模型 tools 字段使用)
 *   - **ToolExecutor** : 接到 ToolCall 后,根据 toolName 找到对应 handler 调用
 *
 * 当前实现:
 *   1. 校验 ToolCall、inputSchema、outputSchema
 *   2. 执行权限/确认策略，未确认的高风险工具默认拒绝
 *   3. 统一处理超时、重试、异常映射和结果标准化
 *   4. 每个失败结果都给出 nextStep，方便模型调整下一步
 */

import type { ToolCall, ToolResult } from "@jue/shared-types";
import { errorInfoFromUnknown } from "./tool-errors.js";
import { PathPermissionStore, type PathPermissionProvider } from "./path-permissions.js";
import { isToolAllowedInPlanMode, type PlanModeStore } from "./plan-mode.js";
import { ToolPolicyGuard, type ToolPermissionProvider } from "./tool-policy.js";
import type { ToolRegistry } from "./tool-registry.js";
import { ToolResultNormalizer } from "./tool-result-normalizer.js";
import { ToolValidator } from "./tool-validator.js";

/**
 * 工具执行器接口。
 */
export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

/**
 * 工具具体执行函数。返回轻量的"业务结果",外层会包成 {@link ToolResult}。
 *
 * - 返回值会被序列化进 ToolResult.output
 * - 抛异常 → 被捕获并映射为 `failed` 状态;`error.code` 若为字符串属性会被透传
 * - `summary` 用于给 LLM 看的简短摘要;不返回时 executor 自动用 output 截断
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export interface ToolHandlerContext {
  /** 当前 call 的元信息,handler 通常只需要 sessionId / requestId */
  call: ToolCall;
  /** 外层统一传入 AbortSignal，handler 应在长任务中主动检查。 */
  signal?: AbortSignal;
}

export interface ToolHandlerResult {
  output: unknown;
  /** 给 LLM 看的简短摘要(可选) */
  summary?: string;
  /** 大输出可标 truncated;Engine 把 output 截断后塞进 tool 消息时用得到 */
  truncated?: boolean;
  tokenEstimate?: number;
  /** 自定义业务码,handler 主动报"非异常型失败"时可用 */
  failure?: { code: string; message: string; retriable?: boolean };
}

/**
 * 默认执行器:从 handler 表里查 → 跑 → 包结果。
 */
export class DefaultToolExecutor implements ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly handlers: Map<string, ToolHandler>;
  private readonly validator: ToolValidator;
  private readonly normalizer: ToolResultNormalizer;
  private readonly policyGuard: ToolPolicyGuard;
  private readonly pathPermissions: PathPermissionStore | undefined;
  private readonly pathPermissionProvider: PathPermissionProvider | undefined;
  private readonly planModeStore: PlanModeStore | undefined;
  private readonly requestToolHistory = new Map<string, Set<string>>();

  constructor(options: {
    registry: ToolRegistry;
    handlers: Map<string, ToolHandler>;
    validator?: ToolValidator;
    normalizer?: ToolResultNormalizer;
    permissionProvider?: ToolPermissionProvider;
    pathPermissions?: PathPermissionStore;
    pathPermissionProvider?: PathPermissionProvider;
    planModeStore?: PlanModeStore;
    allowHighRiskWithoutProvider?: boolean;
  }) {
    this.registry = options.registry;
    this.handlers = options.handlers;
    this.validator = options.validator ?? new ToolValidator();
    this.normalizer = options.normalizer ?? new ToolResultNormalizer();
    this.policyGuard = new ToolPolicyGuard({
      ...(options.permissionProvider ? { permissionProvider: options.permissionProvider } : {}),
      allowHighRiskWithoutProvider: options.allowHighRiskWithoutProvider ?? false,
    });
    this.pathPermissions = options.pathPermissions;
    this.pathPermissionProvider = options.pathPermissionProvider;
    this.planModeStore = options.planModeStore;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    const callValidation = this.validator.validateCall(call);
    if (!callValidation.ok) return this.normalizer.validationRejected(call, startedAt, callValidation.failure);

    const reg = this.registry.get(call.toolName);
    if (!reg) {
      return this.normalizer.rejected(call, startedAt, "TOOL_NOT_REGISTERED", `工具 ${call.toolName} 未注册`, "先读取可用工具列表，选择已注册工具。");
    }
    if (!reg.enabled) {
      return this.normalizer.rejected(
        call,
        startedAt,
        "TOOL_DISABLED",
        reg.unavailableReason ?? `工具 ${call.toolName} 当前不可用`,
        "换用其他可用工具，或让用户修复该工具配置。",
      );
    }
    const workflowGuard = this.checkWorkflowGuard(call, startedAt);
    if (workflowGuard) return workflowGuard;
    const inputValidation = this.validator.validateInput(reg.spec, call.arguments);
    if (!inputValidation.ok) return this.normalizer.validationRejected(call, startedAt, inputValidation.failure);

    const planMode = this.planModeStore?.get();
    if (planMode?.active && !isToolAllowedInPlanMode(reg.spec)) {
      return this.normalizer.rejected(
        call,
        startedAt,
        "PLAN_MODE_READONLY",
        `当前处于计划模式，工具 ${call.toolName} 不允许执行。`,
        "继续使用 file.read、fs.tree、fs.find、search.text 等只读工具探索；写好计划后调用 plan.exit，再用 todo.create 创建待办。",
      );
    }

    const permission = await this.policyGuard.check(reg.spec, call);
    if (!permission.allowed) {
      return this.normalizer.rejected(
        call,
        startedAt,
        permission.code ?? "TOOL_PERMISSION_DENIED",
        permission.message ?? `工具 ${call.toolName} 被权限策略拒绝`,
        permission.nextStep ?? "请求用户确认后重试。",
      );
    }

    const handler = this.handlers.get(call.toolName);
    if (!handler) {
      return this.normalizer.rejected(
        call,
        startedAt,
        "TOOL_HANDLER_MISSING",
        `工具 ${call.toolName} 已注册但缺少 handler 实现`,
        "不要继续调用该工具；向用户报告工具实现缺失。",
      );
    }

    const timeoutMs = call.timeoutMs ?? reg.spec.timeoutMs;
    const maxRetries = reg.spec.retryPolicy?.maxRetries ?? 0;
    let attempt = 0;
    let lastResult: ToolResult | undefined;
    while (attempt <= maxRetries) {
      lastResult = await this.executeOnce({ call, handler, startedAt, timeoutMs });
      if (lastResult.error?.code === "PATH_PERMISSION_REQUIRED") {
        const granted = await this.requestPathPermission(call, lastResult);
        if (granted) {
          lastResult = await this.executeOnce({ call, handler, startedAt, timeoutMs });
        }
      }
      if (lastResult.status === "succeeded") return lastResult;
      const code = lastResult.error?.code;
      const retryAllowed = Boolean(lastResult.error?.retriable && code && reg.spec.retryPolicy?.retryOn.includes(code));
      if (!retryAllowed || attempt >= maxRetries) return lastResult;
      await delay(computeBackoffMs(reg.spec.retryPolicy?.backoffMs ?? 0, reg.spec.retryPolicy?.backoffStrategy ?? "fixed", attempt));
      attempt += 1;
    }
    return lastResult ?? this.normalizer.failed(call, startedAt, { code: "TOOL_FAILED", message: "工具执行失败", retriable: false });
  }

  private checkWorkflowGuard(call: ToolCall, startedAt: number): ToolResult | undefined {
    const history = this.historyForRequest(call.requestId);
    if (call.toolName === "search.text") {
      history.add(call.toolName);
      return undefined;
    }
    if (call.toolName !== "file.read") {
      history.add(call.toolName);
      return undefined;
    }
    const path = typeof call.arguments.path === "string" ? call.arguments.path : "";
    if (!requiresSearchBeforeRead(path) || history.has("search.text")) {
      history.add(call.toolName);
      return undefined;
    }
    return this.normalizer.failed(call, startedAt, {
      code: "WORKFLOW_SEARCH_REQUIRED",
      message: `Reading log-like file '${path}' before searching would skip the production investigation flow.`,
      retriable: true,
      details: {
        nextStep: "Call search.text first with a concrete error keyword or log signature, then read the matching file/lines.",
        requiredTool: "search.text",
        path,
      },
    });
  }

  private historyForRequest(requestId: string): Set<string> {
    let history = this.requestToolHistory.get(requestId);
    if (!history) {
      history = new Set<string>();
      this.requestToolHistory.set(requestId, history);
    }
    return history;
  }

  private async executeOnce(options: { call: ToolCall; handler: ToolHandler; startedAt: number; timeoutMs: number }): Promise<ToolResult> {
    const { call, handler, startedAt, timeoutMs } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await Promise.race([
        handler(call.arguments, { call, signal: controller.signal }),
        new Promise<ToolHandlerResult>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("TOOL_TIMEOUT")), { once: true });
        }),
      ]);
      if (r.failure) {
        return this.normalizer.failedFromHandlerFailure(call, startedAt, r);
      }
      const reg = this.registry.get(call.toolName);
      if (reg) {
        const outputValidation = this.validator.validateOutput(reg.spec, r.output);
        if (!outputValidation.ok) return this.normalizer.validationRejected(call, startedAt, outputValidation.failure);
      }
      return this.normalizer.succeeded(call, startedAt, r);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.message === "TOOL_TIMEOUT")) {
        return this.normalizer.timeout(call, startedAt, timeoutMs);
      }
      const error = errorInfoFromUnknown(err);
      return this.normalizer.failed(call, startedAt, {
        code: error.code,
        message: error.message,
        retriable: error.retriable,
        details: { ...(error.details ?? {}), nextStep: error.details?.nextStep ?? "根据错误信息修正参数，或换用其他工具。" },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestPathPermission(call: ToolCall, result: ToolResult): Promise<boolean> {
    if (!this.pathPermissionProvider || !this.pathPermissions) return false;
    const details = result.error?.details;
    if (!isRecord(details)) return false;
    const requestedPath = typeof details.requestedPath === "string" ? details.requestedPath : undefined;
    const resolvedPath = typeof details.resolvedPath === "string" ? details.resolvedPath : undefined;
    const suggestedRoot = typeof details.suggestedRoot === "string" ? details.suggestedRoot : resolvedPath;
    const operation = typeof details.operation === "string" ? details.operation : "read";
    if (!requestedPath || !resolvedPath || !suggestedRoot) return false;
    const decision = await this.pathPermissionProvider({
      toolName: call.toolName,
      requestedPath,
      resolvedPath,
      suggestedRoot,
      operation: normalizePathOperation(operation),
    }, call);
    if (!decision.approved) return false;
    this.pathPermissions.addRoot(decision.root ?? suggestedRoot);
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresSearchBeforeRead(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(".log") || normalized.endsWith(".trace") || normalized.endsWith(".out")) return true;
  return normalized.includes("/log/") || normalized.includes("/logs/") || normalized.startsWith("log/") || normalized.startsWith("logs/");
}

function normalizePathOperation(value: string) {
  if (value === "read" || value === "write" || value === "execute" || value === "search" || value === "list") return value;
  return "read";
}

/**
 * Noop 执行器(向后兼容)。Engine 在没有 ToolExecutor 注入时用它兜底。
 */
export class NoopToolExecutor implements ToolExecutor {
  async execute(call: ToolCall): Promise<ToolResult> {
    return new ToolResultNormalizer().rejected(
      call,
      Date.now(),
      "TOOL_EXECUTOR_NOT_IMPLEMENTED",
      "ToolExecutor 未注入,工具调用被拒绝",
      "检查 runtime 是否正确注入 DefaultToolExecutor。",
    );
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(base: number, strategy: "fixed" | "linear" | "exponential", attempt: number): number {
  if (strategy === "linear") return base * (attempt + 1);
  if (strategy === "exponential") return base * (2 ** attempt);
  return base;
}
