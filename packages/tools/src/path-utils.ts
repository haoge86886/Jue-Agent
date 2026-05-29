import { isAbsolute, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { ToolExecutionError } from "./tool-errors.js";
import { PathPermissionStore, resolveAllowedPath, type PathOperation } from "./path-permissions.js";

/**
 * 把用户传入路径解析到 workspaceRoot 内。文件读写类工具必须统一走这里，
 * 防止 ../、跨盘符绝对路径、符号边界判断不一致等问题。
 */
export function resolveWorkspacePath(workspaceRoot: string, reqPath: string): string {
  return resolveToolPath({ workspaceRoot, reqPath, operation: "read" });
}

export function resolveToolPath(options: {
  workspaceRoot: string;
  reqPath: string;
  operation: PathOperation;
  permissions?: PathPermissionStore;
  suggestedRootKind?: "path" | "parent";
}): string {
  return resolveAllowedPath({
    workspaceRoot: options.workspaceRoot,
    requestedPath: normalize(options.reqPath),
    operation: options.operation,
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.suggestedRootKind ? { suggestedRootKind: options.suggestedRootKind } : {}),
  });
}

function legacyResolveWorkspacePath(workspaceRoot: string, reqPath: string): string {
  const root = resolvePath(workspaceRoot);
  const normalized = normalize(reqPath);
  const abs = isAbsolute(normalized) ? normalized : resolvePath(root, normalized);
  const rel = relative(root, abs);
  const escapes = rel.startsWith("..") || rel.split(sep).some((seg) => seg === "..") || isAbsolute(rel);
  if (escapes) {
    throw new ToolExecutionError({
      code: "PATH_OUT_OF_WORKSPACE",
      message: `路径越出 workspace 边界: ${reqPath}`,
      nextStep: "改用 workspace 内的相对路径。",
    });
  }
  return abs;
}

export function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  const rel = relative(resolvePath(workspaceRoot), absPath);
  return rel === "" ? "." : rel;
}

export function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是非空字符串`,
      nextStep: "按工具 inputSchema 传入合法参数。",
    });
  }
  return value;
}

export function ensureOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是字符串`,
      nextStep: "按工具 inputSchema 传入合法参数。",
    });
  }
  return value;
}

export function ensureBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是布尔值`,
      nextStep: "按工具 inputSchema 传入 true 或 false。",
    });
  }
  return value;
}

export function ensureNonNegativeInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是非负整数`,
      nextStep: "按工具 inputSchema 传入合法整数。",
    });
  }
  return value;
}

export function ensurePositiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是正整数`,
      nextStep: "按工具 inputSchema 传入合法正整数。",
    });
  }
  return value;
}

export function ensureOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ToolExecutionError({
      code: "INVALID_ARGUMENT",
      message: `参数 ${field} 必须是正整数`,
      nextStep: "按工具 inputSchema 传入合法正整数。",
    });
  }
  return value;
}
