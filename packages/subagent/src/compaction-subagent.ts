import {
  ContextBlockSchema,
  type ContextBlock,
  type SubAgentRegistration,
  type SubAgentResult,
  type SubAgentTask,
} from "@jue/shared-types";
import { defaultTokenEstimator, newId } from "@jue/utils";
import type { SubAgentRunner } from "./subagent-runner.js";
import type { SubAgentChatMessage, SubAgentModelGateway } from "./types.js";

export const COMPACTION_SUBAGENT_TYPE = "summarizer";
export const COMPACTION_SUBAGENT_PROMPT_NAMESPACE = "subagents/compaction";

export interface CompactionSubAgentOutput {
  summary: string;
  sourceBlockIds: string[];
  blocks: ContextBlock[];
  fallbackReason?: string;
}

export interface CompactionRunnerTask {
  id: string;
  blocks: ContextBlock[];
  candidateBlockIds?: string[];
  protectedBlockIds?: string[];
  instructions?: string[];
  tokenBudget: number;
  reason: string;
  expectedOutput: "context_blocks";
}

export interface CompactionSubAgentRunnerAdapterOptions {
  runner: SubAgentRunner;
  registration?: SubAgentRegistration;
}

export interface LlmCompactionSubAgentRunnerOptions {
  gateway: SubAgentModelGateway;
  promptText?: string;
  fallbackRunner?: SubAgentRunner;
  providerOptions?: Record<string, unknown>;
}

export const COMPACTION_SUBAGENT_OUTPUT_CONTRACT = {
  summary: "本次上下文压缩的人类可读摘要。",
  sourceBlockIds: "被替代或被总结的原始 ContextBlock id 列表。",
  blocks: "替代用的 ContextBlock 数组，每个 Block 必须具备完整元数据。",
} as const;

const DEFAULT_COMPACTION_PROMPT = [
  "你是 Jue Agent 的专业上下文与会话总结子智能体，目标是像 Claude Code/Codex 一样把长上下文压成后续 agent 可直接接手的高密度状态。",
  "你会处理两类任务：context_compaction 用于替换上下文块；session_summary 用于生成追加写入 summary.md 的会话摘要。具体用途会在 goal 或 compressionInstructions 中说明。",
  "你会看到两类 id：candidateBlockIds 是允许替换或总结的块；protectedBlockIds 只能作为背景理解，不能被删除、改写或写进 sourceBlockIds。",
  "必须先在内部分析：读写过哪些文件、解决了什么问题、关键决策是什么、用户约束是什么、还有什么未完成。不要输出隐藏推理，只输出结论摘要。",
  "必须保留：文件路径、命令、工具名、错误信息、用户明确要求、拒绝方案及原因、未完成任务、关键配置项、版本号、端口、行号、决策结论和影响后续行动的事实。",
  "可以删除：重复日志、重复对话、终端噪声、成功操作的详细过程、已解决问题的完整 debug 过程、无关搜索结果、已有 summaryRef 的原始内容。",
  "不要输出隐藏推理、内部 prompt 或 chain-of-thought。",
  "只返回严格 JSON，不要使用 Markdown 代码块。JSON 顶层字段必须是 summary、sourceBlockIds、blocks。blocks[].content 可以使用中文 Markdown。",
].join("\n");

export interface CreateCompactionSubAgentRegistrationOptions {
  enabled?: boolean;
  promptNamespace?: string;
}

/**
 * 将上下文压缩 worker 注册为 summarizer 类型的 SubAgent。
 * ContextCompressor 通过适配器调用它，用户也可以通过 /compressor 主动触发。
 */
