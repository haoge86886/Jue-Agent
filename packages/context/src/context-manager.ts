/**
 * @file useChatStore.ts
 * @module @jue/cli/ui/state/useChatStore
 *
 * 终端聊天界面的核心状态机
 *
 * 关键设计:
 * - `items` 只保存已经完成且不会再变化的消息, 交给 Ink `<Static>` 组件追加渲染
 * - `live` 单独保存正在流式输出的 assistant 文本, 避免每个 delta 都重新渲染历史消息
 * - delta 先累积到 ref, 再按固定间隔刷新到 React state, 降低 Ink 闪烁和抖动
 * - tool 调用开始前会先提交当前 live 文本, 保证回答段落和工具卡片展示顺序稳定
 */
/**
 * ContextManager 负责管理所有上下文块的组装、优先级、缓存、压缩与预算，为模型提供稳定可用的上下文
 * 核心职责：统一管理 prompt 结构、优先级排序、过期清理、去重、压缩，将各类输入转换为标准 ContextBlock
 * 自动根据上下文预算压力执行规则压缩或 LLM 压缩，保证在 token 限制内提供最高价值信息，最终输出 ChatMessage[]
 */
import type {
  ContextAssembly,
  ContextBlock,
  ContextBlockType,
  ContextBudget,
  ContextCompressionResult,
  Id,
  MemoryRecord,
  Message,
  MessagePart,
  Role,
  SubAgentTask,
} from "@jue/shared-types";
import { defaultTokenEstimator, getModuleLogger, newId } from "@jue/utils";
import { GreedyContextBudgeter, getContextCeiling, type ContextBudgeter, type ContextBudgetPressure } from "./budgeter.js";
import { NoopContextCacheStore, type ContextCacheStore } from "./cache-store.js";
import { NoopContextCompressor, type ContextCompressor, type RuleCompressionOptions } from "./compressor.js";
import { InMemoryToolResultStore, type ToolResultQuery, type ToolResultStore } from "./tool-result-store.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_BUDGET: ContextBudget = {
  totalTokenBudget: 16_000,
  reservedForResponse: 1_024,
  reservedForSystem: 0,
  reservedForTools: 0,
  reservedForMemory: 0,
};

const DEFAULT_SUBAGENT_BUDGET: ContextBudget = {
  totalTokenBudget: 8_000,
  reservedForResponse: 512,
  reservedForSystem: 0,
  reservedForTools: 0,
  reservedForMemory: 0,
};

// 优先级定义，数值越高越不容易被淘汰，pinned=true 会强制保留
const PRIORITY: Record<ContextBlockType, number> = {
  system_instruction: 100,
  global_rules: 100,
  user_input: 100,
  tool_summary: 50,
  subagent_summary: 30,
  subagent_system_prompt: 100,
  subagent_task: 98,
  subagent_tool_list: 92,
  subagent_output_format: 92,
  subagent_memory: 55,
  user_memory: 55,
  team_memory: 50,
  global_memory: 45,
  conversation_short_term: 40,
  recent_messages: 80,
  shell_history: 35,
  tool_result_history: 60,
  user_attachment: 70,
  task_state: 90,
  environment: 20,
  frontend_capabilities: 15,
  session_flags: 12,
  remote_device_status: 10,
  custom: 5,
};

// 只保留消息类型 Block，用于后续构建 ChatMessage，其他类型交给 system 上下文渲染
const MESSAGE_BLOCK_TYPES = new Set<ContextBlockType>(["recent_messages", "user_input"]);

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string;
  blockId?: Id;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface AssembleInput {
  sessionId: Id;
  requestId: Id;
  systemPromptText: string;
  systemPromptSnapshotId?: Id;
  recentMessages: Message[];
  extraBlocks?: ContextBlock[];
  budget?: ContextBudget;
}

export interface AssembleOutput {
  assembly: ContextAssembly;
  messages: ChatMessage[];
}

export interface SubAgentToolDescriptor {
  name: string;
  description?: string;
  kind?: string;
  inputSchema?: unknown;
}

export interface MainAgentContextInput extends AssembleInput {
  currentUserInputText?: string;
  memoryRecords?: MemoryRecord[];
  memoryBlocks?: ContextBlock[];
  attachments?: MessagePart[];
  attachmentBlocks?: ContextBlock[];
  shellHistoryBlocks?: ContextBlock[];
  toolResultBlocks?: ContextBlock[];
  toolResultQuery?: ToolResultQuery;
  taskState?: string;
  taskStateBlocks?: ContextBlock[];
  environmentBlocks?: ContextBlock[];
  frontendCapabilityBlocks?: ContextBlock[];
  sessionFlagBlocks?: ContextBlock[];
  remoteDeviceBlocks?: ContextBlock[];
  customBlocks?: ContextBlock[];
  persistedCompressedBlocks?: ContextBlock[];
  preserveRecentMessageCount?: number;
  allowLlmCompression?: boolean;
  /** 是否强制执行 LLM 压缩，会忽略当前压力状态，直接由 runner 触发 */
  forceLlmCompression?: boolean;
  /** 是否强制执行规则压缩，会忽略配置与压力，直接在构建流程中执行 */
  forceRuleCompression?: boolean;
}

export interface BuildForSubAgentInput {
  sessionId: Id;
  requestId: Id;
  task: SubAgentTask;
  subagentSystemPromptText: string;
  tools?: SubAgentToolDescriptor[];
  outputFormat?: string;
  inheritedBlocks?: ContextBlock[];
  memoryRecords?: MemoryRecord[];
  memoryBlocks?: ContextBlock[];
  budget?: ContextBudget;
  allowLlmCompression?: boolean;
  forceLlmCompression?: boolean;
  forceRuleCompression?: boolean;
}

interface PipelineOptions {
  allowLlmCompression?: boolean;
  forceLlmCompression?: boolean;
  forceRuleCompression?: boolean;
}

