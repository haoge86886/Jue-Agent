import { mkdirSync, writeFileSync } from "node:fs";
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
  const tasks = sliceTasks(loaded.suite.tasks, options);
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const adapter = new JueRuntimeEvalAdapter({
    ...(options.configFile ? { configFile: options.configFile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.askUserPolicy ? { askUserPolicy: options.askUserPolicy } : {}),
  });
  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    results.push(await runEvalTask({ task, outDir, adapter, options }));
  }
  const report: EvalReport = {
    suiteName: loaded.suite.name,
    startedAt,
    finishedAt: Date.now(),
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    results,
  };
  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.exportPredictions) writePredictions(outDir, results);
  return report;
}

function sliceTasks(tasks: EvalTask[], options: EvalRunOptions): EvalTask[] {
  const start = options.rangeStart ?? 1;
  const zeroBasedStart = Math.max(0, start - 1);
  const endExclusive = options.rangeEnd !== undefined ? Math.min(tasks.length, options.rangeEnd) : tasks.length;
  const ranged = tasks.slice(zeroBasedStart, endExclusive);
  if (options.limit !== undefined) return ranged.slice(0, Math.max(0, options.limit));
  return ranged;
}

async function runEvalTask(input: { task: EvalTask; outDir: string; adapter: JueRuntimeEvalAdapter; options: EvalRunOptions }): Promise<EvalTaskResult> {
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
  writeFileSync(resolve(input.outDir, `${input.task.id}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
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
  const proc = spawnSync("git", ["diff", "--binary"], { cwd, encoding: "utf8", timeout: 30_000 });
  if (proc.status !== 0) return "";
  return proc.stdout ?? "";
}
