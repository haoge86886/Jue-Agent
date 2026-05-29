/**
 * @file prompt-manager.ts
 * @module @jue/prompting/prompt-manager
 *
 * Prompt 工程层对外统一入口。它只负责静态/动态 prompt 的基础拼装、诊断和快照,
 * 记忆正文、工具详情列表、上下文压缩等由 context/memory/tool 层继续处理。
 */

import { getModuleLogger } from "@jue/utils";
import { DynamicPromptBuilder } from "./dynamic-prompt-builder.js";
import { newSnapshotId, type SnapshotStore } from "./snapshot-store.js";
import { StaticPromptLoader } from "./static-prompt-loader.js";
import {
  DEFAULT_PROMPT_TEMPLATE_ENGINE,
  type ComposePromptOptions,
  type PromptTemplateEngine,
} from "./prompt-template-engine.js";
import type {
  BuiltPrompt,
  PromptBuildDiagnostics,
  PromptRuntimeContext,
  PromptSegment,
  PromptSegmentDiagnostic,
  StaticPromptCategory,
  StaticPromptRequest,
} from "./types.js";

const DEFAULT_STATIC_ORDER: StaticPromptCategory[] = [
  "system",
  "global_rules",
  "task",
  "tool_usage",
  "recommendation",
  "coding",
  "subagent_roles",
];

export interface PromptManagerOptions {
  staticLoader: StaticPromptLoader;
  dynamicBuilder: DynamicPromptBuilder;
  snapshotStore: SnapshotStore;
  templateEngine?: PromptTemplateEngine;
  staticOrder?: StaticPromptCategory[];
  composeOptions?: ComposePromptOptions;
}

export interface BuildPromptOptions {
  templateVars?: Record<string, unknown>;
  staticCategoriesOverride?: StaticPromptCategory[];
  staticRequestsOverride?: StaticPromptRequest[];
  includeDynamic?: boolean;
  includeUserPrompt?: boolean;
  composeOptions?: ComposePromptOptions;
}

export class PromptManager {
  private readonly logger = getModuleLogger("prompt");
  private readonly staticLoader: StaticPromptLoader;
  private readonly dynamicBuilder: DynamicPromptBuilder;
  private readonly snapshotStore: SnapshotStore;
  private readonly templateEngine: PromptTemplateEngine;
  private readonly staticOrder: StaticPromptCategory[];
  private readonly composeOptions: ComposePromptOptions;

  constructor(options: PromptManagerOptions) {
    this.staticLoader = options.staticLoader;
    this.dynamicBuilder = options.dynamicBuilder;
    this.snapshotStore = options.snapshotStore;
    this.templateEngine = options.templateEngine ?? DEFAULT_PROMPT_TEMPLATE_ENGINE;
    this.staticOrder = options.staticOrder ?? DEFAULT_STATIC_ORDER;
    this.composeOptions = options.composeOptions ?? {};
  }

  build(runtimeCtx: PromptRuntimeContext, options: BuildPromptOptions = {}): BuiltPrompt {
    const staticRequests = this.resolveStaticRequests(options);
    const loadStaticOptions = {
      vars: options.templateVars ?? {},
      ...(options.includeUserPrompt !== undefined
        ? { includeUserPrompt: options.includeUserPrompt }
        : {}),
    };
    const staticResult = this.staticLoader.loadManyDetailed(staticRequests, loadStaticOptions);
    const dynamicResult =
      options.includeDynamic === false
        ? { segments: [] as PromptSegment[], diagnostics: [] as PromptSegmentDiagnostic[] }
        : this.dynamicBuilder.buildDetailed(runtimeCtx);

    const composeResult = this.templateEngine.compose(
      [...staticResult.segments, ...dynamicResult.segments],
      { ...this.composeOptions, ...options.composeOptions },
    );

    const diagnostics = this.buildDiagnostics(
      staticResult.diagnostics,
      dynamicResult.diagnostics,
      composeResult.diagnostics.template,
      composeResult.segments,
      composeResult.text,
    );

    const built: BuiltPrompt = {
      segments: composeResult.segments,
      text: composeResult.text,
      snapshotId: newSnapshotId(),
      builtAt: Date.now(),
      diagnostics,
    };

    this.snapshotStore.save(built);
    this.logger.debug(
      {
        snapshotId: built.snapshotId,
        loadedSegmentCount: diagnostics.loadedSegmentCount,
        skippedSegmentCount: diagnostics.skippedSegmentCount,
        totalChars: diagnostics.totalChars,
      },
      "prompt built",
    );

    return built;
  }

  loadSnapshot(snapshotId: string): BuiltPrompt | undefined {
    return this.snapshotStore.load(snapshotId);
  }

  listSnapshotIds(): string[] {
    return this.snapshotStore.list();
  }

  private resolveStaticRequests(options: BuildPromptOptions): StaticPromptRequest[] {
    if (options.staticRequestsOverride) return options.staticRequestsOverride;
    const categories = options.staticCategoriesOverride ?? this.staticOrder;
    return categories.map((category) => ({ category }));
  }

  private buildDiagnostics(
    staticDiagnostics: PromptSegmentDiagnostic[],
    dynamicDiagnostics: PromptSegmentDiagnostic[],
    templateDiagnostics: PromptSegmentDiagnostic[],
    segments: PromptSegment[],
    text: string,
  ): PromptBuildDiagnostics {
    const all = [...staticDiagnostics, ...dynamicDiagnostics, ...templateDiagnostics];
    return {
      static: staticDiagnostics,
      dynamic: dynamicDiagnostics,
      template: templateDiagnostics,
      cache: all.filter((item) => item.status === "cache_hit" || item.status === "cache_miss"),
      loadedSegmentCount: segments.length,
      skippedSegmentCount: all.filter((item) => item.status !== "loaded").length,
      totalChars: text.length,
    };
  }
}

export const DEFAULT_STATIC_PROMPT_ORDER = DEFAULT_STATIC_ORDER;
