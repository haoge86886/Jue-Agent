/**
 * Runtime composition layer.
 *
 * Frontends call this after the launcher has prepared a StartupContext. This
 * module wires config, logging, prompts, tools, memory, engine, and session
 * objects together. It must not parse CLI args or decide which frontend runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAuditLogger } from "@jue/audit";
import { getConfig, initConfig, type ConfigLoaderOptions, type ModelProfile, type RootConfig } from "@jue/config";
import { ContextManager, DefaultContextCompressor, ThresholdContextBudgeter } from "@jue/context";
import { AgentEngine, DefaultToolOrchestrator, OpenAICompatibleGateway, type ModelGateway } from "@jue/engine";
import { prepareStartup, type PreparedStartupContext } from "@jue/infra";
import { AsyncMemoryPipeline, buildMemoryIndexBlocks, DreamMemoryMaintenanceService, FileMemoryRepository, LlmDreamMemoryPruner, LlmDreamObservationPruner, LlmMemoryExtractor, MemoryManager, normalizeMemoryExtractionOutput, normalizeMemoryPruningOutput, normalizeObservationPruningOutput, workspacePathSlug, type DreamMemoryPrunerRunner, type DreamMemoryPruningContext, type DreamObservationPrunerRunner, type MemoryExtractionOutput, type MemoryExtractorRunner, type MemoryLlmGateway, type MemoryPruningOutput, type ObservationPruningOutput, type StyleObservationCandidate } from "@jue/memory";
import {
  DynamicPromptBuilder,
  InMemoryPromptKvCache,
  InMemorySnapshotStore,
  PromptManager,
  PromptTemplateEngine,
  StaticPromptLoader,
} from "@jue/prompting";
import { FileSessionRepository, FileToolResultRepository, SessionManager, type SessionTranscriptSink } from "@jue/session";
import { FilesystemSkillProvider } from "@jue/skills";
import {
  CompactionSubAgentRunnerAdapter,
  createCompactionSubAgentRegistration,
  createDefaultSubAgentRegistrations,
  DefaultSubAgentPlanBuilder,
  FileSubAgentMemoryProvider,
  ScopedSubAgentMemoryProvider,
  LlmCompactionSubAgentRunner,
  SubAgentLoopRunner,
  RuleCompactionSubAgentRunner,
  SubAgentManager,
  SubAgentRegistry,
} from "@jue/subagent";
import { TeamExecutionQueue, TeamOrchestrator, applyTeamLeadActions, extractLeadDecision, extractTeamLeadActions, normalizeMemberName, type LeadDecisionParseResult, type TeamLeadAction, type TeamLeadActionResult, type TeamMemberRunner, type TeamPromptProvider, type TeamQueueEvent, type TeamSnapshot } from "@jue/team";
import { DefaultToolExecutor, MCPAdapter, PlanModeStore, memoryWriteInvocationToRecord, registerBuiltinTools, ToolRegistry, type AskUserQuestionProvider, type BuiltinToolRegistrationOptions, type ToolHandler, type ToolPermissionProvider } from "@jue/tools";
import { isWithinRoot, PathPermissionStore, type PathPermissionProvider } from "@jue/tools";
import { getAuditLogger, getModuleLogger, initLogger, newId, setAuditLogger, type AuditLogger } from "@jue/utils";
import type { FrontendCapabilities, MemoryDocument, MemoryExtractionInput } from "@jue/shared-types";

export type { TeamOrchestrator, TeamSnapshot } from "@jue/team";
export type { TeamExecutionQueue, TeamQueueEvent } from "@jue/team";

export interface RuntimeHandle {
  config: Readonly<RootConfig>;
  sessionManager: SessionManager;
  teamRuntime: TeamRuntime;
  engine: AgentEngine;
  modelGateway: ModelGateway;
  startupContext: PreparedStartupContext;
  memoryManager: MemoryManager;
  dreamMemory: DreamMemoryMaintenanceService;
}

export interface TeamRuntime {
  createTeam(options?: { teamName?: string }): TeamOrchestrator;
  createQueue(options: { team: TeamOrchestrator; concurrency?: number; onEvent?: (event: TeamQueueEvent) => void }): TeamExecutionQueue;
  normalizeMemberName(input: string): string;
  extractLeadDecision(text: string): LeadDecisionParseResult;
  extractLeadActions(text: string): TeamLeadAction[];
  applyLeadActions(team: TeamOrchestrator, from: string, actions: readonly TeamLeadAction[]): TeamLeadActionResult[];
}

export interface CreateRuntimeOptions extends ConfigLoaderOptions {
  startupContext?: PreparedStartupContext;
  modelOverride?: string;
  wrapGateway?: (inner: ModelGateway) => ModelGateway;
  askUserQuestionProvider?: AskUserQuestionProvider;
  /**
   * Ink/TTY frontends must keep stderr clean, otherwise JSON logs are rendered as chat text.
   * Set this to true only for explicit debugging runs that want pino logs mirrored to the terminal.
   */
  consoleLogging?: boolean;
}

