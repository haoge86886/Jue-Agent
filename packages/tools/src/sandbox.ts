import { spawn } from "node:child_process";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { ToolExecutionError } from "./tool-errors.js";
import { PathPermissionStore } from "./path-permissions.js";

export interface SandboxCommand {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  waitMs?: number;
  env?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxRunner {
  run(command: SandboxCommand): Promise<SandboxResult>;
}

export interface SimpleSandboxOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  pathPermissions?: PathPermissionStore;
  blockedPatterns?: string[];
  allowedCommands?: string[];
}

/**
 * Windows ??? SimpleSandbox?
 *
 * ??????????????????????? cwd ????????
 * ?? Linux/macOS ? sandbox-runtime ??????? SandboxRunner ???????
 */
export class SimpleSandbox implements SandboxRunner {
  private readonly allowedRoots: string[];
  private readonly pathPermissions: PathPermissionStore | undefined;
  private readonly blockedPatterns: RegExp[];
  private readonly allowedCommands: string[];

  constructor(options: SimpleSandboxOptions) {
    this.allowedRoots = [options.workspaceRoot, ...(options.allowedRoots ?? [])].map((item) => resolvePath(item));
    this.pathPermissions = options.pathPermissions;
    this.blockedPatterns = (options.blockedPatterns ?? []).map((item) => new RegExp(item, "i"));
    this.allowedCommands = options.allowedCommands ?? [];
  }

  async run(input: SandboxCommand): Promise<SandboxResult> {
    const cwd = resolvePath(input.cwd ?? this.allowedRoots[0] ?? process.cwd());
    if (!isWithinAllowedRoots(cwd, this.currentAllowedRoots())) {
      throw new ToolExecutionError({
        code: "SANDBOX_CWD_DENIED",
        message: `?? cwd ???????: ${cwd}`,
        nextStep: "? cwd ?? workspace ???????",
      });
    }
    if (this.allowedCommands.length > 0 && !this.allowedCommands.includes(input.command)) {
      throw new ToolExecutionError({
        code: "SANDBOX_COMMAND_NOT_ALLOWED",
        message: `????????: ${input.command}`,
        nextStep: "????????????????????",
      });
    }
    const full = [input.command, ...(input.args ?? [])].join(" ");
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(full)) {
        throw new ToolExecutionError({
          code: "SANDBOX_BLOCKED_PATTERN",
          message: `??????????: ${pattern.source}`,
          nextStep: "??????????????????????",
        });
      }
    }
    return runChildProcess({ ...input, cwd });
  }

  private currentAllowedRoots(): string[] {
    return [...this.allowedRoots, ...(this.pathPermissions?.listRoots() ?? [])];
  }
}

export class UnsupportedSandbox implements SandboxRunner {
  async run(): Promise<SandboxResult> {
    throw new ToolExecutionError({
      code: "SANDBOX_NOT_IMPLEMENTED",
      message: "??????? runner ????",
      nextStep: "? Windows ?? SimpleSandbox?Linux/macOS ???? sandbox-runtime?",
    });
  }
}

function runChildProcess(input: SandboxCommand): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const command = normalizeCommandForPlatform(input);
    const child = spawn(command.command, command.args ?? [], {
      cwd: command.cwd,
      env: { ...process.env, ...(command.env ?? {}) },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, command.timeoutMs ?? 30_000);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const waitMs = Math.max(0, command.waitMs ?? 0);
      if (waitMs > 0) {
        setTimeout(() => resolve({ exitCode, stdout, stderr, timedOut }), waitMs);
        return;
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

const WINDOWS_CMD_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "tsx", "tsc", "vitest", "eslint", "prettier"]);

function normalizeCommandForPlatform(input: SandboxCommand): SandboxCommand {
  if (process.platform !== "win32") return input;
  const commandName = basename(input.command).toLowerCase();
  const usesCmdShim = WINDOWS_CMD_SHIMS.has(commandName) || commandName.endsWith(".cmd") || commandName.endsWith(".bat");
  if (!usesCmdShim) return input;
  return {
    ...input,
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", [input.command, ...(input.args ?? [])].map(quoteForCmd).join(" ")],
  };
}

function quoteForCmd(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  const escaped = value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/&/g, "^&")
    .replace(/\|/g, "^|")
    .replace(/</g, "^<")
    .replace(/>/g, "^>")
    .replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function isWithinAllowedRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