export interface ContextBuildOutput extends AssembleOutput {
  pressure: ContextBudgetPressure;
  compressedBlockIds: Id[];
  cacheHitKeys: string[];
}

export interface ContextManagerOptions {
  budgeter?: ContextBudgeter;
  compressor?: ContextCompressor;
  cacheStore?: ContextCacheStore;
  toolResultStore?: ToolResultStore;
  defaultBudget?: ContextBudget;
  defaultSubAgentBudget?: ContextBudget;
  estimateTokens?: (text: string) => number;
  ruleCompressionOptions?: RuleCompressionOptions;
  runRuleCompressionEveryBuild?: boolean;
}

interface BuildState {
  sourceOrder: number;
}

interface BlockOptions {
  priority?: number;
  createdAt?: number;
  expiresAt?: number;
  relevance?: number;
  pinned?: boolean;
  compressible?: boolean;
  compressionStrategy?: ContextBlock["compressionStrategy"];
  cacheKey?: string;
  summaryRef?: Id;
  rawRef?: ContextBlock["rawRef"];
  tags?: string[];
  metadata?: Record<string, unknown>;
  sensitivity?: ContextBlock["sensitivity"];
}

export class ContextManager {
  private readonly logger = getModuleLogger("context");
  private readonly budgeter: ContextBudgeter;
  private readonly compressor: ContextCompressor;
  private readonly cacheStore: ContextCacheStore;
  private readonly toolResultStore: ToolResultStore;
  private readonly estimate: (text: string) => number;
  private readonly defaultBudget: ContextBudget;
  private readonly defaultSubAgentBudget: ContextBudget;
  private readonly ruleCompressionOptions: RuleCompressionOptions;
  private readonly runRuleCompressionEveryBuild: boolean;
  private buildState: BuildState = { sourceOrder: 0 };

  constructor(options: ContextManagerOptions = {}) {
    this.budgeter = options.budgeter ?? new GreedyContextBudgeter();
    this.compressor = options.compressor ?? new NoopContextCompressor();
    this.cacheStore = options.cacheStore ?? new NoopContextCacheStore();
    this.toolResultStore = options.toolResultStore ?? new InMemoryToolResultStore();
    this.estimate = options.estimateTokens ?? ((text) => defaultTokenEstimator.estimate(text));
    this.defaultBudget = options.defaultBudget ?? DEFAULT_BUDGET;
    this.defaultSubAgentBudget = options.defaultSubAgentBudget ?? DEFAULT_SUBAGENT_BUDGET;
    this.ruleCompressionOptions = options.ruleCompressionOptions ?? {};
    this.runRuleCompressionEveryBuild = options.runRuleCompressionEveryBuild ?? true;
  }

  getToolResultStore(): ToolResultStore {
    return this.toolResultStore;
  }

  /**
   * 基础上下文组装，不执行压缩，只做块构建、缓存应用、预算统计
   * 适合轻量场景使用，不触发任何压缩逻辑，直接根据输入构建上下文块并统计预算，返回最终上下文与消息
   */
  assemble(input: AssembleInput): AssembleOutput {
    const budget = input.budget ?? this.defaultBudget;
    const cached = this.applyCache(this.buildMainBlocks(input));
    const assembly = this.finalizeBudget(input.sessionId, input.requestId, budget, cached.blocks, [], cached.cacheHitKeys);
    const messages = this.messagesForMainAgent(assembly.blocks, input.recentMessages);
    this.logAssembly(input.sessionId, input.requestId, assembly);
    return { assembly, messages };
  }

  /** 为主代理构建完整上下文，执行完整流水线：选择器 -> 预算器 -> 压缩器 */
  async buildForMainAgent(input: MainAgentContextInput): Promise<ContextBuildOutput> {
    const budget = input.budget ?? this.defaultBudget;
    const pipelineOptions = pipelineOptionsFrom(input);
    const pipeline = await this.runPipeline(input.sessionId, input.requestId, budget, this.buildMainBlocks(input), pipelineOptions);
    return {
      ...pipeline,
      messages: this.messagesForMainAgent(pipeline.assembly.blocks, input.recentMessages, input.currentUserInputText),
    };
  }

  /** 为子代理构建上下文，继承部分上下文块，使用独立预算与专用系统提示 */
  async buildForSubAgent(input: BuildForSubAgentInput): Promise<ContextBuildOutput> {
    const budget = input.budget ?? this.defaultSubAgentBudget;
    const pipelineOptions = pipelineOptionsFrom(input);
    const pipeline = await this.runPipeline(input.sessionId, input.requestId, budget, this.buildSubAgentBlocks(input), pipelineOptions);
    return { ...pipeline, messages: this.messagesForSubAgent(pipeline.assembly.blocks) };
  }

