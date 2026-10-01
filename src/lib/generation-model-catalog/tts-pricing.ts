// 站內 TTS 單價（唯一真源，2026-10-01 接上真計費）。
//
// 費率逐字取自 VPS 上游定價表 `/opt/agent-harness/gateway/pricing-and-validation.ts:14`
//   → `'tts-zh': { base_cost: 0, per_char: 0.001 }`
// 即：一口價固定成分 base_cost = 0，逐字成分 per_char = 0.001 幣/字（暴君 2026-10-01 同意的口徑）。
//
// ── 為什麼鏡射成一顆站內常數，而不進 catalog 的 pricing 機制 ──────────────────
// catalog（`types.ts`→`pricing.ts`）的定價維度只有兩種：圖像按解析度、視頻按
// 秒 × 解析度（credit 表），或整單一口價 `fixedCoins`。**沒有「字」這一維**——
// 把 0.001 塞進 tts-1 的 `fixedCoins` 會變成「0.001 幣/整單」，語義不同（該欄
// 對上游 base_cost=0，本就該是 0）。要讓 catalog 表達 per_char 得新增欄位 +
// 覆寫清洗 + admin UI，屬機制擴建；本刀只接費率，不發明新計費機制。
// ⇒ per-char 站內只此一份；上游若改價，改這一顆 + 站內三處消費點自動同源。
//
// ── 消費點（全部改吃本檔）──────────────────────────────────────────────────
//   · `POST /v1/tts/generations`（B 端／MCP 提交）        → baseBillingAmount
//   · `POST /api/canvas/storyboard-voiceover`（逐鏡配音）→ 逐行 billingAmount
//   · `billing-projection.estimateGatePathBasePrice`（閘門路徑記帳，kind=tts）
//   · `canvas/storyboard-voiceover.estimateVoiceoverCoins`（dryRun 報價，同一把尺）

import { QUOTA_PER_COIN } from "@/lib/quota-constants";

/** 站內 TTS 單價：幣/字（＝上游 `'tts-zh'.per_char`）。 */
export const TTS_COINS_PER_CHAR = 0.001;

/**
 * 字數 → 幣。精度收斂到 1e-6（與 `task-response.resolveTaskCostCoins`、
 * `estimateVoiceoverCoins` 同一把尺）。非有限值／≤0 一律 0。
 */
export function ttsCoinsForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars * TTS_COINS_PER_CHAR * 1e6) / 1e6;
}

/**
 * 字數 → 帳本 quota（1 幣 = `QUOTA_PER_COIN`；沿用既有 `× QUOTA_PER_COIN` 換算，
 * 不自算第二套）。真 0 字 = 0 —— 這正是 `billing-ledger` 零額短路的**唯一**合法成因；
 * 非空文本一律非 0（0.001 幣/字 × 500000 = 500 quota/字，整數無舍入殘差）。
 */
export function ttsQuotaForChars(chars: number): number {
  return Math.round(ttsCoinsForChars(chars) * QUOTA_PER_COIN);
}
