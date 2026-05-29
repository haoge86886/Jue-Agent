/**
 * Default config is split into two layers.
 *
 * - USER_CONFIG_TEMPLATE is written to <user-home>/.jue/config.yaml and only exposes runtime options users should edit.
 * - SYSTEM_DEFAULT_CONFIG stays in code and owns internal paths, prompt wiring, logging, and registry defaults.
 */

export const DEFAULT_CONFIG_FILE_NAME = "config.yaml";

export const USER_CONFIG_TEMPLATE = `# Jue Agent user config
# Location: <user-home>/.jue/config.yaml
# Exposed options: model connection, context budgets, compression thresholds, tool confirmation, MCP, and remote access.
# Internal implementation details such as prompt templates, log paths, caches, and registries are intentionally not exposed here.

model:
  provider: openai
  modelName: qwen-plus
  baseURL: https://api.openai.com/v1
  apiKey: ""

runtime:
  maxIterations: 64

context:
  mainAgentBudget:
    totalTokenBudget: 100000
    reservedForResponse: 1024
    reservedForSystem: 0
    reservedForTools: 0
    reservedForMemory: 0
  subAgentBudget:
    totalTokenBudget: 8000
    reservedForResponse: 512
    reservedForSystem: 0
    reservedForTools: 0
    reservedForMemory: 0
  budgeter:
    ruleCompressionThreshold: 0.6
    llmCompressionThreshold: 0.85
    maxCompressionFailures: 3
  ruleCompression:
    staleAfterMs: 1800000
    lowRelevanceThreshold: 0.3
    recentToolResultCount: 3
    maxContentChars: 4000
    runEveryBuild: true

tools:
  confirmation:
    mode: destructive_only
    customRequireConfirmTools: []
    customSkipConfirmTools: []
  builtin:
    fileReadEnabled: true
    fileWriteEnabled: true
    fileEditEnabled: true
    shellEnabled: true
    httpEnabled: false
    searchEnabled: false
    scrapeEnabled: false
  mcpServers: []

security:
  remoteAccess:
    enabled: false
`;

export const SYSTEM_DEFAULT_CONFIG = {
  app: {
    name: "jue-agent",
    env: "development",
    defaultLanguage: "zh-CN",
    defaultTimezone: "Asia/Shanghai",
    paths: {
      promptsDir: "./prompts",
      dataDir: "./data",
      snapshotDir: "./data/snapshots",
      tempDir: "./.cache",
    },
    telemetry: {
      enabled: true,
      logLevel: "info",
      pretty: false,
    },
    frontends: {
      cli: true,
      webConsole: false,
      mobileRemote: false,
      api: false,
    },
    agentLoop: {
      maxIterations: 64,
    },
  },
  model: {
    streamByDefault: true,
    profiles: [
      {
        id: "main",
        provider: "openai",
        modelName: "qwen-plus",
        baseURL: "https://api.openai.com/v1",
        apiKey: "",
        role: "main",
        enabled: true,
        timeoutMs: 60_000,
        sampling: {
          temperature: 0.3,
          topP: 1,
        },
        limits: {
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          reservedForResponse: 1_024,
        },
      },
    ],
    routing: {
      main: "main",
    },
  },
  tools: {
    enabledKinds: ["builtin"],
    defaults: {
      timeoutMs: 30_000,
      maxRetries: 0,
      permissionScope: "user",
      defaultSideEffectLevel: "none",
    },
    builtin: {
      fileReadEnabled: true,
      fileEditEnabled: true,
      fileSearchEnabled: true,
      listTreeEnabled: true,
      textSearchEnabled: true,
      todoEnabled: true,
      backgroundTaskEnabled: true,
      skillEnabled: true,
      askUserQuestionEnabled: true,
      fileWriteEnabled: true,
      shellEnabled: true,
      httpEnabled: false,
      searchEnabled: false,
      scrapeEnabled: false,
    },
    confirmation: {
      mode: "destructive_only",
    },
    mcpServers: [],
  },
  memory: {
    enabledScopes: ["working"],
    defaultSensitivity: "internal",
    storage: {
      backend: "memory",
      enableEmbedding: false,
    },
    extraction: {
      enabled: false,
      conservativeMode: true,
      asyncWrite: true,
    },
    sharing: {
      shareWithSubAgentsByDefault: false,
    },
    cleanup: {
      enabled: false,
    },
  },
  recommendation: {
    enabled: false,
    sources: [],
    defaultLanguages: ["zh-CN"],
  },
  security: {
    remoteAccess: {
      enabled: false,
    },
    secretsRedaction: {
      enabled: true,
    },
    audit: {
      enabled: true,
      retainDays: 180,
    },
    cors: {
      enabled: false,
    },
  },
  context: {
    mainAgentBudget: {
      totalTokenBudget: 100_000,
      reservedForResponse: 1_024,
      reservedForSystem: 0,
      reservedForTools: 0,
      reservedForMemory: 0,
    },
    subAgentBudget: {
      totalTokenBudget: 8_000,
      reservedForResponse: 512,
      reservedForSystem: 0,
      reservedForTools: 0,
      reservedForMemory: 0,
    },
    budgeter: {
      ruleCompressionThreshold: 0.6,
      llmCompressionThreshold: 0.85,
      maxCompressionFailures: 3,
    },
    ruleCompression: {
      staleAfterMs: 30 * 60 * 1000,
      lowRelevanceThreshold: 0.3,
      recentToolResultCount: 3,
      maxContentChars: 4_000,
      runEveryBuild: true,
    },
  },
} as const;
