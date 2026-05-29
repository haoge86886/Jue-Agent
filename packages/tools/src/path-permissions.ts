import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ToolCall } from "@jue/shared-types";
import { ToolExecutionError } from "./tool-errors.js";

export type PathOperation = "read" | "write" | "execute" | "search" | "list";

export interface PathPermissionRequest {
  toolName: string;
  requestedPath: string;
  resolvedPath: string;
  suggestedRoot: string;
  operation: PathOperation;
}

export interface PathPermissionDecision {
  approved: boolean;
  root?: string;
  persist?: boolean;
  instruction?: string;
}

export type PathPermissionProvider = (
  request: PathPermissionRequest,
  call: ToolCall,
) => Promise<PathPermissionDecision> | PathPermissionDecision;

export class PathPermissionStore {
  private readonly roots = new Set<string>();

  constructor(initialRoots: string[] = []) {
    for (const root of initialRoots) this.addRoot(root);
  }

  addRoot(root: string): string {
    const normalized = resolvePath(root);
    this.roots.add(normalized);
    return normalized;
  }

  removeRoot(root: string): void {
    this.roots.delete(resolvePath(root));
  }

  listRoots(): string[] {
    return [...this.roots.values()];
  }

  isAllowed(path: string): boolean {
    const abs = resolvePath(path);
    return this.listRoots().some((root) => isWithinRoot(abs, root));
  }
}

export function resolveAllowedPath(options: {
  workspaceRoot: string;
  requestedPath: string;
  operation: PathOperation;
  permissions?: PathPermissionStore;
  suggestedRootKind?: "path" | "parent";
}): string {
  const workspaceRoot = resolvePath(options.workspaceRoot);
  const permissions = options.permissions ?? new PathPermissionStore([workspaceRoot]);
  const abs = isAbsolute(options.requestedPath)
    ? resolvePath(options.requestedPath)
    : resolvePath(workspaceRoot, options.requestedPath);
  if (permissions.isAllowed(abs)) return abs;

  const suggestedRoot = options.suggestedRootKind === "path" ? abs : dirname(abs);
  throw new ToolExecutionError({
    code: "PATH_PERMISSION_REQUIRED",
    message: `需要用户授权访问 workspace 外路径: ${options.requestedPath}`,
    nextStep: "请求用户批准访问该路径；批准后会自动重试原工具调用。",
    details: {
      requestedPath: options.requestedPath,
      resolvedPath: abs,
      suggestedRoot,
      operation: options.operation,
    },
  });
}

export function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
