import React, { useCallback, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { SessionManager } from "@jue/session";
import type { RootConfig } from "@jue/config";
import type { TeamRuntime } from "@jue/runtime";
import type { DreamMemoryMaintenanceService, MemoryManager } from "@jue/memory";
import type { PreparedStartupContext } from "@jue/infra";
import { MessageItem } from "./components/MessageItem.js";
import { Composer } from "./components/Composer.js";
import { WelcomeHero } from "./components/WelcomeHero.js";
import { ContextBudgetBadge } from "./components/ContextBudgetBadge.js";
import { AskUserQuestionPanel } from "./components/AskUserQuestionPanel.js";
import { ResumeSessionPanel } from "./components/ResumeSessionPanel.js";
import { TeamActivityPanel } from "./components/TeamActivityPanel.js";
import { useStableColumns } from "./hooks/use-stable-columns.js";
import type { CliAskUserQuestionBridge, PendingAskUserQuestion } from "./ask-user-bridge.js";
import { useChatStore } from "./state/useChatStore.js";
import type { DebugTeeModelGateway } from "./debug-tee-gateway.js";
import { TEXT } from "./theme.js";

interface AppRootProps {
  sessionManager: SessionManager;
  teamRuntime: TeamRuntime;
  config: Readonly<RootConfig>;
  startupContext?: PreparedStartupContext | undefined;
  debugGateway?: DebugTeeModelGateway;
  memoryManager?: MemoryManager;
  dreamMemory?: DreamMemoryMaintenanceService;
  askUserBridge?: CliAskUserQuestionBridge;
}

export const AppRoot: React.FC<AppRootProps> = ({
  sessionManager,
  teamRuntime,
  config,
  startupContext,
  debugGateway,
  memoryManager,
  dreamMemory,
  askUserBridge,
}) => {
  const { exit } = useApp();
  const { columns, isResizing } = useStableColumns();
  const [draft, setDraft] = useState("");
  const [pendingAsk, setPendingAsk] = useState<PendingAskUserQuestion | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number | null>(null);
  const draftBeforeHistoryRef = useRef("");

  React.useEffect(() => {
    if (!askUserBridge) return undefined;
    return askUserBridge.subscribe(setPendingAsk);
  }, [askUserBridge]);

  const store = useChatStore({
    sessionManager,
    teamRuntime,
    config,
    startupContext,
    onExit: () => exit(),
    ...(debugGateway ? { debugGateway } : {}),
    ...(memoryManager ? { memoryManager } : {}),
    ...(dreamMemory ? { dreamMemory } : {}),
  });

  const setDraftFromUser = useCallback((next: string) => {
    historyCursorRef.current = null;
    draftBeforeHistoryRef.current = "";
    setDraft(next);
  }, []);

  const navigateInputHistory = useCallback((delta: -1 | 1) => {
    const history = inputHistoryRef.current;
    if (history.length === 0) return;

    const current = historyCursorRef.current;
    if (current === null) {
      if (delta > 0) return;
      draftBeforeHistoryRef.current = draft;
      const next = history.length - 1;
      historyCursorRef.current = next;
      setDraft(history[next] ?? "");
      return;
    }

    const next = current + delta;
    if (next < 0) {
      historyCursorRef.current = 0;
      setDraft(history[0] ?? "");
      return;
    }

    if (next >= history.length) {
      historyCursorRef.current = null;
      setDraft(draftBeforeHistoryRef.current);
      draftBeforeHistoryRef.current = "";
      return;
    }

    historyCursorRef.current = next;
    setDraft(history[next] ?? "");
  }, [draft]);

  useInput((input, key) => {
    if (store.resumeSelector) {
      if (key.pageUp || key.leftArrow) {
        store.moveResumePage(-1);
        return;
      }
      if (key.pageDown || key.rightArrow) {
        store.moveResumePage(1);
        return;
      }
      if (key.upArrow) {
        store.moveResumeSelection(-1);
        return;
      }
      if (key.downArrow) {
        store.moveResumeSelection(1);
        return;
      }
      if (key.return) {
        store.confirmResumeSelection();
        return;
      }
      if (key.escape) {
        store.cancelResumeSelection();
        return;
      }
    }

    if (!pendingAsk && store.phase === "idle") {
      if (key.upArrow) {
        navigateInputHistory(-1);
        return;
      }
      if (key.downArrow) {
        navigateInputHistory(1);
        return;
      }
    }

    if (key.ctrl && input === "c") {
      store.submit("/exit");
      return;
    }
    if (key.escape) {
      if (pendingAsk && askUserBridge) {
        askUserBridge.answer({
          selectedOptionId: "esc_cancel",
          approved: false,
          approveSimilarFutureRequests: false,
          instruction: "用户按 Esc 取消了本次询问。请停止当前操作，等待用户下一步指令。",
          metadata: { cancelledBy: "esc" },
        });
      }
      store.interrupt();
    }
  });

  const handleSubmit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed) {
      const history = inputHistoryRef.current;
      if (history[history.length - 1] !== trimmed) {
        inputHistoryRef.current = [...history.slice(-99), trimmed];
      }
    }
    historyCursorRef.current = null;
    draftBeforeHistoryRef.current = "";
    store.submit(raw);
    setDraft("");
  };

  const showThinking = store.phase === "sending" && store.live === null;
  const thinkingText = store.modelStatus?.message ?? "thinking...";
  const viewportWidth = Math.max(40, columns);
  const showWelcomeHero = store.items.length === 0 && store.live === null;

  return (
    <Box flexDirection="column" width={viewportWidth}>
      <Box flexDirection="column" paddingX={1}>
        {showWelcomeHero ? (
          <WelcomeHero config={config} cwd={startupContext?.env.cwd ?? process.cwd()} width={Math.max(20, viewportWidth - 2)} />
        ) : null}

        <Static items={store.items}>{(item) => <MessageItem key={item.id} item={item} />}</Static>

        {!isResizing ? (
          <>
            {showThinking ? (
              <Box paddingLeft={1} flexShrink={0}>
                <Text color={TEXT.muted}>
                  <Spinner type="dots" /> <Text> {thinkingText}</Text>
                </Text>
              </Box>
            ) : null}

            {store.live ? <MessageItem item={store.live} /> : null}
          </>
        ) : null}
      </Box>

      {!isResizing ? (
        <>
          <Box paddingX={1}>
            <ContextBudgetBadge status={store.contextBudget} width={Math.max(20, viewportWidth - 2)} />
          </Box>
          {store.teamStatus ? (
            <Box paddingX={1}>
              <Text color={TEXT.muted}>
                Team {store.teamStatus.teamName} | run {store.teamStatus.runStatus ?? "idle"}{store.teamStatus.runRound ? ` r${store.teamStatus.runRound}` : ""} | input {store.teamStatus.inputMemberName} | active {store.teamStatus.activeMemberName} | members {store.teamStatus.members.length} | tasks {store.teamStatus.tasks.length} | inbox {store.teamStatus.pendingInboxCount} | dirty {store.teamStatus.dirtyArtifactCount} | running {store.teamStatus.runningCount} | queued {store.teamStatus.queuedCount}
              </Text>
            </Box>
          ) : null}
          {store.teamStatus ? (
            <Box paddingX={1}>
              <TeamActivityPanel status={store.teamStatus} activities={store.teamActivities} width={Math.max(20, viewportWidth - 2)} />
            </Box>
          ) : null}
          {store.resumeSelector ? (
            <Box paddingX={1}>
              <ResumeSessionPanel state={store.resumeSelector} width={Math.max(20, viewportWidth - 2)} />
            </Box>
          ) : null}
          {pendingAsk && askUserBridge ? (
            <Box paddingX={1}>
              <AskUserQuestionPanel
                pending={pendingAsk}
                onAnswer={(response) => askUserBridge.answer(response)}
                onCancel={() => {
                  askUserBridge.answer({
                    selectedOptionId: "esc_cancel",
                    approved: false,
                    approveSimilarFutureRequests: false,
                    instruction: "用户按 Esc 取消了本次询问。请停止当前操作，等待用户下一步指令。",
                    metadata: { cancelledBy: "esc" },
                  });
                  store.interrupt();
                }}
                width={Math.max(20, viewportWidth - 2)}
              />
            </Box>
          ) : null}
          <Box paddingX={1} paddingBottom={1}>
            <Composer
              value={draft}
              onChange={setDraftFromUser}
              onSubmit={handleSubmit}
              busy={store.phase !== "idle" || pendingAsk !== null}
              closed={store.phase === "exiting"}
              width={Math.max(20, viewportWidth - 2)}
            />
          </Box>
        </>
      ) : null}
    </Box>
  );
};
