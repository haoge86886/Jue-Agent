import { resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureOptionalString, ensureString, resolveToolPath } from "../path-utils.js";
import type { SandboxRunner } from "../sandbox.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";

export const shellRunToolSpec: ToolSpec = {
  name: "shell.run",
  displayName: "Run Command",
  description: "Run a short-lived local command in the sandbox. Use for tests, typecheck, build, lint, git queries, package manager queries, and one-shot verification. Use monitor.start for long-running or streaming tasks.",
  version: "0.1.0",
  kind: "builtin",
  category: "shell",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", description: "Executable or shell builtin to run, such as git, pnpm, node, cmd, powershell.exe, dir, set, echo." },
      args: { type: "array", items: { type: "string" }, default: [] },
      cwd: { type: "string", default: "." },
      timeoutMs: { type: "integer", minimum: 1, default: 30000 },
      waitMs: { type: "integer", minimum: 0, default: 0, description: "Extra milliseconds to wait after command exit for short async output or file flush." },
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
  confirmation: { required: true, reason: "Commands can read/write local files, start processes, or access external systems.", autoApproveScopes: [] },
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
              message: `${result.stderr || result.stdout || `command exited with code ${result.exitCode}`}
Next step: ${result.timedOut ? "If this is a long-running service, use monitor.start; otherwise narrow the command scope or increase timeoutMs before retrying." : "Read stdout/stderr, fix the command, args, cwd, or code, then verify again. Do not repeat the same failing command mechanically."}`,
              retriable: result.timedOut,
            },
          }
        : {}),
    };
  };
}
