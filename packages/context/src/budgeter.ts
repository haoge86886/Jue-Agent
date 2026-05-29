import type { ContextAssembly, ContextBlock, ContextBlockType, ContextBudget } from "@jue/shared-types";
import { newId } from "@jue/utils";

/** ContextManager 根据这个压力等级决定是否触发规则压缩或 LLM 压缩。 */
export type ContextBudgetPressure = "normal" | "rule_compress" | "llm_compress" | "overflow";

export interface BudgetInput {
  sessionId: string;
  requestId: string;
  blocks: ContextBlock[];
  budget: ContextBudget;
}

export interface BudgetPressureReport {
  pressure: ContextBudgetPressure;
  usedTokens: number;
  ceilingTokens: number;
  usageRatio: number;
  consecutiveCompressionFailures: number;
  compressionCircuitOpen: boolean;
}

export interface ContextBudgeter {
  budget(input: BudgetInput): ContextAssembly;
  inspect(input: Pick<BudgetInput, "blocks" | "budget">): BudgetPressureReport;
  recordCompressionFailure(): void;
  recordCompressionSuccess(): void;
}

export interface ThresholdContextBudgeterOptions {
  ruleCompressionThreshold?: number;
  llmCompressionThreshold?: number;
  maxCompressionFailures?: number;
}

export class ThresholdContextBudgeter implements ContextBudgeter {
  private readonly ruleCompressionThreshold: number;
  private readonly llmCompressionThreshold: number;
  private readonly maxCompressionFailures: number;
  private consecutiveCompressionFailures = 0;

  constructor(options: ThresholdContextBudgeterOptions = {}) {
    this.ruleCompressionThreshold = options.ruleCompressionThreshold ?? 0.6;
    this.llmCompressionThreshold = options.llmCompressionThreshold ?? 0.85;
    this.maxCompressionFailures = options.maxCompressionFailures ?? 3;
  }

  /**
   * 轻量预算预检。这里只判断压力等级，不丢弃 Block。
   */
  inspect(input: Pick<BudgetInput, "blocks" | "budget">): BudgetPressureReport {
    const ceilingTokens = getContextCeiling(input.budget);
    const usedTokens = sumTokens(input.blocks);
    const usageRatio = ceilingTokens > 0 ? usedTokens / ceilingTokens : 1;
    const compressionCircuitOpen = this.consecutiveCompressionFailures >= this.maxCompressionFailures;
    let pressure: ContextBudgetPressure = "normal";
    if (usageRatio > 1) pressure = "overflow";
    else if (usageRatio >= this.llmCompressionThreshold) pressure = "llm_compress";
    else if (usageRatio >= this.ruleCompressionThreshold) pressure = "rule_compress";

    return {
      pressure,
      usedTokens,
      ceilingTokens,
      usageRatio,
      consecutiveCompressionFailures: this.consecutiveCompressionFailures,
      compressionCircuitOpen,
    };
  }

  /**
   * 最终预算选择。
   * pinned 块强制保留；其余块先满足 system/tools/memory 的最低预留，再让剩余块按优先级竞争总预算。
   */
  budget(input: BudgetInput): ContextAssembly {
    const { sessionId, requestId, budget } = input;
    const ceiling = getContextCeiling(budget);
    const pinned = input.blocks.filter((block) => block.pinned);
    const candidates = input.blocks.filter((block) => !block.pinned);
    const kept: ContextBlock[] = [];
    const dropped = new Set<string>();
    const keptIds = new Set<string>();
    let total = 0;

    for (const block of pinned) {
      kept.push(block);
      keptIds.add(block.id);
      total += block.tokenEstimate;
    }

    if (total <= ceiling) {
      const reservedPlans: Array<{ bucket: BudgetBucket; tokens: number }> = [
        { bucket: "system", tokens: budget.reservedForSystem },
        { bucket: "tools", tokens: budget.reservedForTools },
        { bucket: "memory", tokens: budget.reservedForMemory },
      ];
      for (const plan of reservedPlans) {
        if (plan.tokens <= 0) continue;
        const remainingForBucket = Math.max(0, plan.tokens - sumTokens(kept.filter((block) => classifyBudgetBucket(block.type) === plan.bucket)));
        total = keepWithinLimit({
          source: candidates.filter((block) => classifyBudgetBucket(block.type) === plan.bucket),
          kept,
          keptIds,
          dropped,
          currentTotal: total,
          hardLimit: Math.min(ceiling, total + remainingForBucket),
        });
      }

      total = keepWithinLimit({
        source: candidates,
        kept,
        keptIds,
        dropped,
        currentTotal: total,
        hardLimit: ceiling,
      });
    }

    for (const block of input.blocks) {
      if (!keptIds.has(block.id)) dropped.add(block.id);
    }

    return {
      id: newId("ctx"),
      sessionId,
      requestId,
      createdAt: Date.now(),
      budget,
      blocks: kept,
      droppedBlockIds: [...dropped],
      compressedBlockIds: [],
      totalTokens: total,
      strategyVersion: "3",
      cacheHitKeys: [],
    };
  }

  recordCompressionFailure(): void {
    this.consecutiveCompressionFailures += 1;
  }

  recordCompressionSuccess(): void {
    this.consecutiveCompressionFailures = 0;
  }
}

/** 兼容旧命名：当前实现等价于 ThresholdContextBudgeter。 */
export class GreedyContextBudgeter extends ThresholdContextBudgeter {}

export function getContextCeiling(budget: ContextBudget): number {
  return budget.hardCeilingTokens ?? Math.max(0, budget.totalTokenBudget - budget.reservedForResponse);
}

type BudgetBucket = "system" | "tools" | "memory" | "other";

function keepWithinLimit(input: {
  source: readonly ContextBlock[];
  kept: ContextBlock[];
  keptIds: Set<string>;
  dropped: Set<string>;
  currentTotal: number;
  hardLimit: number;
}): number {
  let total = input.currentTotal;
  for (const block of [...input.source].sort(compareBlocksForBudget)) {
    if (input.keptIds.has(block.id)) continue;
    if (total + block.tokenEstimate <= input.hardLimit) {
      input.kept.push(block);
      input.keptIds.add(block.id);
      input.dropped.delete(block.id);
      total += block.tokenEstimate;
    } else {
      input.dropped.add(block.id);
    }
  }
  return total;
}

function classifyBudgetBucket(type: ContextBlockType): BudgetBucket {
  if (
    type === "system_instruction" ||
    type === "global_rules" ||
    type === "task_state" ||
    type === "environment" ||
    type === "frontend_capabilities" ||
    type === "session_flags" ||
    type === "remote_device_status" ||
    type === "subagent_system_prompt" ||
    type === "subagent_task" ||
    type === "subagent_tool_list" ||
    type === "subagent_output_format"
  ) return "system";
  if (type === "tool_summary" || type === "shell_history" || type === "tool_result_history" || type === "subagent_summary") return "tools";
  if (
    type === "user_memory" ||
    type === "team_memory" ||
    type === "global_memory" ||
    type === "conversation_short_term" ||
    type === "subagent_memory"
  ) return "memory";
  return "other";
}

function sumTokens(blocks: readonly ContextBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.tokenEstimate, 0);
}

function compareBlocksForBudget(left: ContextBlock, right: ContextBlock): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (right.priority !== left.priority) return right.priority - left.priority;
  if (right.relevance !== left.relevance) return right.relevance - left.relevance;
  return right.createdAt - left.createdAt;
}
