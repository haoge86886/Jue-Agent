/**
 * @file memory-index.ts
 * @module @jue/memory/memory-index
 *
 * 将 MEMORY.md 索引转换为 ContextBlock。索引块只暴露摘要和细节文件路径，
 * 不直接注入完整记忆正文；模型判断相关后必须通过 file.read 读取细节文件。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextBlock, MemoryScope } from "@jue/shared-types";
import { defaultTokenEstimator, newId } from "@jue/utils";
import { workspacePathSlug } from "./repository.js";

export interface MemoryIndexBlockOptions {
  globalJueDir: string;
  workspaceRoot?: string;
  now?: number;
}

export function buildMemoryIndexBlocks(options: MemoryIndexBlockOptions): ContextBlock[] {
  const now = options.now ?? Date.now();
  const specs: Array<{ scope: MemoryScope; path: string; title: string }> = [
    { scope: "user", path: join(options.globalJueDir, "user", "memory", "MEMORY.md"), title: "用户长期记忆索引" },
    { scope: "global", path: join(options.globalJueDir, "global", "memory", "MEMORY.md"), title: "全局长期记忆索引" },
  ];
  if (options.workspaceRoot) {
    specs.push({
      scope: "project",
      path: join(options.globalJueDir, "projects", workspacePathSlug(options.workspaceRoot), "memory", "MEMORY.md"),
      title: "项目长期记忆索引",
    });
  }

  return specs.flatMap((spec) => {
    if (!existsSync(spec.path)) return [];
    const raw = readFileSync(spec.path, "utf8").split(/\r?\n/).slice(0, 200).join("\n").trim();
    if (!raw || !raw.includes("](")) return [];
    const content = [
      `[${spec.title}]`,
      `scope=${spec.scope}`,
      `indexPath=${spec.path}`,
      "这些是长期记忆索引行，不是完整事实。若某条索引与当前任务相关，必须先使用 file.read 读取该索引指向的细节 .md 文件，再把细节内容作为依据。不要只凭索引行回答。",
      "",
      raw,
    ].join("\n");
    return [{
      id: newId("ctx"),
      type: scopeToBlockType(spec.scope),
      source: "memory",
      priority: 58,
      tokenEstimate: defaultTokenEstimator.estimate(content),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      relevance: 0.62,
      pinned: false,
      compressible: true,
      compressionStrategy: "rule_extract",
      sensitivity: "internal",
      content,
      rawRef: { kind: "file", id: spec.path },
      tags: ["memory", "memory_index", spec.scope],
      metadata: { scope: spec.scope, indexPath: spec.path, readDetailsWithTool: "file.read" },
    } satisfies ContextBlock];
  });
}

function scopeToBlockType(scope: MemoryScope): ContextBlock["type"] {
  if (scope === "global") return "global_memory";
  if (scope === "team") return "team_memory";
  return "user_memory";
}

