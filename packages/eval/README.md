# Jue Eval Runner

This package runs Jue Agent against local smoke suites, realistic engineering suites, and imported public benchmark records.

The runner is intentionally separate from CLI/Ink UI. It calls `@jue/runtime` directly, creates one workspace per task, records events/tool calls, and writes reports under `.evals/`.

## Built-in suites

```bash
pnpm eval:smoke:dry
pnpm eval:smoke
pnpm eval:realistic:dry
pnpm eval:realistic
```

`--dry-run` only validates suite loading and report generation. Removing it calls the configured model and may consume API quota.

## Output

Each run writes:

- `report.json`: machine-readable report.
- `report.md`: summary table and failures.
- `<task-id>.json`: full task result with events and tool traces.
- `workspaces/<task-id>/`: the isolated workspace used by the task.
- `predictions.jsonl`: optional SWE-bench style patch predictions when `--export-predictions` is used.

`.evals/` is ignored by git and should not be committed.

## Supported suite inputs

- Directory with child task folders, each containing `task.json`.
- `suite.json` or `tasks.json` with `{ "name": "...", "tasks": [...] }`.
- JSONL where each line is a task object.
- External benchmark JSONL with `--benchmark <format>`.

Supported benchmark formats:

- `swe-bench`
- `terminal-bench`
- `multi-swe-bench`
- `swe-polybench`

## SWE-bench / SWE-bench Lite / SWE-bench Verified

SWE-bench-style records normally contain:

- `instance_id`
- `repo`, for example `django/django`
- `base_commit`
- `problem_statement`
- test metadata such as `FAIL_TO_PASS` / `PASS_TO_PASS`

Jue eval can import these records, clone/check out repos, run the agent, and export `predictions.jsonl` with `model_patch` generated from `git diff --binary`.

Prepare a small JSONL first. For example, place records at:

```bash
.evals/benchmarks/swe-bench/tasks.jsonl
```

Run a dry load check:

```bash
pnpm eval:swebench:dry
```

Run Jue Agent and export patches:

```bash
pnpm eval:swebench
```

Equivalent explicit command:

```bash
pnpm --filter @jue/eval run run -- \
  --benchmark swe-bench \
  --suite ../../.evals/benchmarks/swe-bench/tasks.jsonl \
  --out ../../.evals/runs/swe-bench \
  --prepare-repos \
  --repo-cache-dir ../../.evals/repo-cache \
  --export-predictions \
  --timeout-ms 600000
```

Run a small 1-based inclusive batch with `--range`. This is the recommended way to test the first 10 tasks or an arbitrary interval inside a larger benchmark file:

```bash
pnpm --filter @jue/eval run run -- \
  --benchmark swe-bench \
  --suite ../../.evals/benchmarks/swe-bench/tasks.jsonl \
  --out ../../.evals/runs/swe-bench-1-10 \
  --range 1-10 \
  --prepare-repos \
  --repo-cache-dir ../../.evals/repo-cache \
  --export-predictions \
  --timeout-ms 600000
```

Examples:

- `--range 1-10` runs the first 10 tasks.
- `--range 101-150` runs tasks 101 through 150.
- `--range 1-500 --limit 20` loads the first 500 tasks, then runs at most 20.
- `--range 1-500 --sample 20 --seed smoke-a` randomly selects 20 tasks from the first 500 with a stable seed.
- `--range 1-10 --dry-run` validates import and report generation without model calls.
- Existing `<task-id>.json` files in `--out` are treated as completed and skipped; pass `--force` to re-run and replace them.
- Per-task workspace preparation failures, including clone/fetch failures, are recorded as failed task results and the batch continues.

Random sample example:

```bash
pnpm --filter @jue/eval run run -- \
  --benchmark swe-bench \
  --suite ../../.evals/benchmarks/swe-bench/tasks.jsonl \
  --out ../../.evals/runs/swe-bench-sample-20 \
  --range 1-500 \
  --sample 20 \
  --seed smoke-a \
  --prepare-repos \
  --repo-cache-dir ../../.evals/repo-cache \
  --export-predictions \
  --timeout-ms 600000
```

Then use the official SWE-bench harness to score `.evals/runs/swe-bench/predictions.jsonl`. Jue eval does not replace the official Docker/harness scoring; it produces candidate patches and local traces.

Recommended workflow:

1. Start with 1 to 3 SWE-bench Lite or Verified examples.
2. Run Jue eval with `--prepare-repos --export-predictions`.
3. Inspect `.evals/runs/swe-bench/<instance-id>.json` and the workspace diff.
4. Run the official SWE-bench harness against `predictions.jsonl`.
5. Only then scale to larger subsets.

## Terminal-Bench

Terminal-Bench tasks are usually Docker/container-oriented. Jue eval can import JSONL tasks with `--benchmark terminal-bench`, run the agent in a prepared workspace, and record behavior, but official Terminal-Bench scoring should still be done with the official benchmark runner.

Put converted task records at:

```bash
.evals/benchmarks/terminal-bench/tasks.jsonl
```

Dry run:

```bash
pnpm eval:terminal-bench:dry
```

Run:

```bash
pnpm eval:terminal-bench
```

For production-grade Terminal-Bench scoring, use the official runner after adapting Jue as an agent command/provider. This repo-side runner is useful for preflight, traces, and regression analysis.

## Notes on machine safety

- Each task uses an isolated workspace under `.evals/runs/<run>/workspaces/<task-id>`.
- SWE-bench repo mode clones source repos into `.evals/runs/<run>/repo-cache` or `--repo-cache-dir`.
- Real runs use your configured Jue model profile and may read/write user-level `.jue` config/logs unless you provide an isolated config.
- Public benchmark tasks can execute project tests and setup commands. Prefer a VM/container for large benchmark runs.
