import React from "react";
import { Box, Text } from "ink";
import type { ContextBudgetStatus } from "../types.js";
import { TEXT } from "../theme.js";

interface ContextBudgetBadgeProps {
  status: ContextBudgetStatus | undefined;
  width: number;
}

export const ContextBudgetBadge: React.FC<ContextBudgetBadgeProps> = ({ status, width }) => {
  const label = formatContextBudget(status, width);
  const color = getBudgetColor(status);
  return (
    <Box width={width} justifyContent="flex-end">
      <Text color={color}>{label}</Text>
    </Box>
  );
};

function formatContextBudget(status: ContextBudgetStatus | undefined, width: number): string {
  if (!status) return width < 52 ? "ctx --" : "ctx --% free";
  const freePercent = Math.max(0, Math.min(100, Math.round(status.remainingRatio * 100)));
  const used = formatTokenCount(status.usedTokens);
  const ceiling = formatTokenCount(status.ceilingTokens);
  const flags = [
    status.compressedBlockCount > 0 ? "compact" : undefined,
    status.droppedBlockCount > 0 ? `drop ${status.droppedBlockCount}` : undefined,
  ].filter(Boolean).join(" · ");

  if (width < 52) return `ctx ${freePercent}%`;
  return [`ctx ${freePercent}% free`, `${used}/${ceiling}`, flags].filter(Boolean).join(" · ");
}

function getBudgetColor(status: ContextBudgetStatus | undefined): string {
  if (!status) return TEXT.muted;
  if (status.pressure === "overflow" || status.remainingRatio < 0.2) return "red";
  if (status.pressure === "llm_compress" || status.remainingRatio < 0.4) return TEXT.warn;
  if (status.pressure === "rule_compress") return "yellow";
  return "green";
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
