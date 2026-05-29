import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export interface PreparedEvalWorkspace {
  path: string;
  cleanup(): void;
}

export interface PrepareWorkspaceOptions {
  taskId: string;
  source?: string;
  repo?: string;
  baseCommit?: string;
  repoCacheDir?: string;
  outDir: string;
  keep?: boolean;
}

export function prepareEvalWorkspace(options: PrepareWorkspaceOptions): PreparedEvalWorkspace {
  const safeTaskId = options.taskId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const root = resolve(options.outDir, "workspaces", safeTaskId);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  if (options.source) {
    const source = resolve(options.source);
    if (!existsSync(source)) throw new Error(`workspace source does not exist: ${source}`);
    cpSync(source, root, { recursive: true, force: true, filter: shouldCopyPath });
  } else if (options.repo && options.baseCommit) {
    const source = prepareRepoSource({ repo: options.repo, baseCommit: options.baseCommit, repoCacheDir: options.repoCacheDir ?? resolve(options.outDir, "repo-cache") });
    cpSync(source, root, { recursive: true, force: true, filter: shouldCopyRepoPath });
    runGit(root, ["checkout", options.baseCommit]);
    runGit(root, ["clean", "-fdx"]);
  }

  return {
    path: root,
    cleanup() {
      if (!options.keep) rmSync(root, { recursive: true, force: true });
    },
  };
}

function prepareRepoSource(options: { repo: string; baseCommit: string; repoCacheDir: string }): string {
  mkdirSync(options.repoCacheDir, { recursive: true });
  const repoDir = resolve(options.repoCacheDir, safeRepoDir(options.repo));
  if (!existsSync(repoDir)) runGit(options.repoCacheDir, ["clone", repoUrl(options.repo), repoDir]);
  runGit(repoDir, ["fetch", "--all", "--tags", "--prune"]);
  runGit(repoDir, ["checkout", options.baseCommit]);
  runGit(repoDir, ["clean", "-fdx"]);
  return repoDir;
}

function repoUrl(repo: string): string {
  if (/^(https?:|git@)/.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

function safeRepoDir(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function runGit(cwd: string, args: string[]): void {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${proc.stderr || proc.stdout}`);
}

function shouldCopyPath(path: string): boolean {
  const name = basename(path);
  if (name === "node_modules" || name === ".git" || name === "dist" || name === "coverage") return false;
  if (name === ".evals" || name === ".jue") return false;
  const parent = basename(dirname(path));
  return !(parent === ".git" || parent === "node_modules");
}

function shouldCopyRepoPath(path: string): boolean {
  const name = basename(path);
  if (name === "node_modules" || name === "dist" || name === "coverage") return false;
  if (name === ".evals" || name === ".jue") return false;
  const parent = basename(dirname(path));
  return parent !== "node_modules";
}
