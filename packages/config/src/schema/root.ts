/**
 * @file schema/root.ts
 * @module @jue/config/schema/root
 *
 * Root schema assembly for all user-facing config sections.
 * When adding a section, update ConfigSectionSchema, RootConfigSchema, and SectionToSchema together.
 */

import { z } from "zod";
import { AppConfigSchema } from "./app.js";
import { ModelConfigSchema } from "./model.js";
import { ToolsConfigSchema } from "./tools.js";
import { MemoryConfigSchema } from "./memory.js";
import { RecommendationConfigSchema } from "./recommendation.js";
import { SecurityConfigSchema } from "./security.js";
import { ContextConfigSchema } from "./context.js";

/** Config section enum. Keep this in sync with RootConfigSchema and SectionToSchema. */
export const ConfigSectionSchema = z.enum([
  "app",
  "model",
  "tools",
  "memory",
  "recommendation",
  "security",
  "context",
]);
export type ConfigSection = z.infer<typeof ConfigSectionSchema>;

/** Full validated config shape. Each child schema owns its defaults and validation. */
export const RootConfigSchema = z.object({
  app: AppConfigSchema,
  model: ModelConfigSchema,
  tools: ToolsConfigSchema,
  memory: MemoryConfigSchema,
  recommendation: RecommendationConfigSchema,
  security: SecurityConfigSchema,
  context: ContextConfigSchema,
});
export type RootConfig = z.infer<typeof RootConfigSchema>;

/** Map from config section name to its schema, used by ConfigLoader. */
export const SectionToSchema = {
  app: AppConfigSchema,
  model: ModelConfigSchema,
  tools: ToolsConfigSchema,
  memory: MemoryConfigSchema,
  recommendation: RecommendationConfigSchema,
  security: SecurityConfigSchema,
  context: ContextConfigSchema,
} as const;
