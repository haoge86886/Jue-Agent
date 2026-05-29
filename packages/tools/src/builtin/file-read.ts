/**
 * @file file-read.ts
 * @module @jue/tools/builtin/file-read
 *
 * 内置工具:`file.read` —— 读取本地文件内容。
 *
 * 这是项目里第一个真实工具,也是验证 Agent Loop 链路是否打通的"小白鼠"。
 * 设计取舍以"安全 + 可观测"为先,功能维持极简:
 *
 *   1. 强制路径在 `workspaceRoot` 子树内(经 path.resolve + 前缀比对),
 *      防止 `../`、绝对路径越界、符号链接逃逸等常见问题。
 *   2. 默认编码 utf-8;`encoding=base64` 给二进制留口。
 *   3. 通过 `maxBytes` 限制单次读取,避免一份大日志把上下文撑爆。
 *   4. 偏移读取 (`offset` + `length`):便于 LLM 分段阅读大文件(对应 design.md
 *      里"长文档分块策略"的最小落地)。
 *
 * 与 ToolHandler 解耦:`createFileReadHandler({ workspaceRoot, ... })` 工厂返回
 * 一个绑定了 workspaceRoot 的 handler,Engine 在装配时再注册到 DefaultToolExecutor。
 * 这样 workspaceRoot 由 bootstrap 决定,工具实现不直接读 process.cwd()。
 */

import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import type { PathPermissionStore } from "../path-permissions.js";
import { ensureNonNegativeInt, ensureOptionalPositiveInt, ensureOptionalString, ensureString, resolveToolPath } from "../path-utils.js";

/**
 * file.read 工具的 ToolSpec。注册时 ToolRegistry 会读取它生成模型可见的 tools 清单。
 *
 * inputSchema 用 JSON Schema 风格(对应 `JsonSchemaLikeSchema`),
 * 字段尽量保守:
 *   - `path`     : 必填,workspace 相对路径或绝对路径(后者必须落在 workspace 内)
 *   - `encoding` : 可选,utf-8 / base64
 *   - `offset`   : 可选,起始字节,默认 0
 *   - `length`   : 可选,读取字节数,默认 maxBytes
 */
export const fileReadToolSpec: ToolSpec = {
  name: "file.read",
  displayName: "读取文件",
  description:
    "读取 workspace 内一份本地文件的内容。仅支持 workspace 子树内的路径;返回文本(默认 utf-8)。" +
    "可用 offset/length 分段读取大文件。",
  version: "0.1.0",
  kind: "builtin",
  category: "file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "文件相对 workspace 根的路径,例如 './configs/app.yaml'",
      },
      encoding: {
        type: "string",
        enum: ["utf-8", "base64"],
        default: "utf-8",
        description: "返回内容的编码。二进制文件请用 base64",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "起始字节位置,默认 0",
      },
      length: {
        type: "integer",
        minimum: 1,
        description: "读取的字节数。不传则读至 maxBytes 上限",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "encoding", "size", "truncated", "content"],
    properties: {
      path: { type: "string" },
      encoding: { type: "string", enum: ["utf-8", "base64"] },
      size: { type: "integer", description: "文件总字节数(stat)" },
      bytesRead: { type: "integer", description: "本次实际读取字节数" },
      offset: { type: "integer" },
      truncated: {
        type: "boolean",
        description: "是否因 maxBytes 截断;true 时调用方应再次按 offset 续读",
      },
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

/**
 * 工厂选项。
 *
 * - `workspaceRoot` : 安全边界,所有读取必须在此子树
 * - `maxBytes`      : 单次读取的硬上限(默认 256 KiB,够 LLM 看一份配置/源文件)
 */
export interface FileReadHandlerOptions {
  workspaceRoot: string;
  maxBytes?: number;
  pathPermissions?: PathPermissionStore;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * 工厂:产出绑定了 workspaceRoot 的 ToolHandler。
 *
 * 这里使用工厂而不是模块级常量,有两个原因:
 *   1. 不同入口可能持有不同 workspaceRoot(测试 / 子任务沙箱)
 *   2. 让 handler 不直接依赖 `process.cwd()`,避免被 cwd 切换导致的安全漂移
 */
export function createFileReadHandler(options: FileReadHandlerOptions): ToolHandler {
  const root = resolvePath(options.workspaceRoot);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (args): Promise<ToolHandlerResult> => {
    const reqPath = ensureString(args.path, "path");
    const encoding = (ensureOptionalString(args.encoding, "encoding") ?? "utf-8") as "utf-8" | "base64";
    if (encoding !== "utf-8" && encoding !== "base64") {
      throw new ToolExecutionError({ code: "INVALID_ARGUMENT", message: `不支持的 encoding: ${encoding}`, nextStep: "encoding 只能使用 utf-8 或 base64。" });
    }
    const offset = ensureNonNegativeInt(args.offset, "offset", 0);
    const length = ensureOptionalPositiveInt(args.length, "length");

    const absolutePath = resolveToolPath({ workspaceRoot: root, reqPath, operation: "read", ...(options.pathPermissions ? { permissions: options.pathPermissions } : {}) });
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new ToolExecutionError({ code: "NOT_A_FILE", message: `路径不是普通文件: ${reqPath}`, nextStep: "改用普通文件路径。" });
    }

    const wantBytes = length ?? maxBytes;
    const bytesToRead = Math.min(wantBytes, maxBytes, Math.max(stat.size - offset, 0));
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    if (bytesToRead > 0) {
      const fh = await fs.open(absolutePath, "r");
      try {
        const r = await fh.read(buffer, 0, bytesToRead, offset);
        bytesRead = r.bytesRead;
      } finally {
        await fh.close();
      }
    }

    const content =
      encoding === "utf-8"
        ? buffer.subarray(0, bytesRead).toString("utf-8")
        : buffer.subarray(0, bytesRead).toString("base64");
    const truncated = offset + bytesRead < stat.size;

    return {
      output: {
        path: reqPath,
        encoding,
        size: stat.size,
        bytesRead,
        offset,
        truncated,
        content,
      },
      summary: `读取 ${reqPath} ${bytesRead}/${stat.size} bytes${truncated ? "(截断)" : ""}`,
      truncated,
      tokenEstimate: Math.ceil(bytesRead / 4),
    };
  };
}
