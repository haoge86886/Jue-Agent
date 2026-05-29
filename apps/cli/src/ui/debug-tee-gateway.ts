/**
 * @file debug-tee-gateway.ts
 * @module @jue/cli/ui/debug-tee-gateway
 *
 * 装饰器:把内部 `ModelGateway` 包装一层,在每次 invoke 之前/之后回调监听器。
 *
 * 这是**仅开发期**使用的旁路拍照,实现刻意简单:
 *   - 不修改 `ModelInvokeParams`,不影响 Engine 的实际行为
 *   - 仅在 `enabled === true` 时回调,关掉就和原始 gateway 完全等价
 *   - 监听器抛错被吞掉(避免 UI bug 把主路径打挂)
 *
 * `setListener` / `setEnabled` 由 UI 状态机调用,装饰器不持有任何业务状态。
 *
 * 后续替换为正式的 `EngineDebugHook` 时,这个文件可以整体删除。
 */

import type { ModelChunk, ModelGateway, ModelInvokeParams } from "@jue/engine";

export interface DebugInvokeListener {
  onInvoke(params: ModelInvokeParams): void;
  onFinish(info: { finishReason?: string; usage?: ModelChunk["usage"] }): void;
}

export class DebugTeeModelGateway implements ModelGateway {
  private listener: DebugInvokeListener | undefined;
  private enabled = false;

  constructor(private readonly inner: ModelGateway) {}

  setListener(l: DebugInvokeListener | undefined): void {
    this.listener = l;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  async *invoke(params: ModelInvokeParams): AsyncIterable<ModelChunk> {
    if (this.enabled && this.listener) {
      try {
        this.listener.onInvoke(params);
      } catch {
        // 监听器抛错被吞掉,避免 UI bug 把主路径打挂
      }
    }

    let lastFinish: ModelChunk["finishReason"] | undefined;
    let lastUsage: ModelChunk["usage"] | undefined;
    for await (const chunk of this.inner.invoke(params)) {
      if (chunk.type === "finish") {
        lastFinish = chunk.finishReason;
        lastUsage = chunk.usage;
      }
      yield chunk;
    }

    if (this.enabled && this.listener) {
      try {
        this.listener.onFinish({
          ...(lastFinish ? { finishReason: lastFinish } : {}),
          ...(lastUsage ? { usage: lastUsage } : {}),
        });
      } catch {
        // ignore
      }
    }
  }
}
