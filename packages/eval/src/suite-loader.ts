import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { externalRecordToEvalTask } from "./benchmark-adapters.js";
import type { EvalCheck, EvalSuite, EvalTask, EvalTaskFormat } from "./types.js";

export interface LoadedSuite {
  suite: EvalSuite;
  rootDir: string;
}

export function loadEvalSuite(path: string, options: { benchmark?: EvalTaskFormat } = {}): LoadedSuite {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`suite path does not exist: ${resolved}`);
  const stat = statSync(resolved);
  if (stat.isDirectory()) return loadSuiteDirectory(resolved);
  return { suite: loadSuiteFile(resolved, options), rootDir: dirname(resolved) };
}

function loadSuiteDirectory(dir: string): LoadedSuite {
  const explicit = ["suite.json", "tasks.json", "tasks.jsonl"].map((name) => join(dir, name)).find((file) => existsSync(file));
  if (explicit) return { suite: loadSuiteFile(explicit), rootDir: dir };

  const tasks: EvalTask[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskFile = join(dir, entry.name, "task.json");
    if (existsSync(taskFile)) tasks.push(normalizeTask(JSON.parse(readFileSync(taskFile, "utf8")), dirname(taskFile)));
  }
  return { suite: { name: basenameForSuite(dir), format: "jue-smoke", tasks }, rootDir: dir };
}

function loadSuiteFile(file: string, options: { benchmark?: EvalTaskFormat } = {}): EvalSuite {
  const ext = extname(file).toLowerCase();
  if (ext === ".jsonl") {
    const tasks = readUtf8WithoutBom(file)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return options.benchmark ? externalRecordToEvalTask(parsed, options.benchmark) : normalizeTask(parsed, dirname(file));
      });
    return { name: basenameForSuite(file), format: options.benchmark ?? "custom", tasks };
  }
  const parsed = JSON.parse(readUtf8WithoutBom(file)) as unknown;
  if (isRecord(parsed) && Array.isArray(parsed.tasks)) {
    const suite: EvalSuite = {
      name: typeof parsed.name === "string" ? parsed.name : basenameForSuite(file),
      tasks: parsed.tasks.map((task) => normalizeTask(task, dirname(file))),
    };
    if (typeof parsed.version === "string") suite.version = parsed.version;
    if (isEvalTaskFormat(parsed.format)) suite.format = parsed.format;
    return suite;
  }
  return { name: basenameForSuite(file), format: "custom", tasks: [normalizeTask(parsed, dirname(file))] };
}

function readUtf8WithoutBom(file: string): string {
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function normalizeTask(value: unknown, baseDir: string): EvalTask {
  if (!isRecord(value)) throw new Error("eval task must be an object");
  if (typeof value.id !== "string") throw new Error("eval task requires string id");
  if (typeof value.instruction !== "string") throw new Error(`eval task ${value.id} requires string instruction`);
  const workspace = typeof value.workspace === "string" ? resolve(baseDir, value.workspace) : undefined;
  const task: EvalTask = { id: value.id, instruction: value.instruction };
  if (typeof value.title === "string") task.title = value.title;
  if (isEvalTaskFormat(value.benchmark)) task.benchmark = value.benchmark;
  if (workspace) task.workspace = workspace;
  if (typeof value.repo === "string") task.repo = value.repo;
  if (typeof value.baseCommit === "string") task.baseCommit = value.baseCommit;
  if (typeof value.timeoutMs === "number") task.timeoutMs = value.timeoutMs;
  if (typeof value.configFile === "string") task.configFile = resolve(baseDir, value.configFile);
  if (typeof value.model === "string") task.model = value.model;
  if (value.askUserPolicy === "approve" || value.askUserPolicy === "deny") task.askUserPolicy = value.askUserPolicy;
  if (Array.isArray(value.tags)) task.tags = value.tags.filter((item): item is string => typeof item === "string");
  if (Array.isArray(value.checks)) task.checks = value.checks as EvalCheck[];
  if (isRecord(value.metadata)) task.metadata = value.metadata;
  return task;
}

function basenameForSuite(path: string): string {
  return resolve(path).split(/[\\/]/).filter(Boolean).at(-1) ?? "eval-suite";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvalTaskFormat(value: unknown): value is EvalTaskFormat {
  return value === "jue-smoke" || value === "terminal-bench" || value === "swe-bench" || value === "multi-swe-bench" || value === "swe-polybench" || value === "custom";
}
