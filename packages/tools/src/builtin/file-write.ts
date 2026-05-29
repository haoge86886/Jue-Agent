import { promises as fs } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureBoolean, ensureString, resolveToolPath } from "../path-utils.js";

export const fileWriteToolSpec: ToolSpec = {
  name: "file.write",
  displayName: "写入文件",
  description: "在 workspace 内新建或覆盖写入文件。高风险写操作，执行前必须确认。",
  version: "0.1.0",
  kind: "builtin",
  category: "file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "workspace 内目标文件路径" },
      content: { type: "string", description: "要写入的完整文件内容" },
      overwrite: { type: "boolean", default: false, description: "目标存在时是否允许覆盖" },
      createDirs: { type: "boolean", default: true, description: "是否自动创建父目录" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "bytesWritten", "created", "overwritten"],
    properties: {
      path: { type: "string" },
      bytesWritten: { type: "integer" },
      created: { type: "boolean" },
      overwritten: { type: "boolean" },
    },
  },
  sideEffectLevel: "write",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "workspace",
  confirmation: { required: true, reason: "该工具会新建或覆盖本地文件", autoApproveScopes: [] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "filesystem", "write"],
  sensitivity: "internal",
};

export interface FileWriteHandlerOptions {
  workspaceRoot: string;
  pathPermissions?: PathPermissionStore;
}

export function createFileWriteHandler(options: FileWriteHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  return async (args): Promise<ToolHandlerResult> => {
    const reqPath = ensureString(args.path, "path");
    const content = ensureString(args.content, "content");
    const overwrite = ensureBoolean(args.overwrite, "overwrite", false);
    const createDirs = ensureBoolean(args.createDirs, "createDirs", true);
    const absolutePath = resolveToolPath({ workspaceRoot: root, reqPath, operation: "write", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}), suggestedRootKind: "parent" });
    const existed = await exists(absolutePath);
    if (existed && !overwrite) {
      throw new ToolExecutionError({
        code: "FILE_EXISTS",
        message: `目标文件已存在: ${reqPath}`,
        nextStep: "如果确实要覆盖，设置 overwrite=true；否则选择新路径。",
      });
    }
    if (createDirs) await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const bytesWritten = Buffer.byteLength(content, "utf8");
    return {
      output: { path: reqPath, bytesWritten, created: !existed, overwritten: existed },
      summary: `${existed ? "覆盖" : "新建"}文件 ${reqPath}，写入 ${bytesWritten} bytes`,
      tokenEstimate: 32,
    };
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