  /**
   * 主代理与子代理共用的上下文构建流水线
   * 执行流程：缓存加载 → 规则压缩（按需）→ LLM 压缩（按需）→ 预算最终裁剪 → 输出上下文
   * 所有压缩策略与预算控制都在此流程中统一执行，保证上下文在 token 限制内保持最高质量与稳定性
   */
  private async runPipeline(
    sessionId: Id,
    requestId: Id,
    budget: ContextBudget,
    sourceBlocks: ContextBlock[],
    options: PipelineOptions = {},
  ): Promise<Omit<ContextBuildOutput, "messages">> {
    const cached = this.applyCache(sourceBlocks);
    let blocks = cached.blocks;
    const compressionResults: ContextCompressionResult[] = [];
    const pressure = this.budgeter.inspect({ blocks, budget });

    if (options.forceRuleCompression || this.runRuleCompressionEveryBuild || pressure.pressure !== "normal") {
      const result = await this.compressor.compressByRules(blocks, {
        ...this.ruleCompressionOptions,
        forceRecentCompression: pressure.pressure === "overflow" || pressure.pressure === "llm_compress",
      });
      this.persistToolCompressionResults(blocks, result.blocks, result.results);
      blocks = result.blocks;
      compressionResults.push(...result.results);
    }

    const afterRule = this.budgeter.inspect({ blocks, budget });
    const allowLlmCompression = options.allowLlmCompression !== false;
    const shouldUseLlmCompression =
      options.forceLlmCompression || afterRule.pressure === "overflow" || afterRule.pressure === "llm_compress";

    if (allowLlmCompression && !afterRule.compressionCircuitOpen && shouldUseLlmCompression) {
      const result = await this.compressor.compressWithLlm(blocks, {
        tokenBudget: Math.max(1_024, Math.floor(getContextCeiling(budget) * 0.7)),
        reason: `context budget pressure=${afterRule.pressure}`,
        expectedOutput: "context_blocks",
      });

      const hadLlmCandidates = hasLlmCompressionCandidates(blocks);
      if (result.results.length > 0) {
        this.persistToolCompressionResults(blocks, result.blocks, result.results);
        blocks = result.blocks;
        compressionResults.push(...result.results);
        this.budgeter.recordCompressionSuccess();
      } else {
        if (hadLlmCandidates) this.budgeter.recordCompressionFailure();
      }
    }

    const assembly = this.finalizeBudget(sessionId, requestId, budget, blocks, compressionResults, cached.cacheHitKeys);
    const finalPressure = this.budgeter.inspect({ blocks: assembly.blocks, budget });
    this.logAssembly(sessionId, requestId, assembly);

    return {
      assembly,
      pressure: finalPressure.pressure,
      compressedBlockIds: assembly.compressedBlockIds,
      cacheHitKeys: assembly.cacheHitKeys,
    };
  }

  private persistToolCompressionResults(
    beforeBlocks: ContextBlock[],
    afterBlocks: ContextBlock[],
    results: ContextCompressionResult[],
  ): void {
    if (results.length === 0) return;
    const beforeById = new Map(beforeBlocks.map((block) => [block.id, block]));

    for (const result of results) {
      const original = beforeById.get(result.blockId);
      const rawId = original?.rawRef?.kind === "tool_result" ? original.rawRef.id : undefined;
      if (!rawId) continue;

      const replacement = findReplacementForSource(afterBlocks, result.blockId) ?? afterBlocks.find((block) => block.id === result.blockId);
      const summary = replacement?.content ?? original?.content;
      if (!summary) continue;

      const stored = this.toolResultStore.setSummary(rawId, summary, result.summaryRef);
      if (stored) this.toolResultStore.clearRawContent(rawId);
    }
  }

  private finalizeBudget(
    sessionId: Id,
    requestId: Id,
    budget: ContextBudget,
    blocks: ContextBlock[],
    results: ContextCompressionResult[],
    cacheHitKeys: string[],
  ): ContextAssembly {
    const assembly = this.budgeter.budget({
      sessionId,
      requestId,
      budget,
      blocks: blocks.map((block) => this.normalizeBlock(block))
    });
    return {
      ...assembly,
      compressedBlockIds: unique(results.map((result) => result.blockId)),
      cacheHitKeys: unique(cacheHitKeys)
    };
  }

  /** 构建主代理所有上下文块，包含系统提示、消息、内存、附件、工具结果、环境、任务状态等全部来源 */
  private buildMainBlocks(input: MainAgentContextInput | AssembleInput): ContextBlock[] {
    const now = Date.now();
    const blocks: ContextBlock[] = [];
    this.buildState = { sourceOrder: 0 };

    const latestUser = findLatestUserMessage(input.recentMessages);
    const mainInput = input as MainAgentContextInput;
    const protectedMessageIds = collectProtectedRecentMessageIds(
      input.recentMessages,
      mainInput.preserveRecentMessageCount ?? 0
    );

    if (input.systemPromptText.trim()) {
      const block = this.block("system_instruction", "static_prompt", input.systemPromptText, {
        createdAt: now,
        expiresAt: now + HOUR_MS,
        pinned: true,
        compressible: false,
        compressionStrategy: "none",
        relevance: 1,
        tags: ["prompt", "main_agent"],
      });
      if (input.systemPromptSnapshotId) {
        block.cacheKey = input.systemPromptSnapshotId;
        block.rawRef = { kind: "other", id: input.systemPromptSnapshotId };
      }
      blocks.push(block);
    }

    for (const [messageIndex, message] of input.recentMessages.entries()) {
      const content = renderMessageToText(message);
      if (!content) continue;

      const isCurrentUserInput = message.id === latestUser?.id && message.role === "user";
      const isProtectedRecentMessage = protectedMessageIds.has(message.id);
      const hasToolProtocolPart = message.parts.some(
        (part) => part.type === "tool_call" || part.type === "tool_result"
      );

      blocks.push(this.block(
        isCurrentUserInput ? "user_input" : "recent_messages",
        isCurrentUserInput ? "user_input" : "session",
        content,
        {
          createdAt: message.createdAt,
          expiresAt: message.createdAt + DAY_MS,
          pinned: isCurrentUserInput || isProtectedRecentMessage,
          compressible: !isCurrentUserInput && !isProtectedRecentMessage && !hasToolProtocolPart,
          compressionStrategy: isCurrentUserInput || isProtectedRecentMessage ? "none" : "rule_truncate",
          relevance: isCurrentUserInput || isProtectedRecentMessage ? 1 : messageRelevance(message),
          priority: isCurrentUserInput || isProtectedRecentMessage ? PRIORITY.user_input : messagePriority(message),
          tags: ["message", message.role],
          rawRef: { kind: "other", id: message.id },
          metadata: {
            messageIndex,
            toolName: firstToolNameInMessage(message),
          },
        }
      ));
    }

    applyHistoricalRelevanceDecay(blocks, input.recentMessages.length);

    if (mainInput.currentUserInputText?.trim() && !latestUser) {
      blocks.push(this.block("user_input", "user_input", mainInput.currentUserInputText, {
        createdAt: now,
        expiresAt: now + DAY_MS,
        pinned: true,
        compressible: false,
        compressionStrategy: "none",
        relevance: 1,
        tags: ["message", "user", "synthetic"],
      }));
    }

    blocks.push(...this.normalizeBlocks(mainInput.memoryBlocks ?? []));

    if (mainInput.attachments) {
      blocks.push(...this.attachmentsToBlocks(mainInput.attachments));
    }
    blocks.push(...this.normalizeBlocks(mainInput.attachmentBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.shellHistoryBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.toolResultBlocks ?? []));
    blocks.push(...this.toolResultStore.toContextBlocks(mainInput.toolResultQuery ?? { limit: 20 }));

    if (mainInput.taskState?.trim()) {
      blocks.push(this.block("task_state", "session", mainInput.taskState, {
        createdAt: now,
        expiresAt: now + DAY_MS,
        pinned: true,
        compressible: false,
        compressionStrategy: "none",
        relevance: 1,
        tags: ["task_state"],
      }));
    }

    blocks.push(...this.normalizeBlocks(mainInput.taskStateBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.environmentBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.frontendCapabilityBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.sessionFlagBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.remoteDeviceBlocks ?? []));
    blocks.push(...this.normalizeBlocks(mainInput.customBlocks ?? []));
    blocks.push(...this.normalizePersistedCompressedBlocks(mainInput.persistedCompressedBlocks ?? []));
    blocks.push(...this.normalizeBlocks(input.extraBlocks ?? []));

    return blocks;
  }

