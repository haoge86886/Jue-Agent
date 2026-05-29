import type { ToolSpec } from "@jue/shared-types";
import { askUserQuestionToolSpec, createAskUserQuestionHandler, type AskUserQuestionProvider } from "./ask-user-question.js";
import { BackgroundTaskStore, createBackgroundTaskHandlers, monitorStartToolSpec, taskOutputToolSpec, taskStopToolSpec } from "./background-task.js";
import { createFileEditHandler, fileEditToolSpec } from "./file-edit.js";
import { createFileReadHandler, fileReadToolSpec } from "./file-read.js";
import { createFileWriteHandler, fileWriteToolSpec } from "./file-write.js";
import { createHttpRequestHandler, httpRequestToolSpec } from "./http-request.js";
import { createListTreeHandler, listTreeToolSpec } from "./list-tree.js";
import { createMemoryWriteHandler, memoryWriteToolSpec, type MemoryWriteProvider } from "./memory-write.js";
import { createPlanModeHandlers, planEnterToolSpec, planExitToolSpec } from "./plan-mode.js";
import { createFileSearchHandler, createTextSearchHandler, fileSearchToolSpec, textSearchToolSpec } from "./search.js";
import { createShellRunHandler, shellRunToolSpec } from "./shell-run.js";
import { createSubAgentInvokeHandler, subagentInvokeToolSpec, type SubAgentInvokeProvider } from "./subagent-invoke.js";
import { createSkillInvokeHandler, skillInvokeToolSpec, type SkillProvider } from "./skill.js";
import { createTodoHandlers, todoCreateToolSpec, todoListToolSpec, todoReadToolSpec, todoUpdateToolSpec, TodoStore } from "./todo.js";
import { SimpleSandbox, UnsupportedSandbox, type SandboxRunner } from "../sandbox.js";
import type { PathPermissionStore } from "../path-permissions.js";
import type { PlanModeStore } from "../plan-mode.js";
import type { ToolHandler } from "../tool-executor.js";
import type { ToolRegistry } from "../tool-registry.js";

export interface BuiltinToolRegistrationOptions {
  workspaceRoot: string;
  registry: ToolRegistry;
  handlers: Map<string, ToolHandler>;
  enabled?: Partial<Record<BuiltinToolKey, boolean>>;
  shellAllowedCommands?: string[];
  shellBlockedPatterns?: string[];
  httpAllowedHosts?: string[];
  httpBlockedHosts?: string[];
  pathPermissions?: PathPermissionStore;
  sandbox?: SandboxRunner;
  todoStore?: TodoStore;
  backgroundTaskStore?: BackgroundTaskStore;
  planModeStore?: PlanModeStore;
  skillProvider?: SkillProvider;
  subagentInvokeProvider?: SubAgentInvokeProvider;
  askUserQuestionProvider?: AskUserQuestionProvider;
  memoryWriteProvider?: MemoryWriteProvider;
}

export type BuiltinToolKey =
  | "fileRead"
  | "fileWrite"
  | "fileEdit"
  | "shell"
  | "fileSearch"
  | "listTree"
  | "textSearch"
  | "todo"
  | "planMode"
  | "backgroundTask"
  | "skill"
  | "subagentInvoke"
  | "askUserQuestion"
  | "memoryWrite"
  | "http";

/**
 * Central registration entry for builtin tools. Runtime only passes workspaceRoot/config;
 * tool protocol and handler wiring stay inside the tools package.
 */
