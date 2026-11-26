import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_KNOWLEDGE } from "./knowledge.ts";
import { GENERATION_MODEL_CATALOG } from "./catalog.ts";
import { modelKnowledge } from "./capabilities.ts";
import { applyModelPricingOverrides } from "./pricing-overrides.ts";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS } from "./catalog.ts";

test("every knowledge entry attaches to a real catalog model", () => {
  for (const [modelId] of Object.entries(MODEL_KNOWLEDGE)) {
    assert.ok(GENERATION_MODEL_CATALOG[modelId], `unknown model id in MODEL_KNOWLEDGE: ${modelId}`);
    assert.equal(GENERATION_MODEL_CATALOG[modelId].knowledge, MODEL_KNOWLEDGE[modelId]);
  }
});

test("knowledge fields are non-empty strings and each entry has at least one section", () => {
  for (const [modelId, knowledge] of Object.entries(MODEL_KNOWLEDGE)) {
    const sections = [knowledge.strengths, knowledge.knownDefects, knowledge.usageTips];
    assert.ok(
      sections.some((section) => section && section.length > 0),
      `${modelId} has no section at all — do not attach empty knowledge`,
    );
    // 中文一句话至少 4 个字符才有信息量（CJK 每字 length=1）。
    for (const line of knowledge.strengths ?? []) assert.ok(line.trim().length >= 4, `${modelId} strengths too short: ${line}`);
    for (const line of knowledge.knownDefects ?? []) assert.ok(line.trim().length >= 4, `${modelId} knownDefects too short: ${line}`);
    for (const tip of knowledge.usageTips ?? []) {
      assert.ok(tip.text.trim().length >= 4, `${modelId} usageTip too short: ${tip.text}`);
    }
  }
});

test("usageTip params stay within the model's declared capabilities", () => {
  for (const [modelId, knowledge] of Object.entries(MODEL_KNOWLEDGE)) {
    const definition = GENERATION_MODEL_CATALOG[modelId];
    assert.ok(definition);
    for (const tip of knowledge.usageTips ?? []) {
      if (!tip.params) continue;
      if (tip.params.aspectRatio) {
        assert.ok(
          definition.aspectRatios.includes(tip.params.aspectRatio),
          `${modelId} tip suggests unsupported aspectRatio ${tip.params.aspectRatio}`,
        );
      }
      if (tip.params.outputResolution) {
        assert.ok(
          definition.resolutions.includes(tip.params.outputResolution),
          `${modelId} tip suggests unsupported resolution ${tip.params.outputResolution}`,
        );
      }
      if (tip.params.durationSeconds != null) {
        assert.ok(
          (definition.durations ?? []).includes(tip.params.durationSeconds),
          `${modelId} tip suggests unsupported duration ${tip.params.durationSeconds}`,
        );
      }
      if (tip.params.generateAudio != null) {
        assert.ok(definition.supportsAudio, `${modelId} tip toggles audio but model has no audio support`);
      }
    }
  }
});

test("modelKnowledge() degrades to null for models without data", () => {
  assert.equal(modelKnowledge("gpt-image-2")?.strengths?.length, 3);
  assert.equal(modelKnowledge("does-not-exist"), null);
});

test("knowledge survives pricing overrides (shallow merge keeps the field)", () => {
  try {
    applyModelPricingOverrides({ "gpt-image-2": { imageCredits: { "1k": 12 } } });
    assert.equal(modelKnowledge("gpt-image-2")?.usageTips?.length, 2);
  } finally {
    applyModelPricingOverrides({});
  }
});

test("knowledge covers the majority of the C-end catalog including head models", () => {
  const supported = [...IMAGE_MODEL_IDS, ...VIDEO_MODEL_IDS];
  const covered = supported.filter((id) => MODEL_KNOWLEDGE[id]);
  assert.ok(
    covered.length >= Math.ceil(supported.length * 0.75),
    `coverage too low: ${covered.length}/${supported.length}`,
  );
  const heads = [
    "gpt-image-2",
    "gemini-2.5-flash-image",
    "gemini-3-image",
    "gemini-3.1-flash-image",
    "flux-2-pro",
    "kling-3.0",
    "veo-3.1",
    "seedance-2.0",
  ];
  for (const id of heads) assert.ok(MODEL_KNOWLEDGE[id], `head model missing knowledge: ${id}`);
});
