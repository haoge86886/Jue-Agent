/**
 * 配置加载器。
 *
 * 默认只读取用户目录 `<home>/.jue/config.yaml` 中的简化配置。用户文件只暴露模型
 * provider、baseURL、apiKey、modelName 等运行凭据；prompt 模板路径、日志目录、
 * 工具默认策略、上下文预算等开发/系统选项由代码内默认值绑定，不向用户暴露。
 *
 * 旧版 `configsDir` 多 YAML 目录仍作为显式兼容入口保留，便于测试和迁移。
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ZodType } from "zod";
import { z } from "zod";
import { DEFAULT_CONFIG_FILE_NAME, SYSTEM_DEFAULT_CONFIG, USER_CONFIG_TEMPLATE } from "./default-config.js";
import {
  ConfigDirectoryNotFoundError,
  ConfigIssue,
  ConfigValidationError,
  isConfigError,
} from "./errors.js";
import { readYamlOrEmpty } from "./yaml-reader.js";
import {
  ConfigSection,
  RootConfig,
  RootConfigSchema,
  SectionToSchema,
} from "./schema/root.js";

const ENV_CONFIG_FILE = "JUE_CONFIG_FILE";
const ENV_CONFIGS_DIR = "JUE_CONFIGS_DIR";

const UserModelConfigSchema = z.object({
  provider: z
    .enum(["openai", "anthropic", "azure_openai", "deepseek", "qwen", "moonshot", "ollama", "custom"])
    .default("openai"),
  modelName: z.string().min(1).default("qwen-plus"),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  organization: z.string().optional(),
  profileId: z.string().min(1).default("main"),
  timeoutMs: z.number().int().positive().default(60_000),
  streamByDefault: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.3),
  topP: z.number().min(0).max(1).default(1),
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(4_096),
  reservedForResponse: z.number().int().nonnegative().default(1_024),
});

const UserConfigSchema = z
  .object({
    model: UserModelConfigSchema.optional(),
    runtime: z
      .object({
        maxIterations: z.number().int().positive().optional(),
      })
      .optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    tools: z.record(z.string(), z.unknown()).optional(),
    security: z
      .object({
        remoteAccess: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough();

export interface ConfigLoaderOptions {
  /** 相对路径解析基准。默认使用 `process.cwd()`，但默认配置文件不会放到 cwd 中。 */
  cwd?: string;
  /** 用户主目录。默认 `os.homedir()`，主要供启动层和测试显式注入。 */
  homeDir?: string;
  /** 单文件配置路径。未提供时使用 `JUE_CONFIG_FILE`，再回退到 `<home>/.jue/config.yaml`。 */
  configFile?: string;
  /** 旧版多 YAML 配置目录。显式提供后进入兼容模式，不会自动创建用户级 config.yaml。 */
  configsDir?: string;
  /** @deprecated .env 已迁移到用户级 config.yaml；此字段只为旧调用方保留，不再加载文件。 */
  envFile?: string;
  /** 显式 env 对象。仅用于读取 `JUE_CONFIG_FILE/JUE_CONFIGS_DIR` 这类启动定位变量。 */
  env?: NodeJS.ProcessEnv;
  /** @deprecated .env 已迁移到用户级 config.yaml；此字段保留但不再生效。 */
  loadDotenv?: boolean;
  /** 旧版多文件模式下的 section 文件名映射。 */
  fileMap?: Partial<Record<ConfigSection, string>>;
}

const DEFAULT_FILE_MAP: Record<ConfigSection, string> = {
  app: "app.yaml",
  model: "model.yaml",
  tools: "tools.yaml",
  memory: "memory.yaml",
  recommendation: "recommendation.yaml",
  security: "security.yaml",
  context: "context.yaml",
};

export interface LoadResult {
  /** 已校验的完整 RootConfig。 */
  config: RootConfig;
  /** 每个 section 的来源文件；单文件模式下所有 section 都指向同一个 config.yaml。 */
  sources: Record<ConfigSection, string>;
  /** 兼容字段: 实际配置所在目录。单文件模式下是 config.yaml 所在目录。 */
  configsDir: string;
  /** 新版配置文件路径。旧版多文件模式下为 undefined。 */
  configFile: string | undefined;
  /** @deprecated .env 已迁移到用户级 config.yaml，始终为 undefined。 */
  envFile: string | undefined;
}