  /** 标准化持久化压缩块，统一标记为子代理结果，不可再压缩 */
  private normalizePersistedCompressedBlocks(blocks: ContextBlock[]): ContextBlock[] {
    return this.normalizeBlocks(blocks).map((block) => ({
      ...block,
      source: "subagent_result",
      pinned: false,
      compressible: false,
      compressionStrategy: "summary",
      metadata: {
        ...(block.metadata ?? {}),
        persisted: true,
      },
    }));
  }

  private buildSubAgentBlocks(input: BuildForSubAgentInput): ContextBlock[] {
    const now = Date.now();
    const blocks: ContextBlock[] = [];
    this.buildState = { sourceOrder: 0 };

    blocks.push(this.block("subagent_system_prompt", "subagent_prompt", input.subagentSystemPromptText, {
      createdAt: now,
      expiresAt: now + HOUR_MS,
      pinned: true,
      compressible: false,
      compressionStrategy: "none",
      relevance: 1,
      tags: ["prompt", "subagent", input.task.type],
    }));

    blocks.push(this.block("subagent_task", "system", renderSubAgentTask(input.task), {
      createdAt: input.task.createdAt,
      expiresAt: input.task.createdAt + DAY_MS,
      pinned: true,
      compressible: false,
      compressionStrategy: "none",
      relevance: 1,
      tags: ["task", input.task.type],
      rawRef: { kind: "subagent", id: input.task.id },
    }));

    blocks.push(this.block("subagent_tool_list", "system", renderSubAgentTools(input), {
      createdAt: now,
      expiresAt: now + HOUR_MS,
      pinned: true,
      compressible: false,
      compressionStrategy: "none",
      relevance: 1,
      tags: ["tools", input.task.type],
    }));

    blocks.push(this.block("subagent_output_format", "system", input.outputFormat ?? defaultSubAgentOutputFormat(), {
      createdAt: now,
      expiresAt: now + HOUR_MS,
      pinned: true,
      compressible: false,
      compressionStrategy: "none",
      relevance: 1,
      tags: ["output_format", input.task.type],
    }));

    if (input.memoryRecords) {
      blocks.push(...this.memoryRecordsToBlocks(input.memoryRecords, "subagent_memory"));
    }
    blocks.push(...this.normalizeBlocks(input.memoryBlocks ?? []).map((block) => ({
      ...block,
      type: "subagent_memory" as const
    })));

    blocks.push(...this.filterSubAgentInheritedBlocks(input.task.input.contextBlocks, input.task, true));
    blocks.push(...this.filterSubAgentInheritedBlocks(input.inheritedBlocks ?? [], input.task, false));

    return blocks;
  }

  private filterSubAgentInheritedBlocks(blocks: ContextBlock[], task: SubAgentTask, preselected: boolean): ContextBlock[] {
    const allowed = new Set(task.policy?.allowedContextTypes ?? []);
    return blocks
      .filter((block) => preselected || allowed.has(block.type))
      .map((block) => this.normalizeBlock({
        ...block,
        metadata: { ...(block.metadata ?? {}), inheritedBySubAgent: task.type },
      }));
  }

  private memoryRecordsToBlocks(records: MemoryRecord[], forcedType?: ContextBlockType): ContextBlock[] {
    return records.map((record) => {
      const type = forcedType ?? memoryScopeToBlockType(record.scope);
      const content = renderMemoryBlockContent(record);
      return this.block(type, "memory", content, {
        createdAt: record.createdAt,
        expiresAt: record.expiresAt ?? record.createdAt + 7 * DAY_MS,
        relevance: Math.max(record.weight, record.confidence),
        compressible: true,
        compressionStrategy: "rule_extract",
        sensitivity: record.sensitivity,
        tags: ["memory", record.scope, record.kind, ...record.tags],
        rawRef: { kind: "memory", id: record.id },
        metadata: {
          scope: record.scope,
          ownerId: record.ownerId,
          status: record.status,
          confidence: record.confidence
        },
      });
    });
  }

  private attachmentsToBlocks(parts: MessagePart[]): ContextBlock[] {
    const now = Date.now();
    return parts.map((part) => this.block("user_attachment", "user_input", renderAttachment(part), {
      createdAt: now,
      expiresAt: now + DAY_MS,
      relevance: 0.9,
      compressible: part.type !== "text",
      compressionStrategy: part.type === "text" ? "none" : "rule_extract",
      tags: ["attachment", part.type],
    }));
  }

  private normalizeBlocks(blocks: ContextBlock[]): ContextBlock[] {
    return blocks.map((block) => this.normalizeBlock(block));
  }

