import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { JsonSchemaLike, ToolSpec } from "@jue/shared-types";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensurePositiveInt, ensureString, resolveToolPath, toWorkspaceRelative } from "../path-utils.js";

export const fileSearchToolSpec: ToolSpec = {
  name: "fs.find",
  displayName: "搜索文件",
  description: "按文件名模式搜索 workspace 内文件。适合先定位文件，再读取或编辑。",
  version: "0.1.0",
  kind: "builtin",
  category: "search",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "文件名包含的片段或简单 * 通配模式" },
      path: { type: "string", default: "." },
      maxResults: { type: "integer", minimum: 1, default: 100 },
    },
  },
  outputSchema: searchOutputSchema(),
  sideEffectLevel: "none",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "filesystem", "search"],
  sensitivity: "internal",
};

export const textSearchToolSpec: ToolSpec = {
  name: "search.text",
  displayName: "精确文本搜索",
  description: "在 workspace 内按精确文本搜索文件内容，返回文件、行号和预览。",
  version: "0.1.0",
  kind: "builtin",
  category: "search",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "要搜索的精确文本" },
      path: { type: "string", default: "." },
      maxResults: { type: "integer", minimum: 1, default: 100 },
    },
  },
  outputSchema: searchOutputSchema(),
  sideEffectLevel: "none",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "filesystem", "grep"],
  sensitivity: "internal",
};

export interface SearchHandlerOptions {
  workspaceRoot: string;
  pathPermissions?: PathPermissionStore;
}

export function createFileSearchHandler(options: SearchHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const pattern = ensureString(args.pattern, "pattern");
    const reqPath = typeof args.path === "string" ? args.path : ".";
    const maxResults = ensurePositiveInt(args.maxResults, "maxResults", 100);
    const base = resolveToolPath({ workspaceRoot: root, reqPath, operation: "search", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "path" });
    const matcher = createNameMatcher(pattern);
    const matches: Array<{ path: string; type: "file" | "directory" }> = [];
    await walkFiles(base, async (abs, type) => {
      if (matches.length >= maxResults) return false;
      if (matcher(abs.split(/[\\/]/).at(-1) ?? "")) matches.push({ path: toWorkspaceRelative(root, abs), type });
      return matches.length < maxResults;
    });
    return {
      output: { query: pattern, matches, truncated: matches.length >= maxResults },
      summary: `文件搜索 ${pattern}，命中 ${matches.length} 项`,
      truncated: matches.length >= maxResults,
      tokenEstimate: matches.length * 12,
    };
  };
}

export function createTextSearchHandler(options: SearchHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const query = ensureString(args.query, "query");
    const reqPath = typeof args.path === "string" ? args.path : ".";
    const maxResults = ensurePositiveInt(args.maxResults, "maxResults", 100);
    const base = resolveToolPath({ workspaceRoot: root, reqPath, operation: "search", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "path" });
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    await walkFiles(base, async (abs, type) => {
      if (type !== "file" || matches.length >= maxResults) return matches.length < maxResults;
      const stat = await fs.stat(abs);
      if (stat.size > 1024 * 1024) return true;
      const content = await fs.readFile(abs, "utf8").catch(() => undefined);
      if (content === undefined) return true;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (line.includes(query)) {
          matches.push({ path: toWorkspaceRelative(root, abs), line: i + 1, preview: line.trim().slice(0, 240) });
          if (matches.length >= maxResults) return false;
        }
      }
      return true;
    });
    return {
      output: { query, matches, truncated: matches.length >= maxResults },
      summary: `文本搜索 ${query}，命中 ${matches.length} 处`,
      truncated: matches.length >= maxResults,
      tokenEstimate: matches.length * 24,
    };
  };
}

function searchOutputSchema(): JsonSchemaLike {
  return {
    type: "object",
    additionalProperties: true,
    required: ["query", "matches", "truncated"],
    properties: {
      query: { type: "string" },
      matches: { type: "array", items: { type: "object" } },
      truncated: { type: "boolean" },
    },
  };
}

async function walkFiles(
  base: string,
  visit: (abs: string, type: "file" | "directory") => Promise<boolean> | boolean,
): Promise<boolean> {
  const stat = await fs.stat(base);
  if (stat.isFile()) return visit(base, "file");
  if (!stat.isDirectory()) return true;
  if (!(await visit(base, "directory"))) return false;
  const children = await fs.readdir(base, { withFileTypes: true });
  for (const child of children) {
    if (shouldSkipDir(child.name)) continue;
    const abs = join(base, child.name);
    if (child.isDirectory()) {
      if (!(await walkFiles(abs, visit))) return false;
    } else if (child.isFile()) {
      if (!(await visit(abs, "file"))) return false;
    }
  }
  return true;
}

function createNameMatcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes("*")) return (name) => name.includes(pattern);
  const escaped = pattern.split("*").map(escapeRegExp).join(".*");
  const re = new RegExp(`^${escaped}$`, "i");
  return (name) => re.test(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".cache";
}
