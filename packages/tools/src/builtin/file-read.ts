import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureNonNegativeInt, ensureOptionalPositiveInt, ensureOptionalString, ensureString, resolveToolPath } from "../path-utils.js";

export const fileReadToolSpec: ToolSpec = {
  name: "file.read",
  displayName: "Read File",
  description:
    "Read a local file inside the workspace. Supports byte ranges with offset/length and line ranges with line/lineCount. When search.text returns a line number, prefer line + lineCount instead of guessing byte offsets.",
  version: "0.1.0",
  kind: "builtin",
  category: "file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8", description: "Return encoding. Use base64 for binary files." },
      offset: { type: "integer", minimum: 0, default: 0, description: "Byte offset. Ignored when line is provided." },
      length: { type: "integer", minimum: 1, description: "Bytes to read. Ignored when line is provided." },
      line: { type: "integer", minimum: 1, description: "1-based starting line number. Use this with search.text results." },
      lineCount: { type: "integer", minimum: 1, default: 80, description: "Number of lines to read when line is provided." },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "encoding", "size", "truncated", "content"],
    properties: {
      path: { type: "string" },
      encoding: { type: "string", enum: ["utf-8", "base64"] },
      size: { type: "integer" },
      bytesRead: { type: "integer" },
      offset: { type: "integer" },
      line: { type: "integer" },
      lineCount: { type: "integer" },
      totalLines: { type: "integer" },
      truncated: { type: "boolean" },
      content: { type: "string" },
    },
  },
  sideEffectLevel: "none",
  timeoutMs: 10_000,
  permissionScope: "user",
  errorMapping: [],
  tags: ["builtin", "filesystem", "read"],
  sensitivity: "internal",
};

export interface FileReadHandlerOptions {
  workspaceRoot: string;
  maxBytes?: number;
  pathPermissions?: PathPermissionStore;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

export function createFileReadHandler(options: FileReadHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (args): Promise<ToolHandlerResult> => {
    const reqPath = ensureString(args.path, "path");
    const encoding = (ensureOptionalString(args.encoding, "encoding") ?? "utf-8") as "utf-8" | "base64";
    if (encoding !== "utf-8" && encoding !== "base64") {
      throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: `unsupported encoding: ${encoding}`, nextStep: "Use encoding=utf-8 or encoding=base64." });
    }
    const line = ensureOptionalPositiveInt(args.line, "line");
    const lineCount = ensureOptionalPositiveInt(args.lineCount, "lineCount") ?? 80;
    const offset = ensureNonNegativeInt(args.offset, "offset", 0);
    const length = ensureOptionalPositiveInt(args.length, "length");

    const absolutePath = resolveToolPath({ workspaceRoot: root, reqPath, operation: "read", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}) });
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new ToolExecutionError({ code: "NOT_A_FILE", message: `path is not a regular file: ${reqPath}`, nextStep: "Use a regular file path." });
    }

    if (line !== undefined) return readLineRange({ absolutePath, reqPath, encoding, line, lineCount, statSize: stat.size });
    return readByteRange({ absolutePath, reqPath, encoding, offset, ...(length !== undefined ? { length } : {}), maxBytes, statSize: stat.size });
  };
}

async function readLineRange(input: { absolutePath: string; reqPath: string; encoding: "utf-8" | "base64"; line: number; lineCount: number; statSize: number }): Promise<ToolHandlerResult> {
  if (input.encoding !== "utf-8") {
    throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: "line-based reads require encoding=utf-8", nextStep: "Use encoding=utf-8 or omit encoding when using line/lineCount." });
  }
  const fullContent = await fs.readFile(input.absolutePath, "utf8");
  const lines = fullContent.split(/\r?\n/);
  const startIndex = Math.max(0, input.line - 1);
  const selected = lines.slice(startIndex, startIndex + input.lineCount);
  const content = selected.join("\n");
  const bytesRead = Buffer.byteLength(content, "utf8");
  const truncated = startIndex + input.lineCount < lines.length;
  return {
    output: {
      path: input.reqPath,
      encoding: input.encoding,
      size: input.statSize,
      bytesRead,
      offset: 0,
      line: input.line,
      lineCount: selected.length,
      totalLines: lines.length,
      truncated,
      content,
    },
    summary: `read ${input.reqPath} lines ${input.line}-${input.line + Math.max(0, selected.length - 1)} of ${lines.length}${truncated ? " (truncated)" : ""}`,
    truncated,
    tokenEstimate: Math.ceil(bytesRead / 4),
  };
}

async function readByteRange(input: { absolutePath: string; reqPath: string; encoding: "utf-8" | "base64"; offset: number; length?: number; maxBytes: number; statSize: number }): Promise<ToolHandlerResult> {
  const wantBytes = input.length ?? input.maxBytes;
  const bytesToRead = Math.min(wantBytes, input.maxBytes, Math.max(input.statSize - input.offset, 0));
  const buffer = Buffer.alloc(bytesToRead);
  let bytesRead = 0;
  if (bytesToRead > 0) {
    const fh = await fs.open(input.absolutePath, "r");
    try {
      const r = await fh.read(buffer, 0, bytesToRead, input.offset);
      bytesRead = r.bytesRead;
    } finally {
      await fh.close();
    }
  }

  const content = input.encoding === "utf-8" ? buffer.subarray(0, bytesRead).toString("utf-8") : buffer.subarray(0, bytesRead).toString("base64");
  const truncated = input.offset + bytesRead < input.statSize;
  return {
    output: {
      path: input.reqPath,
      encoding: input.encoding,
      size: input.statSize,
      bytesRead,
      offset: input.offset,
      truncated,
      content,
    },
    summary: `read ${input.reqPath} ${bytesRead}/${input.statSize} bytes${truncated ? " (truncated)" : ""}`,
    truncated,
    tokenEstimate: Math.ceil(bytesRead / 4),
  };
}
