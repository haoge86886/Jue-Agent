/**
 * @file session-stream.ts
 * @module @jue/cli/ui/session-stream
 *
 * Translates StreamEvent from SessionManager/Engine into UI-friendly update intents.
 * This layer does not create ChatItem directly; the store decides how to merge deltas
 * and display tools, errors, context budget, and subagent notices.
 */

import type { StreamEvent } from "@jue/shared-types";
import type { ContextBudgetStatus, ModelStatusState } from "./types.js";

export type UiStreamUpdate =
  | { kind: "delta"; text: string }
  | {
      kind: "tool_call";
      callId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      kind: "tool_result";
      callId: string;
      toolName: string;
      status: "succeeded" | "failed" | "rejected" | "timeout";
      summary?: string;
      error?: { code: string; message: string };
    }
  | { kind: "warning"; code?: string; message: string }
  | { kind: "error"; code?: string; message: string }
  | { kind: "model_status"; status: ModelStatusState }
  | { kind: "context_budget"; status: ContextBudgetStatus }
  | { kind: "subagent_notice"; phase: "started" | "completed"; text: string }
  | { kind: "memory_notice"; text: string };

export function translateStreamEvent(
  ev: StreamEvent,
): UiStreamUpdate | null {
  switch (ev.type) {
    case "model.delta": {
      const p = ev.payload as { delta?: string } | undefined;
      const text = p?.delta ?? "";
      return text ? { kind: "delta", text } : null;
    }
    case "model.status": {
      const p = ev.payload as Partial<ModelStatusState> | undefined;
      if (!p || typeof p.message !== "string" || typeof p.attempt !== "number" || typeof p.maxAttempts !== "number") return null;
      return {
        kind: "model_status",
        status: {
          phase: p.phase === "retrying" ? "retrying" : "connecting",
          attempt: p.attempt,
          maxAttempts: p.maxAttempts,
          message: p.message,
          ...(typeof p.baseURL === "string" ? { baseURL: p.baseURL } : {}),
          ...(typeof p.model === "string" ? { model: p.model } : {}),
          ...(typeof p.error === "string" ? { error: p.error } : {}),
          updatedAt: Date.now(),
        },
      };
    }
    case "tool.invocation.started": {
      const p = ev.payload as
        | { callId: string; toolName: string; arguments: unknown }
        | undefined;
      if (!p) return null;
      if (p.toolName === "subagent.invoke") {
        const args = isRecord(p.arguments) ? p.arguments : {};
        const name = typeof args.subagentName === "string" ? args.subagentName : "subagent";
        return { kind: "subagent_notice", phase: "started", text: `delegated to ${name}` };
      }
      return {
        kind: "tool_call",
        callId: p.callId,
        toolName: p.toolName,
        arguments: p.arguments,
      };
    }
    case "tool.invocation.completed": {
      const p = ev.payload as
        | {
            callId: string;
            toolName: string;
            status: "succeeded" | "failed" | "rejected" | "timeout";
            summary?: string;
            error?: { code: string; message: string };
          }
        | undefined;
      if (!p) return null;
      if (p.toolName === "subagent.invoke") {
        const summary = p.summary ? `: ${p.summary}` : "";
        return { kind: "subagent_notice", phase: "completed", text: `subagent completed (${p.status})${summary}` };
      }
      const u: UiStreamUpdate = {
        kind: "tool_result",
        callId: p.callId,
        toolName: p.toolName,
        status: p.status,
      };
      if (p.summary) u.summary = p.summary;
      if (p.error) u.error = p.error;
      return u;
    }
    case "memory.recorded": {
      const p = ev.payload as { action?: string; written?: Array<{ title?: string; scope?: string; type?: string; writeMode?: string; classificationReason?: string; memoryPath?: string }>; removed?: number; rejectedReasons?: string[] } | undefined;
      if (!p) return null;
      if (p.action === "queued") return { kind: "memory_notice", text: "memory queued: background extraction will update long-term memory" };
      if (p.action === "forget") return { kind: "memory_notice", text: "memory updated: removed " + (p.removed ?? 0) + " item(s)" };
      const written = p.written ?? [];
      if (written.length > 0) {
        const names = written.map((item) => {
          const mode = item.writeMode === "merged" ? "merged" : "created";
          const type = item.type ? "/" + item.type : "";
          const reason = item.classificationReason ? ": " + item.classificationReason : "";
          return (item.title ?? "memory") + " (" + mode + ", " + (item.scope ?? "unknown") + type + ")" + reason;
        }).join("; ");
        return { kind: "memory_notice", text: "memory recorded: " + names };
      }
      return { kind: "memory_notice", text: "memory not recorded" + (p.rejectedReasons?.length ? ": " + p.rejectedReasons.join(", ") : "") };
    }
    case "context.budget.updated": {
      const p = ev.payload as Partial<ContextBudgetStatus> | undefined;
      if (!p || typeof p.remainingRatio !== "number" || typeof p.usedTokens !== "number" || typeof p.ceilingTokens !== "number") return null;
      return {
        kind: "context_budget",
        status: {
          usedTokens: p.usedTokens,
          ceilingTokens: p.ceilingTokens,
          remainingTokens: typeof p.remainingTokens === "number" ? p.remainingTokens : Math.max(0, p.ceilingTokens - p.usedTokens),
          remainingRatio: p.remainingRatio,
          pressure: p.pressure ?? "normal",
          compressedBlockCount: typeof p.compressedBlockCount === "number" ? p.compressedBlockCount : 0,
          droppedBlockCount: typeof p.droppedBlockCount === "number" ? p.droppedBlockCount : 0,
          updatedAt: Date.now(),
        },
      };
    }    case "warning": {
      const p = ev.payload as { code?: string; message?: string } | undefined;
      return {
        kind: "warning",
        ...(p?.code ? { code: p.code } : {}),
        message: p?.message ?? "warning",
      };
    }
    case "error": {
      const p = ev.payload as { code?: string; message?: string } | undefined;
      return {
        kind: "error",
        ...(p?.code ? { code: p.code } : {}),
        message: p?.message ?? "error",
      };
    }
    default:
      return null;
  }
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