export function createRuntime(options: CreateRuntimeOptions = {}): RuntimeHandle {
  const {
    startupContext: providedStartupContext,
    modelOverride,
    wrapGateway,
    askUserQuestionProvider,
    consoleLogging = false,
    ...configOptions
  } = options;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const startupContext = providedStartupContext ?? prepareStartup({
    ...(configOptions.cwd ? { cwd: configOptions.cwd, configRoot: configOptions.cwd } : {}),
    searchRoots: [moduleDir],
  });
  const runtimeRoot = configOptions.cwd ?? startupContext.env.configRoot;
  const configFile = configOptions.configFile ?? startupContext.env.configFile;
  const workspaceRoot = startupContext.env.workspaceRoot;

  initConfig({ ...configOptions, cwd: runtimeRoot, configFile, homeDir: startupContext.env.homeDir });
  const config = getConfig();

  const logsDir = resolve(startupContext.jue.globalDir, "logs");
  const appLogPath = resolve(logsDir, "app.log");
  const auditLogPath = resolve(logsDir, "audit.log");
  const logRetainDays = config.security.audit?.retainDays ?? 180;
  initLogger({
    enabled: config.app.telemetry?.enabled !== false,
    level: config.app.telemetry?.logLevel ?? "info",
    base: { app: config.app.name, env: config.app.env },
    logFile: appLogPath,
    console: consoleLogging,
    retainDays: logRetainDays,
    ...(config.app.telemetry?.redactKeys ? { redactPaths: [...config.app.telemetry.redactKeys] } : {}),
  });
  const logger = getModuleLogger("runtime");

  const profileId = modelOverride ?? config.model.routing.main;
  const profile = config.model.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`model profile not found: ${profileId} (routing.main=${config.model.routing.main})`);
  }
  if (profile.enabled === false) {
    throw new Error(`selected model profile is disabled: ${profileId}`);
  }

  const baseGateway = new OpenAICompatibleGateway(profile);
  const modelGateway = wrapGateway ? wrapGateway(baseGateway) : baseGateway;

  const promptsDir = resolve(runtimeRoot, config.app.paths?.promptsDir ?? "./prompts");
  const promptTemplateEngine = new PromptTemplateEngine();
  const promptKvCache = new InMemoryPromptKvCache();
  const staticLoader = new StaticPromptLoader({
    staticDir: resolve(promptsDir, "static"),
    runtimePaths: {
      workspaceRoot,
      promptsDir,
      userStateDir: startupContext.jue.globalDir,
      projectStateDir: startupContext.jue.projectDir,
    },
    templateEngine: promptTemplateEngine,
    kvCache: promptKvCache,
  });
  const promptManager = new PromptManager({
    staticLoader,
    dynamicBuilder: new DynamicPromptBuilder(),
    snapshotStore: new InMemorySnapshotStore(),
    templateEngine: promptTemplateEngine,
  });

  const subAgentRegistry = new SubAgentRegistry();
  const compactionSubAgent = createCompactionSubAgentRegistration();
  subAgentRegistry.register(compactionSubAgent);
  for (const registration of createDefaultSubAgentRegistrations()) {
    subAgentRegistry.register(registration);
  }

  const contextCfg = config.context;
  const contextManager = new ContextManager({
    budgeter: new ThresholdContextBudgeter({
      ruleCompressionThreshold: contextCfg.budgeter.ruleCompressionThreshold,
      llmCompressionThreshold: contextCfg.budgeter.llmCompressionThreshold,
      maxCompressionFailures: contextCfg.budgeter.maxCompressionFailures,
    }),
    defaultBudget: contextCfg.mainAgentBudget,
    defaultSubAgentBudget: contextCfg.subAgentBudget,
    ruleCompressionOptions: {
      staleAfterMs: contextCfg.ruleCompression.staleAfterMs,
      lowRelevanceThreshold: contextCfg.ruleCompression.lowRelevanceThreshold,
      recentToolResultCount: contextCfg.ruleCompression.recentToolResultCount,
      maxContentChars: contextCfg.ruleCompression.maxContentChars,
    },
    runRuleCompressionEveryBuild: contextCfg.ruleCompression.runEveryBuild,
    compressor: new DefaultContextCompressor({
      llmRunner: new CompactionSubAgentRunnerAdapter({
        runner: new LlmCompactionSubAgentRunner({
          gateway: modelGateway,
          fallbackRunner: new RuleCompactionSubAgentRunner(),
          ...optionalPromptText(loadSubAgentPrompt(promptsDir, "compaction")),
        }),
        registration: compactionSubAgent,
      }),
    }),
  });
  const toolRegistry = new ToolRegistry();
  const toolHandlers = new Map<string, ToolHandler>();
  const planModeStore = new PlanModeStore();
  const builtinCfg = config.tools.builtin;
  const memoryWritableRoots = buildMemoryWritableRoots({
    globalJueDir: startupContext.jue.globalDir,
    workspaceRoot,
  });
  const pathPermissions = new PathPermissionStore([
    workspaceRoot,
    ...memoryWritableRoots,
    ...loadProjectAllowedRoots(startupContext.jue.projectDir),
  ]);
  const skillProvider = new FilesystemSkillProvider({
    roots: [
      { scope: "global", dir: startupContext.jue.globalDir },
      { scope: "project", dir: startupContext.jue.projectDir },
    ],
  });
  const builtinToolRegistration: BuiltinToolRegistrationOptions = {
    registry: toolRegistry,
    handlers: toolHandlers,
    workspaceRoot,
    enabled: {
      fileRead: builtinCfg?.fileReadEnabled !== false,
      fileWrite: builtinCfg?.fileWriteEnabled === true,
      fileEdit: builtinCfg?.fileEditEnabled !== false,
      fileSearch: builtinCfg?.fileSearchEnabled !== false,
      listTree: builtinCfg?.listTreeEnabled !== false,
      textSearch: builtinCfg?.textSearchEnabled !== false,
      todo: builtinCfg?.todoEnabled !== false,
      planMode: true,
      backgroundTask: builtinCfg?.backgroundTaskEnabled !== false,
      skill: builtinCfg?.skillEnabled !== false,
      askUserQuestion: builtinCfg?.askUserQuestionEnabled !== false,
      memoryWrite: true,
      shell: builtinCfg?.shellEnabled === true,
      http: builtinCfg?.httpEnabled === true,
    },
    ...(builtinCfg?.shellAllowedCommands ? { shellAllowedCommands: builtinCfg.shellAllowedCommands } : {}),
    ...(builtinCfg?.shellBlockedPatterns ? { shellBlockedPatterns: builtinCfg.shellBlockedPatterns } : {}),
    ...(builtinCfg?.httpAllowedHosts ? { httpAllowedHosts: builtinCfg.httpAllowedHosts } : {}),
    ...(builtinCfg?.httpBlockedHosts ? { httpBlockedHosts: builtinCfg.httpBlockedHosts } : {}),
    pathPermissions,
    planModeStore,
    skillProvider: skillProvider.asToolProvider(),
    memoryWriteProvider: async (invocation, ctx) => {
      const record = memoryWriteInvocationToRecord(invocation, {
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        workspaceRoot,
      });
      const written = await memoryManager.write({
        requestId: ctx.requestId ?? newId("memreq"),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        workspaceRoot,
        source: invocation.provenance === "explicit" || !invocation.provenance ? "explicit_user" : "subagent",
        records: [record],
      });
      return {
        written: written.map((item) => ({
          id: item.id,
          scope: item.scope,
          title: item.title,
          status: item.status,
          ...(typeof item.metadata?.memoryType === "string" ? { type: item.metadata.memoryType as never } : {}),
          ...(typeof item.metadata?.writeMode === "string" ? { writeMode: item.metadata.writeMode as string } : {}),
          ...(typeof item.metadata?.memoryPath === "string" ? { memoryPath: item.metadata.memoryPath as string } : {}),
          ...(typeof item.metadata?.classificationReason === "string" ? { classificationReason: item.metadata.classificationReason as string } : {}),
        })),
      };
    },
    subagentInvokeProvider: async (request, ctx) => {
      const result = await subAgentManager.dispatch({
        sessionId: ctx?.call.sessionId ?? newId("session"),
        requestId: ctx?.call.requestId ?? newId("request"),
        ...(ctx?.call.id ? { parentCallId: ctx.call.id } : {}),
        subagentName: request.subagentName,
        goal: request.goal,
        ...(request.title ? { title: request.title } : {}),
        ...(request.successCriteria ? { successCriteria: request.successCriteria } : {}),
        ...(request.constraints ? { constraints: request.constraints } : {}),
        ...(request.inputs ? { inputs: request.inputs } : {}),
        ...(request.contextBlocks ? { contextBlocks: request.contextBlocks as never[] } : {}),
        ...(request.memoryRecords ? { memoryRecords: request.memoryRecords as never[] } : {}),
        ...(request.budget ? { budget: request.budget as never } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
      return {
        taskId: result.taskId,
        subagentName: request.subagentName,
        status: result.status,
        conclusion: result.conclusion,
        ...(result.details ? { details: result.details } : {}),
        outputs: {
          ...(result.outputs ?? {}),
          evidence: result.evidence,
          risks: result.risks,
          suggestedActions: result.suggestedActions,
          usage: result.usage,
        },
      };
    },
    ...(askUserQuestionProvider ? { askUserQuestionProvider } : {}),
  };
  registerBuiltinTools(builtinToolRegistration);
  logger.info({ tools: toolRegistry.enabledNames(), skills: skillProvider.listSkills().map((skill) => skill.name), workspaceRoot }, "builtin tools registered");

  if (config.tools.enabledKinds.includes("mcp") && config.tools.mcpServers.length > 0) {
    const mcpAdapter = new MCPAdapter();
    for (const server of config.tools.mcpServers) {
      if (server.enabled === false) continue;
      void mcpAdapter.connectAndAdapt({
        id: server.id,
        transport: server.transport,
        args: server.args,
        env: server.env,
        headers: server.headers,
        cwd: workspaceRoot,
        ...(server.displayName ? { displayName: server.displayName } : {}),
        ...(server.command ? { command: server.command } : {}),
        ...(server.url ? { url: server.url } : {}),
        ...(server.toolPrefix ? { toolPrefix: server.toolPrefix } : {}),
        ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
        ...(server.blockedTools ? { blockedTools: server.blockedTools } : {}),
      }).then((result) => {
        for (const item of result.tools) {
          toolRegistry.register(item.spec, { enabled: item.enabled, ...(item.reason ? { reason: item.reason } : {}) });
          if (item.handler) toolHandlers.set(item.spec.name, item.handler);
        }
        for (const diagnostic of result.diagnostics) {
          logger.warn(diagnostic, "mcp tool registration diagnostic");
        }
      }).catch((err: unknown) => {
        logger.warn({ serverId: server.id, err }, "mcp adapter failed");
      });
    }
  }

  const toolExecutor = new DefaultToolExecutor({
    registry: toolRegistry,
    handlers: toolHandlers,
    permissionProvider: createPermissionProviderFromAskUser(askUserQuestionProvider, memoryWritableRoots, workspaceRoot),
    pathPermissions,
    planModeStore,
    ...(
      askUserQuestionProvider
        ? { pathPermissionProvider: createPathPermissionProviderFromAskUser(askUserQuestionProvider, memoryWritableRoots) }
        : {}
    ),
  });
  const toolOrchestrator = new DefaultToolOrchestrator(toolExecutor);
  let transcriptSink: SessionTranscriptSink | undefined;
  const deferredTranscriptSink: SessionTranscriptSink = {
    appendToolResultPersisted: (input) => transcriptSink?.appendToolResultPersisted(input),
    appendDurableCompression: (input) => transcriptSink?.appendDurableCompression(input),
    appendSubAgentEvent: (input) => transcriptSink?.appendSubAgentEvent(input),
  };

  const memoryLlmGateway = createMemoryLlmGateway(modelGateway);
  const memoryRepository = new FileMemoryRepository({
    globalJueDir: startupContext.jue.globalDir,
    workspaceRoot,
  });
  const formalMemoryWriteTurnKeys = new Map<string, { at: number; callId?: string; records?: unknown[] }>();
  const formalMemoryTurnKey = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`;
  const pruneFormalMemoryWriteTurnKeys = (): void => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of formalMemoryWriteTurnKeys) {
      if (value.at < cutoff) formalMemoryWriteTurnKeys.delete(key);
    }
  };
  let memoryManager!: MemoryManager;
  let subAgentManager!: SubAgentManager;
  const directMemoryExtractor = new LlmMemoryExtractor(memoryLlmGateway);
  const directDreamMemoryPruner = new LlmDreamMemoryPruner(memoryLlmGateway);
  const directDreamObservationPruner = new LlmDreamObservationPruner(memoryLlmGateway);
  const memoryExtractorRunner = new SubAgentMemoryExtractorRunner({
    getManager: () => subAgentManager,
    fallback: directMemoryExtractor,
  });
  const dreamMemoryPrunerRunner = new SubAgentDreamMemoryPrunerRunner({
    getManager: () => subAgentManager,
    fallback: directDreamMemoryPruner,
  });
  const dreamObservationPrunerRunner = new SubAgentDreamObservationPrunerRunner({
    getManager: () => subAgentManager,
    fallback: directDreamObservationPruner,
  });
  const memoryPipeline = new AsyncMemoryPipeline({
    repository: memoryRepository,
    extractorRunner: memoryExtractorRunner,
    globalJueDir: startupContext.jue.globalDir,
    debugSink: { pushMemoryDebug: (event) => memoryManager.pushMemoryDebug(event) },
  });
  memoryManager = new MemoryManager({
    repository: memoryRepository,
    pipeline: memoryPipeline,
    prunerRunner: dreamMemoryPrunerRunner,
    observationPrunerRunner: dreamObservationPrunerRunner,
  });
  const dreamMemory = new DreamMemoryMaintenanceService({
    globalJueDir: startupContext.jue.globalDir,
    workspaceRoot,
    repository: memoryRepository,
    maintain: (context) => memoryManager.maintain(context),
  });

  const subAgentFileMemoryProvider = new FileSubAgentMemoryProvider({ globalJueDir: startupContext.jue.globalDir });
  const subAgentMemoryProvider = new ScopedSubAgentMemoryProvider({
    memorySource: memoryManager,
    fallback: subAgentFileMemoryProvider,
    workspaceRoot,
  });

  subAgentManager = new SubAgentManager({
    registry: subAgentRegistry,
    planBuilder: new DefaultSubAgentPlanBuilder({
      contextBuilder: contextManager,
      toolCatalog: toolRegistry,
      promptProvider: { load: (registration) => loadSubAgentPrompt(promptsDir, registration.type) ?? loadSubAgentPrompt(promptsDir, registration.promptNamespace.replace(/^subagents\//, "")) },
      memoryProvider: subAgentMemoryProvider,
      defaultContextBudget: contextCfg.subAgentBudget,
    }),
    runnerFactory: (registration) => new SubAgentLoopRunner({
      gateway: modelGateway,
      toolExecutor: { execute: (call) => toolExecutor.execute(call) },
    }),
    defaultBudget: {
      maxTokens: contextCfg.subAgentBudget.totalTokenBudget,
      maxToolCalls: 8,
      maxDurationMs: 120_000,
      maxRecursionDepth: 0,
    },
    memoryProvider: subAgentMemoryProvider,
    transcriptSink: {
      appendSubAgentEvent: (event) => deferredTranscriptSink.appendSubAgentEvent({
        sessionId: event.sessionId,
        requestId: event.requestId,
        payload: {
          eventId: event.eventId,
          taskId: event.taskId,
          subagentName: event.subagentName,
          type: event.type,
          at: event.at,
          payload: event.payload,
        },
      }),
    },
  });
  const auditCfg = config.security.audit;
  const auditEnabled = auditCfg?.enabled !== false;
  let auditLogger: AuditLogger;
  if (auditEnabled) {
    auditLogger = new FileAuditLogger({ path: auditLogPath });
    setAuditLogger(auditLogger);
  } else {
    auditLogger = getAuditLogger();
  }

  const sessionRepository = new FileSessionRepository({ globalJueDir: startupContext.jue.globalDir, workspaceRoot });
  const toolResultRepository = new FileToolResultRepository({ globalJueDir: startupContext.jue.globalDir, workspaceRoot });

  const markFormalMemoryWritten = (input: { sessionId: string; requestId: string; callId?: string; records?: unknown[] }): void => {
    pruneFormalMemoryWriteTurnKeys();
    formalMemoryWriteTurnKeys.set(formalMemoryTurnKey(input.sessionId, input.requestId), {
      at: Date.now(),
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.records ? { records: input.records } : {}),
    });
  };
  const hasFormalMemoryWritten = (input: { sessionId: string; requestId: string }): boolean => {
    pruneFormalMemoryWriteTurnKeys();
    return formalMemoryWriteTurnKeys.has(formalMemoryTurnKey(input.sessionId, input.requestId));
  };

  const engine = new AgentEngine({
    promptManager,
    contextManager,
    modelGateway,
    toolRegistry,
    toolOrchestrator,
    memoryManager,
    subAgentRegistry,
    auditLogger,
    toolResultRepository,
    transcriptSink: deferredTranscriptSink,
    compressionPersistence: { autoPersist: false, pressureLevels: ["overflow"] },
    maxLoopIters: config.app.agentLoop?.maxIterations ?? 32,
    runtimeMeta: {
      appEnv: config.app.env,
      defaultLanguage: config.app.defaultLanguage,
      defaultTimezone: config.app.defaultTimezone,
      workspaceRoot,
      memoryIndexBlocks: buildMemoryIndexBlocks({ globalJueDir: startupContext.jue.globalDir, workspaceRoot }),
      getObservationHints: (limit?: number) => memoryManager.getObservationPromptHints(limit),
      markFormalMemoryWritten,
      hasFormalMemoryWritten,
      availableSkills: skillProvider.listSkills().map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        ...(skill.manifest.displayName ? { displayName: skill.manifest.displayName } : {}),
        ...(skill.manifest.description ? { description: skill.manifest.description } : {}),
        ...(skill.manifest.tags.length > 0 ? { tags: skill.manifest.tags } : {}),
      })),
      availableSubAgents: subAgentRegistry.listPublicEnabled().map((agent) => ({
        type: agent.type,
        displayName: agent.displayName,
        description: agent.description,
        invocationName: agent.invocationName ?? agent.type,
        ...(agent.defaultPolicy?.allowedToolNames ? { allowedToolNames: agent.defaultPolicy.allowedToolNames } : {}),
        ...(agent.defaultBudget ? { budget: agent.defaultBudget } : {}),
      })),
      drainSubAgentNotifications: (sessionId: string) => subAgentManager.drainNotifications(sessionId),
      environment: {
        platform: startupContext.env.platform,
        osType: startupContext.env.osType,
        osRelease: startupContext.env.osRelease,
        arch: startupContext.env.arch,
        nodeVersion: startupContext.env.nodeVersion,
        cpuCount: startupContext.env.cpuCount,
        isTTY: startupContext.env.isTTY,
        globalJueDir: startupContext.jue.globalDir,
      },
    },
  });

  const sessionManager = new SessionManager({ engine, repository: sessionRepository, workspaceRoot });
  transcriptSink = sessionManager.asTranscriptSink();
  const teamRuntime = createTeamRuntime({
    sessionManager,
    globalJueDir: startupContext.jue.globalDir,
    workspaceRoot,
    promptsDir,
  });
  logger.info({ profileId, provider: profile.provider, model: profile.modelName, promptsDir, workspaceRoot, runtimeRoot, configFile }, "runtime created");

  return { config, sessionManager, teamRuntime, engine, modelGateway, startupContext, memoryManager, dreamMemory };
}

const TEAM_FRONTEND_CAPABILITIES = {
  streaming: true,
  markdown: true,
  images: false,
  files: true,
  tools: true,
  confirmDialog: false,
  notifications: true,
} satisfies FrontendCapabilities;

function createTeamRuntime(options: { sessionManager: SessionManager; globalJueDir: string; workspaceRoot: string; promptsDir: string }): TeamRuntime {
  const runner = createSessionTeamMemberRunner(options.sessionManager);
  const promptProvider = createTeamPromptProvider(options.promptsDir);
  return {
    createTeam(input = {}) {
      return new TeamOrchestrator({
        ...(input.teamName ? { teamName: input.teamName } : {}),
        globalJueDir: options.globalJueDir,
        projectKey: workspacePathSlug(options.workspaceRoot),
        runner,
        promptProvider,
      });
    },
    createQueue(input) {
      return new TeamExecutionQueue({
        team: input.team,
        ...(input.concurrency ? { concurrency: input.concurrency } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        applyActions(team, memberName, finalText) {
          const actions = extractTeamLeadActions(finalText);
          return { actionCount: actions.length, results: applyTeamLeadActions(team, memberName, actions) };
        },
      });
    },
    normalizeMemberName,
    extractLeadDecision,
    extractLeadActions: extractTeamLeadActions,
    applyLeadActions: applyTeamLeadActions,
  };
}

function createSessionTeamMemberRunner(sessionManager: SessionManager): TeamMemberRunner {
  return {
    run(input) {
      const handle = sessionManager.handle({
        userId: input.userId,
        frontend: "cli",
        mode: "task",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        capabilities: TEAM_FRONTEND_CAPABILITIES,
        message: { role: "user", parts: [{ type: "text", text: input.prompt }] },
        flags: {
          teamMode: true,
          teamName: input.teamName,
          teamMember: input.memberName,
          teamLeader: input.leaderName,
          teamRole: input.role,
          teamAllowedTools: input.allowedToolNames.join(","),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { sessionId: handle.request.sessionId, events: handle.events, done: handle.done };
    },
  };
}

function createTeamPromptProvider(promptsDir: string): TeamPromptProvider {
  return {
    loadTemplate(profileName) {
      return loadOptionalMarkdown(resolve(promptsDir, "team", `${profileName}.md`));
    },
  };
}

function loadOptionalMarkdown(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

function optionalPromptText(promptText: string | undefined): { promptText?: string } {
  return promptText ? { promptText } : {};
}

function loadSubAgentPrompt(promptsDir: string, name: string): string | undefined {
  const file = resolve(promptsDir, "subagents", `${name}.md`);
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

function loadProjectAllowedRoots(projectJueDir: string): string[] {
  const settingsPath = join(projectJueDir, "settings.json");
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.permissions) || !Array.isArray(parsed.permissions.allowedRoots)) return [];
    return parsed.permissions.allowedRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function buildMemoryWritableRoots(options: { globalJueDir: string; workspaceRoot: string }): string[] {
  const globalJueDir = resolve(options.globalJueDir);
  return [
    join(globalJueDir, "user", "memory"),
    join(globalJueDir, "global", "memory"),
    join(globalJueDir, "projects", workspacePathSlug(options.workspaceRoot), "memory"),
  ];
}

function createPathPermissionProviderFromAskUser(askUser: AskUserQuestionProvider, memoryWritableRoots: string[]): PathPermissionProvider {
  return async (request) => {
    const memoryRoot = findMemoryWritableRoot(request.resolvedPath, memoryWritableRoots);
    if (memoryRoot && (request.operation === "read" || request.operation === "write" || request.operation === "search" || request.operation === "list")) {
      return {
        approved: true,
        root: memoryRoot,
        persist: true,
        instruction: "Memory file access is auto-approved for known Jue memory directories.",
      };
    }

    const response = await askUser({
      reason: `Tool ${request.toolName} needs access outside the current workspace.`,
      question: `Allow access to path ${request.resolvedPath}?`,
      allowFreeform: true,
      metadata: {
        pathPermission: {
          toolName: request.toolName,
          requestedPath: request.requestedPath,
          resolvedPath: request.resolvedPath,
          suggestedRoot: request.suggestedRoot,
          operation: request.operation,
        },
      },
      options: [
        {
          id: "approve_once",
          label: "Approve once",
          description: `Allow ${request.operation}: ${request.resolvedPath} for this request only`,
        },
        {
          id: "approve_future",
          label: "Allow project path",
          description: `Allow this project to access ${request.suggestedRoot} in the future`,
        },
        {
          id: "reject",
          label: "Reject with guidance",
          description: "Reject this path access and let the agent choose an alternative.",
        },
      ],
    });
    return {
      approved: response.approved,
      root: request.suggestedRoot,
      persist: response.approveSimilarFutureRequests,
      ...(response.instruction ? { instruction: response.instruction } : {}),
    };
  };
}

function createPermissionProviderFromAskUser(askUser: AskUserQuestionProvider | undefined, memoryWritableRoots: string[], workspaceRoot: string): ToolPermissionProvider {
  return async (prompt) => {
    if (isMemoryWritePermissionPrompt(prompt, memoryWritableRoots, workspaceRoot)) return true;
    if (!askUser) return false;

    const response = await askUser({
      reason: prompt.reason,
      question: `Allow tool ${prompt.toolName} to run?`,
      allowFreeform: true,
      metadata: {
        permission: {
          toolName: prompt.toolName,
          sideEffectLevel: prompt.sideEffectLevel,
          permissionScope: prompt.permissionScope,
          arguments: prompt.arguments,
        },
      },
      options: [
        {
          id: "approve_once",
          label: "Approve once",
          description: summarizeToolPermission(prompt),
        },
        {
          id: "approve_future",
          label: "Approve similar future",
          description: "",
        },
        {
          id: "reject",
          label: "Reject with guidance",
          description: "",
        },
      ],
    });
    return response.approved;
  };
}

function isMemoryWritePermissionPrompt(prompt: Parameters<ToolPermissionProvider>[0], memoryWritableRoots: string[], workspaceRoot: string): boolean {
  if (prompt.sideEffectLevel !== "write") return false;
  if (prompt.toolName !== "file.write" && prompt.toolName !== "file.edit") return false;
  const targetPath = typeof prompt.arguments.path === "string" ? prompt.arguments.path : undefined;
  if (!targetPath) return false;
  const resolvedPath = isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspaceRoot, targetPath);
  return Boolean(findMemoryWritableRoot(resolvedPath, memoryWritableRoots));
}

function findMemoryWritableRoot(path: string, memoryWritableRoots: string[]): string | undefined {
  const resolvedPath = resolve(path);
  return memoryWritableRoots.map((root) => resolve(root)).find((root) => isWithinRoot(resolvedPath, root));
}

function summarizeToolPermission(prompt: Parameters<ToolPermissionProvider>[0]): string {
  const args = safeJson(prompt.arguments);
  return `${prompt.displayName} (${prompt.sideEffectLevel}/${prompt.permissionScope})${args ? ` args=${args}` : ""}`;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findProfile(config: Readonly<RootConfig>, id: string): ModelProfile | undefined {
  return config.model.profiles.find((profile) => profile.id === id);
}

class SubAgentMemoryExtractorRunner implements MemoryExtractorRunner {
  constructor(private readonly options: { getManager: () => SubAgentManager; fallback: MemoryExtractorRunner }) {}

  async extract(input: MemoryExtractionInput, text: string): Promise<MemoryExtractionOutput> {
    const manager = this.options.getManager();
    if (!manager) return this.options.fallback.extract(input, text);
    try {
      const result = await manager.dispatchInternal({
        sessionId: input.sessionId ?? newId("session"),
        requestId: input.requestId ?? newId("request"),
        subagentName: "MemoryExtractorAgent",
        title: "Extract durable memory candidates",
        goal: "Extract stable long-term memory candidates from the provided turn input.",
        successCriteria: [
          "Return candidates only when they are durable and useful across future turns.",
          "Classify scope/type correctly and explain rejection reasons when no memory should be written.",
        ],
        constraints: [
          "Do not store code structure, file paths, git history, debugging recipes, current task state, temporary conversation state, or content already written in JUE.md.",
          "Return strict SubAgentResult JSON with candidates under outputs.candidates and rejected reasons under outputs.rejectedReasons.",
        ],
        inputs: {
          kind: input.kind,
          priority: input.priority,
          sessionId: input.sessionId,
          userId: input.userId,
          workspaceRoot: input.workspaceRoot,
          text,
        },
        budget: { maxToolCalls: 0, maxDurationMs: 30_000, maxRecursionDepth: 0 },
      });
      const normalized = normalizeMemoryExtractionOutput(result.outputs, input);
      if (result.status === "succeeded" && (normalized.candidates.length > 0 || normalized.rejectedReasons.length > 0)) return { ...normalized, raw: result };
      return this.options.fallback.extract(input, text);
    } catch {
      return this.options.fallback.extract(input, text);
    }
  }
}

class SubAgentDreamMemoryPrunerRunner implements DreamMemoryPrunerRunner {
  constructor(private readonly options: { getManager: () => SubAgentManager; fallback: DreamMemoryPrunerRunner }) {}

  async plan(documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<MemoryPruningOutput> {
    const manager = this.options.getManager();
    if (!manager) return this.options.fallback.plan(documents, context);
    try {
      const result = await manager.dispatchInternal({
        sessionId: "dream_memory_pruning",
        requestId: newId("request"),
        subagentName: "DreamMemoryPruning",
        title: "Consolidate long-term memories",
        goal: "Review formal memory markdown documents and propose safe deletion or merge actions.",
        successCriteria: ["Return safe same-scope memory delete/merge plans only.", "Respect user/global/project pruning policies.", "Preserve concrete entities in any mergedDescription or mergedBody."],
        constraints: ["Do not invent memories or propose cross-scope merges.", "Do not process style observation pool candidates in this subagent.", "A mergeGroup must delete at least one real removeName and must not include keepName in removeNames.", "Do not generalize concrete user facts into vague labels such as preferred topic; keep the exact preference target or omit the rewritten fields.", "Do not merge unrelated user facts just because they share scope/type; identity, preference, ability, relationship, collaboration style, and goal are separate semantic categories.", "Return strict SubAgentResult JSON with removeNames, mergeGroups, and diagnostics under outputs."],
        inputs: {
          nowIso: context?.nowIso,
          workspaceRoot: context?.workspaceRoot,
          gate: context?.gate,
          memoryIndexes: context?.memoryIndexes,
          recentSessionSummaries: context?.recentSessionSummaries,
          repositorySignal: context?.repositorySignal,
          documents: documents.slice(0, 120).map((doc) => ({
            name: doc.frontmatter.name,
            description: doc.frontmatter.description,
            type: doc.frontmatter.type,
            scope: doc.frontmatter.scope,
            weight: doc.frontmatter.weight,
            status: doc.frontmatter.status,
            updatedAt: doc.frontmatter.updatedAt,
            bodyPreview: doc.body.slice(0, 1200),
          })),
        },
        budget: { maxToolCalls: 0, maxDurationMs: 90_000, maxRecursionDepth: 0 },
      });
      const normalized = normalizeMemoryPruningOutput(result.outputs);
      if (result.status === "succeeded" && (normalized.removeNames.length > 0 || normalized.mergeGroups.length > 0 || normalized.diagnostics.length > 0)) return { ...normalized, raw: result };
      return this.options.fallback.plan(documents, context);
    } catch {
      return this.options.fallback.plan(documents, context);
    }
  }
}

class SubAgentDreamObservationPrunerRunner implements DreamObservationPrunerRunner {
  constructor(private readonly options: { getManager: () => SubAgentManager; fallback: DreamObservationPrunerRunner }) {}

  async plan(candidates: StyleObservationCandidate[], documents: MemoryDocument[], context?: DreamMemoryPruningContext): Promise<ObservationPruningOutput> {
    const manager = this.options.getManager();
    if (!manager) return this.options.fallback.plan(candidates, documents, context);
    try {
      const result = await manager.dispatchInternal({
        sessionId: "dream_observation_pruning",
        requestId: newId("request"),
        subagentName: "DreamObservationPruning",
        title: "Consolidate observed user signals",
        goal: "Review style-observation-pool candidates and propose high-precision merge/archive/reject actions.",
        successCriteria: ["Merge only semantically equivalent observation candidates.", "Archive candidates already covered by formal user memories.", "Put every meaningless, question-derived, placeholder, unsafe, or contradicted observation in outputs.rejectKeys."],
        constraints: ["Do not edit or propose formal memory markdown changes.", "Do not convert observation candidates into formal memories here.", "Reject non-evidence questions/placeholders such as what do I like, talk about my preferences, chat about my interests, or remember what I like.", "Diagnostics are audit logs only; if a candidate should be deleted, its key must be in rejectKeys.", "Return strict SubAgentResult JSON with mergeGroups, archiveKeys, rejectKeys, and diagnostics under outputs."],
        inputs: {
          nowIso: context?.nowIso,
          workspaceRoot: context?.workspaceRoot,
          gate: context?.gate,
          formalUserMemories: documents.filter((doc) => doc.frontmatter.scope === "user" || doc.frontmatter.type === "user").slice(0, 120).map((doc) => ({
            name: doc.frontmatter.name,
            description: doc.frontmatter.description,
            type: doc.frontmatter.type,
            scope: doc.frontmatter.scope,
            provenance: doc.frontmatter.provenance,
            weight: doc.frontmatter.weight,
            tags: doc.frontmatter.tags,
            bodyPreview: doc.body.slice(0, 1000),
          })),
          observationCandidates: candidates.slice(0, 160).map((item) => ({
            key: item.key,
            candidate: item.candidate,
            status: item.status,
            occurrences: item.occurrences,
            confidence: item.confidence,
            promotedMemoryName: item.promotedMemoryName,
            evidence: item.evidence.slice(-6),
            contradictedBy: item.contradicted_by.slice(-4),
          })),
        },
        budget: { maxToolCalls: 0, maxDurationMs: 60_000, maxRecursionDepth: 0 },
      });
      const normalized = normalizeObservationPruningOutput(result.outputs);
      if (result.status === "succeeded" && (normalized.mergeGroups.length > 0 || normalized.archiveKeys.length > 0 || normalized.rejectKeys.length > 0 || normalized.diagnostics.length > 0)) return { ...normalized, raw: result };
      return this.options.fallback.plan(candidates, documents, context);
    } catch {
      return this.options.fallback.plan(candidates, documents, context);
    }
  }
}










function createMemoryLlmGateway(modelGateway: ModelGateway): MemoryLlmGateway {
  return {
    async completeJson(input) {
      let text = "";
      for await (const chunk of modelGateway.invoke({
        messages: input.messages,
        stream: false,
        toolChoice: "none",
        ...(input.signal ? { signal: input.signal } : {}),
      })) {
        text += chunk.delta;
      }
      return parseJsonObject(text);
    },
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\{[\s\S]*\})/);
    if (!match?.[1]) return {};
    try {
      return JSON.parse(match[1]);
    } catch {
      return {};
    }
  }
}




