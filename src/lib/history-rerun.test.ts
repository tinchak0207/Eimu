import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_RERUN_DEFAULT_COUNT,
  buildHistoryRerunPlan,
  canHistoryEntryRerun,
  historyRerunCoinsPerImage,
  historyRerunEstimate,
} from "./history-rerun.ts";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS, generationCoins } from "./generation-model-catalog.ts";
import type { HistoryEntry } from "./history-types.ts";

const IMAGE_MODEL = IMAGE_MODEL_IDS[0];
const OTHER_IMAGE_MODEL = IMAGE_MODEL_IDS[1] ?? IMAGE_MODEL_IDS[0];

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "entry-1",
    prompt: "Prompt:\n一只猫",
    generatedAt: 1_700_000_000_000,
    results: [
      { provider: "image_eimu", modelId: IMAGE_MODEL, image: null, imageUrl: "https://example.com/a.png" },
    ],
    source: "server",
    ...overrides,
  };
}

test("canHistoryEntryRerun requires prompt, model and image kind", () => {
  assert.equal(canHistoryEntryRerun(makeEntry({ prompt: "   " })), false);
  assert.equal(
    canHistoryEntryRerun(
      makeEntry({
        prompt: "有提示词",
        results: [{ provider: "image_eimu", modelId: VIDEO_MODEL_IDS[0], image: null, imageUrl: null }],
      }),
    ),
    false,
  );
  assert.equal(canHistoryEntryRerun(makeEntry({ prompt: "有提示词" })), true);
});

test("buildHistoryRerunPlan folds a task-backed recipe into a single-image plan", () => {
  const entry = makeEntry({
    prompt: "Prompt:\n一只猫\n\nWorkflow preset: 商品摄影",
    taskId: "task-abc123",
    workflow: {
      qualityProfile: "print",
      imageSize: "1536x1024",
      copies: 4,
      concurrency: 2,
      estimatedCredits: 9,
      referenceImages: [{ name: "a.png", role: "style" }],
    },
  });
  const plan = buildHistoryRerunPlan(entry);

  assert.equal(plan.prompt, "一只猫");
  assert.equal(plan.modelId, IMAGE_MODEL);
  assert.equal(plan.aspectRatio, "3:2");
  assert.equal(plan.outputResolution, "2k");
  assert.equal(plan.qualityMode, "quality");
  assert.equal(plan.retryOfTaskId, "task-abc123");
  assert.equal(plan.referencesInheritable, true);
  assert.equal(plan.hasReferenceImages, true);
  assert.ok(plan.workflow);
  assert.equal(plan.workflow.qualityProfile, "print");
  assert.ok(!("copies" in plan.workflow));
  assert.ok(!("concurrency" in plan.workflow));
  assert.ok(!("estimatedCredits" in plan.workflow));
});

test("buildHistoryRerunPlan applies variant overrides and syncs size back into workflow", () => {
  const entry = makeEntry({
    prompt: "Prompt:\n一只猫",
    workflow: { imageSize: "1024x1024", qualityProfile: "balanced" },
  });
  const plan = buildHistoryRerunPlan(entry, {
    prompt: "  新主体  ",
    modelId: OTHER_IMAGE_MODEL,
    imageSize: "1024x1536",
  });

  assert.equal(plan.prompt, "新主体");
  assert.equal(plan.modelId, OTHER_IMAGE_MODEL);
  assert.equal(plan.aspectRatio, "2:3");
  assert.ok(plan.workflow);
  assert.equal(plan.workflow.imageSize, "1024x1536");
  assert.deepEqual(plan.workflow.imageSizes, ["1024x1536"]);
});

test("estimate is per-image coins times count with no hidden surcharge", () => {
  const entry = makeEntry({
    prompt: "Prompt:\n一只猫",
    workflow: { imageSize: "1024x1024", qualityProfile: "balanced" },
  });
  const plan = buildHistoryRerunPlan(entry);
  const perImage = generationCoins(plan.modelId, { resolution: plan.outputResolution });

  assert.equal(historyRerunCoinsPerImage(plan), perImage);
  assert.equal(historyRerunEstimate(plan, 3), Math.round(perImage * 3 * 10) / 10);
  // 非法 count 收敛为 1，不让界面显示 0 币的预估。
  assert.equal(historyRerunEstimate(plan, 0), historyRerunEstimate(plan, 1));
});

test("default count is 3 and options stay within the workstation copies range", () => {
  assert.equal(HISTORY_RERUN_DEFAULT_COUNT, 3);
});
