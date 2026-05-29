/**
 * @file static-prompt-loader.ts
 * @module @jue/prompting/static-prompt-loader
 *
 * 从文件系统加载静态 Prompt 片段。静态 prompt 是稳定背景信息,
 * 用户自定义的 `JUE.md` 会作为 system 片段的追加内容注入。
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  PromptKvCache,
  PromptRuntimePaths,
  PromptSegment,
  PromptSegmentDiagnostic,
  StaticPromptCategory,
  StaticPromptRequest,
  UserPromptSource,
} from "./types.js";
import { DEFAULT_PROMPT_TEMPLATE_ENGINE, hashText, type PromptTemplateEngine } from "./prompt-template-engine.js";

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const STATIC_FILE_ALIASES: Record<StaticPromptCategory, readonly string[]> = {
  system: ["system.md"],
  global_rules: ["global_rules.md"],
  task: ["task.md", "Tasks.md", "tasks.md"],
  Tasks: ["Tasks.md", "task.md", "tasks.md"],
  tool_usage: ["tool_usage.md"],
  recommendation: ["recommendation.md"],
  coding: ["coding.md"],
  subagent_roles: ["subagent_roles.md"],
};

export interface StaticPromptLoaderOptions {
  staticDir: string;
  namespace?: string;
  runtimePaths?: PromptRuntimePaths;
  userPromptSources?: UserPromptSource[];
  userPromptFiles?: string[];
  templateEngine?: PromptTemplateEngine;
  kvCache?: PromptKvCache;
  enableKvCache?: boolean;
}

export interface LoadStaticPromptOptions {
  vars?: Record<string, unknown>;
  namespace?: string;
  includeUserPrompt?: boolean;
}

export interface LoadStaticPromptResult {
  segments: PromptSegment[];
  diagnostics: PromptSegmentDiagnostic[];
}

export class StaticPromptLoader {
  private readonly staticDir: string;
  private readonly namespace: string;
  private readonly userPromptSources: UserPromptSource[];
  private readonly templateEngine: PromptTemplateEngine;
  private readonly kvCache: PromptKvCache | undefined;
  private readonly enableKvCache: boolean;
  private readonly fileCache = new Map<string, string | null>();

  constructor(options: StaticPromptLoaderOptions) {
    this.staticDir = resolve(options.staticDir);
    this.namespace = options.namespace ?? "static";
    this.userPromptSources = resolveUserPromptSources({
      staticDir: this.staticDir,
      ...(options.runtimePaths ? { runtimePaths: options.runtimePaths } : {}),
      ...(options.userPromptSources ? { userPromptSources: options.userPromptSources } : {}),
      ...(options.userPromptFiles ? { userPromptFiles: options.userPromptFiles } : {}),
    });
    this.templateEngine = options.templateEngine ?? DEFAULT_PROMPT_TEMPLATE_ENGINE;
    this.kvCache = options.kvCache;
    this.enableKvCache = options.enableKvCache ?? false;
  }

  load(category: StaticPromptCategory, vars: Record<string, unknown> = {}): string | undefined {
    return this.loadSegment({ category }, { vars }).segments[0]?.content;
  }

  loadSegment(
    request: StaticPromptRequest,
    options: LoadStaticPromptOptions = {},
  ): LoadStaticPromptResult {
    const diagnostics: PromptSegmentDiagnostic[] = [];
    const namespace = options.namespace ?? request.namespace ?? this.namespace;
    const resolved = this.resolveStaticFile(request.category);

    if (!resolved) {
      diagnostics.push({
        category: request.category,
        origin: "static",
        source: `${request.category}.md`,
        status: request.required ? "failed" : "missing",
        reason: "static prompt file not found",
        namespace,
      });
      return { segments: [], diagnostics };
    }

    const cacheKey = this.kvCache?.makeKey([
      "static",
      namespace,
      request.category,
      resolved,
      JSON.stringify(options.vars ?? {}),
    ]);
    if (this.enableKvCache && cacheKey) {
      const cached = this.kvCache?.get(cacheKey);
      if (cached) {
        diagnostics.push({
          category: request.category,
          origin: "static",
          source: basename(resolved),
          status: "cache_hit",
          contentHash: hashText(cached.value),
          charCount: cached.value.length,
          namespace,
        });
        return {
          segments: [this.toSegment(request.category, namespace, basename(resolved), cached.value)],
          diagnostics,
        };
      }
      diagnostics.push({
        category: request.category,
        origin: "static",
        source: basename(resolved),
        status: "cache_miss",
        namespace,
      });
    }

    const raw = this.readPromptFile(resolved);
    if (!raw) {
      diagnostics.push({
        category: request.category,
        origin: "static",
        source: basename(resolved),
        status: "skipped",
        reason: "empty static prompt file",
        namespace,
      });
      return { segments: [], diagnostics };
    }

    const rendered = this.templateEngine.render(raw, options.vars ?? {}).trim();
    const withUserPrompt =
      request.category === "system" && options.includeUserPrompt !== false
        ? this.appendUserPrompt(rendered, namespace, diagnostics, options.vars ?? {})
        : rendered;

    if (this.enableKvCache && cacheKey) {
      this.kvCache?.set({ key: cacheKey, value: withUserPrompt, createdAt: Date.now() });
    }

    const segment = this.toSegment(request.category, namespace, basename(resolved), withUserPrompt);
    diagnostics.push({
      category: request.category,
      origin: "static",
      source: basename(resolved),
      status: "loaded",
      contentHash: segment.contentHash as string,
      charCount: segment.content.length,
      namespace,
    });
    return { segments: [segment], diagnostics };
  }

  loadMany(
    categories: StaticPromptCategory[] | StaticPromptRequest[],
    vars: Record<string, unknown> = {},
  ): PromptSegment[] {
    return this.loadManyDetailed(categories, { vars }).segments;
  }

  loadManyDetailed(
    categories: StaticPromptCategory[] | StaticPromptRequest[],
    options: LoadStaticPromptOptions = {},
  ): LoadStaticPromptResult {
    const segments: PromptSegment[] = [];
    const diagnostics: PromptSegmentDiagnostic[] = [];
    for (const item of categories) {
      const request = typeof item === "string" ? { category: item } : item;
      const result = this.loadSegment(request, options);
      segments.push(...result.segments);
      diagnostics.push(...result.diagnostics);
    }
    return { segments, diagnostics };
  }

  clearCache(): void {
    this.fileCache.clear();
  }

  private resolveStaticFile(category: StaticPromptCategory): string | undefined {
    for (const fileName of STATIC_FILE_ALIASES[category]) {
      const filePath = resolve(this.staticDir, fileName);
      if (existsSync(filePath)) return filePath;
    }
    return undefined;
  }

  private readPromptFile(filePath: string): string | undefined {
    if (this.fileCache.has(filePath)) {
      const cached = this.fileCache.get(filePath);
      return cached === null ? undefined : cached;
    }
    if (!existsSync(filePath)) {
      this.fileCache.set(filePath, null);
      return undefined;
    }
    const raw = readFileSync(filePath, "utf-8");
    const stripped = raw.replace(COMMENT_RE, "").trim();
    this.fileCache.set(filePath, stripped || null);
    return stripped || undefined;
  }

  private appendUserPrompt(
    base: string,
    namespace: string,
    diagnostics: PromptSegmentDiagnostic[],
    vars: Record<string, unknown>,
  ): string {
    const userContents: string[] = [];
    for (const source of this.userPromptSources) {
      const filePath = isAbsolute(source.path) ? source.path : resolve(dirname(this.staticDir), source.path);
      const content = this.readPromptFile(filePath);
      if (!content) {
        diagnostics.push({
          category: "system",
          origin: "user",
          source: filePath,
          status: source.required ? "failed" : "missing",
          reason: "JUE.md not found or empty",
          namespace,
        });
        continue;
      }
      userContents.push(this.templateEngine.render(content, vars).trim());
      diagnostics.push({
        category: "system",
        origin: "user",
        source: filePath,
        status: "loaded",
        contentHash: hashText(content),
        charCount: content.length,
        namespace,
      });
    }

    if (userContents.length === 0) return base;
    return [base, ...userContents].join("\n");
  }

  private toSegment(
    category: StaticPromptCategory,
    namespace: string,
    source: string,
    content: string,
  ): PromptSegment {
    return {
      category,
      origin: "static",
      source,
      namespace,
      content,
      contentHash: hashText(content),
      loadedAt: Date.now(),
    };
  }
}

export function resolvePromptStaticDir(promptsDir: string): string {
  return join(resolve(promptsDir), "static");
}

export interface ResolveUserPromptSourcesOptions {
  staticDir: string;
  runtimePaths?: PromptRuntimePaths;
  userPromptSources?: UserPromptSource[];
  userPromptFiles?: string[];
}

export function resolveUserPromptSources(
  options: ResolveUserPromptSourcesOptions,
): UserPromptSource[] {
  if (options.userPromptSources) return dedupeSources(options.userPromptSources);
  if (options.userPromptFiles) {
    return dedupeSources(options.userPromptFiles.map((path) => ({ path, scope: "custom" as const })));
  }

  const userStateDir = options.runtimePaths?.userStateDir;
  const projectStateDir = options.runtimePaths?.projectStateDir;
  const workspaceRoot = options.runtimePaths?.workspaceRoot;
  const sources: UserPromptSource[] = [];

  if (userStateDir) sources.push({ path: join(userStateDir, "JUE.md"), scope: "global" });
  if (projectStateDir) sources.push({ path: join(projectStateDir, "JUE.md"), scope: "project" });
  if (workspaceRoot) sources.push({ path: join(workspaceRoot, "JUE.md"), scope: "workspace" });
  return dedupeSources(sources);
}

function dedupeSources(sources: UserPromptSource[]): UserPromptSource[] {
  const seen = new Set<string>();
  const out: UserPromptSource[] = [];
  for (const source of sources) {
    const normalized = resolve(source.path).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(source);
  }
  return out;
}
