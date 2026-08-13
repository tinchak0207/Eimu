import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_REFERENCE_COINS_PER_IMAGE,
  PLANS,
  gptImage2EquivalentImages,
  pricePerCoin,
  pricePerGptImage2Image,
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
