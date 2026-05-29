import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { EvalAgentRunResult, EvalCheck, EvalCheckResult } from "../types.js";

export function scoreChecks(input: { checks: readonly EvalCheck[]; workspacePath: string; run: EvalAgentRunResult }): EvalCheckResult[] {
  return input.checks.map((check) => scoreCheck(check, input.workspacePath, input.run));
}

function scoreCheck(check: EvalCheck, workspacePath: string, run: EvalAgentRunResult): EvalCheckResult {
  try {
    if (check.type === "file_exists") {
      const path = resolve(workspacePath, check.path);
      return result(check, existsSync(path), existsSync(path) ? "file exists" : `file missing: ${check.path}`);
    }
    if (check.type === "file_not_exists") {
      const path = resolve(workspacePath, check.path);
      return result(check, !existsSync(path), existsSync(path) ? `file exists: ${check.path}` : "file absent");
    }
    if (check.type === "file_contains" || check.type === "file_not_contains") {
      const path = resolve(workspacePath, check.path);
      const content = readFileSync(path, "utf8");
      const contains = content.includes(check.text);
      const passed = check.type === "file_contains" ? contains : !contains;
      return result(check, passed, passed ? "file content matched" : `file content mismatch: ${check.path}`);
    }
    if (check.type === "command") {
      const shell = process.platform === "win32" ? "powershell.exe" : "bash";
      const args = process.platform === "win32" ? ["-NoProfile", "-Command", check.command] : ["-lc", check.command];
      const proc = spawnSync(shell, args, { cwd: workspacePath, encoding: "utf8", timeout: check.timeoutMs ?? 30_000 });
      const expectedExitCode = check.expectedExitCode ?? 0;
      const passed = proc.status === expectedExitCode
        && (!check.stdoutContains || (proc.stdout ?? "").includes(check.stdoutContains))
        && (!check.stderrContains || (proc.stderr ?? "").includes(check.stderrContains));
      return result(check, passed, passed ? "command matched" : `command failed: ${check.command}`, {
        status: proc.status,
        stdout: truncate(proc.stdout ?? ""),
        stderr: truncate(proc.stderr ?? ""),
        error: proc.error?.message,
      });
    }
    if (check.type === "transcript_contains") {
      const text = run.events.map((event) => JSON.stringify(event)).join("\n");
      return result(check, text.includes(check.text), text.includes(check.text) ? "transcript matched" : "transcript text missing");
    }
    if (check.type === "tool_called") {
      const count = run.toolCalls.filter((tool) => tool.name === check.name).length;
      const minCount = check.minCount ?? (check.maxCount === undefined ? 1 : 0);
      const passed = count >= minCount && (check.maxCount === undefined || count <= check.maxCount);
      return result(check, passed, passed ? "tool call count matched" : `tool ${check.name} called ${count} times`, {
        count,
        minCount,
        maxCount: check.maxCount,
      });
    }
    if (check.type === "json_path_equals") {
      const value = readJsonPath({ run }, check.path);
      const passed = JSON.stringify(value) === JSON.stringify(check.value);
      return result(check, passed, passed ? "json path matched" : `json path mismatch: ${check.path}`, { value });
    }
    return result(check, false, "unknown check type");
  } catch (error) {
    return result(check, false, error instanceof Error ? error.message : String(error));
  }
}

function result(check: EvalCheck, passed: boolean, message: string, details?: Record<string, unknown>): EvalCheckResult {
  return { check, passed, message, ...(details ? { details } : {}) };
}

function readJsonPath(root: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current = root as Record<string, unknown> | unknown[] | undefined;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) current = current[Number(part)] as Record<string, unknown> | unknown[] | undefined;
    else if (typeof current === "object") current = (current as Record<string, unknown>)[part] as Record<string, unknown> | unknown[] | undefined;
    else return undefined;
  }
  return current;
}

function truncate(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
