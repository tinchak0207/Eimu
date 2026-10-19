import test from "node:test";
import assert from "node:assert/strict";
import { formatPublicGenerationSummary } from "./public-generation-summary";

test("public generation summary exposes image model and parameters only", () => {
  assert.equal(
    formatPublicGenerationSummary({
      modelId: "gpt-image-2",
      mediaType: "image",
      workflow: {
        aspectRatio: "1:1",
        outputResolution: "2k",
        qualityProfile: "balanced",
        productionIntent: "general",
      },
    }),
    "GPT Image 2 · 1:1 · 2K · 均衡 · 通用",
  );
});

test("public generation summary includes video audio choice", () => {
  assert.equal(
    formatPublicGenerationSummary({
      modelId: "kling-3.0-omni",
      mediaType: "video",
      workflow: {
        durationSeconds: 5,
        outputResolution: "720p",
        generateAudio: false,
      },
    }),
    "Kling 3.0 Omni · 5 秒 · 720p · 音效关闭",
  );
});
