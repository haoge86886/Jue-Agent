/**
 * @file use-stable-columns.ts
 * @module @jue/cli/ui/hooks/use-stable-columns
 *
 * 给消费方一个**稳定且经过节流**的终端列数,并暴露 `isResizing` 标志。
 *
 * ## 为什么单纯 debounce columns 还不够
 *
 * - 向外拉(变宽):终端不卷屏,Ink 把活动区按旧高度擦+按新宽度写,正常
 * - 向内拉(变窄):终端可见区变小,活动区超出后**终端会向上滚屏**,
 *   Ink 内部 cursor tracking 失准,下一次 paint 擦除范围错位 → 闪
 *
 * 这一层不是 React 重渲带来的,React.memo 与 columns 节流都救不了它,
 * 因为 Ink 内部本身会响应 stdout 的 `resize` 事件做"小修补 paint"。
 *
 * ## 解法:拖拽期间卸载活动区
 *
 * `useStableColumns` 多返回一个 `isResizing` 标志:
 *   - resize 事件一来 → `isResizing = true`,且在 debounce 结束前持续为 true
 *   - debounce 结束(停手 150ms 后)→ `isResizing = false`,同时同步新 columns
 *
 * AppRoot 在 `isResizing` 期间直接不渲染 Header / Live / Composer,
 * Ink 没有活动区可重画,只剩 Static 历史(已写永驻,不会受 resize 影响),
 * 整个 reflow 过程视觉上是"安静的"。停手后才 mount 回活动区,贴合新尺寸。
 *
 * ## 兜底
 *
 * - 非 TTY / 拿不到 stdout:fallback columns = 80,`isResizing` 永远 false
 * - unmount 时 cleanup 监听器与 timer,避免 setState-after-unmount 警告
 */

import { useEffect, useState } from "react";
import { useStdout } from "ink";

const FALLBACK_COLUMNS = 80;
const DEBOUNCE_MS = 150;

export interface StableColumns {
  columns: number;
  /** 是否正处于"列数变化中,尚未稳定"的状态 */
  isResizing: boolean;
}

export function useStableColumns(): StableColumns {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState<number>(() =>
    Math.max(stdout?.columns ?? FALLBACK_COLUMNS, 1),
  );
  const [isResizing, setIsResizing] = useState<boolean>(false);

  useEffect(() => {
    if (!stdout) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      timer = null;
      const next = Math.max(stdout.columns ?? FALLBACK_COLUMNS, 1);
      setColumns((prev) => (prev === next ? prev : next));
      setIsResizing(false);
    };

    const onResize = (): void => {
      // 任何一次 resize 都先把"unstable"亮起来;timer 用最后一次为准
      setIsResizing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    // mount 时同步一次,避免 SSR / 测试环境下初始尺寸偏差
    const initial = Math.max(stdout.columns ?? FALLBACK_COLUMNS, 1);
    setColumns((prev) => (prev === initial ? prev : initial));

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, [stdout]);

  return { columns, isResizing };
}
