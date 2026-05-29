/**
 * @file useChatStore.ts
 * @module @jue/cli/ui/state/useChatStore
 *
 * 终端聊天界面的核心状态机
 *
 * 关键设计:
 * - `items` 只保存已经完成且不会再变化的消息, 交给 Ink `<Static>` 组件追加渲染
 * - `live` 单独保存正在流式输出的 assistant 文本, 避免每个 delta 都重新渲染历史消息
 * - delta 先累积到 ref, 再按固定间隔刷新到 React state, 降低 Ink 闪烁和抖动
 * - tool 调用开始前会先提交当前 live 文本, 保证回答段落和工具卡片展示顺序稳定
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStdout } from "ink";
import type { SessionManager } from "@jue/session";
import type { RootConfig } from "@jue/config";
import type { TeamExecutionQueue, TeamOrchestrator, TeamQueueEvent, TeamRuntime, TeamSnapshot } from "@jue/runtime";
import type { DreamMemoryMaintenanceService, MemoryManager } from "@jue/memory";
import type { PreparedStartupContext } from "@jue/infra";
import type { Message } from "@jue/shared-types";
import { newId } from "@jue/utils";

import type {
    AssistantTextChatItem,
    ChatItem,
    ChatPhase,
    ContextBudgetStatus,
    ModelStatusState,
    ResumeSelectorState,
    TeamAgentActivity,
    ToolResultChatItem,
    TeamStatus,
} from "../types.js";
import {
    COMMANDS,
    findCommand,
    parseCommand,
    type Command,
} from "../commands.js";
import { translateStreamEvent } from "../session-stream.js";
import type { DebugTeeModelGateway } from "../debug-tee-gateway.js";

interface UseChatStoreOptions {
  sessionManager: SessionManager;
  teamRuntime: TeamRuntime;
  config: Readonly<RootConfig>;
  startupContext?: PreparedStartupContext | undefined;
  debugGateway?: DebugTeeModelGateway;
  memoryManager?: MemoryManager;
  dreamMemory?: DreamMemoryMaintenanceService;
  onExit: () => void;
}

export interface ChatStore {
  /** 已完成的 append-only 聊天条目，交给 AppRoot 的 `<Static>` 渲染。 */
  items: ChatItem[];
  /** 正在流式生成的 assistant 文本，完成后并入 items。 */
  live: AssistantTextChatItem | null;
  phase: ChatPhase;
  devEnabled: boolean;
  sessionId: string | undefined;
  modelId: string;
  appName: string;
  appEnv: string;
  promptsDir: string | undefined;
  contextBudget: ContextBudgetStatus | undefined;
  modelStatus: ModelStatusState | undefined;
  resumeSelector: ResumeSelectorState | null;
  teamStatus: TeamStatus | null;
  teamActivities: TeamAgentActivity[];
  commands: readonly Command[];
  /** 提交用户输入或命令，由状态机决定进入对话、resume 或命令分支。 */
  submit: (raw: string) => void;
  /** 打断当前模型调用或正在进行的用户确认。 */
  interrupt: () => void;
  moveResumeSelection: (delta: number) => void;
  moveResumePage: (delta: number) => void;
  confirmResumeSelection: () => void;
  cancelResumeSelection: () => void;
}

/** delta 先缓存在 ref 中，再按 20fps 左右刷新，减少 Ink 频繁 setState 的抖动。 */
const FLUSH_INTERVAL_MS = 50;
const RESUME_PAGE_SIZE = 8;
const RESUME_HISTORY_LIMIT = 200;
const TEAM_BACKGROUND_CONCURRENCY = 2;
const TEAM_OUTPUT_PREVIEW_MAX = 96;

function teamNameForSession(sessionId: string): string {
  return `team-${sessionId}`;
}

function appendPreview(current: string, next: string): string {
  if (!next) return current;
  const compact = (current + next).replace(/\s+/g, " ").trim();
  return compact.length > TEAM_OUTPUT_PREVIEW_MAX ? `${compact.slice(0, TEAM_OUTPUT_PREVIEW_MAX)}...` : compact;
}

