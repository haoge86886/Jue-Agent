#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareStartup } from "@jue/infra";
import { createRuntime } from "@jue/runtime";
import type { FrontendKind, SessionMode } from "@jue/shared-types";

interface WorkerInput {
  sessionId: string;
  projectDir: string;
  cwd: string;
  mode?: SessionMode;
  userId?: string;
  frontend?: FrontendKind;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) return;

  const input = JSON.parse(raw) as WorkerInput;
  if (!input.sessionId || !input.projectDir) return;
  logWorker(input.projectDir, `start sessionId=${input.sessionId}`);

  const workspaceRoot = input.cwd || input.projectDir;
  const startupContext = prepareStartup({
    cwd: workspaceRoot,
    args: [],
    stdinIsTTY: false,
    searchRoots: [workspaceRoot],
  });

  const { sessionManager, memoryManager, dreamMemory } = createRuntime({ startupContext });
  const loaded = sessionManager.loadPersistedSession(input.sessionId);
  if (!loaded) {
    logWorker(input.projectDir, `session not found sessionId=${input.sessionId}`);
    memoryManager.submitBufferedExtraction("exit");
  await memoryManager.flush();
    const dream = await dreamMemory.runIfDue();
    logWorker(input.projectDir, `dream without session ${JSON.stringify(dream)}`);
    return;
  }

  const history = loaded.messages;
  if (history.length > 0) {
    await sessionManager.summarizeSessionToFile({
      sessionId: input.sessionId,
      userId: input.userId ?? loaded.summary.userId,
      frontend: input.frontend ?? loaded.summary.frontend,
      mode: input.mode ?? loaded.summary.mode,
      history,
      trigger: "agent_close",
    });
  }
  memoryManager.submitBufferedExtraction("exit");
  await memoryManager.flush();
  const dream = await dreamMemory.runIfDue();
  logWorker(input.projectDir, `dream ${JSON.stringify(dream)}`);
}

function logWorker(projectDir: string, message: string): void {
  try {
    const logDir = join(homedir(), ".jue", "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "memory-maintenance.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Background maintenance must never block CLI shutdown.
  }
}

void main().catch((error) => {
  const raw = process.argv[2];
  try {
    const input = raw ? JSON.parse(raw) as Partial<WorkerInput> : undefined;
    if (input?.projectDir) logWorker(input.projectDir, `failed ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } catch {
    // The worker is detached; there is no foreground channel to report parse/log failures.
  }
});

