#!/usr/bin/env node
/**
 * Unified process entry for Jue Agent.
 *
 * This file is intentionally light: it only parses startup intent, handles
 * cheap early exits, prepares the startup context, and then routes to the
 * selected frontend. Heavy resources such as Ink, model gateways, and the
 * session engine are imported only after the target frontend is known.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareStartup, resolveStartupIntent } from "@jue/infra";

const VERSION = "0.1.0";

const args = process.argv.slice(2);
const initialIntent = resolveStartupIntent({ args, stdinIsTTY: process.stdin.isTTY === true });

if (initialIntent.target === "early_exit") {
  if (initialIntent.earlyExitReason === "version") {
    process.stdout.write(`${VERSION}\n`);
  } else {
    printHelp();
  }
  process.exit(0);
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const startupContext = prepareStartup({
  args,
  stdinIsTTY: process.stdin.isTTY === true,
  searchRoots: [moduleDir],
});

try {
  switch (startupContext.intent.target) {
    case "cli_ask":
    case "cli_chat": {
      const { runCli } = await import("@jue/cli");
      await runCli({ args, startupContext });
      break;
    }
    case "web":
    case "mobile":
    case "remote":
      process.stderr.write(`[jue] ${startupContext.intent.target} frontend is reserved for a future release. This build currently supports CLI chat and ask modes.\n`);
      process.exit(2);
      break;
    default:
      printHelp();
      process.exit(2);
  }
} catch (error) {
  process.stderr.write(`[jue] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write([
    "Jue Agent",
    "",
    "Usage:",
    "  jue chat [--model <id>] [--config-file <path>]",
    "  jue ask <text> [--model <id>] [--json] [--no-stream]",
    "  jue --prompt <text> [--json] [--no-stream]",
    "  jue --prompt-file <path> [--json] [--no-stream]",
    "  jue --version",
    "  jue --help",
    "",
    "Reserved frontend targets:",
    "  jue web | mobile | remote",
    "",
  ].join("\n"));
}
