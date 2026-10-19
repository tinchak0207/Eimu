// R2（W5）：单次任务预算闸的纯函式层。
//
// 目标：让「这次生成最多准花多少币」成为一个可被两端（本机软停、伺服器硬停）共用的
// 判定。**这里只交付可测的纯函式**，不接任何 route、不改 `enforceQuotaGate` 的预设
// 行为——没有呼叫端传 cap 时，今天的一字一句都不动（零回归）。
//
// 定价不另立：币值一律由 catalog 的 credits 推导（`generationCoins`，credits ÷ 10），
// 与 `/v1/quota`、billing-projection 同源同价。

import { generationCoins, type GenerationPriceOptions } from "./generation-model-catalog/pricing";

/** 由 catalog 的 credits 推导本次生成的币值（同 `generationCoins`，不另写一份定价）。 */
export function estimateCoins(modelId: string, options: GenerationPriceOptions = {}): number {
  return generationCoins(modelId, options);
}

/**
 * 估算是否超出单次任务上限。
 *
 * - `cap === undefined`（或 null）＝未启用上限 ⇒ **一律 false**（这是预设路径的唯一
 *   保证：没设上限就不可能因为预算被挡）。
 * - cap 或 estimated 非有限数（配置漂移／NaN）⇒ false：预算闸不因坏输入误挡真任务；
 *   真正的金额正确性由伺服器端帐本负责，不在展示/预估层 fail-closed。
 */
export function exceedsBudget(estimated: number, cap: number | undefined | null): boolean {
  if (cap === undefined || cap === null) return false;
  if (!Number.isFinite(cap) || !Number.isFinite(estimated)) return false;
  return estimated > cap;
}
