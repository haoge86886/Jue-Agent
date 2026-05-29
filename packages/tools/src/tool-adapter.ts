import type { ToolSpec } from "@jue/shared-types";
import type { ToolHandler } from "./tool-executor.js";

export interface AdaptedTool {
  spec: ToolSpec;
  handler?: ToolHandler;
  enabled: boolean;
  reason?: string;
}

export interface ToolAdapter<TExternal = unknown> {
  adapt(input: TExternal): Promise<AdaptedTool[]> | AdaptedTool[];
}

export interface ToolAdapterDiagnostic {
  serverId?: string;
  toolName?: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  nextStep?: string;
}

export interface ToolAdapterResult {
  tools: AdaptedTool[];
  diagnostics: ToolAdapterDiagnostic[];
}

export function sanitizeToolName(raw: string, prefix?: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/-/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = /^[a-z]/.test(cleaned) ? cleaned : `tool_${cleaned || "external"}`;
  return prefix ? `${sanitizeToolName(prefix)}.${safe}` : safe;
}
