/**
 * @file types.ts
 * @module @jue/prompting/types
 *
 * Prompt 工程层的公共类型。这里的类型只描述 prompt 拼装本身,
 * 记忆、工具详情、上下文压缩等更重的内容由后续 context/memory/tool 模块负责。
 */

import type {
  FrontendKind,
  Id,
  SessionMode,
  Timestamp,
} from "@jue/shared-types";

export type StaticPromptCategory =
  | "system"
  | "global_rules"
  | "task"
  | "Tasks"
  | "tool_usage"
  | "recommendation"
  | "coding"
  | "subagent_roles";

export type DynamicPromptCategory =
  | "base_info"
  | "auto_memory"
  | "temp_dir"
  | "environment"
  | "runtime_tools"
  | "subagent_catalog"
  | "mcp_status"
  | "frontend_capabilities"
  | "session_flags"
  | "remote_device_status";

export type PromptSegmentCategory = StaticPromptCategory | DynamicPromptCategory;
export type PromptSegmentOrigin = "static" | "dynamic" | "user";

export interface PromptSegment {
  category: PromptSegmentCategory;
  origin: PromptSegmentOrigin;
  source: string;
  content: string;
  namespace?: string;
  priority?: number;
  loadedAt?: Timestamp;
  contentHash?: string;
}

export interface StaticPromptRequest {
  category: StaticPromptCategory;
  namespace?: string;
  required?: boolean;
}

export interface PromptRuntimePaths {
  /** 仓库/工作区根目录,例如 advent_agent。 */
  workspaceRoot?: string;
  /** 项目级状态目录,默认建议为 `<workspaceRoot>/.jue`。 */
  projectStateDir?: string;
  /** 用户全局状态目录,Windows 下默认建议为 `%USERPROFILE%/.jue`。 */
  userStateDir?: string;
  /** 静态 prompt 根目录,通常是 `<workspaceRoot>/prompts`。 */
  promptsDir?: string;
}

export interface UserPromptSource {
  path: string;
  scope: "global" | "project" | "user" | "workspace" | "custom";
  required?: boolean;
}

export type PromptDiagnosticStatus =
  | "loaded"
  | "skipped"
  | "missing"
  | "failed"
  | "deduped"
  | "cache_hit"
  | "cache_miss"
  | "degraded";

export interface PromptSegmentDiagnostic {
  category: PromptSegmentCategory;
  origin: PromptSegmentOrigin;
  source: string;
  status: PromptDiagnosticStatus;
  namespace?: string;
  reason?: string;
  contentHash?: string;
  charCount?: number;
}

export interface PromptBuildDiagnostics {
  static: PromptSegmentDiagnostic[];
  dynamic: PromptSegmentDiagnostic[];
  template: PromptSegmentDiagnostic[];
  cache: PromptSegmentDiagnostic[];
  loadedSegmentCount: number;
  skippedSegmentCount: number;
  totalChars: number;
}

export interface PromptKvCacheEntry {
  key: string;
  value: string;
  createdAt: Timestamp;
  metadata?: Record<string, unknown>;
}

export interface PromptKvCache {
  get(key: string): PromptKvCacheEntry | undefined;
  set(entry: PromptKvCacheEntry): void;
  makeKey(parts: readonly string[]): string;
}

export interface PromptRuntimeContext {
  sessionId?: Id;
  requestId?: Id;
  frontend?: FrontendKind;
  mode?: SessionMode;
  defaultLanguage?: string;
  defaultTimezone?: string;
  appEnv?: string;
  modelId?: string;
  modelName?: string;
  modelProvider?: string;
  workspaceRoot?: string;
  environment?: Record<string, string | number | boolean>;
  enabledToolNames?: string[];
  availableSubAgents?: Array<{
    type: string;
    invocationName: string;
    displayName: string;
    description: string;
    allowedToolNames?: string[];
    budget?: {
      maxTokens?: number;
      maxToolCalls?: number;
      maxDurationMs?: number;
    };
  }>;
  availableSkills?: Array<{
    name: string;
    scope: "global" | "project";
    description?: string;
    displayName?: string;
    tags?: string[];
  }>;
  mcpStatus?: Array<{ id: string; connected: boolean; toolCount?: number }>;
  frontendCapabilities?: Record<string, boolean>;
  sessionFlags?: Record<string, string | boolean | number>;
  remoteDevices?: Array<{ id: string; status: string }>;
  autoMemory?: string | string[];
  tempDir?: {
    enabled?: boolean;
    path?: string;
    root?: string;
  };
}

export interface PromptSnapshotSummary {
  snapshotId: Id;
  builtAt: Timestamp;
  totalChars: number;
  segmentCount: number;
}

export interface BuiltPrompt {
  segments: PromptSegment[];
  text: string;
  snapshotId: Id;
  builtAt: Timestamp;
  diagnostics: PromptBuildDiagnostics;
}
