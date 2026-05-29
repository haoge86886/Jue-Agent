/**
 * @file IconSlot.tsx
 * @module @jue/cli/ui/components/IconSlot
 *
 * 终端"图标位"占位组件。
 *
 * Ink 直接渲染 emoji / Unicode 字符在大多数现代终端都可见;
 * 如果以后改成真实 SVG/字符画,只需要替换这个组件,调用方不变。
 *
 * 入参 `glyph` 与 `color` 可由调用方覆盖,默认走 theme.SYMBOLS.brand。
 */

import React from "react";
import { Text } from "ink";
import { SYMBOLS, TEXT } from "../theme.js";

interface IconSlotProps {
  glyph?: string;
  color?: string;
  bold?: boolean;
}

export const IconSlot: React.FC<IconSlotProps> = ({
  glyph = SYMBOLS.brand,
  color = TEXT.accent,
  bold = true,
}) => (
  <Text color={color} bold={bold}>
    {glyph}
  </Text>
);
