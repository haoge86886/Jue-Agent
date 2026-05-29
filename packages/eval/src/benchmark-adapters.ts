import type { EvalTask, EvalTaskFormat } from "./types.js";

export interface ExternalBenchmarkRecord {
  id?: string;
  instance_id?: string;
  task_id?: string;
  instruction?: string;
  prompt?: string;
  problem_statement?: string;
  repo?: string;
  base_commit?: string;
  tests?: unknown;
  [key: string]: unknown;
}

export function externalRecordToEvalTask(record: ExternalBenchmarkRecord, format: EvalTaskFormat): EvalTask {
  const id = record.id ?? record.instance_id ?? record.task_id;
  if (!id) throw new Error("external benchmark record requires id, instance_id, or task_id");
  const instruction = record.instruction ?? record.prompt ?? record.problem_statement;
  if (!instruction) throw new Error(`external benchmark record ${id} has no instruction text`);
  const repo = typeof record.repo === "string" ? record.repo : undefined;
  const baseCommit = typeof record.base_commit === "string" ? record.base_commit : undefined;
  return {
    id,
    benchmark: format,
    instruction,
    ...(repo ? { repo } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    metadata: {
      sourceFormat: format,
      repo,
      baseCommit,
      tests: record.tests,
      raw: record,
    },
  };
}

export const SUPPORTED_EXTERNAL_BENCHMARKS: EvalTaskFormat[] = [
  "terminal-bench",
  "swe-bench",
  "multi-swe-bench",
  "swe-polybench",
];
