import { SkillLoader, type SkillRoot } from "./skill-loader.js";
import { SkillRegistry } from "./skill-registry.js";
import type { SkillInvocation, SkillInvocationResult, SkillProvider } from "./types.js";

export interface FilesystemSkillProviderOptions {
  roots: SkillRoot[];
  registry?: SkillRegistry;
}

/**
 * Provider used by the tool layer. Invocation does not execute arbitrary code;
 * it returns the matched SKILL.md instructions and invocation payload so the
 * main agent can continue with normal audited tools.
 */
export class FilesystemSkillProvider {
  private readonly registry: SkillRegistry;

  constructor(options: FilesystemSkillProviderOptions) {
    this.registry = options.registry ?? new SkillRegistry();
    const loader = new SkillLoader({ roots: options.roots });
    for (const skill of loader.loadAll()) this.registry.register(skill);
  }

  asToolProvider(): SkillProvider["invoke"] {
    return (invocation) => this.invoke(invocation);
  }

  invoke(invocation: SkillInvocation): SkillInvocationResult {
    const skill = this.registry.get(normalizeSkillName(invocation.skillName));
    if (!skill) {
      const available = this.registry.names();
      return {
        skillName: invocation.skillName,
        status: "unavailable",
        message: available.length > 0
          ? `未找到 skill ${invocation.skillName}。可用 skills: ${available.join(", ")}`
          : "当前没有发现可用 skill。请在全局或项目 .jue/skills/<name>/SKILL.md 中注册。",
        output: { availableSkills: available },
      };
    }

    return {
      skillName: skill.name,
      status: "succeeded",
      message: `已加载 ${skill.scope} skill: ${skill.name}`,
      output: {
        manifest: skill.manifest,
        scope: skill.scope,
        skillFile: skill.skillFile,
        instructions: skill.content,
        invocation: {
          input: invocation.input,
          ...(invocation.reason ? { reason: invocation.reason } : {}),
        },
      },
    };
  }

  listSkills() {
    return this.registry.list();
  }
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}