function compactTask(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}...` : compact;
}

function activityRank(status: TeamAgentActivity["status"]): number {
  if (status === "running" || status === "tool") return 0;
  if (status === "queued") return 1;
  if (status === "failed") return 2;
  return 3;
}

export function useChatStore(options: UseChatStoreOptions): ChatStore {
  const { sessionManager, teamRuntime, config, startupContext, debugGateway, memoryManager, dreamMemory, onExit } = options;

  const [items, setItems] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<AssistantTextChatItem | null>(null);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [devEnabled, setDevEnabled] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<ModelStatusState | undefined>(undefined);
  const [resumeSelector, setResumeSelector] = useState<ResumeSelectorState | null>(null);
  const [teamStatus, setTeamStatus] = useState<TeamStatus | null>(null);
  const [teamActivities, setTeamActivities] = useState<TeamAgentActivity[]>([]);

  const { stdout } = useStdout();

  const sessionIdRef = useRef<string | undefined>(undefined);
  const liveIdRef = useRef<string | null>(null);
  const liveTextRef = useRef<string>("");
  const liveStartedAtRef = useRef<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<ChatPhase>("idle");
  const currentAbortRef = useRef<AbortController | null>(null);
  const teamExecutionQueueRef = useRef<TeamExecutionQueue | null>(null);
  const teamRef = useRef<TeamOrchestrator | null>(null);
  const activeTeamMemberRef = useRef<string | null>(null);
  const teamInputMemberRef = useRef<string | null>(null);
  const teamQueueWasBusyRef = useRef(false);
  const leadAutoResumeRef = useRef<((team: TeamOrchestrator) => void) | null>(null);
  const leadAutoResumeRunningRef = useRef(false);
  const leadStageContinueCountRef = useRef(0);
  const leadFinalRepairCountRef = useRef(0);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const appendItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;

    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const latest = liveTextRef.current;
      setLive((prev) => (prev ? { ...prev, text: latest } : prev));
    }, FLUSH_INTERVAL_MS);
  }, []);

  const beginLive = useCallback(() => {
    const id = newId("ui");
    liveIdRef.current = id;
    liveTextRef.current = "";
    liveStartedAtRef.current = Date.now();
    setLive({
      id,
      kind: "assistant_text",
      text: "",
      streaming: true,
      createdAt: liveStartedAtRef.current,
    });
  }, []);

  const spawnSummaryWorker = useCallback(async (input: {
    sessionId: string;
    projectDir: string;
    cwd: string;
  }) => {
    const isProduction = process.env.NODE_ENV === "production";
    const workerModule = isProduction
      ? new URL("../../session-summary-worker.js", import.meta.url)
      : new URL("../../session-summary-worker.ts", import.meta.url);
    const workerArgs = isProduction
      ? [workerModule.pathname, JSON.stringify(input)]
      : ["--import", "tsx", workerModule.pathname, JSON.stringify(input)];

    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, workerArgs, {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }, []);

  const commitLive = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const id = liveIdRef.current;
    const text = liveTextRef.current;
    const startedAt = liveStartedAtRef.current;
    liveIdRef.current = null;
    liveTextRef.current = "";

    if (id && text) {
      setItems((prev) => [
        ...prev,
        {
          id,
          kind: "assistant_text",
          text,
          streaming: false,
          createdAt: startedAt,
        },
      ]);
    }

    setLive(null);
  }, []);

  const beginLiveStatus = useCallback((text: string) => {
    const id = newId("ui");
    const createdAt = Date.now();
    liveIdRef.current = id;
    liveTextRef.current = text;
    liveStartedAtRef.current = createdAt;
    setLive({
      id,
      kind: "assistant_text",
      text,
      streaming: true,
      createdAt,
    });
  }, []);

  const updateTeamStatus = useCallback((snapshot: TeamSnapshot | null) => {
    if (!snapshot) {
      setTeamStatus(null);
      setTeamActivities([]);
      activeTeamMemberRef.current = null;
      teamInputMemberRef.current = null;
      return;
    }

    // Team 有两条路由：UI 当前成员可能因自动执行 teammate 而变化，
    // 但普通用户输入必须保持在显式输入路由上。默认输入路由是 lead，
    // 只有 /team switch 才会改变它。
    const leaderName = snapshot.session.leaderName;
    activeTeamMemberRef.current ??= leaderName;
    teamInputMemberRef.current ??= leaderName;
    setTeamStatus({
      teamName: snapshot.session.teamName,
      ...(snapshot.activeRun ? { runStatus: snapshot.activeRun.status, runRound: snapshot.activeRun.round } : {}),
      dirtyArtifactCount: snapshot.dirtyArtifactCount,
      activeMemberName: snapshot.session.activeMemberName,
      inputMemberName: teamInputMemberRef.current ?? leaderName,
      members: snapshot.session.members.map((member) => ({
        name: member.name,
        role: member.role,
        ...(member.sessionId ? { sessionId: member.sessionId } : {}),
      })),
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        ...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
        ...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
      })),
      pendingInboxCount: snapshot.inbox.length,
      queuedCount: teamExecutionQueueRef.current?.status().queuedCount ?? 0,
      runningCount: teamExecutionQueueRef.current?.status().runningCount ?? 0,
      runStates: snapshot.runStates.map((state) => ({
        memberName: state.memberName,
        status: state.status,
        consecutiveFailures: state.consecutiveFailures,
        ...(state.lastError ? { lastError: state.lastError } : {}),
      })),
    });
  }, []);

  const describeTeamSnapshot = useCallback((snapshot: TeamSnapshot): string => {
    const memberLine = snapshot.session.members.map((member) => {
      const active = member.name === snapshot.session.activeMemberName ? "*" : "";
      return `${active}${member.name}(${member.role})`;
    }).join(", ");
    const visibleLegacyTasks = snapshot.tasks.filter((task) => task.metadata?.archivedByCleanup !== true);
    const archivedLegacyCount = snapshot.tasks.length - visibleLegacyTasks.length;
    const taskLine = visibleLegacyTasks.length > 0
      ? visibleLegacyTasks.map((task) => `${task.id.slice(0, 10)}:${task.status}:${task.title}`).join("\n")
      : archivedLegacyCount > 0 ? `no visible legacy tasks (${archivedLegacyCount} archived hidden)` : "no legacy tasks";
    const nodeLine = snapshot.taskNodes.length > 0
      ? snapshot.taskNodes.map((node) => `${node.id.slice(0, 10)}:${node.status}:${node.agent}:${node.title}`).join("\n")
      : "no task nodes";
    const runLine = snapshot.runStates.length > 0
      ? snapshot.runStates.map((state) => `${state.memberName}:${state.status}:failures=${state.consecutiveFailures}${state.lastError ? `:${state.lastError}` : ""}`).join("\n")
      : "no member runs yet";
    return `Team ${snapshot.session.teamName}\nactive: ${snapshot.session.activeMemberName}\nmembers: ${memberLine}\ntask nodes:\n${nodeLine}\nlegacy tasks:\n${taskLine}\nruns:\n${runLine}`;
  }, []);

  const updateTeamActivity = useCallback((memberName: string, patch: Partial<TeamAgentActivity>) => {
    setTeamActivities((prev) => {
      const now = Date.now();
      const existing = prev.find((item) => item.memberName === memberName);
      const next: TeamAgentActivity = {
        memberName,
        status: patch.status ?? existing?.status ?? "queued",
        task: patch.task ?? existing?.task ?? "",
        outputPreview: patch.outputPreview ?? existing?.outputPreview ?? "",
        updatedAt: now,
        ...(patch.currentAction !== undefined ? { currentAction: patch.currentAction } : existing?.currentAction ? { currentAction: existing.currentAction } : {}),
        ...(patch.toolName !== undefined ? { toolName: patch.toolName } : existing?.toolName ? { toolName: existing.toolName } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      };
      const merged = existing ? prev.map((item) => item.memberName === memberName ? next : item) : [...prev, next];
      return merged
        .sort((a, b) => activityRank(a.status) - activityRank(b.status) || b.updatedAt - a.updatedAt)
        .slice(0, 8);
    });
  }, []);

  const handleTeamQueueEvent = useCallback((event: TeamQueueEvent) => {
    if (event.type !== "stream") updateTeamStatus(event.snapshot ?? null);
    if (event.type === "queued") {
      teamQueueWasBusyRef.current = true;
      updateTeamActivity(event.job.memberName, { status: "queued", task: compactTask(event.job.text), currentAction: "waiting in queue", outputPreview: "" });
      return;
    }
    if (event.type === "started") {
      teamQueueWasBusyRef.current = true;
      updateTeamActivity(event.job.memberName, { status: "running", task: compactTask(event.job.text), currentAction: "starting isolated agent", outputPreview: "", startedAt: Date.now() });
      appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `[team:${event.job.memberName}] background started in ${event.sessionId.slice(0, 12)}`, createdAt: Date.now() });
      return;
    }
    if (event.type === "completed") {
      updateTeamActivity(event.job.memberName, {
        status: event.summary.error ? "failed" : "completed",
        currentAction: event.summary.error ? event.summary.error.message ?? "failed" : `completed ? tools=${event.summary.toolCallCount} actions=${event.summary.actionCount}`,
        outputPreview: event.summary.finalText ? appendPreview("", event.summary.finalText) : "",
      });
      appendItem({
        id: newId("ui"),
        kind: event.summary.error ? "error" : "system",
        ...(event.summary.error ? {} : { flavor: "ack" as const }),
        text: event.summary.error
          ? `[team:${event.job.memberName}] ${event.summary.error.code ?? "ERROR"}: ${event.summary.error.message ?? "background member failed"}`
          : `[team:${event.job.memberName}] background completed. tools=${event.summary.toolCallCount} actions=${event.summary.actionCount}${event.summary.actionResults.length > 0 ? `\n${event.summary.actionResults.map((result) => `- ${result.status}: ${result.message}`).join("\n")}` : ""}`,
        createdAt: Date.now(),
      });
      return;
    }
    if (event.type === "interrupted") {
      updateTeamActivity(event.job.memberName, { status: "interrupted", currentAction: "interrupted" });
      appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: `[team:${event.job.memberName}] background interrupted`, createdAt: Date.now() });
      return;
    }
    if (event.type === "failed") {
      updateTeamActivity(event.job.memberName, { status: "failed", currentAction: event.error });
      appendItem({ id: newId("ui"), kind: "error", text: `[team:${event.job.memberName}] ${event.error}`, createdAt: Date.now() });
      return;
    }
    if (event.type === "status") {
      if (event.idle && teamQueueWasBusyRef.current) {
        teamQueueWasBusyRef.current = false;
        const team = teamRef.current;
        if (team && team.readyTaskNodes().length > 0) {
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "tip",
            text: "Team dependencies resolved. Dispatching newly ready task nodes.",
            createdAt: Date.now(),
          });
          enqueueReadyTeamNodes(team);
          teamQueueWasBusyRef.current = true;
          return;
        }
        if (event.snapshot.dirtyArtifactCount > 0) {
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "tip",
            text: `Team queue idle. ${event.snapshot.dirtyArtifactCount} artifact(s) ready; resuming lead to synthesize the next step.`,
            createdAt: Date.now(),
          });
          if (team) leadAutoResumeRef.current?.(team);
          return;
        }
        appendItem({
          id: newId("ui"),
          kind: "system",
          flavor: "info",
          text: event.snapshot.inbox.length > 0
            ? `Team queue idle. ${event.snapshot.inbox.length} inbox message(s) remain; main agent is waiting for your next instruction.`
            : "Team queue idle. All background agents are finished; main agent is waiting for your next instruction.",
          createdAt: Date.now(),
        });
      }
      return;
    }
    if (event.type === "stopped") {
      teamQueueWasBusyRef.current = false;
      setTeamActivities((prev) => prev.map((item) => item.status === "running" || item.status === "queued" || item.status === "tool" ? { ...item, status: "interrupted", currentAction: "stopped", updatedAt: Date.now() } : item));
      return;
    }
    if (event.type === "stream") {
      const ui = translateStreamEvent(event.event);
      if (ui?.kind === "context_budget") setContextBudget(ui.status);
      if (ui?.kind === "delta") {
        setTeamActivities((prev) => prev.map((item) => item.memberName === event.job.memberName ? { ...item, status: item.status === "queued" ? "running" : item.status, outputPreview: appendPreview(item.outputPreview, ui.text), currentAction: "generating", updatedAt: Date.now() } : item));
      } else if (ui?.kind === "tool_call") {
        updateTeamActivity(event.job.memberName, { status: "tool", toolName: ui.toolName, currentAction: `using ${ui.toolName}` });
      } else if (ui?.kind === "tool_result") {
        updateTeamActivity(event.job.memberName, { status: "running", currentAction: `${ui.toolName} ${ui.status}`, toolName: ui.toolName });
      } else if (ui?.kind === "model_status") {
        updateTeamActivity(event.job.memberName, { status: "running", currentAction: ui.status.message });
      }
    }
  }, [appendItem, updateTeamActivity, updateTeamStatus]);

  const attachTeamQueue = useCallback((team: TeamOrchestrator) => {
    teamExecutionQueueRef.current?.stop();
    teamExecutionQueueRef.current = teamRuntime.createQueue({ team, concurrency: TEAM_BACKGROUND_CONCURRENCY, onEvent: handleTeamQueueEvent });
  }, [handleTeamQueueEvent, teamRuntime]);

  const clearLive = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    liveIdRef.current = null;
    liveTextRef.current = "";
    setLive(null);
  }, []);
  const pushDelta = useCallback(
    (text: string) => {
      if (!text) return;
      if (liveIdRef.current === null) beginLive();
      liveTextRef.current += text;
      scheduleFlush();
    },
    [beginLive, scheduleFlush],
  );

  useEffect(() => {
    if (!debugGateway) return;

    debugGateway.setListener({
      onInvoke: (params) => {
        appendItem({
          id: newId("ui"),
          kind: "dev",
          channel: "model.invoke",
          data: {
            messages: params.messages.map((message) => ({
              role: message.role,
              content: message.content,
              hasToolCalls: Boolean(message.toolCalls?.length),
              toolCalls: message.toolCalls?.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.function.name,
                args: toolCall.function.arguments,
              })),
              toolCallId: message.toolCallId,
            })),
            tools: params.tools ?? [],
            providerOptions: params.providerOptions ?? {},
          },
          createdAt: Date.now(),
        });
      },
      onFinish: (info) => {
        appendItem({
          id: newId("ui"),
          kind: "dev",
          channel: "model.finish",
          data: info,
          createdAt: Date.now(),
        });
      },
    });

    return () => {
      debugGateway.setListener(undefined);
    };
  }, [appendItem, debugGateway]);

  useEffect(() => {
    debugGateway?.setEnabled(devEnabled);
  }, [debugGateway, devEnabled]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const restoreSessionById = useCallback(
    (requestedSessionId: string) => {
      const resumed = sessionManager.resumeSession({ sessionId: requestedSessionId, frontend: "cli" });
      if (!resumed) {
        appendItem({
          id: newId("ui"),
          kind: "error",
          text: `无法恢复会话: ${requestedSessionId}`,
          createdAt: Date.now(),
        });
        return;
      }
      sessionIdRef.current = resumed.summary.sessionId;
      setSessionId(resumed.summary.sessionId);
      const restoredItems: ChatItem[] = [
        {
          id: newId("ui"),
          kind: "system",
          flavor: "ack",
          text: `已恢复会话: ${resumed.summary.title} (${resumed.summary.sessionId})`,
          createdAt: Date.now(),
        },
        ...messagesToChatItems(resumed.messages),
      ];
      if (resumed.compressionEvents.length > 0) {
        restoredItems.push({
          id: newId("ui"),
          kind: "system",
          flavor: "info",
          text: `恢复时检测到 ${resumed.compressionEvents.length} 条上下文压缩记录，后续上下文将基于 transcript 历史重建。`,
          createdAt: Date.now(),
        });
      }
      if (resumed.diagnostics.length > 0) {
        restoredItems.push({
          id: newId("ui"),
          kind: "system",
          flavor: "tip",
          text: `transcript 恢复诊断:\n${resumed.diagnostics.join("\n")}`,
          createdAt: Date.now(),
        });
      }
      setItems(restoredItems);
      setLive(null);
    },
    [appendItem, sessionManager],
  );

  const dispatchCommand = useCallback(
    (cmd: { name: string; args: string[] }) => {
      const def = findCommand(cmd.name);
      if (!def) {
        appendItem({
          id: newId("ui"),
          kind: "error",
          text: `Unknown command: /${cmd.name}. Type /help to list commands.`, 
          createdAt: Date.now(),
        });
        return;
      }

      if (!def.implemented) {
        appendItem({
          id: newId("ui"),
          kind: "system",
          flavor: "ack",
          text: `/${def.name} 当前尚未实现: ${def.description}`,
          createdAt: Date.now(),
        });
        return;
      }

      switch (def.name) {
        case "help": {
          const lines = COMMANDS.map(
            (command) =>
              `  /${command.name.padEnd(8)} ${command.implemented ? " " : "-"} ${command.description}` +
              (command.usage ? `  (${command.usage})` : ""),
          ).join("\n");
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "info",
            text: `Commands:\n${lines}`, 
            createdAt: Date.now(),
          });
          return;
        }

        case "clear": {
          if (phaseRef.current !== "idle") {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "tip",
              text: "A reply is currently being generated. /clear was ignored; wait for the reply to finish or press Ctrl-C to exit.",
              createdAt: Date.now(),
            });
            return;
          }

          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }

          liveIdRef.current = null;
          liveTextRef.current = "";

          const sink = stdout ?? process.stdout;
          if (sink && (sink as NodeJS.WriteStream).isTTY) {
            sink.write("\x1b[?1049l\x1bc\x1b[3J\x1b[2J\x1b[H");
          }

          setItems([]);
          setLive(null);
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "ack",
            text: "Screen cleared. Conversation context is kept; use /reset to reset the session.",
            createdAt: Date.now(),
          });
          return;
        }

        case "reset": {
          if (sessionIdRef.current) {
            sessionManager.dropSession(sessionIdRef.current);
          }

          sessionIdRef.current = undefined;
          setSessionId(undefined);
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "ack",
            text: "Session reset. The next message will create a new sessionId.",
            createdAt: Date.now(),
          });
          return;
        }

        case "resume": {
          const requestedSessionId = cmd.args[0];
          if (!requestedSessionId) {
            const sessions = sessionManager.listSessions({ frontend: "cli", limit: RESUME_HISTORY_LIMIT });
            if (sessions.length === 0) {
              appendItem({
                id: newId("ui"),
                kind: "system",
                flavor: "tip",
                text: "操作已取消。",
            createdAt: Date.now(),
              });
              return;
            }
            setResumeSelector({
              selectedIndex: 0,
              pageIndex: 0,
              pageSize: RESUME_PAGE_SIZE,
              sessions: sessions.map((session) => ({
                sessionId: session.sessionId,
                title: session.title,
                frontend: session.frontend,
                lastActiveAt: session.lastActiveAt,
                messageCount: session.messageCount,
              })),
            });
            return;
          }
          restoreSessionById(requestedSessionId);
          return;
        }

        case "team": {
          const action = (cmd.args[0] ?? "status").toLowerCase();
          const explicitTeamName = (action === "start" || action === "status") && cmd.args[1]?.startsWith("team:") ? cmd.args[1].slice("team:".length) : undefined;
          const resolveSessionTeamName = () => {
            if (explicitTeamName) return explicitTeamName;
            if (!sessionIdRef.current) throw new Error("Team mode is scoped to the current session. Send a normal message first, then run /team start, or resume an existing session.");
            return teamNameForSession(sessionIdRef.current);
          };
          const ensureTeam = () => {
            if (teamRef.current) return teamRef.current;
            const teamName = resolveSessionTeamName();
            const team = teamRuntime.createTeam({ teamName });
            teamRef.current = team;
            attachTeamQueue(team);
            return team;
          };

          try {
            if (action === "start") {
              const teamName = resolveSessionTeamName();
              const membersStart = explicitTeamName ? 2 : 1;
              const membersArg = cmd.args.slice(membersStart).join(" ");
              const members = membersArg ? membersArg.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
              const team = teamRuntime.createTeam({ teamName });
              teamRef.current = team;
              attachTeamQueue(team);
              const snapshot = team.start({ teamName, leaderName: "lead", ...(members ? { members } : {}) });
              activeTeamMemberRef.current = snapshot.session.leaderName;
              teamInputMemberRef.current = snapshot.session.leaderName;
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Team mode enabled.\n${describeTeamSnapshot(snapshot)}`, createdAt: Date.now() });
              return;
            }

            if (action === "off") {
              teamExecutionQueueRef.current?.stop();
              teamExecutionQueueRef.current = null;
              teamRef.current = null;
              updateTeamStatus(null);
              appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: "Team mode disabled. Normal chat will use the main agent again.", createdAt: Date.now() });
              return;
            }

            const team = ensureTeam();
            const currentMember = teamInputMemberRef.current ?? activeTeamMemberRef.current ?? team.snapshot().session.leaderName;

            if (action === "status") {
              const snapshot = team.snapshot(currentMember);
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: describeTeamSnapshot(snapshot), createdAt: Date.now() });
              return;
            }

            if (action === "run") {
              const text = cmd.args.slice(1).join(" ").trim();
              if (!text) throw new Error("Usage: /team run <task>");
              const snapshot = team.snapshot(currentMember);
              teamInputMemberRef.current = snapshot.session.leaderName;
              activeTeamMemberRef.current = snapshot.session.leaderName;
              updateTeamStatus(snapshot);
              void sendTeamMemberMessage(text, { memberName: snapshot.session.leaderName });
              return;
            }

            if (action === "cleanup") {
              const purgeArchivedLegacyTasks = cmd.args.slice(1).includes("purge");
              const result = team.cleanupLegacyState({ purgeArchivedLegacyTasks });
              const snapshot = team.snapshot(currentMember);
              updateTeamStatus(snapshot);
              appendItem({
                id: newId("ui"),
                kind: "system",
                flavor: "ack",
                text: [
                  "Team cleanup completed.",
                  `archived legacy pending tasks: ${result.archivedLegacyTaskCount}`,
                  `purged archived legacy tasks: ${result.purgedLegacyTaskCount}`,
                  `removed invalid members: ${result.removedMembers.length > 0 ? result.removedMembers.join(", ") : "none"}`,
                  `removed invalid run states: ${result.removedRunStates.length > 0 ? result.removedRunStates.join(", ") : "none"}`,
                  `removed pending invalid messages: ${result.removedPendingMessageCount}`,
                  result.resetActiveMember ? `active member reset to: ${result.resetActiveMember}` : "",
                ].filter(Boolean).join("\n"),
                createdAt: Date.now(),
              });
              return;
            }

            if (action === "switch") {
              const memberName = cmd.args[1];
              if (!memberName) throw new Error("Usage: /team switch <member>");
              const snapshot = team.setActiveMember(memberName);
              teamInputMemberRef.current = snapshot.session.activeMemberName;
              activeTeamMemberRef.current = snapshot.session.activeMemberName;
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Switched team input route to ${snapshot.session.activeMemberName}.`, createdAt: Date.now() });
              return;
            }

            if (action === "add") {
              const memberName = cmd.args[1];
              if (!memberName) throw new Error("Usage: /team add <member> [description]");
              const snapshot = team.addMember(memberName, cmd.args.slice(2).join(" ") || undefined);
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Added team member ${teamRuntime.normalizeMemberName(memberName)}.`, createdAt: Date.now() });
              return;
            }

            if (action === "task") {
              const assignedTo = cmd.args[1]?.includes(":") ? cmd.args[1].split(":", 2)[1] : undefined;
              const offset = assignedTo ? 2 : 1;
              const title = cmd.args.slice(offset).join(" ").trim();
              if (!title) throw new Error("Usage: /team task [to:<member>] <title>");
              const snapshot = team.createTask({ title, createdBy: currentMember, ...(assignedTo ? { assignedTo } : {}) });
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Team task created: ${title}`, createdAt: Date.now() });
              return;
            }

            if (action === "send") {
              const to = cmd.args[1];
              const body = cmd.args.slice(2).join(" ").trim();
              if (!to || !body) throw new Error("Usage: /team send <member> <message>");
              const snapshot = team.sendMessage({ from: currentMember, to, body });
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Message sent to ${teamRuntime.normalizeMemberName(to)}.`, createdAt: Date.now() });
              return;
            }

            if (action === "claim") {
              const taskId = cmd.args[1];
              if (!taskId) throw new Error("Usage: /team claim <taskId>");
              const snapshot = team.claimTask(taskId, currentMember);
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Task claimed by ${currentMember}: ${taskId}`, createdAt: Date.now() });
              return;
            }

            if (action === "complete") {
              const taskId = cmd.args[1];
              const result = cmd.args.slice(2).join(" ").trim();
              if (!taskId || !result) throw new Error("Usage: /team complete <taskId> <result>");
              const snapshot = team.completeTask({ taskId, memberName: currentMember, result, notify: "lead" });
              updateTeamStatus(snapshot);
              appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `Task completed: ${taskId}`, createdAt: Date.now() });
              return;
            }

            appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: "Usage: /team start|run|status|cleanup|switch|add|task|send|claim|complete|off", createdAt: Date.now() });
          } catch (err) {
            appendItem({ id: newId("ui"), kind: "error", text: err instanceof Error ? err.message : String(err), createdAt: Date.now() });
          }
          return;
        }
        case "info": {
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "info",
            text:
              `sessionId : ${sessionIdRef.current ?? "<not-started>"}\n` +
              `model     : ${config.model.routing.main}\n` +
              `app       : ${config.app.name}@${config.app.env}\n` +
              `prompts   : ${config.app.paths?.promptsDir ?? "(default)"}`,
            createdAt: Date.now(),
          });
          return;
        }

        case "dev": {
          const arg = (cmd.args[0] ?? "toggle").toLowerCase();
          const next =
            arg === "on" ? true : arg === "off" ? false : !devEnabled;
          setDevEnabled(next);
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "ack",
            text: `dev mode = ${next ? "ON" : "OFF"}`,
            createdAt: Date.now(),
          });

          if (next && memoryManager) {
            appendItem({
              id: newId("ui"),
              kind: "dev",
              channel: "memory.debug",
              data: memoryManager.getDebugSnapshot(),
              createdAt: Date.now(),
            });
          }

          if (next && !debugGateway) {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "info",
              text: "DebugTeeModelGateway is not mounted. /dev only shows toggle state in this entry.",
              createdAt: Date.now(),
            });
          }
          return;
        }

        case "compressor": {
          const currentSessionId = sessionIdRef.current;
          if (!currentSessionId) {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "tip",
              text: "No session history yet. Send a message before using /compressor.",
              createdAt: Date.now(),
            });
            return;
          }
          setPhase("sending");
          beginLiveStatus("正在关闭 agent...");
          void (async () => {
            try {
              const result = await sessionManager.compressContextForDebug({
                sessionId: currentSessionId,
                userId: "user_local",
                frontend: "cli",
                mode: "chat",
                flags: { command: "/compressor" },
              });
              clearLive();
              appendItem({
                id: newId("ui"),
                kind: "dev",
                channel: "context.compressor",
                data: result,
                createdAt: Date.now(),
              });
            } catch (err) {
              clearLive();
              appendItem({
                id: newId("ui"),
                kind: "error",
                text: err instanceof Error ? err.message : String(err),
                createdAt: Date.now(),
              });
            } finally {
              setPhase("idle");
            }
          })();
          return;
        }

        case "dream": {
          if (!dreamMemory) {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "tip",
              text: "Dream memory maintenance is not mounted in this runtime.",
              createdAt: Date.now(),
            });
            return;
          }
          setPhase("sending");
          beginLiveStatus("Running two-phase memory dream maintenance...");
          void (async () => {
            try {
              const result = await dreamMemory.runManual();
              clearLive();
              const maintenance = result.maintenance;
              appendItem({
                id: newId("ui"),
                kind: "system",
                flavor: "ack",
                text: maintenance
                  ? `Dream completed: checked ${maintenance.checked}, removed ${maintenance.removed}, compacted ${maintenance.compacted}, rewrote ${maintenance.rewrittenIndexes} indexes.`
                  : `Dream skipped: ${result.gate.reason}`,
                createdAt: Date.now(),
              });
              appendItem({
                id: newId("ui"),
                kind: "dev",
                channel: "memory.dream",
                data: result,
                createdAt: Date.now(),
              });
              if (devEnabled && memoryManager) {
                appendItem({ id: newId("ui"), kind: "dev", channel: "memory.debug", data: memoryManager.getDebugSnapshot(), createdAt: Date.now() });
              }
            } catch (err) {
              clearLive();
              appendItem({
                id: newId("ui"),
                kind: "error",
                text: err instanceof Error ? err.message : String(err),
                createdAt: Date.now(),
              });
            } finally {
              setPhase("idle");
            }
          })();
          return;
        }
          case "exit":
          case "quit": {
              const sessionId = sessionIdRef.current;
              if (sessionId) {
                void spawnSummaryWorker({
                  sessionId,
                  projectDir: startupContext?.jue.projectDir ?? process.cwd(),
                  cwd: process.cwd(),
                });
              }
              setPhase("exiting");
              setTimeout(onExit, 0);
              return;
            }
        default:
          appendItem({
            id: newId("ui"),
            kind: "error",
            text: `Command /${def.name} has no handler. This is a developer error.`, 
            createdAt: Date.now(),
          });
      }
    },
    [appendItem, beginLiveStatus, clearLive, config, debugGateway, devEnabled, dreamMemory, memoryManager, onExit, restoreSessionById, sessionManager, stdout],
  );

  const moveResumeSelection = useCallback((delta: number) => {
    setResumeSelector((prev) => {
      if (!prev || prev.sessions.length === 0) return prev;
      const pageSize = Math.max(1, prev.pageSize);
      const pageCount = Math.max(1, Math.ceil(prev.sessions.length / pageSize));
      const nextIndex = (prev.selectedIndex + delta + prev.sessions.length) % prev.sessions.length;
      return { ...prev, selectedIndex: nextIndex, pageIndex: Math.floor(nextIndex / pageSize) % pageCount };
    });
  }, []);

  const moveResumePage = useCallback((delta: number) => {
    setResumeSelector((prev) => {
      if (!prev || prev.sessions.length === 0) return prev;
      const pageSize = Math.max(1, prev.pageSize);
      const pageCount = Math.max(1, Math.ceil(prev.sessions.length / pageSize));
      const nextPage = Math.min(pageCount - 1, Math.max(0, prev.pageIndex + delta));
      const nextSelected = Math.min(prev.sessions.length - 1, nextPage * pageSize);
      return { ...prev, pageIndex: nextPage, selectedIndex: nextSelected };
    });
  }, []);

  const confirmResumeSelection = useCallback(() => {
    const selected = resumeSelector?.sessions[resumeSelector.selectedIndex];
    if (!selected) return;
    setResumeSelector(null);
    restoreSessionById(selected.sessionId);
  }, [restoreSessionById, resumeSelector]);

  const cancelResumeSelection = useCallback(() => {
    setResumeSelector(null);
    appendItem({
      id: newId("ui"),
      kind: "system",
      flavor: "info",
      text: "操作已取消。",
            createdAt: Date.now(),
    });
  }, [appendItem]);

  const sendMessage = useCallback(
    async (text: string) => {
      currentAbortRef.current?.abort();
      const abortController = new AbortController();
      currentAbortRef.current = abortController;
      appendItem({
        id: newId("ui"),
        kind: "user",
        text,
        createdAt: Date.now(),
      });

      setPhase("sending");

      try {
        const { request, events, done } = sessionManager.handle({
          userId: "user_local",
          frontend: "cli",
          mode: "chat",
          ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
          capabilities: {
            streaming: true,
            markdown: true,
            images: false,
            files: true,
            tools: true,
            confirmDialog: false,
            notifications: false,
          },
          message: { role: "user", parts: [{ type: "text", text }] },
          signal: abortController.signal,
        });

        if (!sessionIdRef.current) {
          sessionIdRef.current = request.sessionId;
          setSessionId(request.sessionId);
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "info",
            text: `Session started: session=${request.sessionId.slice(0, 12)}... model=${config.model.routing.main}`, 
            createdAt: Date.now(),
          });
        }

        for await (const ev of events) {
          const ui = translateStreamEvent(ev);
          if (!ui) continue;

          if (ui.kind === "delta") {
            pushDelta(ui.text);
          } else if (ui.kind === "tool_call") {
            commitLive();
            appendItem({
              id: newId("ui"),
              kind: "tool_call",
              callId: ui.callId,
              toolName: ui.toolName,
              arguments: ui.arguments,
              createdAt: Date.now(),
            });
          } else if (ui.kind === "tool_result") {
            const item: ToolResultChatItem = {
              id: newId("ui"),
              kind: "tool_result",
              callId: ui.callId,
              toolName: ui.toolName,
              status: ui.status === "timeout" ? "timed_out" : ui.status,
              createdAt: Date.now(),
              ...(ui.summary ? { summary: ui.summary } : {}),
              ...(ui.error ? { error: ui.error } : {}),
            };
            appendItem(item);
          } else if (ui.kind === "context_budget") {
            setContextBudget(ui.status);
          } else if (ui.kind === "model_status") {
            setModelStatus(ui.status);
          } else if (ui.kind === "subagent_notice") {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: ui.phase === "started" ? "tip" : "ack",
              text: `[subagent] ${ui.text}`,
              createdAt: Date.now(),
            });
          } else if (ui.kind === "memory_notice") {
            appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: `[memory] ${ui.text}`, createdAt: Date.now() });
            if (devEnabled && memoryManager) {
              appendItem({ id: newId("ui"), kind: "dev", channel: "memory.debug", data: memoryManager.getDebugSnapshot(), createdAt: Date.now() });
            }
          } else if (ui.kind === "warning") {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "info",
              text: `[warning] ${ui.code ? `[${ui.code}] ` : ""}${ui.message}`, 
              createdAt: Date.now(),
            });
          } else if (ui.kind === "error") {
            appendItem({
              id: newId("ui"),
              kind: "error",
              text: `${ui.code ? `[${ui.code}] ` : ""}${ui.message}`,
              createdAt: Date.now(),
            });
          }
        }

        const resp = await done;
        commitLive();
        setModelStatus(undefined);
        if (resp.error) {
          appendItem({
            id: newId("ui"),
            kind: "error",
            text: `${resp.error.code ?? "ERROR"}: ${resp.error.message ?? "session failed"}`,
            createdAt: Date.now(),
          });
        }
      } catch (err) {
        commitLive();
        if (abortController.signal.aborted) {
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "info",
            text: "操作已取消。",
            createdAt: Date.now(),
          });
        } else {
          appendItem({
            id: newId("ui"),
            kind: "error",
            text: err instanceof Error ? err.message : String(err),
            createdAt: Date.now(),
          });
        }
      } finally {
        if (currentAbortRef.current === abortController) currentAbortRef.current = null;
        setModelStatus(undefined);
        setPhase("idle");
      }
    },
    [appendItem, commitLive, config.model.routing.main, pushDelta, sessionManager],
  );

  const enqueueTeamBackgroundMember = useCallback((memberName: string, text = "Process your pending team inbox and continue the shared task.", metadata: { taskNodeId?: string } = {}) => {
    teamExecutionQueueRef.current?.enqueue(memberName, text, metadata);
  }, []);

  const enqueueReadyTeamNodes = useCallback((team: TeamOrchestrator) => {
    for (const node of team.readyTaskNodes()) {
      team.markTaskNodeRunning(node.id);
      const instruction = [
        "You are executing a concrete TeamTaskNode. The full task is provided below; do not claim the task is missing.",
        `Task node id: ${node.id}`,
        `Task title: ${node.title}`,
        `Task goal: ${node.description}`,
        node.expectedArtifactType ? `Expected artifact type: ${node.expectedArtifactType}` : "",
        node.contextHints && node.contextHints.length > 0 ? `Context hints:\n${node.contextHints.map((hint) => `- ${hint}`).join("\n")}` : "",
        "Complete this bounded task directly and return concise findings for the lead. If you need tools, use them. If appropriate, end with TEAM_ACTIONS to report completion to lead.",
      ].filter(Boolean).join("\n\n");
      enqueueTeamBackgroundMember(node.agent, instruction, { taskNodeId: node.id });
    }
  }, [enqueueTeamBackgroundMember]);

  const autoResumeLead = useCallback((team: TeamOrchestrator) => {
    if (leadAutoResumeRunningRef.current) return;
    const instruction = team.buildLeadResumeInstruction();
    if (!instruction) return;
    const leaderName = team.snapshot().session.leaderName;
    leadAutoResumeRunningRef.current = true;
    team.updateRunStatus("lead_running", { incrementRound: true });
    team.consumeLeadArtifacts();
    appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `[team:${leaderName}] auto-resuming lead with completed artifacts`, createdAt: Date.now() });
    void sendTeamMemberMessage(instruction, { auto: true, memberName: leaderName }).finally(() => {
      leadAutoResumeRunningRef.current = false;
    });
  }, [appendItem]);

  useEffect(() => {
    leadAutoResumeRef.current = autoResumeLead;
  }, [autoResumeLead]);

  const sendTeamMemberMessage = useCallback(
    async (text: string, options: { auto?: boolean; memberName?: string } = {}) => {
      const team = teamRef.current;
      const memberName = options.memberName ?? (options.auto ? activeTeamMemberRef.current : (teamInputMemberRef.current ?? activeTeamMemberRef.current));
          if (!team || !memberName) {
        await sendMessage(text);
        return;
      }

      if (!sessionIdRef.current) {
        appendItem({ id: newId("ui"), kind: "error", text: "Team messages require an existing session. Send a normal message first, or use /resume to restore a session.", createdAt: Date.now() });
        return;
      }

      currentAbortRef.current?.abort();
      const abortController = new AbortController();
      currentAbortRef.current = abortController;
      appendItem(options.auto
        ? { id: newId("ui"), kind: "system", flavor: "tip", text: `[team:${memberName}] auto-started from inbox`, createdAt: Date.now() }
        : { id: newId("ui"), kind: "user", text: `[team:${memberName}] ${text}`, createdAt: Date.now() });
      setPhase("sending");

      try {
        const isLeaderRun = team.snapshot().session.leaderName === memberName;
        if (isLeaderRun && !options.auto) team.startRun(text);
        if (isLeaderRun) team.updateRunStatus("lead_running");
        const { sessionId: memberSessionId, events, done } = team.runMember({ memberName, userText: text, userId: "user_local", signal: abortController.signal, leaderMode: isLeaderRun });
        let finalText = "";
        updateTeamStatus(team.snapshot(memberName));
        appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `Team member ${memberName} running in isolated session ${memberSessionId.slice(0, 12)}...`, createdAt: Date.now() });

        for await (const ev of events) {
          const ui = translateStreamEvent(ev);
          if (!ui) continue;
          if (ui.kind === "delta") {
            finalText += ui.text;
            pushDelta(ui.text);
          } else if (ui.kind === "tool_call") {
            commitLive();
            appendItem({ id: newId("ui"), kind: "tool_call", callId: ui.callId, toolName: ui.toolName, arguments: ui.arguments, createdAt: Date.now() });
          } else if (ui.kind === "tool_result") {
            appendItem({
              id: newId("ui"),
              kind: "tool_result",
              callId: ui.callId,
              toolName: ui.toolName,
              status: ui.status === "timeout" ? "timed_out" : ui.status,
              createdAt: Date.now(),
              ...(ui.summary ? { summary: ui.summary } : {}),
              ...(ui.error ? { error: ui.error } : {}),
            });
          } else if (ui.kind === "context_budget") {
            setContextBudget(ui.status);
          } else if (ui.kind === "model_status") {
            setModelStatus(ui.status);
          } else if (ui.kind === "warning") {
            appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: `[warning] ${ui.code ? `[${ui.code}] ` : ""}${ui.message}`, createdAt: Date.now() });
          } else if (ui.kind === "error") {
            appendItem({ id: newId("ui"), kind: "error", text: `${ui.code ? `[${ui.code}] ` : ""}${ui.message}`, createdAt: Date.now() });
          }
        }

        const resp = await done;
        commitLive();
        setModelStatus(undefined);
        let autoRunMember: string | undefined;
        const decisionResult = isLeaderRun ? teamRuntime.extractLeadDecision(finalText) : { decision: undefined };
        if (decisionResult.decision?.type === "dispatch_agents") {
          const nodes = team.createTaskNodes(decisionResult.decision.tasks);
          team.updateRunStatus("subagents_running");
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "ack",
            text: `${decisionResult.decision.userVisibleStatus}\n${nodes.map((node) => `- queued ${node.agent}: ${node.title}`).join("\n")}`,
            createdAt: Date.now(),
          });
          enqueueReadyTeamNodes(team);
          leadStageContinueCountRef.current = 0;
        } else if (decisionResult.decision?.type === "stage_summary") {
          team.updateRunStatus(decisionResult.decision.needsUserInput ? "waiting_user" : "lead_running");
          appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: decisionResult.decision.summary, createdAt: Date.now() });
          if (!decisionResult.decision.needsUserInput && decisionResult.decision.nextStep && leadStageContinueCountRef.current < 2) {
            leadStageContinueCountRef.current += 1;
            const leaderName = team.snapshot().session.leaderName;
            const instruction = [
              "Continue the same TeamRun immediately. Do not repeat the previous stage summary.",
              "Execute the next step or produce a final answer. If more teammate work is required, emit LEAD_DECISION dispatch_agents. If enough information is available, emit LEAD_DECISION final.",
              `Previous summary: ${decisionResult.decision.summary}`,
              `Next step: ${decisionResult.decision.nextStep}`,
            ].join("\n\n");
            appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `[team:${leaderName}] continuing stage next step`, createdAt: Date.now() });
            void sendTeamMemberMessage(instruction, { auto: true, memberName: leaderName });
          } else if (!decisionResult.decision.needsUserInput) {
            team.updateRunStatus("waiting_user");
            appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: "Team lead stopped after repeated stage summaries. Waiting for your next instruction to avoid a loop.", createdAt: Date.now() });
          }
        } else if (decisionResult.decision?.type === "final") {
          const finalIssue = validateTeamFinalAnswer(decisionResult.decision.answer);
          if (finalIssue && leadFinalRepairCountRef.current < 1) {
            leadFinalRepairCountRef.current += 1;
            team.updateRunStatus("lead_running");
            const leaderName = team.snapshot().session.leaderName;
            const instruction = [
              "Your previous final answer failed the quality gate and was not shown as final.",
              `Quality issue: ${finalIssue}`,
              "Rewrite the final answer with concrete report content from the available artifacts. Do not use placeholders or empty fields. If artifacts are insufficient, emit LEAD_DECISION dispatch_agents for a targeted follow-up task instead of final.",
            ].join("\n\n");
            appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `[team:${leaderName}] final answer failed quality gate; requesting repair`, createdAt: Date.now() });
            void sendTeamMemberMessage(instruction, { auto: true, memberName: leaderName });
          } else if (finalIssue) {
            team.updateRunStatus("waiting_user");
            appendItem({ id: newId("ui"), kind: "error", text: `Team final answer failed quality gate: ${finalIssue}`, createdAt: Date.now() });
          } else {
          team.updateRunStatus("completed");
          leadStageContinueCountRef.current = 0;
          leadFinalRepairCountRef.current = 0;
          appendItem({ id: newId("ui"), kind: "system", flavor: "ack", text: decisionResult.decision.answer, createdAt: Date.now() });
          }
        } else if (decisionResult.decision?.type === "ask_user") {
          team.updateRunStatus("waiting_user");
          leadStageContinueCountRef.current = 0;
          appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: `${decisionResult.decision.reason}\n${decisionResult.decision.question}`, createdAt: Date.now() });
        } else if (decisionResult.decision?.type === "abort") {
          team.updateRunStatus("failed", { failureReason: decisionResult.decision.reason });
          appendItem({ id: newId("ui"), kind: "error", text: decisionResult.decision.reason, createdAt: Date.now() });
        }
        const actions = decisionResult.decision ? [] : teamRuntime.extractLeadActions(finalText);
        if (actions.length > 0) {
          const results = teamRuntime.applyLeadActions(team, memberName, actions);
          const messagedMembers = new Set(actions.filter((action) => action.type === "send_message" && action.to && action.message).map((action) => teamRuntime.normalizeMemberName(action.to ?? "")));
          autoRunMember = actions.find((action) => action.type === "switch_member" && action.to && messagedMembers.has(teamRuntime.normalizeMemberName(action.to)))?.to;
          if (autoRunMember) team.updateRunStatus("subagents_running");
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "ack",
            text: `Team actions applied:\n${results.map((result) => `- ${result.status}: ${result.message}`).join("\n")}`,
            createdAt: Date.now(),
          });
          if (!autoRunMember && actions.some((action) => action.type === "switch_member")) {
            appendItem({ id: newId("ui"), kind: "system", flavor: "tip", text: "Ignored legacy switch_member without a matching send_message. Use LEAD_DECISION dispatch_agents for new work.", createdAt: Date.now() });
          }
        } else if (isLeaderRun) {
          team.updateRunStatus(resp.error ? "failed" : "waiting_user", resp.error?.message ? { failureReason: resp.error.message } : {});
          if (!finalText.trim() && !resp.error) {
            appendItem({
              id: newId("ui"),
              kind: "system",
              flavor: "info",
              text: "Team lead finished without dispatching more work. Waiting for your next instruction.",
              createdAt: Date.now(),
            });
          }
        }
        updateTeamStatus(team.snapshot(memberName));
        if (resp.error) appendItem({ id: newId("ui"), kind: "error", text: `${resp.error.code ?? "ERROR"}: ${resp.error.message ?? "team member failed"}`, createdAt: Date.now() });
        const handledLeadDecision = Boolean(decisionResult.decision);
        if (!resp.error && !autoRunMember && !handledLeadDecision) teamExecutionQueueRef.current?.enqueuePending(memberName);
        if (!resp.error && autoRunMember && teamRuntime.normalizeMemberName(autoRunMember) !== memberName) {
          const previousInputRoute = teamInputMemberRef.current ?? memberName;
          const delegatedMember = teamRuntime.normalizeMemberName(autoRunMember);
          appendItem({
            id: newId("ui"),
            kind: "system",
            flavor: "tip",
            text: "Team 已派发任务给 " + delegatedMember + "。它已进入后台并发队列；完成后 lead 会自动恢复并总结当前阶段。你的下一条消息仍会发给 " + previousInputRoute + "。如需直接对话，使用 /team switch " + delegatedMember + "。",
            createdAt: Date.now(),
          });
          enqueueTeamBackgroundMember(delegatedMember, "Process your pending team inbox and complete the delegated task.");
        }
      } catch (err) {
        commitLive();
        if (abortController.signal.aborted) {
          appendItem({ id: newId("ui"), kind: "system", flavor: "info", text: "Team member run interrupted.", createdAt: Date.now() });
        } else {
          appendItem({ id: newId("ui"), kind: "error", text: err instanceof Error ? err.message : String(err), createdAt: Date.now() });
        }
      } finally {
        if (currentAbortRef.current === abortController) currentAbortRef.current = null;
        setModelStatus(undefined);
        setPhase("idle");
      }
    },
    [appendItem, commitLive, pushDelta, sendMessage, teamRuntime, updateTeamStatus],
  );

  const submit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      const cmd = parseCommand(trimmed);
      if (cmd) {
        dispatchCommand(cmd);
        return;
      }

      if (teamRef.current && (teamInputMemberRef.current ?? activeTeamMemberRef.current)) {
        void sendTeamMemberMessage(trimmed);
        return;
      }

      void sendMessage(trimmed);
    },
    [dispatchCommand, sendMessage, sendTeamMemberMessage],
  );

  const interrupt = useCallback(() => {
    if (currentAbortRef.current && !currentAbortRef.current.signal.aborted) {
      currentAbortRef.current.abort();
      teamExecutionQueueRef.current?.stop();
      appendItem({
        id: newId("ui"),
        kind: "system",
        flavor: "info",
        text: "正在打断生成...",
        createdAt: Date.now(),
      });
    }
  }, [appendItem]);

  return useMemo<ChatStore>(
    () => ({
      items,
      live,
      phase,
      devEnabled,
      sessionId,
      modelId: config.model.routing.main,
      appName: config.app.name,
      appEnv: config.app.env,
      promptsDir: config.app.paths?.promptsDir,
      contextBudget,
      modelStatus,
      resumeSelector,
      teamStatus,
      teamActivities,
      commands: COMMANDS,
      submit,
      interrupt,
      moveResumeSelection,
      moveResumePage,
      confirmResumeSelection,
      cancelResumeSelection,
    }),
    [items, live, phase, devEnabled, sessionId, config, contextBudget, modelStatus, resumeSelector, teamStatus, teamActivities, submit, interrupt, moveResumeSelection, moveResumePage, confirmResumeSelection, cancelResumeSelection],
  );
}

function previewMessageContent(content: string): string {
  if (!content) return "";
  const max = 80;
  const oneLine = content.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function messagesToChatItems(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role === "user") {
          items.push({ id: newId("ui"), kind: "user", text: part.text, createdAt: message.createdAt });
        } else if (message.role === "assistant") {
          items.push({ id: newId("ui"), kind: "assistant_text", text: part.text, streaming: false, createdAt: message.createdAt });
        } else {
          items.push({ id: newId("ui"), kind: "system", flavor: "info", text: part.text, createdAt: message.createdAt });
        }
      } else if (part.type === "tool_call") {
        items.push({
          id: newId("ui"),
          kind: "tool_call",
          callId: part.callId,
          toolName: part.toolName,
          arguments: safeJsonParse(part.arguments),
          createdAt: message.createdAt,
        });
      } else if (part.type === "tool_result") {
        items.push({
          id: newId("ui"),
          kind: "tool_result",
          callId: part.callId,
          toolName: part.toolName,
          status: part.isError ? "failed" : "succeeded",
          summary: previewMessageContent(part.content),
          createdAt: message.createdAt,
        });
      }
    }
  }
  return items;
}

function validateTeamFinalAnswer(answer: string): string | undefined {
  const trimmed = answer.trim();
  if (trimmed.length < 120) return "final answer is too short to be a substantive report";
  if (/\[[^\]]*(?:内容|content|todo|tbd|待补充|placeholder)[^\]]*\]/i.test(trimmed)) return "final answer contains placeholder brackets";
  if (/\b(?:TBD|TODO|placeholder|待补充|未填写)\b/i.test(trimmed)) return "final answer contains placeholder text";
  if (/(?:关键文件|数据类型|数据量|结论|摘要)\s*[:：]\s*(?:\n|$|[-*]\s*(?:\n|$))/m.test(trimmed)) return "final answer contains empty report fields";
  if (/报告已经完成/.test(trimmed) && !/(?:##|###|[-*]\s+\S|\d+[.、]\s+\S)/.test(trimmed)) return "final answer claims completion but lacks report structure";
  return undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