export function loadConfig(options: ConfigLoaderOptions = {}): LoadResult {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const configLocation = resolveConfigLocation(options, cwd, env);

  if (configLocation.kind === "directory") {
    return loadDirectoryConfig(options, configLocation.dir, undefined);
  }

  ensureUserConfigFile(configLocation.file);
  const raw = readYamlOrEmpty(configLocation.file);
  const userConfig = parseSection("user-config", UserConfigSchema, raw);
  const resolved = buildRootConfigFromUserConfig(userConfig);
  const sections = Object.keys(SectionToSchema) as ConfigSection[];

  for (const section of sections) {
    const schema = SectionToSchema[section] as ZodType;
    parseSection(section, schema, (resolved as Partial<Record<ConfigSection, unknown>>)[section]);
  }

  const sources = Object.fromEntries(sections.map((section) => [section, configLocation.file])) as Record<
    ConfigSection,
    string
  >;

  return {
    config: parseSection("root", RootConfigSchema, resolved) as RootConfig,
    sources,
    configsDir: configLocation.dir,
    configFile: configLocation.file,
    envFile: undefined,
  };
}

export function getDefaultUserConfigFile(homeDir = homedir()): string {
  return resolve(homeDir, ".jue", DEFAULT_CONFIG_FILE_NAME);
}

export function ensureUserConfigFile(configFile = getDefaultUserConfigFile()): string {
  const abs = resolve(configFile);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(abs)) {
    writeFileSync(abs, USER_CONFIG_TEMPLATE, { encoding: "utf-8", flag: "wx" });
    return abs;
  }

  // infra 包为了保持分层，只能创建占位 config.yaml；首次真正加载时在这里补齐用户模板。
  const existing = readFileSync(abs, "utf-8").trim();
  if (
    !existing ||
    existing.includes("真正的默认值由 @jue/config 写入") ||
    existing.includes("会补齐模型 URL、API Key 和模型名模板")
  ) {
    writeFileSync(abs, USER_CONFIG_TEMPLATE, { encoding: "utf-8" });
    return abs;
  }

  const migrated = migrateLegacyUserConfig(existing);
  if (migrated) writeFileSync(abs, migrated, { encoding: "utf-8" });
  return abs;
}

