/**
 * Ink chat frontend runner.
 *
 * The launcher decides that the CLI chat target should run. This module then
 * creates a runtime with the CLI debug gateway wrapper and renders AppRoot in
 * Ink. It should not parse process-level startup intent.
 */

import React from "react";
import { render } from "ink";
import type { PreparedStartupContext } from "@jue/infra";
import { createRuntime, type CreateRuntimeOptions } from "@jue/runtime";
import { join } from "node:path";
import { AppRoot } from "./ui/AppRoot.js";
import { CliAskUserQuestionBridge } from "./ui/ask-user-bridge.js";
import { DebugTeeModelGateway } from "./ui/debug-tee-gateway.js";
import { ProjectSettingsStore } from "./ui/project-settings-store.js";

export interface RunChatOptions {
  configFile?: string;
  configsDir?: string;
  modelOverride?: string;
  startupContext?: PreparedStartupContext;
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  let debugGateway: DebugTeeModelGateway | undefined;
  const settingsStore = opts.startupContext
    ? new ProjectSettingsStore(join(opts.startupContext.jue.projectDir, "settings.json"))
    : undefined;
  const askUserBridge = new CliAskUserQuestionBridge(settingsStore);

  const runtimeOpts: CreateRuntimeOptions = {
    askUserQuestionProvider: askUserBridge.provider,
    wrapGateway: (inner) => {
      debugGateway = new DebugTeeModelGateway(inner);
      return debugGateway;
    },
  };
  if (opts.startupContext) runtimeOpts.startupContext = opts.startupContext;
  if (opts.configFile) runtimeOpts.configFile = opts.configFile;
  if (opts.configsDir) runtimeOpts.configsDir = opts.configsDir;
  if (opts.modelOverride) runtimeOpts.modelOverride = opts.modelOverride;

  const { sessionManager, teamRuntime, config, memoryManager, dreamMemory } = createRuntime(runtimeOpts);

  const app = render(
    <AppRoot
      sessionManager={sessionManager}
      teamRuntime={teamRuntime}
      config={config}
      memoryManager={memoryManager}
      dreamMemory={dreamMemory}
      askUserBridge={askUserBridge}
      {...(opts.startupContext ? { startupContext: opts.startupContext } : {})}
      {...(debugGateway ? { debugGateway } : {})}
    />,
    {
      exitOnCtrlC: false,
    },
  );

  await app.waitUntilExit();
}

