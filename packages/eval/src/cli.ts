import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdownReport } from "./reporters/markdown-reporter.js";
import { runEvalSuite } from "./task-runner.js";
import type { EvalAskUserPolicy, EvalRunOptions, EvalTaskFormat } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (command !== "run") throw new Error(`unknown eval command: ${command}`);
  const options = parseRunOptions(args.slice(1));
  const report = await runEvalSuite(options);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(resolve(options.outDir, "report.md"), renderMarkdownReport(report), "utf8");
  process.stdout.write(`eval ${report.suiteName}: ${report.passed}/${report.total} passed\n`);
  process.stdout.write(`report: ${resolve(options.outDir, "report.md")}\n`);
  if (report.failed > 0) process.exitCode = 1;
}

function parseRunOptions(args: string[]): EvalRunOptions {
  const suitePath = getOption(args, "--suite") ?? args[0];
  if (!suitePath) throw new Error("missing --suite <path>");
  const outDir = getOption(args, "--out") ?? ".evals/runs/latest";
  const askUserPolicy = getOption(args, "--ask-user-policy") as EvalAskUserPolicy | undefined;
  const benchmark = getOption(args, "--benchmark") as EvalTaskFormat | undefined;
  const workspaceRoot = getOption(args, "--workspace-root");
  const repoCacheDir = getOption(args, "--repo-cache-dir");
  const timeoutMs = parseOptionalPositiveInteger(getOption(args, "--timeout-ms"), "--timeout-ms");
  const range = parseRange(getOption(args, "--range"));
  const limit = parseOptionalPositiveInteger(getOption(args, "--limit"), "--limit");
  const sample = parseOptionalPositiveInteger(getOption(args, "--sample"), "--sample");
  const seed = getOption(args, "--seed");
  const model = getOption(args, "--model");
  const configFile = getOption(args, "--config-file");
  return {
    suitePath,
    outDir,
    ...(isBenchmarkFormat(benchmark) ? { benchmark } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(repoCacheDir ? { repoCacheDir } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...range,
    ...(limit !== undefined ? { limit } : {}),
    ...(sample !== undefined ? { sample } : {}),
    ...(seed ? { seed } : {}),
    ...(model ? { model } : {}),
    ...(configFile ? { configFile } : {}),
    ...(askUserPolicy === "approve" || askUserPolicy === "deny" ? { askUserPolicy } : {}),
    dryRun: args.includes("--dry-run"),
    prepareRepos: args.includes("--prepare-repos"),
    exportPredictions: args.includes("--export-predictions"),
    force: args.includes("--force"),
  };
}

function parseRange(value: string | undefined): Pick<EvalRunOptions, "rangeStart" | "rangeEnd"> {
  if (!value) return {};
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) throw new Error("--range must use 1-based inclusive format i-j, for example --range 1-10");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error("--range requires 1 <= i <= j");
  }
  return { rangeStart: start, rangeEnd: end };
}

function parseOptionalPositiveInteger(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

function isBenchmarkFormat(value: unknown): value is EvalTaskFormat {
  return value === "terminal-bench" || value === "swe-bench" || value === "multi-swe-bench" || value === "swe-polybench" || value === "custom" || value === "jue-smoke";
}

function getOption(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function printHelp(): void {
  process.stdout.write([
    "Jue eval runner",
    "",
    "Usage:",
    "  pnpm --filter @jue/eval run -- --suite <path> [--out <dir>] [--dry-run]",
    "",
    "Options:",
    "  --suite <path>            Suite directory, suite.json, tasks.json, or tasks.jsonl",
    "  --benchmark <format>      Interpret JSONL as swe-bench, terminal-bench, multi-swe-bench, or swe-polybench",
    "  --out <dir>               Output directory, default .evals/runs/latest",
    "  --range <i-j>            Run a 1-based inclusive task range, for example 1-10",
    "  --limit <n>              Run at most n tasks after range filtering",
    "  --sample <n>             Randomly sample n tasks after range/limit filtering",
    "  --seed <value>           Stable seed for --sample, default is random",
    "  --force                  Re-run tasks even when their result JSON already exists",
    "  --prepare-repos           Clone/checkout benchmark repos when tasks provide repo/baseCommit",
    "  --repo-cache-dir <path>   Git repo cache directory for --prepare-repos",
    "  --export-predictions      Write predictions.jsonl with git diff patches for SWE-bench harness",
    "  --config-file <path>      Jue config file for model credentials",
    "  --model <id>              Override model profile",
    "  --timeout-ms <n>          Per-task timeout override",
    "  --ask-user-policy <mode>  approve or deny, default approve",
    "  --dry-run                 Prepare and score without calling the model",
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
