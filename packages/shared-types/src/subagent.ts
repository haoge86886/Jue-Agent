/**
 * @file subagent.ts
 * @module @jue/shared-types/subagent
 *
 * SubAgent(瀛愭櫤鑳戒綋)鍗忚灞傘€傛妸"鐭换鍔°€佺嫭绔嬮绠椼€佷笉姹℃煋涓讳笂涓嬫枃"鐨勫娲? * 鎶借薄涓轰竴缁勭粨鏋勫寲瀵硅薄,鐢?`packages/subagent` 鐨?SubAgentRunner 鎵ц銆? *
 * 鍏抽敭妯″瀷:
 *   - {@link SubAgentTask}             : 濮旀淳浠诲姟
 *   - {@link SubAgentInput}            : 浠诲姟杈撳叆(鐩爣 + 鎴愬姛鏍囧噯 + 涓婁笅鏂囪鍓?
 *   - {@link SubAgentResult}           : 缁撴瀯鍖栫粨鏋?缁撹 + 璇佹嵁 + 椋庨櫓 + 寤鸿)
 *   - {@link SubAgentBudget}           : 璧勬簮棰勭畻涓婇檺
 *   - {@link SubAgentContextPolicy}    : 涓讳笂涓嬫枃瑁佸壀绛栫暐
 *   - {@link SubAgentRegistration}     : SubAgentRegistry 涓殑涓€鏉℃敞鍐? *
 * 璁捐鍘熷垯(璇﹁ design.md 搂10):
 *   1. SubAgent 涓婁笅鏂囦笌涓?Agent 闅旂,榛樿鍙户鎵?蹇呰鐨勬渶灏忓瓙闆?
 *   2. 杈撳嚭蹇呴』缁撴瀯鍖?涓?Agent 鍙 result,涓嶈 SubAgent 鍐呴儴 prompt 鍘嗗彶
 *   3. 棰勭畻纭埅姝?鍒扮偣寮哄埗鏀舵暃鍗充娇娌″畬鎴? *   4. 鍏变韩璁板繂/宸ュ叿/鑳藉姏閮介€氳繃鏄惧紡绛栫暐鍏佽,涓嶈兘榛樿鍏ㄥ紑
 */

import { z } from "zod";
import {
  ErrorInfoSchema,
  IdSchema,
  MetadataSchema,
  StatusSchema,
  TimestampSchema,
  TraceContextSchema,
} from "./common.js";
import { ContextBlockSchema, ContextBlockTypeSchema } from "./context.js";
import { MemoryRecordSchema, MemoryScopeSchema } from "./memory.js";

/**
 * SubAgent 绫诲瀷銆俙custom` 鐣欑粰椤圭洰鐗瑰畾 SubAgent銆? */
export const SubAgentTypeSchema = z.enum([
  "explorer",
  "plan",
  "verification",
  "general",
  "coder",
  "reviewer",
  "summarizer",
  "researcher",
  "memory_extractor",
  "dream_memory_pruning",
  "dream_observation_pruning",
  "session_search",
  "custom",
]);
export type SubAgentType = z.infer<typeof SubAgentTypeSchema>;

export const SubAgentVisibilitySchema = z.enum(["public", "internal"]);
export type SubAgentVisibility = z.infer<typeof SubAgentVisibilitySchema>;

export const SubAgentExecutionModeSchema = z.enum(["agent_loop", "rule", "placeholder"]);
export type SubAgentExecutionMode = z.infer<typeof SubAgentExecutionModeSchema>;

/**
 * 璧勬簮棰勭畻銆係ubAgentRunner 浼氱‖鎬ф墽琛屼换鎰忎竴椤圭殑鎴,瓒呰繃鍗冲己鍒剁粨鏉熴€? *
 * 榛樿鍊煎弬鑰?鍙閰嶇疆瑕嗙洊):
 *   - 8k tokens / 8 宸ュ叿璋冪敤 / 120s / 閫掑綊娣卞害 2
 */
