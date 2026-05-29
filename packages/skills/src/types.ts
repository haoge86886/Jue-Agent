export type SkillScope = "global" | "project";

export interface SkillManifest {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  tags: string[];
}

export interface RegisteredSkill {
  name: string;
  scope: SkillScope;
  dir: string;
  skillFile: string;
  manifest: SkillManifest;
  content: string;
  updatedAt: number;
}

export interface SkillInvocation {
  skillName: string;
  input: Record<string, unknown>;
  reason?: string;
}

export interface SkillInvocationResult {
  skillName: string;
  status: "succeeded" | "failed" | "unavailable";
  output?: unknown;
  message: string;
}

export interface SkillProvider {
  invoke(invocation: SkillInvocation): Promise<SkillInvocationResult> | SkillInvocationResult;
}
