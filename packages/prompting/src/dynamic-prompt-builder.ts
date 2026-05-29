/**
 * @file dynamic-prompt-builder.ts
 * @module @jue/prompting/dynamic-prompt-builder
 *
 * Builds runtime prompt segments from environment, frontend capabilities, MCP status,
 * skills, and subagent availability. Startup file preparation belongs to infra/runtime.
 */

import type {
  DynamicPromptCategory,
  PromptRuntimeContext,
  PromptSegment,
  PromptSegmentDiagnostic,
} from "./types.js";
import { hashText } from "./prompt-template-engine.js";

export type DynamicPromptGenerator = (ctx: PromptRuntimeContext) => string | null | undefined;

export interface DynamicPromptBuilderOptions {
  generators?: Partial<Record<DynamicPromptCategory, DynamicPromptGenerator>>;
  order?: DynamicPromptCategory[];
}

export interface BuildDynamicPromptResult {
  segments: PromptSegment[];
  diagnostics: PromptSegmentDiagnostic[];
}

const DEFAULT_DYNAMIC_ORDER: DynamicPromptCategory[] = [
  "base_info",
  "auto_memory",
  "temp_dir",
  "environment",
  "frontend_capabilities",
  "session_flags",
  "runtime_tools",
  "subagent_catalog",
  "mcp_status",
  "remote_device_status",
];

export class DynamicPromptBuilder {
  private readonly generators: Partial<Record<DynamicPromptCategory, DynamicPromptGenerator>>;
  private readonly order: DynamicPromptCategory[];

  constructor(options: DynamicPromptBuilderOptions = {}) {
    this.generators = options.generators ?? {};
    this.order = options.order ?? DEFAULT_DYNAMIC_ORDER;
  }

  build(ctx: PromptRuntimeContext): PromptSegment[] {
    return this.buildDetailed(ctx).segments;
  }