export const SubAgentBudgetSchema = z.object({
  maxTokens: z.number().int().positive().default(8_000),
  maxToolCalls: z.number().int().nonnegative().default(8),
  maxDurationMs: z.number().int().positive().default(120_000),
  maxRecursionDepth: z.number().int().nonnegative().default(2),
});
export type SubAgentBudget = z.infer<typeof SubAgentBudgetSchema>;

/**
 * 涓讳笂涓嬫枃 鈫?SubAgent 鐨勮鍓瓥鐣ャ€傜粦瀹氭灇涓捐€岄潪瑁稿瓧绗︿覆,鍐欓敊鍊艰兘绔嬪埢鎶ラ敊銆? *
 * - `allowedContextTypes` : 鍏佽缁ф壙鐨勪笂涓嬫枃鍧楃被鍨?鐧藉悕鍗曞埗
 * - `allowedToolNames`    : 鍏佽璋冪敤鐨勫伐鍏?鍔ㄦ€佹敞鍐?鏁呬负瀛楃涓?
 * - `allowedMemoryScopes` : 鍏佽璇诲彇鐨勮蹇嗕綔鐢ㄥ煙
 * - `redactSensitiveKeys` : 鍏变韩鍓嶅繀椤昏劚鏁忕殑瀛楁鍚? */
export const SubAgentContextPolicySchema = z.object({
  allowedContextTypes: z.array(ContextBlockTypeSchema).default([]),
  allowedToolNames: z.array(z.string()).default([]),
  deniedToolNames: z.array(z.string()).default([]),
  allowedMemoryScopes: z.array(MemoryScopeSchema).default([]),
  redactSensitiveKeys: z.array(z.string()).default([]),
  inheritFrontendCapabilities: z.boolean().default(false),
  allowSubAgentTools: z.boolean().default(false),
});
export type SubAgentContextPolicy = z.infer<typeof SubAgentContextPolicySchema>;

/**
 * 浠诲姟杈撳叆銆? *
 * - `goal`             : 鑷劧璇█鐩爣(SubAgent 鐨?鎻愮ず璇嶄富浣?)
 * - `successCriteria`  : 楠屾敹鐐广€係ubAgent 鎹鑷垜鍒ゆ柇"鏄惁瀹屾垚"
 * - `constraints`      : 闄愬埗(涓嶅厑璁稿姩浠€涔堛€佸繀椤婚伒瀹堜粈涔?
 * - `inputs`           : 缁撴瀯鍖栬緭鍏ュ弬鏁? * - `contextBlocks`    : 宸茬粡鎸?policy 瑁佸壀杩囩殑涓讳笂涓嬫枃鐗囨
 * - `memorySnapshot`   : 宸茬粡鎸?policy 瑁佸壀杩囩殑璁板繂蹇収
 */
export const SubAgentInputSchema = z.object({
  goal: z.string().min(1).describe("SubAgent task goal"),
  successCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  inputs: z.record(z.string(), z.unknown()).default({}),
  contextBlocks: z.array(ContextBlockSchema).default([]),
  memorySnapshot: z.array(MemoryRecordSchema).default([]),
});
export type SubAgentInput = z.infer<typeof SubAgentInputSchema>;

/**
 * 濮旀淳浠诲姟銆? *
 * - `parentSessionId / parentRequestId` 鐢ㄤ簬鎶?SubAgent 鐨勬墽琛屼覆鍒扮埗 trace 涓? * - `parentAgentId` 浠呭湪宓屽濮旀淳鏃跺瓨鍦?SubAgent 璋冨害鏇存繁鐨?SubAgent)
 */
export const SubAgentTaskSchema = z.object({
  id: IdSchema,
  parentSessionId: IdSchema,
  parentRequestId: IdSchema,
  parentAgentId: IdSchema.optional(),
  type: SubAgentTypeSchema,
  title: z.string().min(1),
  input: SubAgentInputSchema,
  policy: SubAgentContextPolicySchema.optional(),
  budget: SubAgentBudgetSchema.optional(),
  trace: TraceContextSchema.optional(),
  createdAt: TimestampSchema,
  status: StatusSchema.default("pending"),
  metadata: MetadataSchema.optional(),
});
export type SubAgentTask = z.infer<typeof SubAgentTaskSchema>;

