import type { SubAgentContextPolicy, ToolSpec } from "@jue/shared-types";
import { SUBAGENT_INVOKE_TOOL_NAME } from "./default-subagents.js";
import type { ModelToolDefinition } from "./types.js";

export interface ToolDescriptorLike {
  spec: ToolSpec;
  enabled?: boolean;
  unavailableReason?: string;
  modelName?: string;
}

export interface FilteredToolSet {
  descriptors: ToolDescriptorLike[];
  modelTools: ModelToolDefinition[];
  toolNameMap: Record<string, string>;
  deniedToolNames: string[];
}

export class SubAgentToolFilter {
  filter(registrations: ToolDescriptorLike[], policy?: SubAgentContextPolicy): ToolDescriptorLike[] {
    return this.filterWithMetadata(registrations, policy).descriptors;
  }

  filterWithMetadata(registrations: ToolDescriptorLike[], policy?: SubAgentContextPolicy): FilteredToolSet {
    const allowed = new Set(policy?.allowedToolNames ?? []);
    const denied = new Set(policy?.deniedToolNames ?? []);
    if (!policy?.allowSubAgentTools) denied.add(SUBAGENT_INVOKE_TOOL_NAME);

    const deniedToolNames: string[] = [];
    const descriptors = registrations.filter((item) => {
      const name = item.spec.name;
      if (item.enabled === false) {
        deniedToolNames.push(name);
        return false;
      }
      if (denied.has(name)) {
        deniedToolNames.push(name);
        return false;
      }
      if (allowed.size > 0 && !allowed.has(name)) {
        deniedToolNames.push(name);
        return false;
      }
      return true;
    });

    const modelTools = this.toModelTools(descriptors);
    const toolNameMap: Record<string, string> = {};
    descriptors.forEach((item, index) => {
      toolNameMap[modelTools[index]?.function.name ?? toModelToolName(item.spec.name)] = item.spec.name;
    });
    return { descriptors, modelTools, toolNameMap, deniedToolNames };
  }

  toModelTools(registrations: ToolDescriptorLike[]): ModelToolDefinition[] {
    return registrations.map((item) => ({
      type: "function",
      function: {
        name: item.modelName ?? toModelToolName(item.spec.name),
        description: item.spec.description ?? item.spec.displayName ?? item.spec.name,
        parameters: withRequiredRelevanceScore((item.spec.inputSchema ?? {}) as Record<string, unknown>),
      },
    }));
  }
}

export function toModelToolName(internalName: string): string {
  return internalName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function withRequiredRelevanceScore(schema: Record<string, unknown>): Record<string, unknown> {
  const objectSchema = schema.type === "object" ? schema : { type: "object", properties: {} };
  const properties = typeof objectSchema.properties === "object" && objectSchema.properties !== null
    ? objectSchema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(objectSchema.required) ? objectSchema.required.filter((item): item is string => typeof item === "string") : [];
  return {
    ...objectSchema,
    properties: {
      ...properties,
      relevanceScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Required. Estimate how relevant this tool result will be to the current task. 0 = unrelated, 1 = highly relevant.",
      },
    },
    required: Array.from(new Set([...required, "relevanceScore"])),
  };
}