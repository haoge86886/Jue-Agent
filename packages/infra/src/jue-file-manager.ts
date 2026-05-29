import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type JueInstructionScope = "global" | "project";

export interface JueInstructionFile {
  scope: JueInstructionScope;
  dir: string;
  path: string;
  exists: boolean;
  content: string;
}

export interface JueFileLayout {
  globalDir: string;
  globalJuePath: string;
  globalConfigPath: string;
  globalSkillsDir: string;
  projectDir: string;
  projectJuePath: string;
  projectSkillsDir: string;
}

export interface JueFileManagerOptions {
  workspaceRoot?: string;
  homeDir?: string;
  globalJueDir?: string;
  projectJueDir?: string;
  fileName?: string;
  defaultJueContent?: string;
  defaultConfigContent?: string;
}

export interface ReadJueInstructionOptions {
  ensure?: boolean;
}

export interface MergeJueInstructionOptions extends ReadJueInstructionOptions {
  includeSourceHeadings?: boolean;
}

const DEFAULT_JUE_FILE_NAME = "JUE.md";
const DEFAULT_JUE_CONTENT = "";
const DEFAULT_CONFIG_FILE_NAME = "config.yaml";
const DEFAULT_CONFIG_CONTENT = `# Jue Agent 用户配置
# 首次加载时 @jue/config 会补齐模型 URL、API Key 和模型名模板。
`;
const BUILTIN_SKILL_INSTALLER_NAME = "jue-skill-installer";
const BUILTIN_SKILL_INSTALLER_CONTENT = `---
name: jue-skill-installer
displayName: Jue Skill 安装助手
description: 指导 agent 从本地仓库或目录安装 Jue skills，并保留 SKILL.md 旁边的配套文件。
version: 0.1.0
tags: [builtin, skills, installer, 中文]
---

# Jue Skill 安装助手

当用户要求从本地目录、已克隆仓库、下载的 skill 包中“安装 / 注册 / 导入 / 复制 / 部署”skills 时，必须优先使用本 skill 的流程。

## 核心规则

Jue 的 skill 是一个目录，不是单独的 SKILL.md 文件。Jue 只会扫描以下路径：

- 项目级：<workspace>/.jue/skills/<skill-name>/SKILL.md
- 全局级：<user-home>/.jue/skills/<skill-name>/SKILL.md

禁止把 SKILL.md 直接放到 .jue/SKILL.md。禁止只移动 SKILL.md 而丢弃同目录下的 assets、scripts、references、examples、templates 或其他配套文件。

## 安装流程

1. 先确认安装范围。默认使用项目级安装，除非用户明确要求全局安装。全局安装会影响所有项目，必须明确提醒用户。
2. 复制前先检查源路径结构，判断属于哪一种：
   - 单 skill 仓库：仓库根目录直接包含 SKILL.md；
   - 多 skill 仓库：包含 skills/<name>/SKILL.md；
   - 多目录集合：多个子目录分别包含 SKILL.md。
3. 为每个发现的 skill 确定 <skill-name>。优先使用 SKILL.md frontmatter 中的 name 字段；没有 name 时使用源目录名。创建目标目录时使用小写 kebab-case。
4. 复制整个 skill 目录到目标 .jue/skills/<skill-name>/，必须保留子目录和配套文件。
5. 如果目标 skill 已存在，不要直接覆盖。必须先告知用户目标已存在，并获得明确批准后再替换。
6. 安装完成后，告诉用户实际安装路径、安装范围、可调用的 skill 名称，以及是否需要重启或刷新后才能在当前会话使用。

## 复制细节

- 如果源目录根部有 SKILL.md，将源目录下的有效内容整体复制到目标 skill 目录。
- 如果源仓库是 skills/<name>/SKILL.md 结构，按用户选择复制对应的 skills/<name> 整个目录。
- 如果 SKILL.md 引用了本地文件，必须保持相对路径有效，不要打散目录结构。
- 默认跳过 .git、node_modules、dist、build、.cache、logs 等仓库元数据或生成产物，除非用户明确要求保留。
- 项目相关 skill 默认安装到项目 .jue/skills；跨项目复用 skill 才考虑安装到全局 .jue/skills。

## 验证与汇报

复制后必须检查每个目标目录是否包含 SKILL.md，并尽量确认 SKILL.md 引用的配套目录仍存在。最后向用户汇报：

- 已安装的 skill 名称；
- 安装范围：项目级或全局级；
- 目标目录；
- 当前会话是否需要重启或刷新才能调用。
`;

