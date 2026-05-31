import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { JueRuntimeEvalAdapter } from "./agent-adapter.js";
import { scoreChecks } from "./scorers/check-scorer.js";
import { loadEvalSuite } from "./suite-loader.js";
import { prepareEvalWorkspace } from "./workspace-manager.js";
import type { EvalReport, EvalRunOptions, EvalTask, EvalTaskResult } from "./types.js";

export async function runEvalSuite(options: EvalRunOptions): Promise<EvalReport> {
  const startedAt = Date.now();
  const loaded = loadEvalSuite(options.suitePath, { ...(options.benchmark ? { benchmark: options.benchmark } : {}) });
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const selectedTasks = selectTasks(loaded.suite.tasks, options);
  const { pendingTasks, skippedResults } = splitPendingTasks(selectedTasks, outDir, options);
  const adapter = new JueRuntimeEvalAdapter({
    ...(options.configFile ? { configFile: options.configFile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.askUserPolicy ? { askUserPolicy: options.askUserPolicy } : {}),
  });
  const results: EvalTaskResult[] = [];
  results.push(...skippedResults);
  for (const task of pendingTasks) {
    results.push(await runEvalTask({ task, outDir, adapter, options }));
  }
  const report: EvalReport = {
    suiteName: loaded.suite.name,
    startedAt,
    finishedAt: Date.now(),
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    ...(skippedResults.length > 0 ? { skipped: skippedResults.length } : {}),
    results,
  };
  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.exportPredictions) writePredictions(outDir, results);
  return report;
}

function selectTasks(tasks: EvalTask[], options: EvalRunOptions): EvalTask[] {
  const start = options.rangeStart ?? 1;
  const zeroBasedStart = Math.max(0, start - 1);
  const endExclusive = options.rangeEnd !== undefined ? Math.min(tasks.length, options.rangeEnd) : tasks.length;
  const ranged = tasks.slice(zeroBasedStart, endExclusive);
  const limited = options.limit !== undefined ? ranged.slice(0, Math.max(0, options.limit)) : ranged;
  if (options.sample === undefined) return limited;
  return sampleTasks(limited, options.sample, options.seed);
}

function splitPendingTasks(tasks: EvalTask[], outDir: string, options: EvalRunOptions): { pendingTasks: EvalTask[]; skippedResults: EvalTaskResult[] } {
  if (options.force) return { pendingTasks: tasks, skippedResults: [] };
  const pendingTasks: EvalTask[] = [];
  const skippedResults: EvalTaskResult[] = [];
  for (const task of tasks) {
    const resultPath = resolve(outDir, `${safeTaskId(task.id)}.json`);
    if (existsSync(resultPath)) {
      skippedResults.push(readExistingResult(resultPath, task.id));
      process.stdout.write(`skip existing eval task: ${task.id}\n`);
      continue;
    }
    pendingTasks.push(task);
  }
  return { pendingTasks, skippedResults };
}

function readExistingResult(path: string, taskId: string): EvalTaskResult {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EvalTaskResult;
  } catch (error) {
    throw new Error(`existing eval result for ${taskId} cannot be read; use --force to replace it: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sampleTasks(tasks: EvalTask[], count: number, seed: string | undefined): EvalTask[] {
  const target = Math.min(tasks.length, Math.max(0, count));
  const random = seed ? seededRandom(seed) : Math.random;
  const shuffled = [...tasks];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const replacement = shuffled[swapIndex];
    if (current === undefined || replacement === undefined) continue;
    shuffled[index] = replacement;
    shuffled[swapIndex] = current;
  }
  return shuffled.slice(0, target);
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function safeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function runEvalTask(input: { task: EvalTask; outDir: string; adapter: JueRuntimeEvalAdapter; options: EvalRunOptions }): Promise<EvalTaskResult> {
  const startedAt = Date.now();
  const fallbackWorkspacePath = resolve(input.outDir, "workspaces", safeTaskId(input.task.id));
  try {
    const workspace = prepareEvalWorkspace({
      taskId: input.task.id,
      outDir: input.outDir,
      keep: true,
      ...(input.task.workspace ? { source: input.task.workspace } : {}),
      ...(input.options.prepareRepos ? { repo: input.task.repo, baseCommit: input.task.baseCommit, repoCacheDir: input.options.repoCacheDir } : {}),
    });
    const run = await input.adapter.run({
      task: input.task,
      workspacePath: workspace.path,
      timeoutMs: input.task.timeoutMs ?? input.options.timeoutMs ?? 120_000,
      ...(input.options.configFile ? { configFile: input.options.configFile } : {}),
      ...(input.options.model ? { model: input.options.model } : {}),
      ...(input.options.dryRun === undefined ? {} : { dryRun: input.options.dryRun }),
      ...(input.options.askUserPolicy ? { askUserPolicy: input.options.askUserPolicy } : {}),
    });
    const checks = input.options.dryRun ? [] : scoreChecks({ checks: input.task.checks ?? [], workspacePath: workspace.path, run });
    const passed = run.exitReason === "completed" && checks.every((check) => check.passed);
    const result: EvalTaskResult = { task: input.task, workspacePath: workspace.path, run, checks, passed };
    writeEvalTaskResult(input.outDir, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: EvalTaskResult = {
      task: input.task,
      workspacePath: fallbackWorkspacePath,
      run: {
        taskId: input.task.id,
        finalText: "",
        events: [],
        toolCalls: [],
        startedAt,
        finishedAt: Date.now(),
        exitReason: "error",
        error: message,
      },
      checks: [],
      passed: false,
    };
    writeEvalTaskResult(input.outDir, result);
    process.stderr.write(`eval task failed before/while running agent: ${input.task.id}\n${message}\n`);
    return result;
  }
}

function writeEvalTaskResult(outDir: string, result: EvalTaskResult): void {
  writeFileSync(resolve(outDir, `${safeTaskId(result.task.id)}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function writePredictions(outDir: string, results: EvalTaskResult[]): void {
  const lines = results.map((result) => JSON.stringify({
    instance_id: result.task.id,
    model_name_or_path: "jue-agent",
    model_patch: gitDiff(result.workspacePath),
  }));
  writeFileSync(resolve(outDir, "predictions.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function gitDiff(cwd: string): string {
  if (!existsSync(cwd)) return "";
  const proc = spawnSync("git", ["diff", "--binary"], { cwd, encoding: "utf8", timeout: 30_000 });
  if (proc.status !== 0) return "";
  return proc.stdout ?? "";
}
