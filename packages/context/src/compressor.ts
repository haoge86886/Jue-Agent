import type { ContextBlock, ContextBlockType, ContextCompressionResult, Id } from "@jue/shared-types";
import { defaultTokenEstimator, newId } from "@jue/utils";

export interface CompressSingleResult {
  block: ContextBlock;
  result: ContextCompressionResult;
}

export interface RuleCompressionOptions {
  now?: number;
  staleAfterMs?: number;
  lowRelevanceThreshold?: number;
  recentToolResultCount?: number;
  maxContentChars?: number;
  forceRecentCompression?: boolean;
}

/**
 * LLM 压缩任务的最小协议。context 包只暴露候选、保护集和提示，不依赖具体 SubAgent 实现。
 */
export interface LlmCompressionTask {
  id: Id;
  /** SubAgent 可见的上下文。可能包含不可替换块，用于帮助它理解压缩边界。 */
  blocks: ContextBlock[];
  /** 只有这些块允许被替换；SubAgent 输出引用其他块时会被 context 层忽略。 */
  candidateBlockIds: Id[];
  /** 这些块只可阅读，不可总结、删除或替换。 */
  protectedBlockIds: Id[];
  /** 额外的人类可读压缩指令，会被转发给 SubAgent。 */
  instructions: string[];
  tokenBudget: number;
  reason: string;
  expectedOutput: "context_blocks";
}

export interface LlmCompressionOutput {
  blocks: ContextBlock[];
  summary: string;
  sourceBlockIds: Id[];
}

export interface LlmCompressionRunner {
  compact(task: LlmCompressionTask): Promise<LlmCompressionOutput>;
}

export interface ContextCompressor {
  compress(block: ContextBlock): Promise<CompressSingleResult | null>;
  compressByRules(blocks: ContextBlock[], options?: RuleCompressionOptions): Promise<{
    blocks: ContextBlock[];
    results: ContextCompressionResult[];
  }>;
  compressWithLlm(blocks: ContextBlock[], task: Omit<LlmCompressionTask, "id" | "blocks" | "candidateBlockIds" | "protectedBlockIds" | "instructions"> & Partial<Pick<LlmCompressionTask, "candidateBlockIds" | "protectedBlockIds" | "instructions">>): Promise<{
    blocks: ContextBlock[];
    results: ContextCompressionResult[];
  }>;
}

export interface DefaultContextCompressorOptions {
  llmRunner?: LlmCompressionRunner;
  estimateTokens?: (text: string) => number;
  maxLlmFailures?: number;
}

const SYSTEM_VISIBLE_EXCLUDED_TYPES = new Set<ContextBlockType>([
  "system_instruction",
  "global_rules",
  "subagent_system_prompt",
]);

const HARD_PROTECTED_TYPES = new Set<ContextBlockType>([
  "system_instruction",
  "global_rules",
  "subagent_system_prompt",
  "subagent_task",
  "subagent_output_format",
  "user_input",
  "task_state",
]);

export class DefaultContextCompressor implements ContextCompressor {
  private readonly llmRunner: LlmCompressionRunner | undefined;
  private readonly estimateTokens: (text: string) => number;
  private readonly maxLlmFailures: number;
  private llmFailures = 0;

  constructor(options: DefaultContextCompressorOptions = {}) {
    this.llmRunner = options.llmRunner;
    this.estimateTokens = options.estimateTokens ?? ((text) => defaultTokenEstimator.estimate(text));
    this.maxLlmFailures = options.maxLlmFailures ?? 3;
  }

  async compress(block: ContextBlock): Promise<CompressSingleResult | null> {
    const { blocks, results } = await this.compressByRules([block], { forceRecentCompression: true });
    if (results.length === 0 || !blocks[0]) return null;
    return { block: blocks[0], result: results[0] as ContextCompressionResult };
  }

  /**
   * 规则压缩不调用模型，适合处理旧工具输出、低相关历史和已有 summaryRef 的原始内容。
   */
  async compressByRules(
    blocks: ContextBlock[],
    options: RuleCompressionOptions = {},
  ): Promise<{ blocks: ContextBlock[]; results: ContextCompressionResult[] }> {
    const now = options.now ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1000;
    const lowRelevanceThreshold = options.lowRelevanceThreshold ?? 0.3;
    const recentToolResultCount = options.recentToolResultCount ?? 3;
    const maxContentChars = options.maxContentChars ?? 4_000;
    const recentToolIds = getRecentToolResultIds(blocks, recentToolResultCount);
    const results: ContextCompressionResult[] = [];
    const nextBlocks = blocks.map((block) => {
      if (!isRuleCompressible(block, {
        now,
        staleAfterMs,
        lowRelevanceThreshold,
        recentToolIds,
        forceRecentCompression: options.forceRecentCompression === true,
      })) {
        return block;
      }
      const beforeTokens = block.tokenEstimate;
      const content = summarizeByRule(block, maxContentChars);
      const afterTokens = this.estimateTokens(content);
      const compressed: ContextBlock = {
        ...block,
        content,
        tokenEstimate: afterTokens,
        summaryRef: block.summaryRef ?? newId("sum"),
        compressionStrategy: "rule_extract",
        // 规则摘要仍可作为 LLM 压缩输入；只有最终 SubAgent 替代摘要才会固定保留。
        pinned: false,
        compressible: true,
        metadata: {
          ...(block.metadata ?? {}),
          compressedBy: "rule",
          originalTokenEstimate: beforeTokens,
        },
      };
      results.push({
        blockId: block.id,
        strategy: "rule_extract",
        beforeTokens,
        afterTokens,
        ...(compressed.summaryRef ? { summaryRef: compressed.summaryRef } : {}),
        durationMs: 0,
      });
      return compressed;
    });
    return { blocks: nextBlocks, results };
  }