  /** 标准化单个块，补全缺失字段，确保优先级、token 估值、过期时间、相关性等字段合法可用 */
  private normalizeBlock(block: ContextBlock): ContextBlock {
    const next: ContextBlock = {
      ...block,
      priority: block.priority ?? PRIORITY[block.type],
      tokenEstimate: block.tokenEstimate ?? this.estimate(block.content),
      expiresAt: block.expiresAt ?? defaultExpiresAt(block.createdAt, block.type),
      relevance: clamp01(block.relevance ?? 0.5),
      pinned: block.pinned ?? false,
      compressible: block.type === "task_state" ? false : (block.compressible ?? true),
      tags: block.tags ?? [],
    };

    if (block.type === "task_state") {
      next.pinned = true;
      next.compressionStrategy = "none";
    }

    return next;
  }

  private block(type: ContextBlockType, source: ContextBlock["source"], content: string, options: BlockOptions = {}): ContextBlock {
    const createdAt = options.createdAt ?? Date.now();
    const sourceOrder = this.buildState.sourceOrder++;
    const block: ContextBlock = {
      id: newId("ctxb"),
      type,
      source,
      priority: options.priority ?? PRIORITY[type],
      tokenEstimate: this.estimate(content),
      createdAt,
      expiresAt: options.expiresAt ?? defaultExpiresAt(createdAt, type),
      relevance: clamp01(options.relevance ?? 0.5),
      pinned: options.pinned ?? false,
      compressible: options.compressible ?? type !== "task_state",
      compressionStrategy: options.compressionStrategy ?? "rule_truncate",
      sensitivity: options.sensitivity ?? "internal",
      content,
      tags: options.tags ?? [],
      metadata: { sourceOrder, renderOrder: sourceOrder },
    };

    if (type === "task_state") {
      block.pinned = true;
      block.compressible = false;
      block.compressionStrategy = "none";
    }

    if (options.cacheKey) block.cacheKey = options.cacheKey;
    if (options.summaryRef) block.summaryRef = options.summaryRef;
    if (options.rawRef) block.rawRef = options.rawRef;
    if (options.metadata) block.metadata = { ...block.metadata, ...options.metadata };

    return block;
  }

  /** 应用块缓存，命中则直接使用缓存结果，未命中则存入缓存，减少重复计算 */
  private applyCache(blocks: ContextBlock[]): { blocks: ContextBlock[]; cacheHitKeys: string[] } {
    const next: ContextBlock[] = [];
    const cacheHitKeys: string[] = [];

    for (const block of blocks.map((item) => this.normalizeBlock(item))) {
      if (!block.cacheKey) {
        next.push(block);
        continue;
      }

      const cached = this.cacheStore.get(block.cacheKey);
      if (cached) {
        next.push(this.normalizeBlock(cached));
        cacheHitKeys.push(block.cacheKey);
      } else {
        this.cacheStore.set(block.cacheKey, block);
        next.push(block);
      }
    }

    return { blocks: next, cacheHitKeys };
  }

  /** 为主代理生成最终可发送给模型的消息列表，合并系统前缀与历史消息 */
  private messagesForMainAgent(blocks: ContextBlock[], recentMessages: Message[], fallbackUserInputText?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemPrefix = collectSystemPrefix(sortBlocksForRender(blocks));

    if (systemPrefix) {
      messages.push({ role: "system", content: systemPrefix });
    }

    const keptHistory = selectMessagesKeptByBlocks(recentMessages, blocks);
    const chatHistory = sanitizeToolProtocol(messagesFromHistory(keptHistory));
    messages.push(...chatHistory);

    if (chatHistory.length === 0 && fallbackUserInputText?.trim()) {
      messages.push({ role: "user", content: fallbackUserInputText });
    }

    return messages;
  }

  private messagesForSubAgent(blocks: ContextBlock[]): ChatMessage[] {
    const systemContent = collectSystemPrefix(
      sortBlocksForRender(blocks).filter((block) => block.type !== "subagent_task")
    );

    const taskContent = blocks
      .filter((block) => block.type === "subagent_task")
      .map((block) => block.content)
      .join("\n\n");

    const messages: ChatMessage[] = [];
    if (systemContent) messages.push({ role: "system", content: systemContent });
    messages.push({ role: "user", content: taskContent || "No subagent task provided." });

    return messages;
  }

  private logAssembly(sessionId: Id, requestId: Id, assembly: ContextAssembly): void {
    this.logger.debug({
      sessionId,
      requestId,
      kept: assembly.blocks.length,
      dropped: assembly.droppedBlockIds.length,
      compressed: assembly.compressedBlockIds.length,
      cacheHits: assembly.cacheHitKeys.length,
      totalTokens: assembly.totalTokens,
    }, "context assembled");
  }
}

function findReplacementForSource(blocks: ContextBlock[], sourceBlockId: Id): ContextBlock | undefined {
  return blocks.find((block) => {
    const sourceIds = block.metadata?.sourceBlockIds;
    return Array.isArray(sourceIds) && sourceIds.some((id) => id === sourceBlockId);
  });
}

function hasLlmCompressionCandidates(blocks: ContextBlock[]): boolean {
  return blocks.some((block) => {
    if (block.pinned || !block.compressible) return false;
    if (block.metadata?.compressedBy === "llm_compaction_subagent") return false;

    return block.type !== "system_instruction" &&
      block.type !== "global_rules" &&
      block.type !== "subagent_system_prompt" &&
      block.type !== "subagent_task" &&
      block.type !== "subagent_output_format" &&
      block.type !== "user_input" &&
      block.type !== "task_state";
  });
}

function renderMessageToText(message: Message): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "image") parts.push("[image]");
    else if (part.type === "file") parts.push(`[file:${part.name ?? "<unnamed>"}]`);
    else if (part.type === "tool_call") parts.push(`[tool_call:${part.toolName} args=${part.arguments}]`);
    else if (part.type === "tool_result") parts.push(`[tool_result:${part.toolName}${part.isError ? " error" : ""}]\n${part.content}`);
  }
  return parts.join("\n").trim();
}

