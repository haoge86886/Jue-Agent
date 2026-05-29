/**
 * @file index.ts
 * @module @jue/shared-types
 *
 * `@jue/shared-types` 包总入口。
 *
 * 一句话:本包是整个 jjue_agent 的"协议契约层",所有跨包通信、所有持久化数据,
 * 只要离开了某个包的内部边界,就必须使用这里定义的 Zod schema + TS 类型。
 *
 * 子模块按领域切分,可分别从 `@jue/shared-types/<sub>` 子路径导入,
 * 也可以通过此入口一站式导入:
 *
 *   `import { ToolSpecSchema, MessageSchema } from "@jue/shared-types";`
 *
 * 子模块清单:
 *   - common         : Id / Timestamp / Status / Sensitivity 等基础类型
 *   - session        : SessionRequest / Message / StreamEvent / SessionResponse
 *   - context        : ContextBlock / ContextBudget / ContextAssembly
 *   - tool           : ToolSpec / ToolCall / ToolResult / JsonSchemaLike
 *   - memory         : MemoryRecord / MemoryQuery / MemoryWriteRequest
 *   - subagent       : SubAgentTask / SubAgentResult / SubAgentBudget
 *   - recommendation : InterestProfile / RecommendationItem / Batch
 *   - audit          : AuditEvent / AuditActor / AuditTarget
 *
 * 设计原则提醒:
 *   - 写入或读取这些类型时优先 `Schema.parse(...)` 进行运行时校验,而不是裸 cast
 *   - 不在本包内塞业务逻辑,纯协议层
 *   - 新增字段优先用可选 + default,降低对存量数据的破坏
 */

export * from "./common.js";
export * from "./session.js";
export * from "./context.js";
export * from "./tool.js";
export * from "./memory.js";
export * from "./subagent.js";
export * from "./recommendation.js";
export * from "./audit.js";
