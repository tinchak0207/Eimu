import test from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOM_PLAN_MAX_COINS,
  CUSTOM_PLAN_MIN_COINS,
  CUSTOM_PLAN_PRICE_PER_COIN,
  PLAN_REFERENCE_COINS_PER_IMAGE,
  PLANS,
  clampCustomPlanCoins,
  customPlanFor,
  customPlanPrice,
  gptImage2EquivalentImages,
  pricePerCoin,
  pricePerGptImage2Image,
  resolvePricingPlan,
  snapCustomCoins,
} from "./plans.ts";

test("pricing plans match the public image package offers", () => {
  assert.deepEqual(
    PLANS.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      anchorPrice: plan.anchorPrice,
      couponNote: plan.couponNote,
      coins: plan.coins,
      purchaseUrl: plan.purchaseUrl,
      pricePerCoin: pricePerCoin(plan),
      gptImage2Images: gptImage2EquivalentImages(plan),
      pricePerGptImage2Image: pricePerGptImage2Image(plan),
    })),
    [
      {
        id: "starter",
        name: "梦芽 · 轻度尝鲜包",
        price: 9.9,
        anchorPrice: 20,
        couponNote: "用无门槛券",
        coins: 100,
        purchaseUrl: "https://m.tb.cn/h.R8hnjYn?tk=98pJg1LCwU5",
        pricePerCoin: "0.099",
        gptImage2Images: 100,
        pricePerGptImage2Image: "0.099",
      },
      {
        id: "popular",
        name: "梦影 · 主力月度会员",
        price: 29.9,
        anchorPrice: 50,
        couponNote: "用满减券",
        coins: 500,
        purchaseUrl: "https://m.tb.cn/h.RRNPSt8?tk=Jwqvg1LCmYc",
        pricePerCoin: "0.059",
        gptImage2Images: 500,
        pricePerGptImage2Image: "0.059",
      },
      {
        id: "pro",
        name: "梦虹 · 季度高频创作包",
        price: 69,
        anchorPrice: 120,
        couponNote: "限时折扣",
        coins: 1500,
        purchaseUrl: "https://m.tb.cn/h.RQl1F4Y?tk=FtGeg1LCZ7X",
        pricePerCoin: "0.046",
        gptImage2Images: 1500,
        pricePerGptImage2Image: "0.046",
      },
    ],
  );
  assert.equal(PLAN_REFERENCE_COINS_PER_IMAGE, 1);
  assert.equal(PLANS.every((plan) => plan.features.some((feature) => feature.includes("GPT Image 2（1K）"))), true);
  assert.equal(PLANS.some((plan) => plan.name.includes("无限")), false);
});

/* ── 自定义档（2026-09-07 暴君钦定）：0.045 RMB/金币单点权威 ──
   价格是钱：单价常量、区间夹取、档位吸附、解析器（checkout/notify 同源）
   全部钉进断言，任何改动都必须显式过这一关。 */
test("custom plan prices by the single-source 0.045 RMB per coin constant", () => {
  assert.equal(CUSTOM_PLAN_PRICE_PER_COIN, 0.045);
  // 区间：2,000 → 100 万（Log Scale 滑杆两端）。
  assert.equal(CUSTOM_PLAN_MIN_COINS, 2_000);
  assert.equal(CUSTOM_PLAN_MAX_COINS, 1_000_000);
  // 端点价：90 元 / 45,000 元；中间抽查 20,000 → 900。
  assert.equal(customPlanPrice(2_000), 90);
  assert.equal(customPlanPrice(1_000_000), 45_000);
  assert.equal(customPlanPrice(20_000), 900);
  // clamp：越界夹回区间，非有限值回最小档。
  assert.equal(clampCustomPlanCoins(1), 2_000);
  assert.equal(clampCustomPlanCoins(99_999_999), 1_000_000);
  assert.equal(clampCustomPlanCoins(Number.NaN), 2_000);
  // 吸附：对数空间最近邻美观档位。
  assert.equal(snapCustomCoins(4_999), 5_000);
  assert.equal(snapCustomCoins(5_001), 5_000);
  assert.equal(snapCustomCoins(999_999), 1_000_000);
});

test("resolvePricingPlan serves static plans and custom:<coins> identically for checkout and notify", () => {
  assert.equal(resolvePricingPlan("popular")?.id, "popular");
  const custom = resolvePricingPlan("custom:20000");
  assert.equal(custom?.price, 900);
  assert.equal(custom?.coins, 20_000);
  // customPlanFor 与解析器同价（页卡展示 = 服务端计价，不分叉）。
  assert.equal(customPlanFor(20_000).price, resolvePricingPlan("custom:20000")?.price);
  // 非法/越界参数：未知 id 拒绝；越界 coins 夹回合法区间（1 金币 → 最小档）。
  assert.equal(resolvePricingPlan("nope"), null);
  assert.equal(resolvePricingPlan("custom:1")?.coins, 2_000);
  assert.equal(resolvePricingPlan("custom:abc"), null);
});
