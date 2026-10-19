import test from "node:test";
import assert from "node:assert/strict";

import {
  activeModelPricingOverrides,
  applyModelPricingOverrides,
  baseGenerationModel,
  generationCapabilities,
  generationCoins,
  generationCredits,
  generationModel,
  modelPricingRevision,
  modelPriceLabel,
  normalizeModelPricingOverrides,
  subscribeModelPricing,
} from "./generation-model-catalog.ts";
import { imageGenerationCoins } from "./provider-config.ts";

/** 每个测试结束复原为基准价，避免测试间互相污染（apply 是模组级状态）。 */
function withPricing(raw: unknown, fn: () => void): void {
  applyModelPricingOverrides(raw);
  try {
    fn();
  } finally {
    applyModelPricingOverrides({});
  }
}

test("apply overrides change generationCoins / modelPriceLabel / imageGenerationCoins in lockstep", () => {
  withPricing({ "gpt-image-2": { imageCredits: { "1k": 100, "2k": 200 } } }, () => {
    assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 10);
    assert.equal(generationCoins("gpt-image-2", { resolution: "2k" }), 20);
    assert.equal(modelPriceLabel("gpt-image-2", { resolution: "1k" }), "10 币/张");
    // provider-config 的快速/品质报价读同一份 effective catalog
    assert.equal(imageGenerationCoins("gpt-image-2", "fast"), 10);
    assert.equal(imageGenerationCoins("gpt-image-2", "quality"), 20);
    // 未覆写的模型不受影响
    assert.equal(generationCoins("veo-3.1-fast", { resolution: "720p", durationSeconds: 4 }), 4);
  });
});

test("per-key credit merge keeps non-overridden resolutions on the base price", () => {
  withPricing({ "gpt-image-2": { imageCredits: { "2k": 200 } } }, () => {
    assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 1); // 基准 10 credit -> 1 币
    assert.equal(generationCoins("gpt-image-2", { resolution: "2k" }), 20); // 覆写 200 credit -> 20 币
    assert.equal(generationCoins("gpt-image-2", { resolution: "4k" }), 8); // 基准 80 credit -> 8 币
  });
});

test("video overrides merge per-key and keep non-overridden resolutions", () => {
  withPricing({ "kling-3.0": { videoCreditsPerSecond: { "720p": 40 } } }, () => {
    assert.equal(generationCoins("kling-3.0", { resolution: "720p", durationSeconds: 5 }), 20); // 40*5/10
    assert.equal(generationCoins("kling-3.0", { resolution: "1080p", durationSeconds: 5 }), 12.5); // 基准 25*5/10
  });
});

test("video audio table overrides merge per-key too", () => {
  withPricing({ "kling-3.0": { videoCreditsWithAudioPerSecond: { "720p": 50 } } }, () => {
    assert.equal(generationCoins("kling-3.0", { resolution: "720p", durationSeconds: 5, generateAudio: true }), 25); // 50*5/10
    assert.equal(generationCoins("kling-3.0", { resolution: "1080p", durationSeconds: 5, generateAudio: true }), 17.5); // 基准 35*5/10
  });
});

test("table-based models keep resolution pricing even with a stale fixedCoins override", () => {
  withPricing({ "gpt-image-2": { fixedCoins: 3 } }, () => {
    assert.equal(generationCredits("gpt-image-2", { resolution: "1k" }), 10);
    assert.equal(generationCoins("gpt-image-2", { resolution: "4k" }), 8);
    assert.equal(modelPriceLabel("gpt-image-2", { resolution: "4k" }), "8 币/张");
  });
});

test("fixedCoins still prices models without a rate table", () => {
  withPricing({ "tts-1": { fixedCoins: 5 } }, () => {
    assert.equal(generationCoins("tts-1", { resolution: "2k" }), 5);
    assert.equal(modelPriceLabel("tts-1", { resolution: "2k" }), "5 币/张");
  });
});

test("pricing overrides never pollute capability fields", () => {
  const base = baseGenerationModel("gpt-image-2");
  assert.ok(base, "base gpt-image-2 must exist");
  withPricing({ "gpt-image-2": { imageCredits: { "1k": 100 } } }, () => {
    const effective = generationModel("gpt-image-2");
    assert.ok(effective, "effective gpt-image-2 must exist");
    assert.deepEqual(effective.resolutions, base.resolutions);
    assert.deepEqual(effective.aspectRatios, base.aspectRatios);
    assert.equal(effective.popularity, base.popularity);
    assert.equal(effective.kind, base.kind);
    assert.equal(effective.displayName, base.displayName);
    assert.deepEqual(generationCapabilities("gpt-image-2")?.resolutions, base.resolutions);
    // baseGenerationModel 永远回基准定义，基准价不受覆写影响
    assert.equal(baseGenerationModel("gpt-image-2")?.imageCredits?.["1k"], 10);
  });
});

