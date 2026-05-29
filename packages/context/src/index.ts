/**
 * @file index.ts
 * @module @jue/context
 *
 * 上下文工程层入口。
 *
 * 当前职责：
 * - ContextManager：把 prompt、消息、记忆、工具结果等输入拆成 ContextBlock，并装配为模型消息。
 * - ThresholdContextBudgeter：按总预算和 system/tools/memory 预留空间选择保留块。
 * - DefaultContextCompressor：执行规则压缩，并通过注入的 runner 调用压缩 SubAgent。
 * - ToolResultStore：保存工具/shell 输出，并在压缩后保留摘要、清理原文。
 *
 * NoopContextCompressor 和 NoopContextCacheStore 只作为测试/降级默认实现。
 */

export * from "./budgeter.js";
export * from "./compressor.js";
export * from "./cache-store.js";
export * from "./context-manager.js";
export * from "./tool-result-store.js";