/**
 * 璇佹嵁鏉＄洰銆係ubAgent 鐨勭粨璁哄繀椤昏兘杩芥函鍒板叿浣撹瘉鎹?
 * 涓?Agent 涓庡璁″彲鎹鍒ゆ柇缁撹鍙俊搴︺€? */
export const SubAgentEvidenceSchema = z.object({
  id: IdSchema,
  kind: z.enum(["tool_result", "memory", "url", "file", "text"]),
  ref: z.string().optional(),
  summary: z.string().min(1),
});
export type SubAgentEvidence = z.infer<typeof SubAgentEvidenceSchema>;

/**
 * 椋庨櫓鏉＄洰銆傝涓?Agent 鑳藉湪閲囩撼 SubAgent 缁撹鍓嶆劅鐭ユ綔鍦ㄥ壇浣滅敤銆? */
export const SubAgentRiskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  description: z.string().min(1),
  mitigation: z.string().optional(),
});
export type SubAgentRisk = z.infer<typeof SubAgentRiskSchema>;

/**
 * 鍚庣画寤鸿鍔ㄤ綔銆傚彲閫夊湴鎻愪緵宸ュ叿璋冪敤寤鸿(鐢变富 Agent 鍐冲畾鏄惁鎵ц)銆? */
export const SubAgentSuggestedActionSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  toolName: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type SubAgentSuggestedAction = z.infer<typeof SubAgentSuggestedActionSchema>;

/**
 * SubAgent 璧勬簮娑堣€椼€傛眹鎬诲埌 SessionUsage 鏃?浣滀负 subAgentCallCount 涔嬪鐨勭粏鍖栨暟鎹€? */
export const SubAgentUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  toolCallCount: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
});
export type SubAgentUsage = z.infer<typeof SubAgentUsageSchema>;

/**
 * 缁撴瀯鍖栫粨鏋溿€? *
 * 涓?Agent 搴斾富瑕佹秷璐?`conclusion + evidence + risks + suggestedActions`,
 * 涓嶈鍐嶅幓璇?SubAgent 鐨勫唴閮?prompt/瀵硅瘽鍘嗗彶銆? *
 * `outputs` 鐣欑粰绾﹀畾鍨嬪瓧娈?濡?explorer 杩斿洖鐨勬枃浠跺垪琛?,鍏蜂綋褰㈢姸鐢卞悇 SubAgent 鍐呴儴绾﹀畾銆? */
export const SubAgentResultSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  type: SubAgentTypeSchema,
  status: StatusSchema,
  conclusion: z.string().min(1),
  details: z.string().optional(),
  evidence: z.array(SubAgentEvidenceSchema).default([]),
  risks: z.array(SubAgentRiskSchema).default([]),
  suggestedActions: z.array(SubAgentSuggestedActionSchema).default([]),
  outputs: z.record(z.string(), z.unknown()).default({}),
  usage: SubAgentUsageSchema.optional(),
  error: ErrorInfoSchema.optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  metadata: MetadataSchema.optional(),
});
export type SubAgentResult = z.infer<typeof SubAgentResultSchema>;

/**
 * SubAgent 娉ㄥ唽鏉＄洰銆? *
 * - `promptNamespace` : 璇?SubAgent 鐨?prompt 妯℃澘鍦?PromptManager 涓殑鍛藉悕绌洪棿
 * - `defaultPolicy / defaultBudget` : 娉ㄥ唽鏃剁粰鍑虹殑榛樿鍊?浠诲姟鍙鐩? */
export const SubAgentRegistrationSchema = z.object({
  type: SubAgentTypeSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  invocationName: z.string().min(1).optional(),
  visibility: SubAgentVisibilitySchema.default("public"),
  executionMode: SubAgentExecutionModeSchema.default("agent_loop"),
  defaultPolicy: SubAgentContextPolicySchema.optional(),
  defaultBudget: SubAgentBudgetSchema.optional(),
  outputFormat: z.string().optional(),
  maxFailureCount: z.number().int().positive().default(3),
  promptNamespace: z.string().min(1),
  enabled: z.boolean().default(true),
  metadata: MetadataSchema.optional(),
});
export type SubAgentRegistration = z.infer<typeof SubAgentRegistrationSchema>;


