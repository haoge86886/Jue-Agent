/**
 * @file token-estimator.ts
 * @module @jue/utils/token-estimator
 *
 * Token 估算的最小可用版本。当前阶段不引入 tiktoken,纯按字符数粗估,
 * 误差完全可以接受,因为这一阶段的目的是"让 ContextBudgeter 有数可用",
 * 而不是精确计费。
 *
 * 经验系数:
 *   - 英文 / 代码:约 4 字符 ≈ 1 token
 *   - 中文          :约 1.6 字符 ≈ 1 token(含标点)
 *
 * 实际实现统一用 3.5,稍偏保守(估算偏多 → 上下文裁剪偏严 → 不会撞窗口)。
 *
 * 之后如需精确化,可在本文件内换实现,或暴露 `TokenEstimator` 接口让 DI 替换。
 */

const APPROX_CHARS_PER_TOKEN = 3.5;

/**
 * 估算单段文本的 token 数。
 * 经验值,误差大但稳定;空字符串返回 0,不会负数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * 估算多段文本之和。
 */
export function estimateTokensTotal(texts: string[]): number {
  let sum = 0;
  for (const t of texts) sum += estimateTokens(t);
  return sum;
}

/**
 * Token 估算器接口。便于后续把 tiktoken / provider tokenizer 注入进来。
 */
export interface TokenEstimator {
  estimate(text: string): number;
}

export const defaultTokenEstimator: TokenEstimator = {
  estimate: estimateTokens,
};