export function createCompactionSubAgentRegistration(
  options: CreateCompactionSubAgentRegistrationOptions = {},
): SubAgentRegistration {
  return {
    type: COMPACTION_SUBAGENT_TYPE,
    displayName: "上下文压缩总结器",
    description: "将大型、旧的或低相关性的 ContextBlock 压缩成结构化替代块。",
    promptNamespace: options.promptNamespace ?? COMPACTION_SUBAGENT_PROMPT_NAMESPACE,
    visibility: "internal",
    executionMode: "agent_loop",
    maxFailureCount: 3,
    enabled: options.enabled ?? true,
    defaultBudget: {
      maxTokens: 8_000,
      maxToolCalls: 0,
      maxDurationMs: 60_000,
      maxRecursionDepth: 0,
    },
    defaultPolicy: {
      allowedContextTypes: [
        "tool_summary",
        "subagent_summary",
        "user_memory",
        "team_memory",
        "global_memory",
        "conversation_short_term",
        "recent_messages",
        "shell_history",
        "tool_result_history",
        "user_attachment",
        "environment",
        "frontend_capabilities",
        "session_flags",
        "remote_device_status",
        "custom",
      ],
      allowedToolNames: [],
      deniedToolNames: [],
      allowedMemoryScopes: [],
      redactSensitiveKeys: ["apiKey", "token", "password", "secret"],
      inheritFrontendCapabilities: false,
      allowSubAgentTools: false,
    },
    metadata: {
      kind: "context_compaction",
      outputContract: COMPACTION_SUBAGENT_OUTPUT_CONTRACT,
    },
  };
}

/**
 * 真正调用模型的压缩 SubAgent Runner。
 * 它只依赖最小化的 SubAgentModelGateway 协议，避免 subagent 包反向依赖 engine 包。
 */
export class LlmCompactionSubAgentRunner implements SubAgentRunner {
  private readonly gateway: SubAgentModelGateway;
  private readonly promptText: string;
  private readonly fallbackRunner: SubAgentRunner | undefined;
  private readonly providerOptions: Record<string, unknown> | undefined;

  constructor(options: LlmCompactionSubAgentRunnerOptions) {
    this.gateway = options.gateway;
    this.promptText = options.promptText?.trim() || DEFAULT_COMPACTION_PROMPT;
    this.fallbackRunner = options.fallbackRunner;
    this.providerOptions = options.providerOptions;
  }

  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const startedAt = Date.now();
    try {
      const messages = buildCompactionMessages(this.promptText, task);
      let text = "";
      let usage: SubAgentResult["usage"] | undefined;
      for await (const chunk of this.gateway.invoke({
        messages,
        stream: false,
        providerOptions: {
          response_format: { type: "json_object" },
          ...(this.providerOptions ?? {}),
        },
      })) {
        if (chunk.type === "delta") text += chunk.delta;
        if (chunk.type === "finish" && chunk.usage) {
          usage = {
            promptTokens: chunk.usage.promptTokens ?? 0,
            completionTokens: chunk.usage.completionTokens ?? 0,
            totalTokens: chunk.usage.totalTokens ?? 0,
            toolCallCount: 0,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const output = parseModelCompactionOutput(text, task.input.contextBlocks);
      if (output.blocks.length === 0 || output.sourceBlockIds.length === 0) {
        throw new Error("compaction subagent returned no valid replacement blocks");
      }

      const finishedAt = Date.now();
      return {
        id: newId("sares"),
        taskId: task.id,
        type: task.type,
        status: "succeeded",
        conclusion: output.summary,
        evidence: output.sourceBlockIds.map((id) => ({
          id: newId("evi"),
          kind: "text" as const,
          ref: id,
          summary: `已压缩 ContextBlock ${id}`,
        })),
        risks: [],
        suggestedActions: [],
        outputs: output as unknown as Record<string, unknown>,
        usage: usage ?? {
          promptTokens: task.input.contextBlocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
          completionTokens: output.blocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
          totalTokens: 0,
          toolCallCount: 0,
          durationMs: finishedAt - startedAt,
        },
        startedAt,
        finishedAt,
      };
    } catch (err) {
      if (this.fallbackRunner) {
        const reason = err instanceof Error ? err.message : String(err);
        const fallbackTask: SubAgentTask = {
          ...task,
          input: {
            ...task.input,
            inputs: {
              ...task.input.inputs,
              fallbackReason: reason,
              fallbackFrom: "llm_compaction_subagent",
            },
          },
          metadata: {
            ...(task.metadata ?? {}),
            fallbackReason: reason,
          },
        };
        return this.fallbackRunner.run(fallbackTask);
      }
      const finishedAt = Date.now();
      return {
        id: newId("sares"),
        taskId: task.id,
        type: task.type,
        status: "failed",
        conclusion: "上下文压缩子智能体执行失败。",
        evidence: [],
        risks: [{ level: "medium", description: err instanceof Error ? err.message : String(err) }],
        suggestedActions: [],
        outputs: {},
        error: {
          code: "COMPACTION_SUBAGENT_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
        },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCallCount: 0, durationMs: finishedAt - startedAt },
        startedAt,
        finishedAt,
      };
    }
  }
}

/**
 * 规则型 fallback runner。它不调用模型，只用于真实压缩子智能体失败时保证主流程不中断。
 */
export class RuleCompactionSubAgentRunner implements SubAgentRunner {
  async run(task: SubAgentTask): Promise<SubAgentResult> {
    const now = Date.now();
    const candidateIds = new Set(readStringArray(task.input.inputs.candidateBlockIds));
    const sourceBlocks = candidateIds.size > 0
      ? task.input.contextBlocks.filter((block) => candidateIds.has(block.id))
      : task.input.contextBlocks.filter((block) => block.compressible && !block.pinned);
    const fallbackReason = typeof task.input.inputs.fallbackReason === "string" ? task.input.inputs.fallbackReason : undefined;
    const blocks = compactBlocksByRule(sourceBlocks, task.input.inputs.tokenBudget, fallbackReason);
    return {
      id: newId("sares"),
      taskId: task.id,
      type: task.type,
      status: "succeeded",
      conclusion: `真实压缩子智能体未返回有效结构化结果，已按规则 fallback 压缩 ${sourceBlocks.length} 个候选上下文块，生成 ${blocks.length} 个替代块。`,
      evidence: [],
      risks: [],
      suggestedActions: [],
      outputs: {
        summary: "规则型上下文压缩已完成。",
        ...(fallbackReason ? { fallbackReason } : {}),
        sourceBlockIds: sourceBlocks.map((block) => block.id),
        blocks,
      },
      usage: {
        promptTokens: task.input.contextBlocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
        completionTokens: blocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
        totalTokens: blocks.reduce((sum, block) => sum + block.tokenEstimate, 0),
        toolCallCount: 0,
        durationMs: 0,
      },
      startedAt: now,
      finishedAt: now,
    };
  }
}

/**
 * 面向 ContextCompressor 的结构化适配器。
 * context 包只依赖 compact() 协议，不反向依赖 subagent 包。
 */
export class CompactionSubAgentRunnerAdapter {
  private readonly runner: SubAgentRunner;
  private readonly registration: SubAgentRegistration;