  /**
   * LLM 压缩由注入的 runner 执行，通常由 subagent 包提供适配器。
   * 可见上下文和可替换候选分离：SubAgent 能看见背景，但只能替换 context 层允许的块。
   */
  async compressWithLlm(
    blocks: ContextBlock[],
    task: Omit<LlmCompressionTask, "id" | "blocks" | "candidateBlockIds" | "protectedBlockIds" | "instructions"> & Partial<Pick<LlmCompressionTask, "candidateBlockIds" | "protectedBlockIds" | "instructions">>,
  ): Promise<{ blocks: ContextBlock[]; results: ContextCompressionResult[] }> {
    if (!this.llmRunner || this.llmFailures >= this.maxLlmFailures) {
      return { blocks, results: [] };
    }
    const startedAt = Date.now();
    try {
      const visibleBlocks = blocks.filter(isVisibleToLlmCompressor);
      const candidates = blocks.filter(isLlmReplacementCandidate);
      if (visibleBlocks.length === 0 || candidates.length === 0) return { blocks, results: [] };

      const candidateIds = new Set(task.candidateBlockIds ?? candidates.map((block) => block.id));
      const safeCandidateIds = new Set(candidates.filter((block) => candidateIds.has(block.id)).map((block) => block.id));
      if (safeCandidateIds.size === 0) return { blocks, results: [] };

      const protectedIds = new Set([
        ...visibleBlocks.filter((block) => !safeCandidateIds.has(block.id)).map((block) => block.id),
        ...(task.protectedBlockIds ?? []),
      ]);
      const output = await this.llmRunner.compact({
        ...task,
        id: newId("compact"),
        blocks: visibleBlocks,
        candidateBlockIds: [...safeCandidateIds],
        protectedBlockIds: [...protectedIds],
        instructions: [
          ...defaultLlmCompressionInstructions(),
          ...(task.instructions ?? []),
        ],
      });
      const replacementsBySource = filterReplacementsBySafeSources(groupReplacementsBySource(output.blocks), safeCandidateIds);
      const compressedIds = collectActuallyCompressedIds(output.sourceBlockIds, replacementsBySource, safeCandidateIds);
      if (compressedIds.size === 0) return { blocks, results: [] };

      const nextBlocks = replaceCompressedBlocksInOriginalOrder(blocks, compressedIds, replacementsBySource);
      const results = candidates
        .filter((block) => compressedIds.has(block.id) && (replacementsBySource.get(block.id)?.length ?? 0) > 0)
        .map((block): ContextCompressionResult => {
          const replacement = replacementsBySource.get(block.id)?.[0];
          return {
            blockId: block.id,
            strategy: "summary",
            beforeTokens: block.tokenEstimate,
            afterTokens: replacement?.tokenEstimate ?? 0,
            summaryRef: replacement?.summaryRef ?? newId("sum"),
            durationMs: Date.now() - startedAt,
          };
        });
      this.llmFailures = 0;
      return { blocks: nextBlocks, results };
    } catch {
      this.llmFailures += 1;
      return { blocks, results: [] };
    }
  }
}

export class NoopContextCompressor extends DefaultContextCompressor {
  constructor() {
    super();
  }
}

function groupReplacementsBySource(blocks: ContextBlock[]): Map<Id, ContextBlock[]> {
  const grouped = new Map<Id, ContextBlock[]>();
  for (const block of blocks) {
    const sourceIds = readSourceBlockIds(block);
    for (const sourceId of sourceIds) {
      const existing = grouped.get(sourceId) ?? [];
      existing.push(block);
      grouped.set(sourceId, existing);
    }
  }
  return grouped;
}

function filterReplacementsBySafeSources(grouped: Map<Id, ContextBlock[]>, safeCandidateIds: Set<Id>): Map<Id, ContextBlock[]> {
  const safe = new Map<Id, ContextBlock[]>();
  for (const [sourceId, replacements] of grouped.entries()) {
    if (safeCandidateIds.has(sourceId)) safe.set(sourceId, replacements);
  }
  return safe;
}

function collectActuallyCompressedIds(
  reportedSourceIds: Id[],
  replacementsBySource: Map<Id, ContextBlock[]>,
  safeCandidateIds: Set<Id>,
): Set<Id> {
  const ids = new Set<Id>();
  for (const id of reportedSourceIds) {
    if (safeCandidateIds.has(id) && (replacementsBySource.get(id)?.length ?? 0) > 0) ids.add(id);
  }
  for (const id of replacementsBySource.keys()) {
    if (safeCandidateIds.has(id)) ids.add(id);
  }
  return ids;
}

