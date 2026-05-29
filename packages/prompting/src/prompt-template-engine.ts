/**
 * @file prompt-template-engine.ts
 * @module @jue/prompting/prompt-template-engine
 *
 * 轻量 Prompt 模板引擎。它只处理 prompt 工程层需要的基础能力:
 * 变量替换、片段去重、顺序稳定拼接与诊断输出。
 */

import { createHash } from "node:crypto";
import type {
  PromptBuildDiagnostics,
  PromptSegment,
  PromptSegmentDiagnostic,
} from "./types.js";

const DEFAULT_SEPARATOR = "\n\n---\n\n";

export interface ComposePromptOptions {
  separator?: string;
  dedupe?: boolean;
}

export interface ComposePromptResult {
  segments: PromptSegment[];
  text: string;
  diagnostics: Pick<PromptBuildDiagnostics, "template">;
}

export class PromptTemplateEngine {
  render(raw: string, vars: Record<string, unknown> = {}): string {
    return raw.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
      const value = readPath(vars, key);
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : String(value);
    });
  }

  compose(segments: PromptSegment[], options: ComposePromptOptions = {}): ComposePromptResult {
    const separator = options.separator ?? DEFAULT_SEPARATOR;
    const dedupe = options.dedupe !== false;
    const diagnostics: PromptSegmentDiagnostic[] = [];
    const seen = new Set<string>();
    const ordered = [...segments].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const finalSegments: PromptSegment[] = [];

    for (const segment of ordered) {
      const content = segment.content.trim();
      if (!content) {
        diagnostics.push({
          category: segment.category,
          origin: segment.origin,
          source: segment.source,
          status: "skipped",
          reason: "empty segment",
          ...(segment.namespace ? { namespace: segment.namespace } : {}),
        });
        continue;
      }

      const contentHash = segment.contentHash ?? hashText(content);
      if (dedupe && seen.has(contentHash)) {
        diagnostics.push({
          category: segment.category,
          origin: segment.origin,
          source: segment.source,
          status: "deduped",
          reason: "same content hash already loaded",
          contentHash,
          charCount: content.length,
          ...(segment.namespace ? { namespace: segment.namespace } : {}),
        });
        continue;
      }

      seen.add(contentHash);
      finalSegments.push({ ...segment, content, contentHash });
    }

    return {
      segments: finalSegments,
      text: finalSegments.map((segment) => segment.content).join(separator),
      diagnostics: { template: diagnostics },
    };
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!part) return undefined;
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export const DEFAULT_PROMPT_TEMPLATE_ENGINE = new PromptTemplateEngine();
