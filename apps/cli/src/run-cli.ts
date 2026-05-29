/**
 * CLI frontend adapter.
 *
 * The launcher owns startup intent and environment preparation. This module
 * only translates prepared CLI targets into terminal behavior: one-shot ask,
 * streaming console output, or the Ink chat UI.
 */

import { readFileSync } from "node:fs";
import { getOptionValue, type PreparedStartupContext } from "@jue/infra";
import { createRuntime, type CreateRuntimeOptions } from "@jue/runtime";
import { pipeStream, type SessionManager } from "@jue/session";
import { ConsoleStreamRenderer } from "./console-stream-renderer.js";
import type { RunChatOptions } from "./run-chat.js";

const OPTION_VALUE_FLAGS = new Set([
  "--prompt",
  "-p",
  "--prompt-file",
  "--model",
  "-m",
  "--config-file",
  "--configs-dir",
  "-c",
]);

export interface RunCliOptions {
  args: string[];
  startupContext: PreparedStartupContext;
}

interface CliOptions {
  prompt?: string;
  promptFile?: string;
  modelOverride?: string;
  configFile?: string;
  configsDir?: string;
  stream: boolean;
  json: boolean;
}

export async function runCli(options: RunCliOptions): Promise<void> {
  switch (options.startupContext.intent.target) {
    case "cli_ask":
      await runCliAsk(parseAskOptions(options.args), options.startupContext);
      return;
    case "cli_chat":
      await runCliChat(parseCliOptions(options.args), options.startupContext);
      return;
    default:
      throw new Error(`unsupported CLI startup target: ${options.startupContext.intent.target}`);
  }
}

export async function runCliAsk(opts: CliOptions, startupContext: PreparedStartupContext): Promise<void> {
  const promptText = await resolvePrompt(opts);
  if (!promptText) {
    throw new Error("missing prompt. Use --prompt, --prompt-file, STDIN, or `jue chat`.");
  }

  const { sessionManager } = createRuntime(buildRuntimeOpts(opts, startupContext));
  const { ok } = await runOneTurn(sessionManager, promptText, {
    streaming: opts.stream,
    json: opts.json,
  });
  if (!ok) process.exitCode = 1;
}

export async function runCliChat(opts: CliOptions, startupContext: PreparedStartupContext): Promise<void> {
  const { runChat } = await import("./run-chat.js");
  await runChat(buildChatOpts(opts, startupContext));
}

async function runOneTurn(
  sessionManager: SessionManager,
  promptText: string,
  opts: { streaming: boolean; json: boolean },
): Promise<{ ok: boolean; sessionId: string }> {
  const { request, events, done } = sessionManager.handle({
    userId: "user_local",
    frontend: "cli",
    mode: "chat",
    capabilities: {
      streaming: opts.streaming,
      markdown: true,
      images: false,
      files: true,
      tools: true,
      confirmDialog: false,
      notifications: false,
    },
    message: { role: "user", parts: [{ type: "text", text: promptText }] },
  });

  if (opts.json) {
    const collected: unknown[] = [];
    for await (const event of events) collected.push(event);
    const response = await done;
    process.stdout.write(`${JSON.stringify({ response, events: collected }, null, 2)}\n`);
    return { ok: !response.error, sessionId: request.sessionId };
  }

  const renderer = new ConsoleStreamRenderer();
  const response = await pipeStream(events, done, renderer);
  return { ok: !response.error, sessionId: request.sessionId };
}

async function resolvePrompt(opts: CliOptions): Promise<string | undefined> {
  if (opts.prompt) return opts.prompt;
  if (opts.promptFile) return readFileSync(opts.promptFile, "utf-8").trim();
  if (process.stdin.isTTY !== true) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    return text || undefined;
  }
  return undefined;
}

function parseAskOptions(args: string[]): CliOptions {
  const base = parseCliOptions(args);
  const explicitPrompt = getOptionValue(args, "--prompt", "-p");
  if (explicitPrompt) return base;
  const text = collectAskText(args);
  return text ? { ...base, prompt: text } : base;
}

function parseCliOptions(args: string[]): CliOptions {
  const prompt = getOptionValue(args, "--prompt", "-p");
  const promptFile = getOptionValue(args, "--prompt-file");
  const modelOverride = getOptionValue(args, "--model", "-m");
  const configFile = getOptionValue(args, "--config-file");
  const configsDir = getOptionValue(args, "--configs-dir", "-c");
  return {
    ...(prompt ? { prompt } : {}),
    ...(promptFile ? { promptFile } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(configFile ? { configFile } : {}),
    ...(configsDir ? { configsDir } : {}),
    stream: !args.includes("--no-stream"),
    json: args.includes("--json"),
  };
}

function buildRuntimeOpts(opts: CliOptions, startupContext: PreparedStartupContext): CreateRuntimeOptions {
  return {
    startupContext,
    cwd: startupContext.env.configRoot,
    configFile: opts.configFile ?? startupContext.env.configFile,
    ...(opts.configsDir ? { configsDir: opts.configsDir } : {}),
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  };
}

function buildChatOpts(opts: CliOptions, startupContext: PreparedStartupContext): RunChatOptions {
  return {
    startupContext,
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
    ...(opts.configsDir ? { configsDir: opts.configsDir } : {}),
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  };
}

function collectAskText(args: string[]): string | undefined {
  const parts: string[] = [];
  let inAsk = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!inAsk) {
      if (arg === "ask") inAsk = true;
      continue;
    }
    if (arg === "--") {
      parts.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (OPTION_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    parts.push(arg);
  }
  const text = parts.join(" ").trim();
  return text || undefined;
}
