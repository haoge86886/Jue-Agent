import type { RegisteredSkill } from "./types.js";

/**
 * In-memory skill registry. Project skills intentionally override global skills
 * with the same name, matching the common agent pattern of local project policy
 * taking precedence over user-wide defaults.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  register(skill: RegisteredSkill): void {
    const current = this.skills.get(skill.name);
    if (current?.scope === "project" && skill.scope === "global") return;
    this.skills.set(skill.name, skill);
  }

  get(name: string): RegisteredSkill | undefined {
    return this.skills.get(name);
  }

  list(): RegisteredSkill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((skill) => skill.name);
  }
}
