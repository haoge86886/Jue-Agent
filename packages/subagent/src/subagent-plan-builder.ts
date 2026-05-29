import type { ContextBlock, ContextBudget, MemoryRecord, SubAgentRegistration, SubAgentTask } from "@jue/shared-types";
import { SubAgentToolFilter, type ToolDescriptorLike } from "./tool-filter.js";
import type {
  SubAgentContextBuilder,
  SubAgentInvocationRequest,
  SubAgentMemoryProvider,
  SubAgentPlan,
  SubAgentPlanBuilder,
  SubAgentPromptProvider,
  SubAgentToolCatalog,
} from "./types.js";

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  "你是一个被委派的子智能体，只处理父 Agent 明确交给你的任务。",
  "你看不到父 Agent 的完整对话历史，只能使用当前任务、必要上下文块、工具列表、输出格式和专属记忆。",
  "禁止调用 subagent.invoke；subagent 嵌套被禁止。",
  "只能使用显式授予的工具，优先选择最小充分工具集。",
  "不要扩大任务范围，不要假装拥有未提供的上下文。",
  "最终只输出一个符合要求的 JSON 对象，不要 Markdown 代码块，不要输出内部推理过程。",
].join("\n");

export interface DefaultSubAgentPlanBuilderOptions {
  contextBuilder: SubAgentContextBuilder;
  toolCatalog: SubAgentToolCatalog;
  promptProvider: SubAgentPromptProvider;
  memoryProvider?: SubAgentMemoryProvider;
  toolFilter?: SubAgentToolFilter;
  defaultContextBudget?: ContextBudget;
}

export class DefaultSubAgentPlanBuilder implements SubAgentPlanBuilder {
  private readonly contextBuilder: SubAgentContextBuilder;
  private readonly toolCatalog: SubAgentToolCatalog;
  private readonly promptProvider: SubAgentPromptProvider;
  private readonly memoryProvider: SubAgentMemoryProvider | undefined;
  private readonly toolFilter: SubAgentToolFilter;
  private readonly defaultContextBudget: ContextBudget | undefined;

  constructor(options: DefaultSubAgentPlanBuilderOptions) {
    this.contextBuilder = options.contextBuilder;
    this.toolCatalog = options.toolCatalog;
    this.promptProvider = options.promptProvider;
    this.memoryProvider = options.memoryProvider;
    this.toolFilter = options.toolFilter ?? new SubAgentToolFilter();
    this.defaultContextBudget = options.defaultContextBudget;
  }

  async build(input: SubAgentInvocationRequest, registration: SubAgentRegistration, task: SubAgentTask): Promise<SubAgentPlan> {
    const policy = task.policy ?? registration.defaultPolicy;
    const filteredTools = this.toolFilter.filterWithMetadata(this.toolCatalog.listEnabled().map((item) => ({
      spec: item.spec,
      ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
      ...(item.unavailableReason ? { unavailableReason: item.unavailableReason } : {}),
    } satisfies ToolDescriptorLike)), policy);

    const templatedTask = applyTaskTemplate(task, registration);
    const promptText = (await this.promptProvider.load(registration))?.trim() || buildDefaultPrompt(registration);
    const memory = await this.memoryProvider?.loadForSubAgent({
      registration,
      task: templatedTask,
      requestedRecords: input.memoryRecords ?? [],
    });
    const memoryRecords = mergeMemoryRecords(input.memoryRecords ?? [], memory?.records ?? []);
    const inheritedBlocks = filterContextBlocks(input.contextBlocks ?? [], policy?.allowedContextTypes ?? []);

    const contextBudget = toContextBudget(input.budget) ?? this.defaultContextBudget;
    const context = await this.contextBuilder.buildForSubAgent({
      sessionId: input.sessionId,
      requestId: input.requestId,
      task: templatedTask,
      subagentSystemPromptText: promptText,
      tools: filteredTools.descriptors.map((item) => ({
        name: item.spec.name,
        kind: item.spec.kind,
        description: item.spec.description ?? item.spec.displayName,
      })),
      ...(registration.outputFormat ? { outputFormat: registration.outputFormat } : {}),
      inheritedBlocks,
      memoryRecords,
      ...(memory?.blocks ? { memoryBlocks: memory.blocks } : {}),
      ...(contextBudget ? { budget: contextBudget } : {}),
      allowLlmCompression: false,
      forceLlmCompression: false,
    });

    return {
      registration,
      task: templatedTask,
      messages: context.messages,
      toolDefinitions: filteredTools.modelTools,
      toolNameMap: filteredTools.toolNameMap,
      outputFormat: registration.outputFormat ?? defaultOutputFormat(),
      contextBlocks: context.assembly.blocks,
      deniedToolNames: filteredTools.deniedToolNames,
    };
  }
}