export class JueFileManager {
  private readonly workspaceRoot: string;
  private readonly globalJueDir: string;
  private readonly projectJueDir: string;
  private readonly fileName: string;
  private readonly defaultJueContent: string;
  private readonly defaultConfigContent: string;

  constructor(options: JueFileManagerOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.fileName = options.fileName ?? DEFAULT_JUE_FILE_NAME;
    this.globalJueDir = resolve(options.globalJueDir ?? join(options.homeDir ?? homedir(), ".jue"));
    this.projectJueDir = resolve(options.projectJueDir ?? join(this.workspaceRoot, ".jue"));
    this.defaultJueContent = options.defaultJueContent ?? DEFAULT_JUE_CONTENT;
    this.defaultConfigContent = options.defaultConfigContent ?? DEFAULT_CONFIG_CONTENT;
  }

  getLayout(): JueFileLayout {
    return {
      globalDir: this.globalJueDir,
      globalJuePath: join(this.globalJueDir, this.fileName),
      globalConfigPath: join(this.globalJueDir, DEFAULT_CONFIG_FILE_NAME),
      globalSkillsDir: join(this.globalJueDir, "skills"),
      projectDir: this.projectJueDir,
      projectJuePath: join(this.projectJueDir, this.fileName),
      projectSkillsDir: join(this.projectJueDir, "skills"),
    };
  }

  ensure(): JueFileLayout {
    const layout = this.getLayout();
    ensureDir(layout.globalDir);
    ensureDir(layout.projectDir);
    ensureDir(layout.globalSkillsDir);
    ensureDir(layout.projectSkillsDir);
    ensureFile(layout.globalJuePath, this.defaultJueContent);
    ensureFile(layout.globalConfigPath, this.defaultConfigContent);
    ensureFile(layout.projectJuePath, this.defaultJueContent);
    ensureBuiltinSkills(layout);
    return layout;
  }

  readInstructionFiles(options: ReadJueInstructionOptions = {}): JueInstructionFile[] {
    const layout = options.ensure === false ? this.getLayout() : this.ensure();
    return [
      readInstructionFile("global", layout.globalDir, layout.globalJuePath),
      readInstructionFile("project", layout.projectDir, layout.projectJuePath),
    ];
  }

  readMergedInstructions(options: MergeJueInstructionOptions = {}): string {
    return this.readInstructionFiles(options)
      .map((instructionFile) => formatInstructionFile(instructionFile, options))
      .filter(Boolean)
      .join("\n\n");
  }

  readPromptInstructions(options: MergeJueInstructionOptions = {}): string {
    return this.readMergedInstructions(options);
  }
}

export function createJueFileManager(options: JueFileManagerOptions = {}): JueFileManager {
  return new JueFileManager(options);
}

export function ensureJueFiles(options: JueFileManagerOptions = {}): JueFileLayout {
  return new JueFileManager(options).ensure();
}

export function readMergedJueInstructions(
  options: JueFileManagerOptions & MergeJueInstructionOptions = {},
): string {
  const { ensure, includeSourceHeadings, ...managerOptions } = options;
  return new JueFileManager(managerOptions).readMergedInstructions({
    ...(ensure === undefined ? {} : { ensure }),
    ...(includeSourceHeadings === undefined ? {} : { includeSourceHeadings }),
  });
}

function ensureDir(path: string): void {
  if (existsSync(path) && statSync(path).isDirectory()) return;
  mkdirSync(path, { recursive: true });
}

function ensureFile(path: string, content: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
}

function ensureBuiltinSkills(layout: JueFileLayout): void {
  const skillDir = join(layout.globalSkillsDir, BUILTIN_SKILL_INSTALLER_NAME);
  ensureDir(skillDir);
  ensureFile(join(skillDir, "SKILL.md"), BUILTIN_SKILL_INSTALLER_CONTENT);
}

function readInstructionFile(
  scope: JueInstructionScope,
  dir: string,
  path: string,
): JueInstructionFile {
  const exists = existsSync(path) && statSync(path).isFile();
  return {
    scope,
    dir,
    path,
    exists,
    content: exists ? readFileSync(path, "utf-8") : "",
  };
}

function formatInstructionFile(
  instructionFile: JueInstructionFile,
  options: MergeJueInstructionOptions,
): string {
  const content = instructionFile.content.trim();
  if (!content) return "";
  if (!options.includeSourceHeadings) return content;
  return [`# ${instructionFile.scope} ${basename(instructionFile.path)}`, content].join("\n\n");
}