function replaceCompressedBlocksInOriginalOrder(
  blocks: ContextBlock[],
  compressedIds: Set<Id>,
  replacementsBySource: Map<Id, ContextBlock[]>,
): ContextBlock[] {
  const insertedReplacementIds = new Set<Id>();
  const next: ContextBlock[] = [];
  for (const block of blocks) {
    if (!compressedIds.has(block.id)) {
      next.push(block);
      continue;
    }
    const replacements = replacementsBySource.get(block.id) ?? [];
    if (replacements.length === 0) {
      next.push(block);
      continue;
    }
    for (const replacement of replacements) {
      if (insertedReplacementIds.has(replacement.id)) continue;
      insertedReplacementIds.add(replacement.id);
      const sourceBlockIds = readSourceBlockIds(replacement);
      const sourceMessageIds = collectSourceMessageIds(blocks, sourceBlockIds.length > 0 ? sourceBlockIds : [block.id]);
      next.push({
        ...replacement,
        createdAt: block.createdAt,
        metadata: {
          ...(replacement.metadata ?? {}),
          ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
          renderOrder: block.metadata?.renderOrder ?? block.metadata?.sourceOrder ?? block.createdAt,
          replacedBlockId: block.id,
        },
      });
    }
  }
  for (const replacements of replacementsBySource.values()) {
    for (const block of replacements) {
      if (!insertedReplacementIds.has(block.id)) next.push(block);
    }
  }
  return next;
}

function collectSourceMessageIds(blocks: ContextBlock[], sourceBlockIds: Id[]): Id[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const ids = sourceBlockIds.flatMap((id) => {
    const block = byId.get(id);
    return block?.rawRef?.kind === "other" ? [block.rawRef.id] : [];
  });
  return Array.from(new Set(ids));
}
function readSourceBlockIds(block: ContextBlock): Id[] {
  const raw = block.metadata?.sourceBlockIds;
  return Array.isArray(raw) ? raw.filter((item): item is Id => typeof item === "string") : [];
}

function isRuleCompressible(
  block: ContextBlock,
  options: {
    now: number;
    staleAfterMs: number;
    lowRelevanceThreshold: number;
    recentToolIds: Set<Id>;
    forceRecentCompression: boolean;
  },
): boolean {
  if (block.pinned || !block.compressible) return false;
  if (block.type === "system_instruction" || block.type === "global_rules" || block.type === "user_input" || block.type === "recent_messages") return false;
  if (block.type === "task_state") return false;
  if (!options.forceRecentCompression && block.type === "tool_result_history" && options.recentToolIds.has(block.id)) return false;
  if (block.summaryRef) return true;
  if (block.relevance < options.lowRelevanceThreshold) return true;
  if (block.type === "tool_result_history" || block.type === "shell_history") {
    const lastReferencedAt = block.lastReferencedAt ?? block.createdAt;
    return options.now - lastReferencedAt > options.staleAfterMs;
  }
  return block.tokenEstimate > 1_500;
}

function isVisibleToLlmCompressor(block: ContextBlock): boolean {
  return !SYSTEM_VISIBLE_EXCLUDED_TYPES.has(block.type);
}

function isLlmReplacementCandidate(block: ContextBlock): boolean {
  if (block.pinned || !block.compressible) return false;
  if (HARD_PROTECTED_TYPES.has(block.type)) return false;
  const compressedBy = block.metadata?.compressedBy;
  if (compressedBy === "llm_compaction_subagent") return false;
  return true;
}

function defaultLlmCompressionInstructions(): string[] {
  return [
    "你可以阅读全部可见 ContextBlock 来理解任务，但只能替换 candidateBlockIds 中列出的块。",
    "protectedBlockIds 只可作为背景理解，绝对不能总结、删除、改写或作为 sourceBlockIds 输出。",
    "压缩时必须保留：文件路径、命令、工具名、错误信息、用户明确要求、未完成任务、关键配置项、版本号、决策结论和会影响后续行动的事实。",
    "可以删除：重复日志、重复对话、终端噪声、长文件的逐字原文、已经有 summaryRef 的原始内容。",
    "输出替代块应尽量少而信息密度高；如果多个旧块语义连续，可以合并成一个 subagent_summary。",
  ];
}

function getRecentToolResultIds(blocks: ContextBlock[], count: number): Set<Id> {
  return new Set(
    blocks
      .filter((block) => block.type === "tool_result_history")
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, count)
      .map((block) => block.id),
  );
}

function summarizeByRule(block: ContextBlock, maxContentChars: number): string {
  const content = block.summaryRef
    ? `[summaryRef:${block.summaryRef}]`
    : block.content.length > maxContentChars
      ? `${block.content.slice(0, maxContentChars)}\n[truncated:${block.content.length - maxContentChars} chars]`
      : block.content;
  return [`[compressed:${block.type}]`, content].join("\n");
}

