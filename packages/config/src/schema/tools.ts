/**
 * @file schema/tools.ts
 * @module @jue/config/schema/tools
 *
 * 工具子系统配置(对应 `configs/tools.yaml`)。
 *
 * 配置层职责:决定**哪些工具可用**与**调用时的策略**;
 * 工具本身的协议形状(ToolSpec)在 `@jue/shared-types/tool`,不重复定义。
 *
 * 优先级关系(由高到低):
 *   1. 单工具 `rules`(显式打开/关闭某个工具)
 *   2. `categoryFlags`(按业务类别开关)
 *   3. `enabledKinds` + `builtin` 等大类开关
 *   4. `defaults`(兜底超时、重试、权限作用域)
 */

import { z } from "zod";
import {
  PermissionScopeSchema,
  SideEffectLevelSchema,
  ToolCategorySchema,
  ToolKindSchema,
} from "@jue/shared-types";

/**
 * 单工具开关规则。`rules` 数组中的条目优先级最高,可一刀切覆盖类别开关。
 */
export const ToolEnableRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  reason: z.string().optional(),
});
export type ToolEnableRule = z.infer<typeof ToolEnableRuleSchema>;

/**
 * 工具默认策略。注册时未声明对应字段的工具应用这些默认值。
 */
export const ToolDefaultsSchema = z.object({
  timeoutMs: z.number().int().positive().default(30_000),
  maxRetries: z.number().int().nonnegative().default(0),
  permissionScope: PermissionScopeSchema.default("user"),
  defaultSideEffectLevel: SideEffectLevelSchema.default("none"),
});
export type ToolDefaults = z.infer<typeof ToolDefaultsSchema>;

/**
 * 业务类别开关 + 类别级确认要求。
 * 例:把整个 `shell` 类别 `requireConfirmation: true`,无需逐个工具改。
 */
export const ToolCategoryFlagsSchema = z.object({
  category: ToolCategorySchema,
  enabled: z.boolean().default(true),
  requireConfirmation: z.boolean().default(false),
});
export type ToolCategoryFlags = z.infer<typeof ToolCategoryFlagsSchema>;

/**
 * 全局确认策略。
 *
 * `mode` 取值:
 *   - `never`            : 全部跳过(不推荐用于生产)
 *   - `destructive_only` : 仅破坏性工具需确认(默认)
 *   - `external_only`    : 仅访问外部网络/远程系统的工具需确认
 *   - `always`           : 全部要求确认
 *
 * `customRequire/SkipConfirmTools` 提供例外名单。
 */
export const ConfirmationConfigSchema = z.object({
  mode: z.enum(["never", "destructive_only", "external_only", "always"]).default(
    "destructive_only",
  ),
  customRequireConfirmTools: z.array(z.string()).default([]),
  customSkipConfirmTools: z.array(z.string()).default([]),
});
export type ConfirmationConfig = z.infer<typeof ConfirmationConfigSchema>;

/**
 * 单个 MCP Server 接入配置。
 *
 * - `transport=stdio` 时使用 `command + args + env` 启动子进程
 * - 远程类型(sse/websocket/http)使用 `url + headers`
 * - `toolPrefix` 用于多 MCP Server 间防止工具重名(如 `mcp_filesystem.read`)
 * - `allowed/blockedTools` 是该 server 暴露工具的允许/拒绝名单
 *
 * 末尾的 `superRefine` 按 transport 强制要求对应字段:
 *   - `stdio`              → 必须有 command
 *   - `sse/websocket/http` → 必须有 url,且 url 必须是合法 URL(避免无效配置只在
 *                            实际连接阶段才报错)
 */
export const McpServerConfigSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    transport: z.enum(["stdio", "sse", "websocket", "http"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    autoReconnect: z.boolean().default(true),
    startupTimeoutMs: z.number().int().positive().default(10_000),
    toolPrefix: z.string().optional(),
    allowedTools: z.array(z.string()).default([]),
    blockedTools: z.array(z.string()).default([]),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio") {
      if (!cfg.command || cfg.command.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "transport=stdio 时必须提供 command",
        });
      }
    } else {
      if (!cfg.url || cfg.url.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: `transport=${cfg.transport} 时必须提供 url`,
        });
      } else {
        try {
          new URL(cfg.url);
        } catch {
          ctx.addIssue({
            code: "custom",
            path: ["url"],
            message: `transport=${cfg.transport} 的 url 必须是合法 URL: ${cfg.url}`,
          });
        }
      }
    }
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * 内置工具开关。这些是项目自带、随 `@jue/tool` 注册的工具。
 *
 * 安全相关默认值:
 *   - `shellBlockedPatterns` 默认拦截 `rm -rf /` 等明显破坏性命令
 *   - `httpAllowedHosts` 留空表示不限制(开发期);生产建议显式白名单
 */
export const BuiltinToolsConfigSchema = z.object({
  fileReadEnabled: z.boolean().default(true),
  fileWriteEnabled: z.boolean().default(true),
  fileEditEnabled: z.boolean().default(true),
  fileSearchEnabled: z.boolean().default(true),
  listTreeEnabled: z.boolean().default(true),
  textSearchEnabled: z.boolean().default(true),
  todoEnabled: z.boolean().default(true),
  backgroundTaskEnabled: z.boolean().default(true),
  skillEnabled: z.boolean().default(true),
  askUserQuestionEnabled: z.boolean().default(true),
  shellEnabled: z.boolean().default(true),
  shellAllowedCommands: z.array(z.string()).default([]),
  shellBlockedPatterns: z.array(z.string()).default([
    "rm -rf /",
    "mkfs",
    "shutdown",
  ]),
  httpEnabled: z.boolean().default(true),
  httpAllowedHosts: z.array(z.string()).default([]),
  httpBlockedHosts: z.array(z.string()).default([]),
  searchEnabled: z.boolean().default(false),
  scrapeEnabled: z.boolean().default(false),
});
export type BuiltinToolsConfig = z.infer<typeof BuiltinToolsConfigSchema>;

/**
 * 工具领域配置主结构。
 */
export const ToolsConfigSchema = z.object({
  enabledKinds: z.array(ToolKindSchema).default(["builtin", "external", "mcp"]),
  defaults: ToolDefaultsSchema.optional(),
  categoryFlags: z.array(ToolCategoryFlagsSchema).default([]),
  rules: z.array(ToolEnableRuleSchema).default([]),
  builtin: BuiltinToolsConfigSchema.optional(),
  confirmation: ConfirmationConfigSchema.optional(),
  mcpServers: z.array(McpServerConfigSchema).default([]),
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
