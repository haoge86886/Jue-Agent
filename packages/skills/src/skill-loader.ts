import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { RegisteredSkill, SkillManifest, SkillScope } from "./types.js";

export interface SkillRoot {
  scope: SkillScope;
  dir: string;
}

export interface SkillLoaderOptions {
  roots: SkillRoot[];
  skillFileName?: string;
}

const DEFAULT_SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 256 * 1024;

/**
 * Filesystem loader for Claude-Code-style skills:
 *   <jue-dir>/skills/<skill-name>/SKILL.md
 *
 * A SKILL.md may begin with simple YAML-like frontmatter. The loader only
 * parses a conservative subset so the package has no runtime dependency.
 */
export class SkillLoader {
  private readonly roots: SkillRoot[];
  private readonly skillFileName: string;

  constructor(options: SkillLoaderOptions) {
    this.roots = options.roots.map((root) => ({ scope: root.scope, dir: resolve(root.dir) }));
    this.skillFileName = options.skillFileName ?? DEFAULT_SKILL_FILE;
  }

  loadAll(): RegisteredSkill[] {
    const loaded: RegisteredSkill[] = [];
    for (const root of this.roots) {
      loaded.push(...this.loadRoot(root));
    }
    return loaded;
  }

  private loadRoot(root: SkillRoot): RegisteredSkill[] {
    const skillsDir = join(root.dir, "skills");
    if (!existsSync(skillsDir)) return [];
    const stats = safeStat(skillsDir);
    if (!stats?.isDirectory()) return [];

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const loaded: RegisteredSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);
      const skillFile = join(skillDir, this.skillFileName);
      const skill = this.loadSkill(root.scope, skillDir, skillFile);
      if (skill) loaded.push(skill);
    }
    return loaded;
  }

  private loadSkill(scope: SkillScope, dir: string, skillFile: string): RegisteredSkill | undefined {
    const stats = safeStat(skillFile);
    if (!stats?.isFile() || stats.size > MAX_SKILL_BYTES) return undefined;
    const raw = readFileSync(skillFile, "utf8");
    const parsed = parseSkillMarkdown(raw, basename(dir));
    return {
      name: parsed.manifest.name,
      scope,
      dir,
      skillFile,
      manifest: parsed.manifest,
      content: parsed.content,
      updatedAt: stats.mtimeMs,
    };
  }
}

function parseSkillMarkdown(raw: string, fallbackName: string): { manifest: SkillManifest; content: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return {
      manifest: { name: normalizeSkillName(fallbackName), tags: [] },
      content: normalized.trim(),
    };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    return {
      manifest: { name: normalizeSkillName(fallbackName), tags: [] },
      content: normalized.trim(),
    };
  }

  const frontmatter = normalized.slice(4, end).trim();
  const content = normalized.slice(end + 5).trim();
  const fields = parseFrontmatter(frontmatter);
  return {
    manifest: {
      name: normalizeSkillName(fields.name ?? fallbackName),
      ...(fields.displayName ? { displayName: fields.displayName } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.version ? { version: fields.version } : {}),
      tags: parseTags(fields.tags),
    },
    content,
  };
}

function parseFrontmatter(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) fields[key] = value;
  }
  return fields;
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed-skill";
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
