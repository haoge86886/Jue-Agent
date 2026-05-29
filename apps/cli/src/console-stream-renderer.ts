import type { StreamEvent } from "@jue/shared-types";
import type { StreamRenderer } from "@jue/session";

/**
 * CLI 专用的流式渲染器。
 *
 * session 包不直接写 stdout/stderr，避免会话层绑定终端实现。
 * one-shot CLI 需要裸流式输出时，由 CLI 入口自行选择这个渲染器。
 */
export class ConsoleStreamRenderer implements StreamRenderer {
  private wroteAny = false;

  handle(event: StreamEvent): void {
    if (event.type === "model.delta") {
      const delta = (event.payload as { delta?: string } | undefined)?.delta ?? "";
      if (delta) {
        process.stdout.write(delta);
        this.wroteAny = true;
      }
      return;
    }

    if (event.type === "error") {
      const err = (event.payload as { error?: { message?: string } } | undefined)?.error;
      process.stderr.write(`\n[error] ${err?.message ?? "unknown"}\n`);
    }
  }

  finalize(): void {
    if (this.wroteAny) process.stdout.write("\n");
  }
}