export function safeLoadConfig(
  options: ConfigLoaderOptions = {},
): { ok: true; result: LoadResult } | { ok: false; error: Error } {
  try {
    return { ok: true, result: loadConfig(options) };
  } catch (err) {
    if (isConfigError(err)) return { ok: false, error: err };
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function resolveConfigLocation(
  options: ConfigLoaderOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { kind: "file"; file: string; dir: string } | { kind: "directory"; dir: string } {
  const legacyConfigsDir = options.configsDir ?? env[ENV_CONFIGS_DIR];
  if (legacyConfigsDir) {
    const dir = isAbsolute(legacyConfigsDir) ? legacyConfigsDir : resolve(cwd, legacyConfigsDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ConfigDirectoryNotFoundError(dir, cwd);
    return { kind: "directory", dir };
  }

  const rawFile = options.configFile ?? env[ENV_CONFIG_FILE] ?? getDefaultUserConfigFile(options.homeDir);
  const file = isAbsolute(rawFile) ? rawFile : resolve(cwd, rawFile);
  return { kind: "file", file, dir: dirname(file) };
}

function loadDirectoryConfig(
  options: ConfigLoaderOptions,
  configsDir: string,
  loadedEnvFile: string | undefined,
): LoadResult {
  const fileMap: Record<ConfigSection, string> = { ...DEFAULT_FILE_MAP, ...options.fileMap };
  const rawSections: Partial<Record<ConfigSection, unknown>> = {};
  const sources: Record<ConfigSection, string> = {} as Record<ConfigSection, string>;
  const sections = Object.keys(SectionToSchema) as ConfigSection[];

  for (const section of sections) {
    const filePath = resolve(configsDir, fileMap[section]);
    sources[section] = filePath;
    rawSections[section] = readYamlOrEmpty(filePath);
  }

  for (const section of sections) {
    const schema = SectionToSchema[section] as ZodType;
    parseSection(section, schema, rawSections[section]);
  }

  return {
    config: parseSection("root", RootConfigSchema, rawSections) as RootConfig,
    sources,
    configsDir,
    configFile: undefined,
    envFile: loadedEnvFile,
  };
}

function buildRootConfigFromUserConfig(userConfig: z.infer<typeof UserConfigSchema>): unknown {
  const model = UserModelConfigSchema.parse(userConfig.model ?? {});
  const base = structuredClone(SYSTEM_DEFAULT_CONFIG) as Record<string, unknown>;

  if (userConfig.runtime?.maxIterations !== undefined) {
    setNested(base, ["app", "agentLoop", "maxIterations"], userConfig.runtime.maxIterations);
  }
  if (userConfig.context) {
    base.context = deepMerge(base.context, userConfig.context);
  }
  if (userConfig.tools) {
    base.tools = deepMerge(base.tools, userConfig.tools);
  }
  if (userConfig.security?.remoteAccess) {
    const security = isPlainObject(base.security) ? base.security : {};
    security.remoteAccess = deepMerge(security.remoteAccess, userConfig.security.remoteAccess);
    base.security = security;
  }

  // 用户文件暴露的是简化模型配置；这里展开成 runtime 既有的 profiles/routing 结构。
  base.model = {
    streamByDefault: model.streamByDefault,
    profiles: [
      {
        id: model.profileId,
        provider: model.provider,
        modelName: model.modelName,
        ...(model.baseURL ? { baseURL: model.baseURL } : {}),
        ...(model.apiKey ? { apiKey: model.apiKey } : {}),
        ...(model.organization ? { organization: model.organization } : {}),
        role: "main",
        enabled: true,
        timeoutMs: model.timeoutMs,
        sampling: {
          temperature: model.temperature,
          topP: model.topP,
        },
        limits: {
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reservedForResponse: model.reservedForResponse,
        },
      },
    ],
    routing: {
      main: model.profileId,
    },
  };

  return base;
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isPlainObject(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function migrateLegacyUserConfig(content: string): string | undefined {
  const raw = parseLooseYaml(content);
  if (!isPlainObject(raw)) return undefined;
  const model = raw.model;
  if (!isPlainObject(model)) return undefined;
  if (typeof model.modelName === "string" && !Array.isArray(model.profiles)) return undefined;

  const profiles = Array.isArray(model.profiles) ? model.profiles : [];
  const firstProfile = profiles.find(isPlainObject);
  if (!firstProfile) return undefined;

  return formatUserConfigTemplate({
    provider: stringValue(firstProfile.provider, "openai"),
    modelName: stringValue(firstProfile.modelName, "qwen-plus"),
    baseURL: stringValue(firstProfile.baseURL, "https://api.openai.com/v1"),
    apiKey: stringValue(firstProfile.apiKey, ""),
  });
}

function parseLooseYaml(content: string): unknown {
  const temp = resolve(process.cwd(), `.jue-config-migrate-${Date.now()}.yaml`);
  try {
    writeFileSync(temp, content, { encoding: "utf-8", flag: "wx" });
    return readYamlOrEmpty(temp);
  } catch {
    return undefined;
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 迁移辅助文件清理失败不影响配置加载；后续会用当前文件继续解析。
    }
  }
}

function formatUserConfigTemplate(model: {
  provider: string;
  modelName: string;
  baseURL: string;
  apiKey: string;
}): string {
  return USER_CONFIG_TEMPLATE
    .replace("provider: openai", `provider: ${model.provider}`)
    .replace("modelName: qwen-plus", `modelName: ${model.modelName}`)
    .replace("baseURL: https://api.openai.com/v1", `baseURL: ${model.baseURL}`)
    .replace('apiKey: ""', `apiKey: "${escapeYamlDoubleQuoted(model.apiKey)}"`);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSection<T>(name: string, schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues: ConfigIssue[] = parsed.error.issues.map(
      (i: z.ZodIssue): ConfigIssue => ({
        path: i.path.length === 0 ? "<root>" : i.path.join("."),
        message: i.message,
        code: i.code,
      }),
    );
    throw new ConfigValidationError(name, issues);
  }
  return parsed.data;
}
