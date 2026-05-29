import type { SubAgentResult, SubAgentTask } from "@jue/shared-types";

export interface SubAgentRunner {
  run(task: SubAgentTask): Promise<SubAgentResult>;
}