test("unknown model ids, mismatched fields, and invalid values are dropped", () => {
  // 未知 modelId / 错位栏位（video 模型塞 image 栏位、image 模型塞 video 栏位）
  assert.deepEqual(
    normalizeModelPricingOverrides({
      "not-a-model": { fixedCoins: 5 },
      "kling-3.0": { imageCredits: { "720p": 10 } },
      "gpt-image-2": { videoCreditsPerSecond: { "1k": 10 } },
      "veo-3.1": { imageCredits: { "720p": 10 } },
    }),
    {},
  );

  // 不存在于该模型 resolutions 的解析度
  assert.deepEqual(normalizeModelPricingOverrides({ "gpt-image-2": { imageCredits: { "3k": 10 } } }), {});

  // 非法 credit 值：0、负数、超出上限；合法小数 credit（≥ 0.1）按精度保留
  assert.deepEqual(normalizeModelPricingOverrides({ "gpt-image-2": { imageCredits: { "1k": 0, "2k": -5 } } }), {});
  assert.deepEqual(
    normalizeModelPricingOverrides({ "gpt-image-2": { imageCredits: { "1k": 1.5, "2k": 2_000_000, "4k": 50 } } }),
    { "gpt-image-2": { imageCredits: { "1k": 1.5, "4k": 50 } } },
  );
});

test("fixedCoins 0 and negative are rejected; valid values are kept and rounded", () => {
  assert.deepEqual(
    normalizeModelPricingOverrides({
      "tts-1": { fixedCoins: 0 },
      "veo-3.1": { fixedCoins: -2 },
      "gpt-image-2": { fixedCoins: 100_001 },
      "kling-3.0": { fixedCoins: Number.NaN },
    }),
    {},
  );
  // 四舍五入到 PRICING_DECIMALS 位小数
  assert.deepEqual(normalizeModelPricingOverrides({ "tts-1": { fixedCoins: 3.1415926 } }), {
    "tts-1": { fixedCoins: 3.14159 },
  });
  // 下界 0.1 合法
  assert.deepEqual(normalizeModelPricingOverrides({ "tts-1": { fixedCoins: 0.1 } }), {
    "tts-1": { fixedCoins: 0.1 },
  });
});

test("限免级小数定价：1e-5 币的 fixedCoins 与 credit 都按精度保留，generationCoins 走 0.01+ 粒度", () => {
  // fixedCoins 直接保留到 PRICING_DECIMALS 位（1e-5 币）
  assert.deepEqual(normalizeModelPricingOverrides({ "tts-1": { fixedCoins: 0.00001 } }), {
    "tts-1": { fixedCoins: 0.00001 },
  });
  // 小于最小步长的值视为无效（设 0 币的变体），静默丢弃
  assert.deepEqual(normalizeModelPricingOverrides({ "tts-1": { fixedCoins: 0.000001 } }), {});

  withPricing({ "tts-1": { fixedCoins: 0.00001 } }, () => {
    assert.equal(generationCoins("tts-1"), 0.00001);
  });

  // credit 小数：0.1 credit = 0.01 币、0.0001 credit = 1e-5 币
  withPricing({ "gpt-image-2": { imageCredits: { "1k": 0.1, "2k": 0.0001 } } }, () => {
    assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 0.01);
    assert.equal(generationCoins("gpt-image-2", { resolution: "2k" }), 0.00001);
  });
});

test("applying {} restores base prices and clears active overrides", () => {
  try {
    applyModelPricingOverrides({ "gpt-image-2": { imageCredits: { "1k": 100 } } });
    assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 10);
    applyModelPricingOverrides({});
    assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 1);
    assert.deepEqual(activeModelPricingOverrides(), {});
    assert.equal(generationModel("gpt-image-2")?.imageCredits?.["1k"], 10);
    assert.equal(baseGenerationModel("gpt-image-2")?.imageCredits?.["1k"], 10);
  } finally {
    applyModelPricingOverrides({});
  }
});

test("subscribers are notified on apply and the revision bumps; unsubscribe stops notifications", () => {
  let notifications = 0;
  const unsubscribe = subscribeModelPricing(() => {
    notifications += 1;
  });
  try {
    const revBefore = modelPricingRevision();
    applyModelPricingOverrides({ "gpt-image-2": { fixedCoins: 3 } });
    assert.equal(notifications, 1);
    assert.equal(modelPricingRevision(), revBefore + 1);

    applyModelPricingOverrides({});
    assert.equal(notifications, 2);
    assert.equal(modelPricingRevision(), revBefore + 2);

    unsubscribe();
    applyModelPricingOverrides({ "gpt-image-2": { fixedCoins: 3 } });
    assert.equal(notifications, 2);
    assert.equal(modelPricingRevision(), revBefore + 3);
  } finally {
    unsubscribe();
    applyModelPricingOverrides({});
  }
});

test("GPT Image 2.5 Flare/Sunburst price at three times GPT Image 2 per resolution", () => {
  // 项目负责人裁定（2026-09-09）：2.5 两档 = gpt-image-2 × 3（10/20/80 -> 30/60/240 credit）
  for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    assert.equal(generationCredits(modelId, { resolution: "1k" }), 30);
    assert.equal(generationCredits(modelId, { resolution: "2k" }), 60);
    assert.equal(generationCredits(modelId, { resolution: "4k" }), 240);
    assert.equal(generationCoins(modelId, { resolution: "1k" }), 3);
    assert.equal(generationCoins(modelId, { resolution: "2k" }), 6);
    assert.equal(generationCoins(modelId, { resolution: "4k" }), 24);
    assert.equal(modelPriceLabel(modelId, { resolution: "1k" }), "3 币/张");
  }
  for (const resolution of ["1k", "2k", "4k"] as const) {
    assert.equal(
      generationCredits("gpt-image-2.5-sunburst", { resolution }),
      generationCredits("gpt-image-2", { resolution }) * 3,
      `sunburst ${resolution} must be 3x gpt-image-2`,
    );
  }
});