function renderAttachment(part: MessagePart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image") {
    return ["[image attachment]", `mimeType=${part.mimeType}`, part.url ? `url=${part.url}` : undefined, part.base64 ? `base64Bytes=${part.base64.length}` : undefined]
      .filter(Boolean)
      .join("\n");
  }
  if (part.type === "file") {
    return ["[file attachment]", part.name ? `name=${part.name}` : undefined, `mimeType=${part.mimeType}`, part.path ? `path=${part.path}` : undefined, part.url ? `url=${part.url}` : undefined, part.size !== undefined ? `size=${part.size}` : undefined]
      .filter(Boolean)
      .join("\n");
  }
  if (part.type === "tool_call") return `[tool_call:${part.toolName}]\n${part.arguments}`;
  return `[tool_result:${part.toolName}]\n${part.content}`;
}

function collectSystemPrefix(blocks: ContextBlock[]): string {
  const renderable = blocks.filter((block) => shouldRenderBlockInSystemPrefix(block));
  const consumed = new Set<Id>();

  const sections = [
    renderContextSection("System And Rules", renderable, consumed, isInstructionSectionBlock),
    renderContextSection("Task State", renderable, consumed, isTaskStateSectionBlock),
    renderContextSection("Runtime And Frontend", renderable, consumed, isRuntimeSectionBlock),
    renderContextSection("Memory", renderable, consumed, isMemorySectionBlock),
    renderContextSection("Compressed Conversation", renderable, consumed, isCompressedConversationSectionBlock),
    renderContextSection("Tools And SubAgents", renderable, consumed, isToolingSectionBlock),
    renderContextSection("Tool And Shell History", renderable, consumed, isToolHistorySectionBlock),
    renderContextSection("User Attachments", renderable, consumed, (block) => block.type === "user_attachment"),
    renderContextSection("Other Context", renderable, consumed, () => true),
  ].filter((section) => section.length > 0);

  if (sections.length === 0) return "";

  return [
    "The following context is visible to the model for this turn. Sections are grouped by purpose; compressed blocks contain summaries or retrieval notices. Re-run the relevant tool or ask the user if exact original content is needed.",
    ...sections,
  ].join("\n\n");
}

function formatBlockForSystemPrompt(block: ContextBlock): string {
  if (block.type === "system_instruction" || block.type === "subagent_system_prompt") return block.content.trim();
  if (isSubAgentCompressedBlock(block)) return renderSubAgentCompressedNotice(block);
  if (isCompressedMessageBlock(block)) return renderCompressedMessageNotice(block);
  if (isCompressedToolLikeBlock(block)) return renderCompressedToolNotice(block);

  return [
    `<context_block id="${block.id}" type="${block.type}" source="${block.source}" relevance="${formatRelevance(block.relevance)}">`,
    block.content.trim(),
    "</context_block>",
  ].join("\n");
}

function renderContextSection(
  title: string,
  blocks: ContextBlock[],
  consumed: Set<Id>,
  predicate: (block: ContextBlock) => boolean,
): string {
  const selected = blocks.filter((block) => !consumed.has(block.id) && predicate(block));
  if (selected.length === 0) return "";

  for (const block of selected) consumed.add(block.id);
  const body = selected.map(formatBlockForSystemPrompt).filter((text) => text.length > 0).join("\n\n---\n\n");
  return body.length > 0 ? [`## ${title}`, body].join("\n") : "";
}

function isInstructionSectionBlock(block: ContextBlock): boolean {
  return block.type === "system_instruction" || block.type === "global_rules" || block.type === "subagent_system_prompt";
}

function isTaskStateSectionBlock(block: ContextBlock): boolean {
  return block.type === "task_state" || block.type === "subagent_task";
}

function isRuntimeSectionBlock(block: ContextBlock): boolean {
  return block.type === "environment" ||
    block.type === "frontend_capabilities" ||
    block.type === "session_flags" ||
    block.type === "remote_device_status";
}

function isMemorySectionBlock(block: ContextBlock): boolean {
  return block.type === "user_memory" ||
    block.type === "team_memory" ||
    block.type === "global_memory" ||
    block.type === "conversation_short_term" ||
    block.type === "subagent_memory";
}

function isToolingSectionBlock(block: ContextBlock): boolean {
  return block.type === "tool_summary" ||
    block.type === "subagent_tool_list" ||
    block.type === "subagent_output_format";
}

function isCompressedConversationSectionBlock(block: ContextBlock): boolean {
  return isCompressedMessageBlock(block) || isSubAgentCompressedBlock(block);
}

function isToolHistorySectionBlock(block: ContextBlock): boolean {
  return block.type === "tool_result_history" || block.type === "shell_history";
}

function sortBlocksForRender(blocks: ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((left, right) => blockRenderOrder(left) - blockRenderOrder(right));
}

function blockRenderOrder(block: ContextBlock): number {
  const raw = block.metadata?.renderOrder ?? block.metadata?.sourceOrder;
  return typeof raw === "number" ? raw : block.createdAt;
}

function isSubAgentCompressedBlock(block: ContextBlock): boolean {
  return block.source === "subagent_result" && block.metadata?.compressedBy === "llm_compaction_subagent";
}

function renderSubAgentCompressedNotice(block: ContextBlock): string {
  const sourceIds = Array.isArray(block.metadata?.sourceBlockIds)
    ? block.metadata.sourceBlockIds.filter((item): item is string => typeof item === "string")
    : [];

  return [
    `<compressed_context id="${block.id}" type="${block.type}" source="${block.source}" relevance="${formatRelevance(block.relevance)}">`,
    "This content was summarized and compacted by a subagent.",
    sourceIds.length > 0 ? `sourceBlockIds=${sourceIds.join(",")}` : "",
    block.summaryRef ? `summaryRef=${block.summaryRef}` : "",
    block.content.trim(),
    "If exact original content is needed, re-run the relevant tool or ask the user for it.",
    "</compressed_context>",
  ].filter(Boolean).join("\n");
}

