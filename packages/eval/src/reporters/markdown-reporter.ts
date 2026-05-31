import type { EvalReport } from "../types.js";

export function renderMarkdownReport(report: EvalReport): string {
  const lines = [
    `# Eval Report: ${report.suiteName}`,
    "",
    `- total: ${report.total}`,
    `- passed: ${report.passed}`,
    `- failed: ${report.failed}`,
    ...(report.skipped !== undefined ? [`- skippedExisting: ${report.skipped}`] : []),
    `- durationMs: ${report.finishedAt - report.startedAt}`,
    "",
    "| task | status | exit | checks | durationMs |",
    "| --- | --- | --- | ---: | ---: |",
  ];
  for (const result of report.results) {
    const passedChecks = result.checks.filter((check) => check.passed).length;
    lines.push(`| ${escapeCell(result.task.id)} | ${result.passed ? "pass" : "fail"} | ${result.run.exitReason} | ${passedChecks}/${result.checks.length} | ${result.run.finishedAt - result.run.startedAt} |`);
  }
  lines.push("", "## Failures", "");
  for (const result of report.results.filter((item) => !item.passed)) {
    lines.push(`### ${result.task.id}`, "", `- exitReason: ${result.run.exitReason}`, ...(result.run.error ? [`- error: ${result.run.error}`] : []));
    for (const check of result.checks.filter((item) => !item.passed)) lines.push(`- check failed: ${check.message}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function escapeCell(input: string): string {
  return input.replace(/\|/g, "\\|");
}
