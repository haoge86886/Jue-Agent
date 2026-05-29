import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureString, resolveToolPath } from "../path-utils.js";

export const fileEditToolSpec: ToolSpec = {
  name: "file.edit",
  displayName: "精确编辑文件",
  description: "只替换 workspace 内文件中的指定片段。必须提供唯一 oldText，避免模糊修改。",
  version: "0.1.0",
  kind: "builtin",
  category: "file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "oldText", "newText"],
    properties: {
      path: { type: "string", description: "workspace 内目标文件路径" },
      oldText: { type: "string", description: "要被替换的精确原文，必须唯一" },
      newText: { type: "string", description: "替换后的文本" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "replacements", "bytesWritten"],
    properties: {
      path: { type: "string" },
      replacements: { type: "integer" },
      bytesWritten: { type: "integer" },
    },
  },
  sideEffectLevel: "write",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "workspace",
  confirmation: { required: true, reason: "该工具会修改本地文件片段", autoApproveScopes: [] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "filesystem", "edit"],
  sensitivity: "internal",
};

export interface FileEditHandlerOptions {
  workspaceRoot: string;
  pathPermissions?: PathPermissionStore;
}

export function createFileEditHandler(options: FileEditHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const reqPath = ensureString(args.path, "path");
    const oldText = ensureString(args.oldText, "oldText");
    const newText = ensureString(args.newText, "newText");
    const absolutePath = resolveToolPath({ workspaceRoot: root, reqPath, operation: "write", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "parent" });
    const original = await fs.readFile(absolutePath, "utf8");
    const matches = countOccurrences(original, oldText);
    if (matches === 0) {
      throw new ToolExecutionError({
        code: "EDIT_TARGET_NOT_FOUND",
        message: `未在 ${reqPath} 中找到 oldText`,
        nextStep: "先用 file.read 或 search.text 精确确认原文后再编辑。",
      });
    }
    if (matches > 1) {
      throw new ToolExecutionError({
        code: "EDIT_TARGET_NOT_UNIQUE",
        message: `oldText 在 ${reqPath} 中出现 ${matches} 次`,
        nextStep: "扩大 oldText 上下文，使目标片段唯一。",
      });
    }
    const updated = original.replace(oldText, newText);
    await fs.writeFile(absolutePath, updated, "utf8");
    const bytesWritten = Buffer.byteLength(updated, "utf8");
    return {
      output: { path: reqPath, replacements: 1, bytesWritten },
      summary: `编辑 ${reqPath}，替换 1 处文本`,
      tokenEstimate: 32,
    };
  };
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
