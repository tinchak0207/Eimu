import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_MODEL_IDS,
  defaultGenerateAudio,
  generationCoins,
  generationCredits,
  modelAspectRatios,
  modelPriceLabel,
  modelResolutions,
  modelSupportsAudio,
  generationCapabilities,
  normalizeGenerationConfig,
  resolutionLabel,
} from "./generation-model-catalog.ts";
import { resolveAdobe2ApiImageModelId, resolveAdobe2ApiVideoModelId } from "./generation-core/adobe2api-upstream.ts";

test("recommended model is first and the requested image supply models lead the public menu", () => {
  assert.equal(GENERATION_MODEL_IDS[0], "gpt-image-2");
  assert.deepEqual(GENERATION_MODEL_IDS.slice(1, 5), [
    "gemini-3.1-flash-image",
    "image-5-pro",
    "image-5-lite",
    "seedream-2.0",
  ]);
});

test("Dreamina image aliases expose only the requested Seedream generations", () => {
  for (const modelId of ["image-5-pro", "image-5-lite", "seedream-2.0"]) {
    assert.equal(generationCapabilities(modelId)?.mediaType, "image");
    assert.deepEqual(modelResolutions(modelId), ["1k", "2k", "4k"]);
  }
});

test("official Adobe credits map to platform coins at the established ten-to-one baseline", () => {
  assert.equal(generationCredits("gpt-image-2", { resolution: "4k" }), 80);
  assert.equal(generationCoins("gpt-image-2", { resolution: "1k" }), 1);
  assert.equal(generationCoins("gpt-image-2", { resolution: "4k" }), 8);
  assert.equal(generationCoins("gemini-3.1-flash-image", { resolution: "2k" }), 2);
  assert.equal(generationCoins("gemini-3.1-flash-image", { resolution: "4k" }), 3);
  assert.equal(generationCoins("veo-3.1-fast", { resolution: "720p", durationSeconds: 4 }), 4);
  assert.equal(generationCoins("kling-3.0", { resolution: "720p", durationSeconds: 5 }), 10);
  assert.equal(generationCoins("kling-3.0", {
    resolution: "720p",
    durationSeconds: 5,
    generateAudio: true,
  }), 12.5);
  assert.equal(generationCoins("seedance-2.0-fast", { resolution: "480p", durationSeconds: 4 }), 40);
});

test("video menu prices use per-second units without changing total generation cost", () => {
  assert.equal(modelPriceLabel("veo-3.1-fast", { resolution: "720p", durationSeconds: 4 }), "1 币/秒");
  assert.equal(modelPriceLabel("kling-3.0", { resolution: "720p", durationSeconds: 10 }), "2 币/秒");
  assert.equal(modelPriceLabel("kling-3.0", {
    resolution: "720p",
    durationSeconds: 5,
    generateAudio: true,
  }), "2.5 币/秒");
  assert.equal(generationCoins("kling-3.0", {
    resolution: "720p",
    durationSeconds: 5,
    generateAudio: true,
  }), 12.5);
});

test("audio capability and defaults match the live Adobe model contract", () => {
  assert.equal(modelSupportsAudio("kling-3.0-omni"), true);
  assert.equal(defaultGenerateAudio("kling-3.0-omni"), false);
  assert.equal(defaultGenerateAudio("veo-3.1"), true);
  assert.equal(modelSupportsAudio("runway-gen-4.5"), false);
});

test("image controls expose Adobe resolution language and all live Adobe2API ratios", () => {
  assert.deepEqual(modelResolutions("gpt-image-2"), ["1k", "2k", "4k"]);
  assert.equal(resolutionLabel("1k"), "1K 标准");
  assert.equal(resolutionLabel("2k"), "2K 高清");
  assert.equal(resolutionLabel("4k"), "4K 超清");
  assert.ok(modelAspectRatios("gpt-image-2").includes("2:3"));
  assert.ok(modelAspectRatios("gpt-image-2").includes("1:1"));
  assert.ok(modelAspectRatios("gpt-image-2").includes("9:16"));
});

test("catalog resolves image and video selections to real Adobe2API model ids", () => {
  assert.equal(resolveAdobe2ApiImageModelId("gpt-image-2", "2:3", "4k"), "firefly-gpt-image-4k-2x3");
  assert.equal(resolveAdobe2ApiImageModelId("gemini-3.1-flash-image", "1:4", "2k"), "firefly-nano-banana2-2k-1x4");
  assert.equal(resolveAdobe2ApiImageModelId("adobe-firefly", "16:9", "2k"), "firefly-image5-2k-16x9");
  assert.equal(resolveAdobe2ApiVideoModelId("veo-3.1-fast", "9:16", "1080p", 8), "firefly-veo31-fast-8s-9x16-1080p");
  assert.equal(resolveAdobe2ApiVideoModelId("kling-3.0", "16:9", "720p", 10), "firefly-kling3-10s-16x9-720p");
  assert.equal(resolveAdobe2ApiVideoModelId("seedance-2.0-fast", "16:9", "480p", 4), "firefly-seedance2-fast-4s-16x9-480p");
});

test("one capability projection normalizes UI, request, LoRA, reference, and pricing fields", () => {
  const image = normalizeGenerationConfig("adobe-firefly", {
    aspectRatio: "16:9",
    outputResolution: "4k",
    durationSeconds: 8,
    generateAudio: true,
    qualityMode: "quality",
    referenceCount: 2,
    loraModelVersionIds: ["one", "two"],
  });
  assert.equal(image.config.aspectRatio, "16:9");
  assert.equal(image.config.outputResolution, "1k");
  assert.equal(image.config.durationSeconds, undefined);
  assert.equal(image.config.generateAudio, undefined);
  assert.equal(image.config.referenceCount, 0);
  assert.deepEqual(image.config.loraModelVersionIds, []);
  assert.ok(image.clearedFields.includes("referenceImages"));
  assert.ok(image.clearedFields.includes("loraModelVersionIds"));
  assert.equal(generationCoins("adobe-firefly", image.config), 1);

  const video = normalizeGenerationConfig("kling-3.0", {
    outputResolution: "720p",
    durationSeconds: 7,
    generateAudio: true,
  });
  assert.equal(video.config.durationSeconds, 5);
  assert.equal(video.config.generateAudio, true);
  assert.equal(generationCoins("kling-3.0", video.config), 12.5);

  assert.equal(generationCapabilities("pixai-tsubaki2")?.lora, true);
  assert.deepEqual(
    normalizeGenerationConfig("pixai-tsubaki2", { loraModelVersionIds: ["first", "second"] }).config.loraModelVersionIds,
    ["first"],
  );
});