function applyTaskTemplate(task: SubAgentTask, registration: SubAgentRegistration): SubAgentTask {
  const template = taskTemplateFor(registration.type, task);
  return {
    ...task,
    input: {
      ...task.input,
      goal: template,
    },
    metadata: {
      ...(task.metadata ?? {}),
      taskTemplate: registration.type,
    },
  };
}

function taskTemplateFor(type: SubAgentRegistration["type"], task: SubAgentTask): string {
  const inputs = Object.keys(task.input.inputs).length > 0 ? JSON.stringify(task.input.inputs, null, 2) : "{}";
  const success = task.input.successCriteria.length > 0 ? task.input.successCriteria.map((item) => `- ${item}`).join("\n") : "- 父 Agent 没有提供显式成功标准；请从目标中推断最小必要成功标准。";
  const constraints = task.input.constraints.length > 0 ? task.input.constraints.map((item) => `- ${item}`).join("\n") : "- 无额外约束。";
  const common = [
    `任务标题：${task.title}`,
    `父 Agent 目标：\n${task.input.goal}`,
    `成功标准：\n${success}`,
    `约束：\n${constraints}`,
    `结构化输入：\n${inputs}`,
    "通用要求：只处理委派任务；不要调用其他 subagent；不要输出内部推理；最终输出严格 JSON。",
  ];
  if (type === "explorer") {
    return [...common, "Explorer 专属要求：", "- 根据 inputs.breadth 或约束确定搜索广度：quick / medium / very_thorough。", "- 返回文件、符号、引用、搜索关键词和覆盖范围说明。", "- 只做定位探索，不做代码评审，不修改代码。"].join("\n\n");
  }
  if (type === "plan") {
    return [...common, "Plan 专属要求：", "- 输出有顺序的 planSteps，必要时标注 owner/scope。", "- 包含 keyFiles、tradeoffs、risks、validation commands 和 openQuestions。", "- 不写文件，不执行高风险命令。"].join("\n\n");
  }
  if (type === "verification") {
    return [...common, "Verification 专属要求：", "- findings 必须按严重程度排序。", "- 每条 finding 都要包含证据、影响和具体修复计划。", "- 如果没有发现问题，明确说明并列出残余风险和测试缺口。"].join("\n\n");
  }
  if (type === "session_search") {
    return [...common, "SessionSearch 专属要求：", "- 使用工作目录、用户第一条消息、文件名、模块名和技术词汇搜索历史会话摘要。", "- 只在高度相关时返回 matchedSessions 和 injectedContext。"].join("\n\n");
  }
  return [...common, "General-purpose 专属要求：", "- 严格围绕委派目标和成功标准执行。", "- 报告 completedWork、changedFiles、validation、risks 和 followUp。"].join("\n\n");
}function buildDefaultPrompt(registration: SubAgentRegistration): string {
  return [
    DEFAULT_SUBAGENT_SYSTEM_PROMPT,
    "",
    `子智能体：${registration.displayName}`,
    `描述：${registration.description}`,
    registration.outputFormat ? `输出格式：\n${registration.outputFormat}` : defaultOutputFormat(),
  ].join("\n");
}

function defaultOutputFormat(): string {
  return "只返回 JSON，字段包含 conclusion、details、evidence、risks、suggestedActions、outputs；不要 Markdown 代码块或额外说明。";
}

function filterContextBlocks(blocks: ContextBlock[], allowedTypes: readonly string[]): ContextBlock[] {
  if (allowedTypes.length === 0) return [];
  const allowed = new Set(allowedTypes);
  return blocks
    .filter((block) => allowed.has(block.type))
    .map((block) => redactContextBlock(block));
}

function redactContextBlock(block: ContextBlock): ContextBlock {
  return {
    ...block,
    content: redactText(block.content),
    metadata: block.metadata ? redactRecord(block.metadata) : undefined,
  };
}

function redactText(text: string): string {
  return text
    .replace(/(api[_-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [REDACTED]");
}

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/api[_-]?key|token|password|secret|authorization|cookie/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeMemoryRecords(base: MemoryRecord[], extra: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const merged: MemoryRecord[] = [];
  for (const record of [...base, ...extra]) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    merged.push(record);
  }
  return merged;
}

function toContextBudget(budget: Partial<import("@jue/shared-types").SubAgentBudget> | undefined): ContextBudget | undefined {
  if (!budget?.maxTokens) return undefined;
  return {
    totalTokenBudget: budget.maxTokens,
    reservedForResponse: Math.min(2_000, Math.floor(budget.maxTokens * 0.25)),
    reservedForSystem: Math.min(1_500, Math.floor(budget.maxTokens * 0.2)),
    reservedForTools: Math.min(1_500, Math.floor(budget.maxTokens * 0.2)),
    reservedForMemory: Math.min(1_000, Math.floor(budget.maxTokens * 0.15)),
    hardCeilingTokens: budget.maxTokens,
  };
}