import { resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureOptionalString, ensureString, resolveToolPath } from "../path-utils.js";
import type { SandboxRunner } from "../sandbox.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";

export const shellRunToolSpec: ToolSpec = {
  name: "shell.run",
  displayName: "执行命令",
  description: "在沙箱中执行短生命周期本地命令。用于测试、类型检查、构建、git 查询和一次性验证；长时间运行任务请使用 monitor.start。",
  version: "0.1.0",
  kind: "builtin",
  category: "shell",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", description: "要执行的可执行文件，如 git、npm、pnpm、node、powershell.exe" },
      args: { type: "array", items: { type: "string" }, default: [] },
      cwd: { type: "string", default: "." },
      timeoutMs: { type: "integer", minimum: 1, default: 30000 },
      waitMs: { type: "integer", minimum: 0, default: 0, description: "命令结束后额外等待的毫秒数，用于等待短暂异步输出或文件落盘。" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["exitCode", "stdout", "stderr", "timedOut"],
    properties: {
      exitCode: { type: ["integer", "null"] },
      stdout: { type: "string" },
      stderr: { type: "string" },
      timedOut: { type: "boolean" },
    },
  },
  sideEffectLevel: "external",
  timeoutMs: 30_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "workspace",
  confirmation: { required: true, reason: "命令可能读写本地文件、启动进程或访问外部系统。", autoApproveScopes: [] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "shell", "sandbox"],
  sensitivity: "internal",
};

export interface ShellRunHandlerOptions {
  workspaceRoot: string;
  sandbox: SandboxRunner;
  pathPermissions?: PathPermissionStore;
}

export function createShellRunHandler(options: ShellRunHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const command = ensureString(args.command, "command");
    const rawArgs = Array.isArray(args.args) ? args.args.map((item) => ensureString(item, "args[]")) : [];
    const cwdRaw = ensureOptionalString(args.cwd, "cwd") ?? ".";
    const cwd = resolveToolPath({ workspaceRoot: root, reqPath: cwdRaw, operation: "execute", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "path" });
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
    const waitMs = typeof args.waitMs === "number" && Number.isInteger(args.waitMs) && args.waitMs >= 0 ? Math.min(args.waitMs, 30_000) : 0;
    const result = await options.sandbox.run({ command, args: rawArgs, cwd, timeoutMs, waitMs });
    const failed = result.timedOut || (result.exitCode !== 0 && result.exitCode !== null);
    return {
      output: result,
      summary: `命令 ${command} 退出码 ${result.exitCode}${result.timedOut ? "（超时）" : ""}`,
      tokenEstimate: Math.ceil((result.stdout.length + result.stderr.length) / 4),
      truncated: false,
      ...(failed
        ? {
            failure: {
              code: result.timedOut ? "COMMAND_TIMEOUT" : "COMMAND_FAILED",
              message: `${result.stderr || result.stdout || `命令退出码 ${result.exitCode}`}\n下一步: ${result.timedOut
                ? "如果这是长时间运行服务，改用 monitor.start；否则缩小命令范围或提高 timeoutMs 后重试。"
                : "阅读 stdout/stderr，修正命令、参数、cwd 或代码后再运行验证；不要机械重复同一个失败命令。"}`,
              retriable: result.timedOut,
            },
          }
        : {}),
    };
  };
}
