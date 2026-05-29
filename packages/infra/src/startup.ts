/**
 * Startup preparation utilities.
 *
 * This module is shared by all process entries. It resolves the user-facing
 * working directory, classifies startup intent, creates `.jue` files, and
 * captures stable environment facts before any frontend or runtime is loaded.
 */

import { existsSync, statSync } from "node:fs";
import { arch, cpus, homedir, platform, release, tmpdir, type } from "node:os";
import { dirname, resolve } from "node:path";
import { JueFileManager, type JueFileLayout } from "./jue-file-manager.js";

export type StartupFrontend = "cli" | "web" | "mobile" | "remote";
export type StartupTarget = "early_exit" | "cli_chat" | "cli_ask" | "web" | "mobile" | "remote";
export type StartupEarlyExitReason = "version" | "help";

export interface StartupIntent {
  target: StartupTarget;
  frontend: StartupFrontend;
  args: string[];
  earlyExitReason?: StartupEarlyExitReason;
}

export interface StartupEnvironmentInfo {
  cwd: string;
  workspaceRoot: string;
  configRoot: string;
  configFile: string;
  homeDir: string;
  tempDir: string;
  platform: NodeJS.Platform;
  osType: string;
  osRelease: string;
  arch: string;
  nodeVersion: string;
  shell?: string;
  terminal?: string;
  cpuCount: number;
  isTTY: boolean;
}

export interface PreparedStartupContext {
  intent: StartupIntent;
  env: StartupEnvironmentInfo;
  jue: JueFileLayout;
}

export interface ResolveStartupIntentOptions {
  args?: string[];
  stdinIsTTY?: boolean;
  frontend?: StartupFrontend;
}

export interface PrepareStartupOptions extends ResolveStartupIntentOptions {
  cwd?: string;
  configRoot?: string;
  searchRoots?: string[];
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

const KNOWN_COMMANDS = new Set(["ask", "chat", "help", "mobile", "remote", "version", "web"]);

export function resolveStartupIntent(options: ResolveStartupIntentOptions = {}): StartupIntent {
  const args = [...(options.args ?? process.argv.slice(2))];
  const frontend = options.frontend ?? "cli";
  const first = firstCommandArg(args);

  if (hasAnyFlag(args, "--version", "-V") || first === "version") {
    return { target: "early_exit", frontend, args, earlyExitReason: "version" };
  }
  if (hasAnyFlag(args, "--help", "-h") || first === "help") {
    return { target: "early_exit", frontend, args, earlyExitReason: "help" };
  }

  if (first === "web") return { target: "web", frontend: "web", args };
  if (first === "mobile") return { target: "mobile", frontend: "mobile", args };
  if (first === "remote") return { target: "remote", frontend: "remote", args };
  if (first === "ask") return { target: "cli_ask", frontend, args };
  if (first === "chat") return { target: "cli_chat", frontend, args };
  if (getOptionValue(args, "--prompt", "-p") || getOptionValue(args, "--prompt-file") || options.stdinIsTTY === false) {
    return { target: "cli_ask", frontend, args };
  }

  return { target: "cli_chat", frontend, args };
}

export function prepareStartup(options: PrepareStartupOptions = {}): PreparedStartupContext {
  const cwd = resolveStartupCwd({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const home = resolve(options.homeDir ?? homedir());
  const intent = resolveStartupIntent({
    ...(options.args ? { args: options.args } : {}),
    ...(options.stdinIsTTY === undefined ? {} : { stdinIsTTY: options.stdinIsTTY }),
    ...(options.frontend ? { frontend: options.frontend } : {}),
  });
  const configRoot = resolveConfigRoot({
    cwd,
    ...(options.configRoot ? { configRoot: options.configRoot } : {}),
    ...(options.searchRoots ? { searchRoots: options.searchRoots } : {}),
  });
  const jueManager = new JueFileManager({ homeDir: home, workspaceRoot: cwd });
  const jue = jueManager.ensure();
  const env = collectStartupEnvironment({
    cwd,
    workspaceRoot: cwd,
    configRoot,
    configFile: jue.globalConfigPath,
    homeDir: home,
    ...(options.env ? { env: options.env } : {}),
  });
  return { intent, env, jue };
}

export function resolveStartupCwd(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.cwd) return resolve(options.cwd);
  const env = options.env ?? process.env;
  return resolve(env.INIT_CWD || process.cwd());
}

export function collectStartupEnvironment(options: {
  cwd?: string;
  workspaceRoot?: string;
  configRoot?: string;
  configFile?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): StartupEnvironmentInfo {
  const env = options.env ?? process.env;
  const cwd = resolveStartupCwd({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const shell = env.SHELL ?? env.ComSpec;
  const terminal = env.TERM_PROGRAM ?? env.TERM;
  return {
    cwd,
    workspaceRoot: resolve(options.workspaceRoot ?? cwd),
    configRoot: resolve(options.configRoot ?? cwd),
    configFile: options.configFile
      ? resolve(options.configFile)
      : resolve(options.homeDir ?? homedir(), ".jue", "config.yaml"),
    homeDir: resolve(options.homeDir ?? homedir()),
    tempDir: tmpdir(),
    platform: platform(),
    osType: type(),
    osRelease: release(),
    arch: arch(),
    nodeVersion: process.version,
    ...(shell ? { shell } : {}),
    ...(terminal ? { terminal } : {}),
    cpuCount: cpus().length,
    isTTY: process.stdout.isTTY === true,
  };
}

export function resolveConfigRoot(options: { cwd?: string; configRoot?: string; searchRoots?: string[] } = {}): string {
  if (options.configRoot) return resolve(options.configRoot);
  const cwd = resolve(options.cwd ?? process.cwd());
  const searchRoots = [cwd, ...(options.searchRoots ?? [])].map((item) => resolve(item));
  const foundWithConfigs = findInSearchRoots(searchRoots, (dir) =>
    existsSync(resolve(dir, "pnpm-workspace.yaml")) && isDirectory(resolve(dir, "configs")),
  );
  if (foundWithConfigs) return foundWithConfigs;
  const foundConfigs = findInSearchRoots(searchRoots, (dir) => isDirectory(resolve(dir, "configs")));
  if (foundConfigs) return foundConfigs;
  const foundWorkspace = findInSearchRoots(searchRoots, (dir) => existsSync(resolve(dir, "pnpm-workspace.yaml")));
  return foundWorkspace ?? cwd;
}

export function getOptionValue(args: readonly string[], longName: string, shortName?: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === longName || (shortName && arg === shortName)) return args[index + 1];
    if (arg.startsWith(`${longName}=`)) return arg.slice(longName.length + 1);
    if (shortName && arg.startsWith(`${shortName}=`)) return arg.slice(shortName.length + 1);
  }
  return undefined;
}

function hasAnyFlag(args: readonly string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function firstCommandArg(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    if (KNOWN_COMMANDS.has(arg)) return arg;
  }
  return undefined;
}

function findInSearchRoots(
  searchRoots: readonly string[],
  predicate: (dir: string) => boolean,
): string | undefined {
  for (const root of searchRoots) {
    const found = walkUpFor(root, predicate);
    if (found) return found;
  }
  return undefined;
}

function walkUpFor(start: string, predicate: (dir: string) => boolean): string | undefined {
  let current = resolve(start);
  while (true) {
    if (predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
