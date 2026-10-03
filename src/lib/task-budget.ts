// R2（W5）：單次任務預算閘的純函式層。
//
// 目標：讓「這次生成最多准花多少幣」成為一個可被兩端（本機軟停、伺服器硬停）共用的
// 判定。**這裡只交付可測的純函式**，不接任何 route、不改 `enforceQuotaGate` 的預設
// 行為——沒有呼叫端傳 cap 時，今天的一字一句都不動（零回歸）。
//
// 定價不另立：幣值一律由 catalog 的 credits 推導（`generationCoins`，credits ÷ 10），
// 與 `/v1/quota`、billing-projection 同源同價。

import { generationCoins, type GenerationPriceOptions } from "./generation-model-catalog/pricing";

/** 由 catalog 的 credits 推導本次生成的幣值（同 `generationCoins`，不另寫一份定價）。 */
export function estimateCoins(modelId: string, options: GenerationPriceOptions = {}): number {
  return generationCoins(modelId, options);
}

/**
 * 估算是否超出單次任務上限。
 *
 * - `cap === undefined`（或 null）＝未啟用上限 ⇒ **一律 false**（這是預設路徑的唯一
 *   保證：沒設上限就不可能因為預算被擋）。
 * - cap 或 estimated 非有限數（配置漂移／NaN）⇒ false：預算閘不因壞輸入誤擋真任務；
 *   真正的金額正確性由伺服器端帳本負責，不在展示/預估層 fail-closed。
 */
export function exceedsBudget(estimated: number, cap: number | undefined | null): boolean {
  if (cap === undefined || cap === null) return false;
  if (!Number.isFinite(cap) || !Number.isFinite(estimated)) return false;
  return estimated > cap;
}
