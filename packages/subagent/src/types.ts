import type {
  ContextBlock,
  ContextBudget,
  Id,
  MemoryRecord,
  SubAgentBudget,
  SubAgentRegistration,
  SubAgentResult,
  SubAgentTask,
  ToolCall,
  ToolResult,
} from "@jue/shared-types";

export interface SubAgentChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "subagent";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface SubAgentModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface SubAgentModelChunk {
  type: "delta" | "finish" | "status";
  delta: string;
  status?: {
    phase: "connecting" | "retrying";
    attempt: number;
    maxAttempts: number;
    message: string;
    baseURL?: string;
    model?: string;
    error?: string;
  };
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "error";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface SubAgentModelGateway {
  invoke(params: {
    messages: SubAgentChatMessage[];
    stream?: boolean;
    tools?: SubAgentModelToolDefinition[];
    toolChoice?: "auto" | "none";
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncIterable<SubAgentModelChunk>;
}

export interface SubAgentToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

export interface SubAgentInvocationRequest {
  sessionId: Id;
  requestId: Id;
  parentCallId?: Id;
  parentTaskId?: Id;
  subagentName: string;
  title?: string;
  goal: string;
  successCriteria?: string[];
  constraints?: string[];
  inputs?: Record<string, unknown>;
  contextBlocks?: ContextBlock[];
  memoryRecords?: MemoryRecord[];
  budget?: Partial<SubAgentBudget>;
  signal?: AbortSignal;
  dispatchMode?: "sync" | "async";
}

export interface SubAgentPlan {
  registration: SubAgentRegistration;
  task: SubAgentTask;
  messages: SubAgentChatMessage[];
  toolDefinitions: SubAgentModelToolDefinition[];
  toolNameMap: Record<string, string>;
  outputFormat: string;
  contextBlocks: ContextBlock[];
  deniedToolNames: string[];
}

export interface SubAgentPlanBuilder {
  build(input: SubAgentInvocationRequest, registration: SubAgentRegistration, task: SubAgentTask): Promise<SubAgentPlan> | SubAgentPlan;
}

export interface SubAgentPromptProvider {
  load(registration: SubAgentRegistration): Promise<string | undefined> | string | undefined;
}

export interface SubAgentToolCatalog {
  listEnabled(): Array<{ spec: import("@jue/shared-types").ToolSpec; enabled?: boolean; unavailableReason?: string | undefined }>;
}

export interface SubAgentContextBuilder {
  buildForSubAgent(input: {
    sessionId: Id;
    requestId: Id;
    task: SubAgentTask;
    subagentSystemPromptText: string;
    tools?: Array<{ name: string; kind?: string; description?: string }>;
    outputFormat?: string;
    inheritedBlocks?: ContextBlock[];
    memoryRecords?: MemoryRecord[];
    memoryBlocks?: ContextBlock[];
    budget?: ContextBudget;
    allowLlmCompression?: boolean;
    forceLlmCompression?: boolean;
    forceRuleCompression?: boolean;
  }): Promise<{ messages: SubAgentChatMessage[]; assembly: { blocks: ContextBlock[] } }>;
}

export interface SubAgentMemoryProvider {
  loadForSubAgent(input: {
    registration: SubAgentRegistration;
    task: SubAgentTask;
    requestedRecords: MemoryRecord[];
  }): Promise<{ records?: MemoryRecord[]; blocks?: ContextBlock[] }> | { records?: MemoryRecord[]; blocks?: ContextBlock[] };

  recordAfterRun?(input: {
    registration: SubAgentRegistration;
    task: SubAgentTask;
    result: SubAgentResult;
  }): Promise<void> | void;
}

export interface SubAgentTranscriptSink {
  appendSubAgentEvent(event: SubAgentRuntimeEvent): void;
}

export interface SubAgentRuntimeEvent {
  eventId: Id;
  sessionId: Id;
  requestId: Id;
  taskId: Id;
  subagentName: string;
  type:
    | "subagent.started"
    | "subagent.progress"
    | "subagent.tool.started"
    | "subagent.tool.completed"
    | "subagent.completed"
    | "subagent.failed"
    | "subagent.timeout";
  at: number;
  payload: Record<string, unknown>;
}

export interface SubAgentNotification {
  id: Id;
  sessionId: Id;
  requestId: Id;
  taskId: Id;
  subagentName: string;
  status: SubAgentResult["status"];
  conclusion: string;
  result: SubAgentResult;
  createdAt: number;
}

export interface SubAgentRunnerResult extends SubAgentResult {}
export type ModelToolDefinition = SubAgentModelToolDefinition;
