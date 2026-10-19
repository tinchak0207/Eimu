// 站内音乐生成单价（**唯一真源**，2026-10-10 补：音乐此前完全没有价目来源）。
//
// 背景（记忆 `2026-10-10-music-has-no-price-authority`）：音乐是唯一活链路，但
// harness 的 MODEL_PRICING 无音乐条目、平台 model-pricing 只覆盖图片/影片、
// music_gen 回执不带 cost_coins ⇒ agent 无法报价、评测按硬规则禁止付费验证。
// 本档补上站内唯一价目来源：任何「音乐收多少钱」的数字只能从这里取。
//
// ── 口径 ────────────────────────────────────────────────────────────────────
//   固定 1 币/次，**统一价**：不分上游通路（FlowMusic2API / Lyria / YuE2）、不分
//   版本、不分 take 数（一次生成尝试一手 ref = 一次计费）。这也是
//   `POST /v1/music/charges` 实扣与 `GET /v1/models` 的 `x_coins_per_music`
//   的共同来源——报价与实扣同源，不是两份数字。
//
// ── 消费点（全部改吃本档）─────────────────────────────────────────────────
//   · `POST /v1/music/charges`（扣费端点）        → musicQuotaPerGeneration()
//   · `GET /v1/models`（agent 报价工具读它）       → musicCoinsPerGeneration()
//   · harness 的 music_gen 报价/计费判定           → shouldChargeMusicGeneration()
//
// ── 「金额不接受调用方输入」───────────────────────────────────────────────
// 本档没有任何接受金额作为参数的出口；调用方（harness / 其他路由）只能读结果。
// 扣费端点（/v1/music/charges）的请求体只收 `{ ref }`，出现任何金额栏位一律 400。

import { QUOTA_PER_COIN } from "@/lib/quota-constants";

/** 音乐生成单价（币/次）。唯一常数——改价只改这一行。 */
export const MUSIC_COINS_PER_GENERATION = 1;

/** 扣费端点路径（唯一真源；/v1/models 的 x_endpoint 与路由本体都引用它）。 */
export const MUSIC_CHARGE_ENDPOINT = "/v1/music/charges";

/** 一次音乐生成的定价（币）。呼叫方零输入——金额只能来自本档。 */
export function musicCoinsPerGeneration(): number {
  return MUSIC_COINS_PER_GENERATION;
}

/**
 * 一次音乐生成对应的帐本 quota（1 币 = `QUOTA_PER_COIN`，沿用既有换算常量，
 * 不自算第二套）。实扣直接拿这个数走 reserveImageQuota。
 */
export function musicQuotaPerGeneration(): number {
  return Math.round(musicCoinsPerGeneration() * QUOTA_PER_COIN);
}

/**
 * 这次音乐生成该不该计费（**唯一判定**）。
 *
 * 这两条是**呼叫端**（harness 的 music_gen）才能观察的事实，平台看不到——所以
 * 判定函数放在这里给呼叫端共用，而不是塞进扣费端点：
 *   · `probe: true`         探针/试跑，不计费（零花费验证走探针，不走真单）。
 *   · `producedAudio: false` 这次没有真的产出音频（上游失败/被取消），不计费。
 *
 * 扣费端点（/v1/music/charges）的契约＝「呼叫即声明这是一次真实、非探针、有成品
 * 的生成」——呼叫端在动手前用本函数判定，不该计费的就别调用端点。
 */
export function shouldChargeMusicGeneration(facts: {
  probe?: boolean;
  producedAudio?: boolean;
}): boolean {
  if (facts.probe === true) return false;
  if (facts.producedAudio === false) return false;
  return true;
}
