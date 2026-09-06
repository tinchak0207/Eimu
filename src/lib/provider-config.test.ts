import test from "node:test";
import assert from "node:assert/strict";

import {
  ADOBE_FIREFLY_MODEL_ID,
  MODEL_CONFIGS,
  NANO_BANANA_2_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PROVIDERS,
  imageGenerationCoins,
  modelPromotionTag,
  modelDisplayName,
  resolveUpstreamModelId,
} from "./provider-config.ts";

test("Adobe Firefly Image 5 is available through the server-side relay", () => {
  assert.equal(ADOBE_FIREFLY_MODEL_ID, "adobe-firefly");
  assert.equal(PROVIDERS.image_tinchak.models.includes(ADOBE_FIREFLY_MODEL_ID), true);
  assert.equal(modelDisplayName(ADOBE_FIREFLY_MODEL_ID), "Adobe Firefly Image 5 · 1 币/张");
  assert.equal(imageGenerationCoins(ADOBE_FIREFLY_MODEL_ID, "fast"), 1);
});

test("Nano Banana Pro and Nano Banana 2 keep distinct official model identities", () => {
  assert.equal(NANO_BANANA_PRO_MODEL_ID, "gemini-3-image");
  assert.equal(NANO_BANANA_2_MODEL_ID, "gemini-3.1-flash-image");
  assert.ok(PROVIDERS.image_tinchak.models.includes(NANO_BANANA_PRO_MODEL_ID));
  assert.ok(PROVIDERS.image_tinchak.models.includes(NANO_BANANA_2_MODEL_ID));
  assert.equal(modelDisplayName(NANO_BANANA_PRO_MODEL_ID), "Nano Banana Pro · 4 币/张");
  assert.equal(modelDisplayName(NANO_BANANA_2_MODEL_ID), "Nano Banana 2 · 2 币/张");
});

test("GPT Image 2 follows the Adobe credit table at ten credits per coin", () => {
  assert.equal(imageGenerationCoins("gpt-image-2", "fast"), 1);
  assert.equal(imageGenerationCoins("gpt-image-2", "quality"), 2);
});

test("PixAI Tsubaki.2 keeps the recommendation tag; default engine is GPT Image 2", () => {
  // 2026-09-05 暴君裁定：預設模型改 GPT Image 2；Tsubaki.2 保留「推荐」標籤。
  assert.equal(modelPromotionTag(PIXAI_TSUBAKI2_MODEL_ID), "推荐");
  assert.equal(MODEL_CONFIGS.fast.image_tinchak, "gpt-image-2");
  assert.equal(MODEL_CONFIGS.quality.image_tinchak, "gpt-image-2");
});

test("endpoint overrides do not replace nano-banana-pro with the legacy default model", () => {
  assert.equal(resolveUpstreamModelId("gpt-image-2", "codex-gpt-image-2"), "codex-gpt-image-2");
  assert.equal(resolveUpstreamModelId(NANO_BANANA_PRO_MODEL_ID, "codex-gpt-image-2"), NANO_BANANA_PRO_MODEL_ID);
});

import { resolveAdobe2ApiModelId } from "./generation-core/adobe2api-upstream.ts";

test("Adobe 3P proxy aliases preserve the requested model, quality, and supported aspect ratio", () => {
  assert.equal(resolveAdobe2ApiModelId("gpt-image-2", "1536x1024", "quality"), "firefly-gpt-image-2k-3x2");
  assert.equal(resolveAdobe2ApiModelId("gemini-3.1-flash-image", "1024x1024", "fast"), "firefly-nano-banana2-1k-1x1");
  assert.equal(resolveAdobe2ApiModelId("gemini-3.1-flash-image", "1536x1024", "quality"), "firefly-nano-banana2-2k-3x2");
  assert.equal(resolveAdobe2ApiModelId("adobe-firefly", "1024x1024", "quality"), "firefly-image5-2k-1x1");
});