function isCompressedToolLikeBlock(block: ContextBlock): boolean {
  const compressedBy = block.metadata?.compressedBy;
  return Boolean(block.summaryRef || typeof compressedBy === "string") && (
    block.type === "tool_result_history" ||
    block.type === "shell_history" ||
    block.type === "tool_summary"
  );
}

function renderCompressedToolNotice(block: ContextBlock): string {
  const toolName = typeof block.metadata?.toolName === "string" ? block.metadata.toolName : block.tags.find((tag) => tag !== "tool" && tag !== "shell");
  const label = toolName ? `Tool result ${toolName}` : `Tool result ${block.id}`;

  return [
    `<compressed_context id="${block.id}" type="${block.type}" source="${block.source}" relevance="${formatRelevance(block.relevance)}">`,
    `${label} has been compressed. Re-run the corresponding tool if full output is needed.`,
    block.summaryRef ? `summaryRef=${block.summaryRef}` : "",
    "</compressed_context>",
  ].filter(Boolean).join("\n");
}

function renderCompressedMessageNotice(block: ContextBlock): string {
  return [
    `<compressed_context id="${block.id}" type="${block.type}" source="${block.source}" relevance="${formatRelevance(block.relevance)}">`,
    "Historical conversation content has been compressed and exact original text is no longer included.",
    block.summaryRef ? `summaryRef=${block.summaryRef}` : "",
    block.content.trim().length > 0 ? `Summary or retained note: ${stripCompressionMarker(block.content.trim())}` : "",
    "If exact historical details are required, ask the user or re-read the relevant files/tool results.",
    "</compressed_context>",
  ].filter(Boolean).join("\n");
}

function stripCompressionMarker(content: string): string {
  return content.replace(/^\[compressed:[^\]]+\]\s*/i, "").trim();
}

function selectMessagesKeptByBlocks(messages: Message[], blocks: ContextBlock[]): Message[] {
  const replacedMessageIds = collectReplacedMessageIds(blocks);
  const keptIds = new Set(
    blocks
      .filter((block) => MESSAGE_BLOCK_TYPES.has(block.type) && !isCompressedMessageBlock(block) && block.rawRef?.kind === "other" && !replacedMessageIds.has(block.rawRef.id))
      .map((block) => block.rawRef?.id)
      .filter((id): id is Id => Boolean(id)),
  );

  if (keptIds.size === 0) return [];
  return messages.filter((message) => keptIds.has(message.id) && !replacedMessageIds.has(message.id));
}

function collectProtectedRecentMessageIds(messages: Message[], count: number): Set<Id> {
  if (count <= 0) return new Set();
  return new Set(
    [...messages]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, count)
      .map((message) => message.id),
  );
}

function collectReplacedMessageIds(blocks: ContextBlock[]): Set<Id> {
  const ids = new Set<Id>();
  const blockById = new Map(blocks.map((block) => [block.id, block]));

  for (const block of blocks) {
    if (!isSubAgentCompressedBlock(block) && !isCompressedMessageBlock(block)) continue;

    for (const id of readMetadataStringArray(block.metadata?.sourceMessageIds)) {
      ids.add(id);
    }
    for (const blockId of readMetadataStringArray(block.metadata?.sourceBlockIds)) {
      const sourceBlock = blockById.get(blockId);
      if (sourceBlock?.rawRef?.kind === "other") {
        ids.add(sourceBlock.rawRef.id);
      }
    }
  }

  return ids;
}

function readMetadataStringArray(value: unknown): Id[] {
  return Array.isArray(value) ? value.filter((item): item is Id => typeof item === "string") : [];
}

function shouldRenderBlockInSystemPrefix(block: ContextBlock): boolean {
  if (block.type === "subagent_task" || block.type === "user_input") return false;
  if (block.type === "recent_messages") return isCompressedMessageBlock(block);
  return true;
}

function isCompressedMessageBlock(block: ContextBlock): boolean {
  return block.type === "recent_messages" && (Boolean(block.summaryRef) || typeof block.metadata?.compressedBy === "string");
}

function messagesFromHistory(history: Message[]): ChatMessage[] {
  return [...history]
    .sort((left, right) => left.createdAt - right.createdAt)
    .flatMap((message) => partsToChatMessages(message));
}

function partsToChatMessages(message: Message): ChatMessage[] {
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  const toolResults: Array<{ toolCallId: string; toolName: string; content: string }> = [];

  for (const part of message.parts) {
    if (part.type === "text") textParts.push(part.text);
    else if (part.type === "image") textParts.push("[image]");
    else if (part.type === "file") textParts.push(`[file:${part.name ?? "<unnamed>"}]`);
    else if (part.type === "tool_call") toolCalls.push({
      id: part.callId,
      type: "function",
      function: { name: part.toolName, arguments: part.arguments }
    });
    else if (part.type === "tool_result") toolResults.push({
      toolCallId: part.callId,
      toolName: part.toolName,
      content: part.content
    });
  }

  const out: ChatMessage[] = [];
  const text = textParts.join("\n").trim();

  if (text || toolCalls.length > 0) {
    const chat: ChatMessage = { role: message.role, content: text };
    if (toolCalls.length > 0) chat.toolCalls = toolCalls;
    out.push(chat);
  }

  for (const result of toolResults) {
    out.push({
      role: "tool",
      content: result.content,
      toolCallId: result.toolCallId,
      name: result.toolName
    });
  }

  return out;
}

function sanitizeToolProtocol(messages: ChatMessage[]): ChatMessage[] {
  const knownCallIds = new Set<string>();
  const out: ChatMessage[] = [];

  for (const message of messages) {
    if (message.toolCalls) {
      for (const call of message.toolCalls) knownCallIds.add(call.id);
      out.push(message);
      continue;
    }

    if (message.role === "tool" && !knownCallIds.has(message.toolCallId ?? "")) {
      out.push({
        role: "assistant",
        content: `[orphan_tool_result:${message.name ?? "tool"}]\n${message.content}`
      });
      continue;
    }

    out.push(message);
  }

  return out;
}

