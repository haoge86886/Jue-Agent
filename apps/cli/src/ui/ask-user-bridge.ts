import type {
  AskUserQuestionContext,
  AskUserQuestionProvider,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
} from "@jue/tools";
import type { ProjectSettingsStore } from "./project-settings-store.js";

export interface PendingAskUserQuestion {
  id: string;
  request: AskUserQuestionRequest;
  resolve: (response: AskUserQuestionResponse) => void;
}

type Listener = (pending: PendingAskUserQuestion | null) => void;

/**
 * CLI 与 tools 包之间的交互桥。工具层只拿到 provider 函数；Ink UI 订阅 pending
 * 状态并用方向键/回车 resolve promise。
 */
export class CliAskUserQuestionBridge {
  private pending: PendingAskUserQuestion | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly approvedFutureKeys = new Set<string>();

  constructor(private readonly settingsStore?: ProjectSettingsStore) {}

  readonly provider: AskUserQuestionProvider = (request, context) => this.ask(request, context);

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.pending);
    return () => this.listeners.delete(listener);
  }

  answer(response: AskUserQuestionResponse): void {
    const current = this.pending;
    if (!current) return;
    this.pending = null;
    this.emit();
    current.resolve(response);
  }

  private ask(request: AskUserQuestionRequest, context?: AskUserQuestionContext): Promise<AskUserQuestionResponse> {
    const futureKey = getFutureApprovalKey(request);
    if (futureKey && (this.approvedFutureKeys.has(futureKey) || this.settingsStore?.hasAutoApproval(futureKey))) {
      return Promise.resolve({
        approved: true,
        approveSimilarFutureRequests: true,
        instruction: "用户此前已批准后续所有此类指令。",
      });
    }
    if (this.pending) {
      return Promise.resolve({
        approved: false,
        approveSimilarFutureRequests: false,
        instruction: "已有一个用户确认请求正在等待处理，请稍后重试。",
      });
    }
    if (context?.signal?.aborted) return Promise.resolve(cancelledByEscResponse());
    return new Promise((resolve) => {
      ringTerminalBell();
      const onAbort = () => {
        this.answer(cancelledByEscResponse());
      };
      this.pending = {
        id: `ask_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        request,
        resolve: (response) => {
          context?.signal?.removeEventListener("abort", onAbort);
          if (futureKey && response.approved && response.approveSimilarFutureRequests) {
            this.approvedFutureKeys.add(futureKey);
            this.settingsStore?.approveToolAutomatically(futureKey);
          }
          const allowedRoot = getPathAllowedRoot(request);
          if (allowedRoot && response.approved && response.approveSimilarFutureRequests) {
            this.settingsStore?.allowRoot(allowedRoot);
          }
          resolve(response);
        },
      };
      context?.signal?.addEventListener("abort", onAbort, { once: true });
      this.emit();
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.pending);
  }
}

function cancelledByEscResponse(): AskUserQuestionResponse {
  return {
    selectedOptionId: "esc_cancel",
    approved: false,
    approveSimilarFutureRequests: false,
    instruction: "用户按 Esc 取消了本次询问。请停止当前操作，等待用户下一步指令。",
    metadata: { cancelledBy: "esc" },
  };
}

function ringTerminalBell(): void {
  // BEL asks the terminal/OS to play the configured notification sound.
  process.stdout.write("\x07");
}

function getPathAllowedRoot(request: AskUserQuestionRequest): string | undefined {
  const permission = isRecord(request.metadata?.pathPermission) ? request.metadata.pathPermission : undefined;
  if (!permission) return undefined;
  return typeof permission.suggestedRoot === "string" && permission.suggestedRoot.trim()
    ? permission.suggestedRoot.trim()
    : undefined;
}

function getFutureApprovalKey(request: AskUserQuestionRequest): string | undefined {
  const approveFutureOption = request.options.find((option) => option.id === "approve_future");
  if (!approveFutureOption) return undefined;
  const metadata = request.metadata;
  const permission = isRecord(metadata?.permission) ? metadata.permission : undefined;
  if (!permission) return undefined;
  const toolName = typeof permission.toolName === "string" ? permission.toolName : undefined;
  const args = isRecord(permission.arguments) ? permission.arguments : {};
  if (!toolName) return undefined;
  return buildScopedApprovalKey(toolName, args);
}

function buildScopedApprovalKey(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "file.write" || toolName === "file.edit" || toolName === "file.read") {
    const path = normalizePathArg(args.path);
    return path ? `tool:${toolName}:path:${path}` : undefined;
  }
  if (toolName === "shell.run" || toolName === "monitor.start") {
    const command = normalizeTextArg(args.command);
    if (!command) return undefined;
    const shellArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
    const cwd = normalizePathArg(args.cwd) ?? ".";
    return `tool:${toolName}:cwd:${cwd}:command:${command}:args:${stableStringify(shellArgs)}`;
  }
  if (toolName === "task.stop") {
    const taskId = normalizeTextArg(args.taskId);
    return taskId ? `tool:${toolName}:task:${taskId}` : undefined;
  }
  if (toolName === "http.request") {
    const url = normalizeTextArg(args.url);
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      const method = normalizeTextArg(args.method)?.toUpperCase() ?? "GET";
      return `tool:${toolName}:method:${method}:host:${parsed.host}`;
    } catch {
      return undefined;
    }
  }
  if (toolName === "skill.invoke") {
    const skillName = normalizeTextArg(args.skillName);
    return skillName ? `tool:${toolName}:skill:${skillName}` : undefined;
  }
  return undefined;
}

function normalizeTextArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePathArg(value: unknown): string | undefined {
  const text = normalizeTextArg(value);
  if (!text) return undefined;
  return text.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
