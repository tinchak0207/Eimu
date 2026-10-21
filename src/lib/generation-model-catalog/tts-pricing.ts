// 站内 TTS 单价（唯一真源，2026-10-01 接上真计费）。
//
// 费率逐字取自 VPS 上游定价表 `/opt/agent-harness/gateway/pricing-and-validation.ts:14`
//   → `'tts-zh': { base_cost: 0, per_char: 0.001 }`
// 即：一口价固定成分 base_cost = 0，逐字成分 per_char = 0.001 币/字（暴君 2026-10-01 同意的口径）。
//
// ── 为什么镜射成一颗站内常数，而不进 catalog 的 pricing 机制 ──────────────────
// catalog（`types.ts`→`pricing.ts`）的定价维度只有两种：图像按解析度、视频按
// 秒 × 解析度（credit 表），或整单一口价 `fixedCoins`。**没有「字」这一维**——
// 把 0.001 塞进 tts-1 的 `fixedCoins` 会变成「0.001 币/整单」，语义不同（该栏
// 对上游 base_cost=0，本就该是 0）。要让 catalog 表达 per_char 得新增栏位 +
// 覆写清洗 + admin UI，属机制扩建；本刀只接费率，不发明新计费机制。
// ⇒ per-char 站内只此一份；上游若改价，改这一颗 + 站内三处消费点自动同源。
//
// ── 消费点（全部改吃本档）──────────────────────────────────────────────────
//   · `POST /v1/tts/generations`（B 端／MCP 提交）        → baseBillingAmount
//   · `POST /api/canvas/storyboard-voiceover`（逐镜配音）→ 逐行 billingAmount
//   · `billing-projection.estimateGatePathBasePrice`（闸门路径记帐，kind=tts）
//   · `canvas/storyboard-voiceover.estimateVoiceoverCoins`（dryRun 报价，同一把尺）

import { QUOTA_PER_COIN } from "@/lib/quota-constants";

/** 站内 TTS 单价：币/字（＝上游 `'tts-zh'.per_char`）。 */
export const TTS_COINS_PER_CHAR = 0.001;

/**
 * 字数 → 币。精度收敛到 1e-6（与 `task-response.resolveTaskCostCoins`、
 * `estimateVoiceoverCoins` 同一把尺）。非有限值／≤0 一律 0。
 */
export function ttsCoinsForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars * TTS_COINS_PER_CHAR * 1e6) / 1e6;
}

/**
 * 字数 → 帐本 quota（1 币 = `QUOTA_PER_COIN`；沿用既有 `× QUOTA_PER_COIN` 换算，
 * 不自算第二套）。真 0 字 = 0 —— 这正是 `billing-ledger` 零额短路的**唯一**合法成因；
 * 非空文本一律非 0（0.001 币/字 × 500000 = 500 quota/字，整数无舍入残差）。
 */
export function ttsQuotaForChars(chars: number): number {
  return Math.round(ttsCoinsForChars(chars) * QUOTA_PER_COIN);
}
