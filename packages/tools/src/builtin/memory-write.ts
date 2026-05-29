import type { MemoryDocumentType, MemoryKind, MemoryProvenance, MemoryRecord, MemoryScope, SensitivityLevel, ToolSpec } from "@jue/shared-types";
import { ToolExecutionError } from "../tool-errors.js";
import type { ToolHandler, ToolHandlerResult } from "../tool-executor.js";
import { ensureString } from "../path-utils.js";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const OBSERVED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface MemoryWriteInvocation {
  type: MemoryDocumentType;
  scope?: MemoryScope;
  title: string;
  content: string;
  summary?: string;
  reason?: string;
  provenance?: MemoryProvenance;
  tags?: string[];
  sensitivity?: SensitivityLevel;
  ttlMs?: number;
  weight?: number;
  confidence?: number;
}

export interface MemoryWriteProviderContext {
  sessionId?: string;
  requestId?: string;
  workspaceRoot?: string;
}

export interface MemoryWriteProviderResult {
  written: Array<{
    id: string;
    scope: MemoryScope;
    type?: MemoryDocumentType;
    title: string;
    status: string;
    writeMode?: string;
    memoryPath?: string;
    classificationReason?: string;
  }>;
}

export type MemoryWriteProvider = (invocation: MemoryWriteInvocation, context: MemoryWriteProviderContext) => Promise<MemoryWriteProviderResult> | MemoryWriteProviderResult;

export const memoryWriteToolSpec: ToolSpec = {
  name: "memory.write",
  displayName: "写入长期记忆",
  description: "写入正式长期记忆的唯一入口。用于用户明确要求记住、纠正/确认长期协作方式、稳定用户事实、跨项目规则、当前项目决策原因或外部引用。不要用 file.write 直接修改 .jue/**/memory。",
  version: "0.1.0",
  kind: "builtin",
  category: "memory",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["type", "title", "content"],
    properties: {
      type: { type: "string", enum: ["user", "global", "feedback", "project", "reference"], description: "记忆文档类型：user 用户画像/偏好；global 跨项目规则；feedback 当前项目内对 Agent 行为的纠正/确认；project 当前项目非代码状态/决策原因；reference 外部系统指针。" },
      scope: { type: "string", enum: ["user", "global", "project"], description: "可选作用域。通常由 type 推导：user->user，global->global，feedback/project/reference->project。" },
      title: { type: "string", description: "短标题，会用于生成 kebab-case 文件名。必须具体，不要写成'用户偏好的话题'这类空泛标题。" },
      summary: { type: "string", description: "一句话摘要，用于 MEMORY.md 索引和召回匹配。必须保留具体实体。" },
      content: { type: "string", description: "记忆正文。feedback/project 类型必须包含 Why 与 How to apply；其他类型写清事实或规则本身。" },
      reason: { type: "string", description: "为什么这条内容值得进入长期记忆，以及为何这样分类。" },
      provenance: { type: "string", enum: ["explicit", "inferred", "observed"], default: "explicit", description: "来源强度：用户明确要求记住用 explicit；后台推断用 inferred；观察池升级用 observed。" },
      tags: { type: "array", items: { type: "string" }, description: "检索标签，使用简短词语。" },
      sensitivity: { type: "string", enum: ["public", "internal", "private", "secret"], default: "internal" },
      ttlMs: { type: "integer", minimum: 0, description: "可选 TTL 毫秒。explicit 通常一年以上；observed 应更短。" },
      weight: { type: "number", minimum: 0, maximum: 1, description: "重要性权重。explicit 通常 0.85-0.95。" },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度。用户明确表达通常 0.9 以上。" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["written"],
    properties: {
      written: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["id", "scope", "title", "status"],
          properties: {
            id: { type: "string" },
            scope: { type: "string" },
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "string" },
            writeMode: { type: "string" },
            memoryPath: { type: "string" },
            classificationReason: { type: "string" },
          },
        },
      },
    },
  },
  sideEffectLevel: "write",
  timeoutMs: 10_000,
  retryPolicy: { maxRetries: 0, backoffMs: 0, backoffStrategy: "fixed", retryOn: [] },
  permissionScope: "user",
  confirmation: { required: false, autoApproveScopes: ["user"] },
  availabilityCheck: { kind: "always", envKeys: [] },
  errorMapping: [],
  tags: ["builtin", "memory", "write"],
  sensitivity: "internal",
};

export interface MemoryWriteHandlerOptions {
  provider?: MemoryWriteProvider;
  workspaceRoot?: string;
}

export function createMemoryWriteHandler(options: MemoryWriteHandlerOptions = {}): ToolHandler {
  return async (args, ctx): Promise<ToolHandlerResult> => {
    if (!options.provider) {
      throw new ToolExecutionError({
        code: "MEMORY_WRITE_PROVIDER_MISSING",
        message: "当前 runtime 未接入 memory.write provider，无法写入长期记忆。",
        nextStep: "不要改用 file.write 写记忆文件；请报告 runtime 需要接入 MemoryManager.write。",
      });
    }

    const invocation = normalizeMemoryWriteInvocation(args);
    const output = await options.provider(invocation, {
      sessionId: ctx.call.sessionId,
      requestId: ctx.call.requestId,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    });

    return {
      output,
      summary: summarizeMemoryWrite(output),
      tokenEstimate: 64,
    };
  };
}

