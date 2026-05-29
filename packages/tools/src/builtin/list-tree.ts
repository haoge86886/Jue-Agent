import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureNonNegativeInt, ensurePositiveInt, ensureString, resolveToolPath, toWorkspaceRelative } from "../path-utils.js";

export const listTreeToolSpec: ToolSpec = {
  name: "fs.tree",
  displayName: "列出目录树",
  description: "列出 workspace 内目录树，默认限制深度和条目数，适合先了解项目结构。",
  version: "0.1.0",
  kind: "builtin",
  category: "file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", default: ".", description: "要列出的目录路径" },
      maxDepth: { type: "integer", minimum: 0, default: 3 },
      maxEntries: { type: "integer", minimum: 1, default: 200 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["root", "entries", "truncated"],
    properties: {
      root: { type: "string" },
      entries: { type: "array", items: { type: "object" } },
      truncated: { type: "boolean" },
    },
  },
  sideEffectLevel: "none",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "filesystem", "tree"],
  sensitivity: "internal",
};

export interface ListTreeHandlerOptions {
  workspaceRoot: string;
  pathPermissions?: PathPermissionStore;
}

export function createListTreeHandler(options: ListTreeHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const reqPath = typeof args.path === "string" ? ensureString(args.path, "path") : ".";
    const maxDepth = ensureNonNegativeInt(args.maxDepth, "maxDepth", 3);
    const maxEntries = ensurePositiveInt(args.maxEntries, "maxEntries", 200);
    const start = resolveToolPath({ workspaceRoot: root, reqPath, operation: "list", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "path" });
    const entries: Array<{ path: string; type: "file" | "directory"; depth: number; size?: number }> = [];
    let truncated = false;
    await walk(start, 0);
    return {
      output: { root: reqPath, entries, truncated },
      summary: `列出目录 ${reqPath}，${entries.length} 项${truncated ? "(截断)" : ""}`,
      truncated,
      tokenEstimate: Math.ceil(entries.length * 8),
    };

    async function walk(dir: string, depth: number): Promise<void> {
      if (truncated || depth > maxDepth) return;
      const children = await fs.readdir(dir, { withFileTypes: true });
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const abs = join(dir, child.name);
        if (child.isDirectory()) {
          entries.push({ path: toWorkspaceRelative(root, abs), type: "directory", depth });
          await walk(abs, depth + 1);
        } else if (child.isFile()) {
          const stat = await fs.stat(abs);
          entries.push({ path: toWorkspaceRelative(root, abs), type: "file", depth, size: stat.size });
        }
      }
    }
  };
}