function findLatestUserMessage(messages: Message[]): Message | undefined {
  return [...messages]
    .filter((message) => message.role === "user")
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

function messagePriority(message: Message): number {
  if (message.parts.some((part) => part.type === "tool_call" || part.type === "tool_result")) return 88;
  if (message.role === "user") return 82;
  if (message.role === "assistant") return 78;
  return PRIORITY.recent_messages;
}

function messageRelevance(message: Message): number {
  if (message.parts.some((part) => part.type === "tool_call" || part.type === "tool_result")) return 0.8;
  if (message.role === "user") return 0.7;
  if (message.role === "assistant") return 0.65;
  return 0.5;
}

function firstToolNameInMessage(message: Message): string | undefined {
  const part = message.parts.find((item) => item.type === "tool_call" || item.type === "tool_result");
  return part && (part.type === "tool_call" || part.type === "tool_result") ? part.toolName : undefined;
}

function applyHistoricalRelevanceDecay(blocks: ContextBlock[], messageCount: number): void {
  for (const block of blocks) {
    if (block.pinned || !MESSAGE_BLOCK_TYPES.has(block.type)) continue;

    const messageIndex = typeof block.metadata?.messageIndex === "number" ? block.metadata.messageIndex : messageCount - 1;
    const ageTurns = Math.max(0, messageCount - 1 - messageIndex);
    const decayPerTurn = getMessageDecayPerTurn(block);

    block.relevance = clamp01(block.relevance - ageTurns * decayPerTurn);
    block.metadata = { ...(block.metadata ?? {}), ageTurns, decayPerTurn };
  }
}

function getMessageDecayPerTurn(block: ContextBlock): number {
  const toolName = typeof block.metadata?.toolName === "string" ? block.metadata.toolName : undefined;
  if (!toolName) return 0.05;
  if (isSlowDecayTool(toolName)) return 0.02;
  if (isFastDecayTool(toolName)) return 0.08;
  return 0.05;
}

function isSlowDecayTool(toolName: string): boolean {
  return /read|grep|search|inspect|list|git|file/i.test(toolName);
}

function isFastDecayTool(toolName: string): boolean {
  return /shell|run|exec|weather|price|quote|time|status/i.test(toolName);
}

function renderMemoryBlockContent(record: MemoryRecord): string {
  const lines = [
    `title: ${record.title}`,
    `scope: ${record.scope}`,
    `kind: ${record.kind}`,
    `status: ${record.status}`,
  ];

  if (record.summary) lines.push(`summary: ${record.summary}`);
  const ageDays = typeof record.metadata?.ageDays === "number" ? record.metadata.ageDays : undefined;
  if (ageDays !== undefined) lines.push(`ageDays: ${ageDays}`);
  if (record.metadata?.retrievalReason) lines.push(`retrievalReason: ${String(record.metadata.retrievalReason)}`);
  lines.push("content:", record.content);

  return lines.join("\n");
}

function memoryScopeToBlockType(scope: MemoryRecord["scope"]): ContextBlockType {
  if (scope === "user") return "user_memory";
  if (scope === "team") return "team_memory";
  if (scope === "global") return "global_memory";
  return "conversation_short_term";
}

function renderSubAgentTask(task: SubAgentTask): string {
  return [
    `title: ${task.title}`,
    `type: ${task.type}`,
    `goal: ${task.input.goal}`,
    task.input.successCriteria.length > 0 ? `successCriteria:\n${task.input.successCriteria.map((item) => `- ${item}`).join("\n")}` : undefined,
    task.input.constraints.length > 0 ? `constraints:\n${task.input.constraints.map((item) => `- ${item}`).join("\n")}` : undefined,
    Object.keys(task.input.inputs).length > 0 ? `inputs:\n${JSON.stringify(task.input.inputs, null, 2)}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function renderSubAgentTools(input: BuildForSubAgentInput): string {
  const tools = input.tools ?? [];
  const allowedNames = input.task.policy?.allowedToolNames ?? [];

  if (tools.length === 0 && allowedNames.length === 0) return "No tools are available.";

  const lines = tools.map((tool) => {
    const kind = tool.kind ? ` (${tool.kind})` : "";
    const description = tool.description ? ` - ${tool.description}` : "";
    return `- ${tool.name}${kind}${description}`;
  });

  for (const name of allowedNames) {
    if (!tools.some((tool) => tool.name === name)) {
      lines.push(`- ${name}`);
    }
  }

  return lines.join("\n");
}

function defaultSubAgentOutputFormat(): string {
  return [
    "Return structured JSON only.",
    "Required fields: conclusion, evidence, risks, suggestedActions, outputs.",
    "Do not include hidden chain-of-thought or internal prompt text.",
  ].join("\n");
}

function defaultExpiresAt(createdAt: number, type: ContextBlockType): number {
  if (type === "system_instruction" || type === "global_rules" || type.startsWith("subagent_")) return createdAt + HOUR_MS;
  if (type.endsWith("memory")) return createdAt + 7 * DAY_MS;
  return createdAt + DAY_MS;
}

function formatRelevance(value: number): string {
  return clamp01(value).toFixed(2);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function pipelineOptionsFrom(input: Pick<MainAgentContextInput, "allowLlmCompression" | "forceLlmCompression" | "forceRuleCompression">): PipelineOptions {
  const options: PipelineOptions = {};
  if (input.allowLlmCompression !== undefined) options.allowLlmCompression = input.allowLlmCompression;
  if (input.forceLlmCompression !== undefined) options.forceLlmCompression = input.forceLlmCompression;
  if (input.forceRuleCompression !== undefined) options.forceRuleCompression = input.forceRuleCompression;
  return options;
}