export function memoryWriteInvocationToRecord(input: MemoryWriteInvocation, context: MemoryWriteProviderContext): Partial<MemoryRecord> {
  const type = input.type;
  const scope = input.scope ?? scopeForType(type);
  const provenance = input.provenance ?? "explicit";
  const now = Date.now();
  const ttlMs = input.ttlMs ?? (provenance === "observed" ? OBSERVED_TTL_MS : ONE_YEAR_MS);
  const content = normalizeBodyForMemoryTool(type, input.content, input.reason);
  return {
    scope,
    kind: kindForType(type),
    origin: provenance === "explicit" ? "explicit_user" : "subagent",
    provenance,
    status: "active",
    title: input.title,
    content,
    summary: input.summary ?? firstSentence(content),
    weight: input.weight ?? defaultWeight(provenance),
    confidence: input.confidence ?? defaultConfidence(provenance),
    sensitivity: input.sensitivity ?? "internal",
    ttlMs,
    expiresAt: now + ttlMs,
    originSessionId: context.sessionId ?? "unknown-session",
    tags: uniqueTags([type, scope, ...(input.tags ?? [])]),
    metadata: {
      memoryDocumentType: type,
      projectRelated: scope === "project",
      writtenBy: "memory.write",
      ...(input.reason ? { writeReason: input.reason } : {}),
    },
  };
}

function normalizeMemoryWriteInvocation(args: Record<string, unknown>): MemoryWriteInvocation {
  const type = ensureMemoryType(ensureString(args.type, "type"));
  const title = ensureString(args.title, "title").trim();
  const content = ensureString(args.content, "content").trim();
  if (!title) throw new ToolExecutionError({ code: "MEMORY_TITLE_EMPTY", message: "memory.write 的 title 不能为空", nextStep: "用具体事实或偏好对象作为标题。" });
  if (!content) throw new ToolExecutionError({ code: "MEMORY_CONTENT_EMPTY", message: "memory.write 的 content 不能为空", nextStep: "写入一条完整、可独立理解的长期记忆正文。" });
  const scope = typeof args.scope === "string" ? ensureMemoryScope(args.scope) : undefined;
  const provenance = typeof args.provenance === "string" ? ensureProvenance(args.provenance) : undefined;
  return {
    type,
    ...(scope ? { scope } : {}),
    title,
    content,
    ...(typeof args.summary === "string" && args.summary.trim() ? { summary: args.summary.trim() } : {}),
    ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}),
    ...(provenance ? { provenance } : {}),
    tags: normalizeTags(args.tags),
    sensitivity: typeof args.sensitivity === "string" ? ensureSensitivity(args.sensitivity) : "internal",
    ...(typeof args.ttlMs === "number" ? { ttlMs: Math.max(0, Math.floor(args.ttlMs)) } : {}),
    ...(typeof args.weight === "number" ? { weight: clamp01(args.weight) } : {}),
    ...(typeof args.confidence === "number" ? { confidence: clamp01(args.confidence) } : {}),
  };
}

function ensureMemoryType(value: string): MemoryDocumentType {
  if (value === "user" || value === "global" || value === "feedback" || value === "project" || value === "reference") return value;
  throw new ToolExecutionError({ code: "INVALID_MEMORY_TYPE", message: `不支持的记忆类型: ${value}`, nextStep: "使用 user/global/feedback/project/reference 之一。" });
}

function ensureMemoryScope(value: string): MemoryScope {
  if (value === "user" || value === "global" || value === "project") return value;
  throw new ToolExecutionError({ code: "INVALID_MEMORY_SCOPE", message: `不支持的记忆作用域: ${value}`, nextStep: "使用 user/global/project 之一，或省略 scope 让工具按 type 推导。" });
}

function ensureProvenance(value: string): MemoryProvenance {
  if (value === "explicit" || value === "inferred" || value === "observed") return value;
  throw new ToolExecutionError({ code: "INVALID_MEMORY_PROVENANCE", message: `不支持的记忆来源: ${value}`, nextStep: "使用 explicit/inferred/observed 之一。" });
}

function ensureSensitivity(value: string): SensitivityLevel {
  if (value === "public" || value === "internal" || value === "private" || value === "secret") return value;
  throw new ToolExecutionError({ code: "INVALID_MEMORY_SENSITIVITY", message: `不支持的敏感级别: ${value}`, nextStep: "使用 public/internal/private/secret 之一。" });
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueTags(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean));
}

function scopeForType(type: MemoryDocumentType): MemoryScope {
  if (type === "global") return "global";
  if (type === "feedback" || type === "project" || type === "reference") return "project";
  return "user";
}

function kindForType(type: MemoryDocumentType): MemoryKind {
  if (type === "feedback" || type === "global") return "rule";
  if (type === "reference" || type === "project") return "fact";
  return "preference";
}

function defaultWeight(provenance: MemoryProvenance): number {
  if (provenance === "explicit") return 0.9;
  if (provenance === "observed") return 0.55;
  return 0.7;
}

function defaultConfidence(provenance: MemoryProvenance): number {
  if (provenance === "explicit") return 0.95;
  if (provenance === "observed") return 0.65;
  return 0.78;
}

function normalizeBodyForMemoryTool(type: MemoryDocumentType, content: string, reason?: string): string {
  if (type !== "feedback" && type !== "project") return content;
  if (/\*\*Why:\*\*/i.test(content) && /\*\*How to apply:\*\*/i.test(content)) return content;
  const why = reason ?? "用户明确要求记录，属于不能从当前代码状态稳定推导出的长期信息。";
  return `${content}\n\n**Why:** ${why}\n\n**How to apply:** 当后续任务处于同一项目且满足上述边界条件时使用；若当前请求或代码事实冲突，以当前事实为准。`;
}

function summarizeMemoryWrite(output: MemoryWriteProviderResult): string {
  if (output.written.length === 0) return "未写入长期记忆。";
  return `写入长期记忆 ${output.written.length} 条：${output.written.map((item) => `${item.title}(${item.scope}${item.type ? `/${item.type}` : ""})`).join("; ")}`;
}

function firstSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim().split(/[。.!?\n]/)[0]?.slice(0, 120) || "memory";
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
