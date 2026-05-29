#!/usr/bin/env node
/**
 * Direct CLI development entry.
 *
 * Production startup should go through @jue/launcher. This file exists only so
 * CLI frontend developers can run the terminal UI package in isolation.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareStartup } from "@jue/infra";
import { runCli } from "./run-cli.js";

const args = process.argv.slice(2);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const startupContext = prepareStartup({
  args,
  stdinIsTTY: process.stdin.isTTY === true,
  searchRoots: [moduleDir],
});

try {
  await runCli({ args, startupContext });
} catch (error) {
  process.stderr.write(`[jue-cli] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