export function registerBuiltinTools(options: BuiltinToolRegistrationOptions): void {
  const enabled = options.enabled ?? {};
  if (enabled.fileRead !== false) register(options, withToolGuidance(fileReadToolSpec), createFileReadHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.fileWrite === true) register(options, withToolGuidance(fileWriteToolSpec), createFileWriteHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.fileEdit !== false) register(options, withToolGuidance(fileEditToolSpec), createFileEditHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.listTree !== false) register(options, withToolGuidance(listTreeToolSpec), createListTreeHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.fileSearch !== false) register(options, withToolGuidance(fileSearchToolSpec), createFileSearchHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.textSearch !== false) register(options, withToolGuidance(textSearchToolSpec), createTextSearchHandler({ workspaceRoot: options.workspaceRoot, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  if (enabled.http === true) register(options, withToolGuidance(httpRequestToolSpec), createHttpRequestHandler({
    ...(options.httpAllowedHosts ? { allowedHosts: options.httpAllowedHosts } : {}),
    ...(options.httpBlockedHosts ? { blockedHosts: options.httpBlockedHosts } : {}),
  }));
  if (enabled.shell === true) {
    const sandbox = options.sandbox ?? createDefaultSandbox(options.workspaceRoot, options.shellAllowedCommands, options.shellBlockedPatterns, options.pathPermissions);
    register(options, withToolGuidance(shellRunToolSpec), createShellRunHandler({ workspaceRoot: options.workspaceRoot, sandbox, ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}) }));
  }
  if (enabled.backgroundTask !== false) {
    options.registry.register(withToolGuidance(monitorStartToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(taskOutputToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(taskStopToolSpec), { enabled: true });
    for (const [name, handler] of createBackgroundTaskHandlers({
      workspaceRoot: options.workspaceRoot,
      ...(options.pathPermissions ? { pathPermissions: options.pathPermissions } : {}),
      ...(options.backgroundTaskStore ? { store: options.backgroundTaskStore } : {}),
    })) {
      options.handlers.set(name, handler);
    }
  }
  if (enabled.memoryWrite !== false) {
    register(options, withToolGuidance(memoryWriteToolSpec), createMemoryWriteHandler({
      workspaceRoot: options.workspaceRoot,
      ...(options.memoryWriteProvider ? { provider: options.memoryWriteProvider } : {}),
    }));
  }
  if (enabled.skill !== false) {
    register(options, withToolGuidance(skillInvokeToolSpec), createSkillInvokeHandler({
      ...(options.skillProvider ? { provider: options.skillProvider } : {}),
    }));
  }
  if (enabled.subagentInvoke !== false) {
    register(options, withToolGuidance(subagentInvokeToolSpec), createSubAgentInvokeHandler({
      ...(options.subagentInvokeProvider ? { provider: options.subagentInvokeProvider } : {}),
    }));
  }
  if (enabled.askUserQuestion !== false) {
    register(options, withToolGuidance(askUserQuestionToolSpec), createAskUserQuestionHandler({
      ...(options.askUserQuestionProvider ? { provider: options.askUserQuestionProvider } : {}),
    }));
  }
  if (enabled.todo !== false) {
    options.registry.register(withToolGuidance(todoCreateToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(todoUpdateToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(todoListToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(todoReadToolSpec), { enabled: true });
    for (const [name, handler] of createTodoHandlers(options.todoStore ?? new TodoStore())) {
      options.handlers.set(name, handler);
    }
  }
  if (enabled.planMode !== false && options.planModeStore) {
    options.registry.register(withToolGuidance(planEnterToolSpec), { enabled: true });
    options.registry.register(withToolGuidance(planExitToolSpec), { enabled: true });
    for (const [name, handler] of createPlanModeHandlers(options.planModeStore)) {
      options.handlers.set(name, handler);
    }
  }
}

function register(options: BuiltinToolRegistrationOptions, spec: ToolSpec, handler: ToolHandler): void {
  options.registry.register(spec, { enabled: true });
  options.handlers.set(spec.name, handler);
}

function withToolGuidance(spec: ToolSpec): ToolSpec {
  const guidance = TOOL_GUIDANCE[spec.name];
  if (!guidance) return spec;
  return {
    ...spec,
    ...(guidance.displayName ? { displayName: guidance.displayName } : {}),
    description: guidance.description,
  };
}

const TOOL_GUIDANCE: Record<string, { displayName?: string; description: string }> = {
  "file.read": {
    displayName: "Read File",
    description: "Read local file content. Use it for source code, config, logs, design docs, and user-specified files. Before editing, read the relevant snippet to confirm the current state. Use offset/length for large files; do not use it to list directories or locate filenames.",
  },
  "file.write": {
    displayName: "Write File",
    description: "Create a new file or overwrite a whole file. Use it for new config, tests, scripts, docs, or explicit full rewrites. For small edits to an existing file, prefer file.edit. Before overwrite, confirm the path and the need for overwrite=true.",
  },
  "memory.write": {
    displayName: "Write Memory",
    description: "Persist durable user or project memory only when the user explicitly asks to remember something, or when an approved memory pipeline record is available. Do not use file.write for .jue/**/memory paths; memory.write keeps MEMORY.md, frontmatter, TTL, and indexes synchronized.",
  },
  "file.edit": {
    displayName: "Edit File",
    description: "Replace one unique exact snippet in a file. Use it for focused code fixes, config replacement, and doc edits. Before calling, use file.read or search.text to confirm oldText is unique; if not unique, read more context or split the edit.",
  },
  "fs.tree": {
    displayName: "List Tree",
    description: "List directory structure with depth and entry limits. Use it to understand an unfamiliar repo, module locations, or candidate files. It does not read file content. Lower maxDepth/maxEntries for large trees.",
  },
  "fs.find": {
    displayName: "Find Files",
    description: "Find files/directories by filename or glob. Use when you know a filename, extension, or partial path, such as package.json, *.config.ts, or SKILL.md. After finding candidates, use file.read or search.text.",
  },
  "search.text": {
    displayName: "Search Text",
    description: "Search exact text in file contents and return line numbers/previews. Hard workflow rule: for function names, config keys, error messages, log signatures, TODO/FIXME, old implementations, or references, call search.text first, then read the hit files. Do not replace search with broad manual reading.",
  },
  "shell.run": {
    displayName: "Run Command",
    description: "Run a short-lived local command in the sandbox. Use for tests, typecheck, build, lint, git queries, package manager queries, and one-shot verification. Use monitor.start for long-running or streaming processes. On failure, read stdout/stderr/nextStep and adjust; do not repeat blindly.",
  },
  "monitor.start": {
    displayName: "Start Background Task",
    description: "Start a long-running or streaming background task, such as dev server, watch, or log monitor. After starting, observe with task.output; stop with task.stop when done, failed, or no longer needed.",
  },
  "task.output": {
    displayName: "Read Task Output",
    description: "Read the event stream of a monitor.start task. Use sinceSeq for incremental reads to avoid context bloat. Use stdout/stderr/system events to decide whether the task started, failed, should be stopped, or needs more waiting.",
  },
  "task.stop": {
    displayName: "Stop Background Task",
    description: "Stop a monitor.start background task. Use when work is complete, startup failed, the user asks to stop, a port must be released, or the process should not keep running. Usually read task.output first.",
  },
  "http.request": {
    displayName: "HTTP Request",
    description: "Request an HTTP/HTTPS endpoint only when the user explicitly asks or the task truly requires external access, such as a public API, small text resource, health check, or user-provided URL. Do not include secrets, tokens, or private data in request parameters.",
  },
  "skill.invoke": {
    displayName: "Invoke Skill",
    description: "Invoke an available skill listed in the prompt. skillName must exactly match an available skill. Do not invent tools such as skill.list or list_available_skills.",
  },
  "subagent.invoke": {
    displayName: "Invoke SubAgent",
    description: "Start an isolated subagent loop. Use for targeted code location, parallel exploration, planning, or verification. Provide clear task boundaries, expected output, and allowed tools. After the subagent returns, the main agent must integrate the result and continue; do not stop just because a subtask was dispatched.",
  },
  "ask_user_question": {
    displayName: "Ask User",
    description: "Use when task goal, path scope, permission, safety risk, delete/overwrite/move, global install, long-term approval, or mutually exclusive choices are unclear. Hard rule: if confirmation is needed, call ask_user_question; do not use a normal reply asking the user to answer yes/no as a substitute.",
  },
  "todo.create": {
    displayName: "Create Todo",
    description: "Create a todo item only for tasks with 3+ steps, cross-file/cross-turn execution, persistent state tracking, or after plan mode. Each todo must have a clear title, concrete description, and verifiable done criteria.",
  },
  "todo.update": {
    displayName: "Update Todo",
    description: "Update an existing todo. Mark in_progress before starting, done only after completion and verification, blocked when waiting on user decision or other blockers, and include a concise note.",
  },
  "todo.list": {
    displayName: "List Todos",
    description: "List todo summaries including done, in_progress, blocked, and pending, sorted by task order. Use after finishing an item to confirm the next step and avoid skips or duplicates.",
  },
  "todo.read": {
    displayName: "Read Todo",
    description: "Read full todo details only when you need description, acceptance criteria, note, or blocker reason. Prefer todo.list when you only need the next step.",
  },
  "plan.enter": {
    displayName: "EnterPlanMode",
    description: "Enter plan mode for complex, risky, cross-file, or user-requested planning tasks. In plan mode only do read-only exploration, ask user questions, and write the plan; do not write files, run shell, access network, or start background tasks.",
  },
  "plan.exit": {
    displayName: "ExitPlanMode",
    description: "Exit plan mode with a complete plan including steps, risks, verification, and todo breakdown. If the plan has 3+ steps, create todos with todo.create immediately after exit, then execute via the todo flow.",
  },
};

function createDefaultSandbox(workspaceRoot: string, allowedCommands?: string[], blockedPatterns?: string[], pathPermissions?: PathPermissionStore): SandboxRunner {
  if (process.platform === "win32") {
    return new SimpleSandbox({
      workspaceRoot,
      ...(pathPermissions ? { pathPermissions } : {}),
      ...(allowedCommands ? { allowedCommands } : {}),
      ...(blockedPatterns ? { blockedPatterns } : {}),
    });
  }
  return new UnsupportedSandbox();
}