  buildDetailed(ctx: PromptRuntimeContext): BuildDynamicPromptResult {
    const segments: PromptSegment[] = [];
    const diagnostics: PromptSegmentDiagnostic[] = [];

    for (const category of this.order) {
      const generator = this.generators[category] ?? DEFAULT_GENERATORS[category];
      if (!generator) {
        diagnostics.push({
          category,
          origin: "dynamic",
          source: `builtin:${category}`,
          status: "missing",
          reason: "no dynamic generator registered",
        });
        continue;
      }

      try {
        const raw = generator(ctx);
        const content = raw?.trim();
        if (!content) {
          diagnostics.push({
            category,
            origin: "dynamic",
            source: `builtin:${category}`,
            status: "skipped",
            reason: "runtime data unavailable",
          });
          continue;
        }

        const contentHash = hashText(content);
        segments.push({
          category,
          origin: "dynamic",
          source: `builtin:${category}`,
          content,
          contentHash,
          loadedAt: Date.now(),
        });
        diagnostics.push({
          category,
          origin: "dynamic",
          source: `builtin:${category}`,
          status: "loaded",
          contentHash,
          charCount: content.length,
        });
      } catch (error) {
        diagnostics.push({
          category,
          origin: "dynamic",
          source: `builtin:${category}`,
          status: "degraded",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { segments, diagnostics };
  }
}

const DEFAULT_GENERATORS: Partial<Record<DynamicPromptCategory, DynamicPromptGenerator>> = {
  base_info: (ctx) => {
    const lines = ["[base_info]"];
    if (ctx.sessionId) lines.push(`- sessionId: ${ctx.sessionId}`);
    if (ctx.requestId) lines.push(`- requestId: ${ctx.requestId}`);
    if (ctx.frontend) lines.push(`- frontend: ${ctx.frontend}`);
    if (ctx.mode) lines.push(`- mode: ${ctx.mode}`);
    if (ctx.modelId) lines.push(`- modelId: ${ctx.modelId}`);
    if (ctx.modelName) lines.push(`- modelName: ${ctx.modelName}`);
    if (ctx.modelProvider) lines.push(`- modelProvider: ${ctx.modelProvider}`);
    if (ctx.defaultLanguage) lines.push(`- language: ${ctx.defaultLanguage}`);
    if (ctx.defaultTimezone) lines.push(`- timezone: ${ctx.defaultTimezone}`);
    if (ctx.appEnv) lines.push(`- appEnv: ${ctx.appEnv}`);
    if (ctx.workspaceRoot) lines.push(`- workspaceRoot: ${ctx.workspaceRoot}`);
    lines.push(`- now: ${new Date().toISOString()}`);
    return lines.length === 1 ? null : lines.join("\n");
  },

  auto_memory: (ctx) => {
    const lines = [
      "[memory_rules]",
      "- 当前 Agent 具备长期记忆能力。不要声称没有持久化记忆；如果没有检索到相关记忆，应说明当前上下文未提供相关记忆。",
      "- 主 Agent 负责显式记忆写入：当用户出现四类信号时，必须调用 memory.write 写入正式长期记忆。不要用 file.write 或 file.edit 直接修改 .jue/**/memory、MEMORY.md 或记忆细节文件。",
      "- 写入长期记忆不需要再向用户二次确认；如果用户已经表达记住、纠正、确认或稳定事实，直接调用 memory.write。该工具会统一维护 MEMORY.md 索引、frontmatter、TTL、来源、分类和写入事件。",
      "- 必须存的四类信号：显式记住(记住/remember/save this)、纠正(不要/别/stop/no, do X)、确认(对/就是这样/继续这么做)、稳定事实(用户角色/长期约束/外部系统指针)。其他闲聊、临时上下文、可从代码或 git 推导的信息默认不存。",
      "- 记忆分类要按语义判断：用户身份、兴趣、习惯、长期偏好 => user；跨项目工作流、环境约束、通用协作规则 => global；当前仓库决策原因、deadline、feedback、reference/Linear/Grafana/Slack 指针 => project。作品名里的 Project 不等于当前软件项目。",
      "- 用户自称身份或个人属性时，frontmatter 必须使用 type: user 和 scope: user，例如性别、地域、职业、兴趣、口味、作息、沟通偏好。不要把用户画像写成 scope: global。",
      "- memory.write 参数要具体：type 只能是 user/global/feedback/project/reference；title 与 summary 必须保留具体实体，不能写成‘用户偏好的话题’这类空泛描述；content 写清事实或规则。feedback/project 类型需要写出 Why 与 How to apply。",
      "- provenance 规则：用户原话要求记住或明确纠正确认 => explicit，高权重，不能自动删除；MemoryExtractorAgent 周期推断 => inferred，中权重，可复审；观察池升级 => observed，低权重、TTL 较短，引用时降权。",
      "- 如果上下文出现 Memory observation hints，它们只是随机抽取的待验证假设，不代表高置信事实。只有当用户当前话题明显偏向该主题、且没有明确不相干任务时，才可以自然询问验证；如果用户正在执行完全不相关的任务，不要提起或使用这些假设。",
      "- feedback/project 正文必须包含 **Why:** 和 **How to apply:**；user/global 可以用简洁事实句，但要避免写入已经存在于 JUE.md 的内容。",
      "- MEMORY.md 只是索引，不是完整事实。若索引行与当前任务相关，先用 file.read 读取对应细节 .md 再判断。记忆可能过时；涉及代码、路径、函数、flag、版本时必须用当前代码或工具结果验证。",
      "- 当前用户请求、当前代码状态和工具结果优先级高于长期记忆；冲突时遵循当前请求，并说明旧记忆可能过时。",
      "- 当用户没有什么具体的工程性任务而只是闲聊时,不要太生硬的说'我从你的记忆中读到...',避免破坏对话氛围感"
    ];
    if (ctx.environment?.globalJueDir) lines.push(`- globalJueDir: ${ctx.environment.globalJueDir}`);
    if (ctx.workspaceRoot) lines.push(`- workspaceRoot: ${ctx.workspaceRoot}`);
    if (ctx.autoMemory) {
      const memories = Array.isArray(ctx.autoMemory) ? ctx.autoMemory : [ctx.autoMemory];
      const cleaned = memories.map((memory) => memory.trim()).filter(Boolean);
      lines.push("[auto_memory]", ...cleaned.map((memory) => `- ${memory}`));
    }
    return lines.join("\n");
  },

  temp_dir: (ctx) => {
    if (!ctx.tempDir?.enabled || !ctx.tempDir.path) return null;
    return [
      "[temp_dir]",
      `- path: ${ctx.tempDir.path}`,
      "- 后续临时文件应优先写入该目录。",
    ].join("\n");
  },

  environment: (ctx) => {
    const lines = ["[environment]"];
    if (ctx.appEnv) lines.push(`- appEnv: ${ctx.appEnv}`);
    if (ctx.defaultLanguage) lines.push(`- language: ${ctx.defaultLanguage}`);
    if (ctx.defaultTimezone) lines.push(`- timezone: ${ctx.defaultTimezone}`);
    if (ctx.workspaceRoot) lines.push(`- workspaceRoot: ${ctx.workspaceRoot}`);
    if (ctx.environment) {
      for (const [key, value] of Object.entries(ctx.environment)) {
        lines.push(`- ${key}: ${value}`);
      }
    }
    return lines.length === 1 ? null : lines.join("\n");
  },

  frontend_capabilities: (ctx) => {
    if (!ctx.frontend && !ctx.frontendCapabilities) return null;
    const lines = ["[frontend]"];
    if (ctx.frontend) lines.push(`- kind: ${ctx.frontend}`);
    if (ctx.frontendCapabilities) {
      const flags = Object.entries(ctx.frontendCapabilities)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      if (flags) lines.push(`- capabilities: ${flags}`);
    }
    return lines.length === 1 ? null : lines.join("\n");
  },

  session_flags: (ctx) => {
    if (!ctx.sessionFlags || Object.keys(ctx.sessionFlags).length === 0) return null;
    const lines = ["[session_flags]"];
    for (const [key, value] of Object.entries(ctx.sessionFlags)) {
      lines.push(`- ${key}: ${value}`);
    }
    return lines.join("\n");
  },

  runtime_tools: (ctx) => {
    const lines = ["[runtime_tools]"];
    if (ctx.enabledToolNames && ctx.enabledToolNames.length > 0) {
      lines.push(`- enabled (${ctx.enabledToolNames.length}): ${ctx.enabledToolNames.join(", ")}`);
    }
    if (ctx.availableSkills && ctx.availableSkills.length > 0) {
      lines.push("- available skills for skill.invoke:");
      for (const skill of ctx.availableSkills) {
        const displayName = skill.displayName ? ` (${skill.displayName})` : "";
        const description = skill.description ? ` - ${skill.description}` : "";
        const tags = skill.tags && skill.tags.length > 0 ? ` [${skill.tags.join(", ")}]` : "";
        lines.push(`  - ${skill.name}${displayName} <${skill.scope}>${tags}${description}`);
      }
      lines.push("- skill.invoke must use one exact skill name from the list above. Do not invent names such as skill.list or list_available_skills.");
    }
    return lines.length === 1 ? null : lines.join("\n");
  },

  subagent_catalog: (ctx) => {
    if (!ctx.availableSubAgents || ctx.availableSubAgents.length === 0) return null;
    const lines = [
      "[subagent_catalog]",
      "- Use tool subagent.invoke to delegate to a public subagent. Do not invent other subagent tools.",
      "- Subagents run in isolated context windows with filtered tool permissions. Pass only the task goal, success criteria, constraints, and necessary background.",
      "- Subagents must not call subagent.invoke. If multiple subtasks are useful, the main agent should start separate subagent.invoke calls.",
      "- Prefer ExplorerAgent for locating code, PlanAgent for architecture plans, verification for read-only review, and General-purpose for bounded execution tasks.",
    ];
    for (const agent of ctx.availableSubAgents) {
      const tools = agent.allowedToolNames && agent.allowedToolNames.length > 0
        ? ` tools=${agent.allowedToolNames.join(",")}`
        : " tools=minimal";
      const budget = agent.budget
        ? ` budget=${agent.budget.maxDurationMs ?? "?"}ms/${agent.budget.maxToolCalls ?? "?"}calls/${agent.budget.maxTokens ?? "?"}tokens`
        : "";
      lines.push(`- ${agent.invocationName} (${agent.displayName}, type=${agent.type})${tools}${budget}: ${agent.description}`);
    }
    return lines.join("\n");
  },
  mcp_status: (ctx) => {
    if (!ctx.mcpStatus || ctx.mcpStatus.length === 0) return null;
    const lines = ["[mcp_status]"];
    for (const item of ctx.mcpStatus) {
      const tools = item.toolCount !== undefined ? ` (${item.toolCount} tools)` : "";
      lines.push(`- ${item.id}: ${item.connected ? "connected" : "disconnected"}${tools}`);
    }
    return lines.join("\n");
  },

  remote_device_status: (ctx) => {
    if (!ctx.remoteDevices || ctx.remoteDevices.length === 0) return null;
    const lines = ["[remote_devices]"];
    for (const device of ctx.remoteDevices) {
      lines.push(`- ${device.id}: ${device.status}`);
    }
    return lines.join("\n");
  },
};

export const DEFAULT_DYNAMIC_PROMPT_ORDER = DEFAULT_DYNAMIC_ORDER;



