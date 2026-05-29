import { z } from "zod";
import { ContextBudgetSchema } from "@jue/shared-types";

export const ContextBudgeterConfigSchema = z.object({
  ruleCompressionThreshold: z.number().min(0).max(1).default(0.6),
  llmCompressionThreshold: z.number().min(0).max(1).default(0.85),
  maxCompressionFailures: z.number().int().nonnegative().default(3),
});
export type ContextBudgeterConfig = z.infer<typeof ContextBudgeterConfigSchema>;

export const RuleCompressionConfigSchema = z.object({
  staleAfterMs: z.number().int().nonnegative().default(30 * 60 * 1000),
  lowRelevanceThreshold: z.number().min(0).max(1).default(0.3),
  recentToolResultCount: z.number().int().nonnegative().default(3),
  maxContentChars: z.number().int().positive().default(4_000),
  runEveryBuild: z.boolean().default(true),
});
export type RuleCompressionConfig = z.infer<typeof RuleCompressionConfigSchema>;

export const ContextConfigSchema = z.object({
  mainAgentBudget: ContextBudgetSchema.default({
    totalTokenBudget: 16_000,
    reservedForResponse: 1_024,
    reservedForSystem: 0,
    reservedForTools: 0,
    reservedForMemory: 0,
  }),
  subAgentBudget: ContextBudgetSchema.default({
    totalTokenBudget: 8_000,
    reservedForResponse: 512,
    reservedForSystem: 0,
    reservedForTools: 0,
    reservedForMemory: 0,
  }),
  budgeter: ContextBudgeterConfigSchema.default({
    ruleCompressionThreshold: 0.6,
    llmCompressionThreshold: 0.85,
    maxCompressionFailures: 3,
  }),
  ruleCompression: RuleCompressionConfigSchema.default({
    staleAfterMs: 30 * 60 * 1000,
    lowRelevanceThreshold: 0.3,
    recentToolResultCount: 3,
    maxContentChars: 4_000,
    runEveryBuild: true,
  }),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

