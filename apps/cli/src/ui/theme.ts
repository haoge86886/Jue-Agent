/**
 * @file theme.ts
 * @module @jue/cli/ui/theme
 *
 * 终端配色 token。集中放在这里,组件不要散落 hex / 颜色名。
 *
 * 配色思路:
 *   - user      : 蓝色  · 中性可读,与 assistant 区分
 *   - assistant : 青绿  · 亮度足、辨识度高
 *   - tool      : 黄色  · "动作正在发生"的暖色提示
 *   - dev       : 紫色  · 开发期专属,与业务事件不冲突
 *   - error     : 红色  · 终止性
 *   - system    : 灰色  · 启动横幅 / 命令回执
 *
 * 用 Ink 内置色名(跨大多数终端兼容);后续要更精细可换 hex,Ink 会自动降级。
 */

export const ROLE_PALETTE = {
  user: {
    bar: "blue",
    label: "you",
    labelBg: "blue",
    labelFg: "white",
    /**
     * 用户输入的灰底块背景。模仿 Claude Code 的视觉:
     * 历史消息里 user 输入用"浅灰块"高亮,assistant 文本无块,
     * 一眼就能扫出对话节奏。
     *
     * `blackBright` 是 ANSI 标准色,几乎所有现代终端会映射成深灰/浅灰,
     * 与 `white` 前景搭配在主流暗色主题下对比度足够。
     */
    blockBg: "blackBright",
  },
  assistant: { bar: "cyan", label: "agent", labelBg: "cyan", labelFg: "black" },
  tool: { bar: "yellow", label: "tool", labelBg: "yellow", labelFg: "black" },
  dev: { bar: "magenta", label: "dev", labelBg: "magenta", labelFg: "white" },
  error: { bar: "red", label: "error", labelBg: "red", labelFg: "white" },
  system: { bar: "greyBright", label: "system", labelBg: "#525d70", labelFg: "white" },
} as const;

export type RolePaletteKey = keyof typeof ROLE_PALETTE;

export const TEXT = {
  primary: "white",
  muted: "gray",
  accent: "cyan",
  warn: "yellow",
  hint: "gray",
} as const;

/**
 * 装饰字符。后续如要换 nerd-font 图标,只改这里。
 *
 * - `brand`        : Header 左侧 IconSlot 默认占位字符
 * - `prompt`       : 输入框 prompt 符号
 * - `bullet`/`arrow` : 系统消息/列表前缀
 */
export const SYMBOLS = {
  prompt: "›",
  bullet: "•",
  arrow: "→",
  spark: "✦",
  brand: "✦",
} as const;