  constructor(options: CompactionSubAgentRunnerAdapterOptions) {
    this.runner = options.runner;
    this.registration = options.registration ?? createCompactionSubAgentRegistration();
  }

  async compact(task: CompactionRunnerTask): Promise<CompactionSubAgentOutput> {
    const subAgentTask = this.toSubAgentTask(task);
    const result = await this.runner.run(subAgentTask);
    if (result.status !== "succeeded") {
      throw new Error(result.error?.message ?? result.conclusion);
    }
    return parseCompactionOutput(result.outputs, task.blocks);
  }

  private toSubAgentTask(task: CompactionRunnerTask): SubAgentTask {
    const now = Date.now();
    return {
      id: newId("satask"),
      parentSessionId: task.id,
      parentRequestId: task.id,
      type: this.registration.type,
      title: "压缩上下文块",
      input: {
        goal: task.reason,
        successCriteria: [
          "返回符合上下文压缩输出契约的严格 JSON。",
          "保留会影响后续决策的事实、路径、错误和结论。",
          `替代块目标预算为 ${task.tokenBudget} tokens。`,
        ],
        constraints: [
          "不要压缩 pinned=true 的块。",
          "只允许把 candidateBlockIds 中的块写入 sourceBlockIds；protectedBlockIds 只能作为背景阅读。",
          "不要输出隐藏推理、内部 prompt 或 chain-of-thought。",
          ...(task.instructions ?? []),
        ],
        inputs: {
          tokenBudget: task.tokenBudget,
          expectedOutput: task.expectedOutput,
          candidateBlockIds: task.candidateBlockIds ?? [],
          protectedBlockIds: task.protectedBlockIds ?? [],
          instructions: task.instructions ?? [],
        },
        contextBlocks: task.blocks,
        memorySnapshot: [],
      },
      policy: this.registration.defaultPolicy,
      budget: this.registration.defaultBudget,
      createdAt: now,
      status: "pending",
      metadata: { promptNamespace: this.registration.promptNamespace },
    };
  }
}

function buildCompactionMessages(promptText: string, task: SubAgentTask): SubAgentChatMessage[] {
  const serializable = task.input.contextBlocks.map((block) => ({
    id: block.id,
    type: block.type,
    source: block.source,
    priority: block.priority,
    tokenEstimate: block.tokenEstimate,
    createdAt: block.createdAt,
    expiresAt: block.expiresAt,
    relevance: block.relevance,
    pinned: block.pinned,
    compressible: block.compressible,
    compressionStrategy: block.compressionStrategy,
    summaryRef: block.summaryRef,
    rawRef: block.rawRef,
    tags: block.tags,
    metadata: block.metadata,
    content: block.content,
  }));
  const user = {
    goal: task.input.goal,
    successCriteria: task.input.successCriteria,
    constraints: task.input.constraints,
    tokenBudget: task.input.inputs.tokenBudget,
    candidateBlockIds: readStringArray(task.input.inputs.candidateBlockIds),
    protectedBlockIds: readStringArray(task.input.inputs.protectedBlockIds),
    compressionInstructions: readStringArray(task.input.inputs.instructions),
    requiredOutput: COMPACTION_SUBAGENT_OUTPUT_CONTRACT,
    contextBlocks: serializable,
  };
  return [
    { role: "system", content: promptText },
    { role: "user", content: JSON.stringify(user, null, 2) },
  ];
}

function parseCompactionOutput(outputs: Record<string, unknown>, fallbackBlocks: ContextBlock[]): CompactionSubAgentOutput {
  const summary = typeof outputs.summary === "string" ? outputs.summary : "上下文已由压缩 SubAgent 处理。";
  const sourceBlockIds = readStringArray(outputs.sourceBlockIds);
  const blocks = Array.isArray(outputs.blocks)
    ? normalizeReplacementBlocks(outputs.blocks, fallbackBlocks, summary)
    : [];
  return {
    summary,
    sourceBlockIds: sourceBlockIds.length > 0 ? sourceBlockIds : collectSourceIdsFromBlocks(blocks, fallbackBlocks),
    blocks,
    ...(typeof outputs.fallbackReason === "string" ? { fallbackReason: outputs.fallbackReason } : {}),
  };
}

function parseModelCompactionOutput(text: string, sourceBlocks: ContextBlock[]): CompactionSubAgentOutput {
  const parsed = extractJsonObject(text);
  if (!isRecord(parsed)) throw new Error("compaction subagent did not return a JSON object");
  return parseCompactionOutput(parsed, sourceBlocks);
}

function normalizeReplacementBlocks(items: unknown[], sourceBlocks: ContextBlock[], fallbackSummary: string): ContextBlock[] {
  const sourceById = new Map(sourceBlocks.map((block) => [block.id, block]));
  const now = Date.now();
  const blocks: ContextBlock[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const sourceIds = readSourceBlockIds(item);
    const firstSource = sourceIds.map((id) => sourceById.get(id)).find((block): block is ContextBlock => Boolean(block));
    const content = typeof item.content === "string" && item.content.trim() ? item.content.trim() : fallbackSummary;
    const replacementId = typeof item.id === "string" ? item.id : newId("ctxb");
    const itemMetadata = isRecord(item.metadata) ? item.metadata : {};
    const compressedBy = typeof itemMetadata.compressedBy === "string" ? itemMetadata.compressedBy : "llm_compaction_subagent";
    const compactionNotice = typeof itemMetadata.compactionNotice === "string" ? itemMetadata.compactionNotice : "该内容由子智能体总结压缩";
    const candidate = {
      ...item,
      id: replacementId,
      type: typeof item.type === "string" ? item.type : "subagent_summary",
      source: "subagent_result",
      priority: typeof item.priority === "number" ? item.priority : Math.min(firstSource?.priority ?? 50, 50),
      tokenEstimate: typeof item.tokenEstimate === "number" ? item.tokenEstimate : defaultTokenEstimator.estimate(content),
      createdAt: typeof item.createdAt === "number" ? item.createdAt : firstSource?.createdAt ?? now,
      expiresAt: typeof item.expiresAt === "number" ? item.expiresAt : firstSource?.expiresAt,
      relevance: typeof item.relevance === "number" ? item.relevance : firstSource?.relevance ?? 0.5,
      // 子智能体摘要是原始块的替代物，必须进入最终上下文，否则等同于压缩后丢失信息。
      pinned: true,
      compressible: false,
      compressionStrategy: "summary",
      summaryRef: typeof item.summaryRef === "string" ? item.summaryRef : newId("sum"),
      sensitivity: typeof item.sensitivity === "string" ? item.sensitivity : firstSource?.sensitivity ?? "internal",
      content,
      rawRef: { kind: "subagent", id: replacementId },
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : ["compaction", "subagent"],
      metadata: {
        ...itemMetadata,
        sourceBlockIds: sourceIds.length > 0 ? sourceIds : sourceBlocks.map((block) => block.id),
        compressedBy,
        compactionNotice,
        ...(typeof itemMetadata.fallbackReason === "string" ? { fallbackReason: itemMetadata.fallbackReason } : {}),
      },
    };
    const parsed = ContextBlockSchema.safeParse(candidate);
    if (parsed.success) blocks.push(parsed.data);
  }
  return blocks;
}

function compactBlocksByRule(blocks: ContextBlock[], tokenBudget: unknown, fallbackReason?: string): ContextBlock[] {
  const maxChars = Math.max(800, Math.min(4_000, Number(tokenBudget || 2_000) * 3));
  return blocks
    .filter((block) => block.compressible && !block.pinned)
    .map((block) => createRuleSummaryBlock(block, maxChars, fallbackReason));
}

function createRuleSummaryBlock(block: ContextBlock, maxChars: number, fallbackReason?: string): ContextBlock {
  const reason = fallbackReason ?? (typeof block.metadata?.fallbackReason === "string" ? block.metadata.fallbackReason : undefined);
  const reasonLabel = reason ? ` fallbackReason=${reason}` : "";
  const content = `规则压缩摘要(${block.type}${reasonLabel}): ${block.content.replace(/\s+/g, " ").trim().slice(0, maxChars)}`;
  return {
    ...block,
    id: newId("ctxb"),
    type: "tool_summary",
    source: "subagent_result",
    priority: Math.min(block.priority, 50),
    tokenEstimate: defaultTokenEstimator.estimate(content),
    summaryRef: block.summaryRef ?? newId("sum"),
    pinned: true,
    compressible: false,
    compressionStrategy: "summary",
    content,
    rawRef: { kind: "subagent", id: block.id },
    tags: uniqueStrings([...block.tags, "compaction", "rule_fallback"]),
    metadata: {
      ...(block.metadata ?? {}),
      sourceBlockIds: [block.id],
      compressedBy: "rule_compaction_subagent",
      compactionNotice: "该内容由规则型压缩 fallback 处理，真实压缩子智能体未成功返回结构化结果",
      ...(reason ? { fallbackReason: reason } : {}),
    },
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("no JSON object found in compaction output");
  }
}

function readSourceBlockIds(item: Record<string, unknown>): string[] {
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  return uniqueStrings([
    ...readStringArray(item.sourceBlockIds),
    ...readStringArray(metadata?.sourceBlockIds),
    ...(typeof metadata?.sourceBlockId === "string" ? [metadata.sourceBlockId] : []),
  ]);
}

function collectSourceIdsFromBlocks(blocks: ContextBlock[], fallbackBlocks: ContextBlock[]): string[] {
  const fromBlocks = blocks.flatMap((block) => readStringArray(block.metadata?.sourceBlockIds));
  return uniqueStrings(fromBlocks.length > 0 ? fromBlocks : fallbackBlocks.map((block) => block.id));
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
