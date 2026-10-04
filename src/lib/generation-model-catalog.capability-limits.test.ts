// 能力契约的「数量上限」通道（对称差 D23／P1-7）：`/v1/models` 的 `x_capabilities`
// 逐模型揭露**批次数**与**参考图上限**，补上对手 `ListModelCapabilities` 有、我方缺的两格。
//
// 验的是真函式与真常数（不是源码字串）：能力投射读到的数字必须**就是执行端挡人的那颗**，
// 而执行端的闸门必须真的在挡（后者在 route.test.ts 用真请求验，本档验同源）。

import test from "node:test";
import assert from "node:assert/strict";

import { generationCapabilities } from "./generation-model-catalog.ts";
import { MAX_REQUEST_BATCH_COUNT, MAX_REQUEST_REFERENCE_IMAGES } from "./generation-core/request-limits.ts";
// 执行端常数（真的挡人的那一端）：能力值与它们同值才叫「揭露＝行为」。
import { MAX_BATCH_ITEM_N } from "./generation-core/batch-service.ts";
import { MAX_REFERENCE_IMAGES } from "./biz-image-references.ts";

const IMAGE_MODEL = "gpt-image-2";
const VIDEO_MODEL = "seedance-2.0";
/** catalog 明文 `referenceImages: false`：不收参考图的模型。 */
const NO_REFERENCE_MODEL = "adobe-firefly";

test("单点常数没有第二份：B 端参考图闸门与批量闸门都只是引用点", () => {
  assert.equal(MAX_REFERENCE_IMAGES, MAX_REQUEST_REFERENCE_IMAGES);
  assert.equal(MAX_BATCH_ITEM_N, MAX_REQUEST_BATCH_COUNT);
});

test("每个模型都揭露批次数，且值＝执行端常数（图／视频同尺）", () => {
  for (const modelId of [IMAGE_MODEL, VIDEO_MODEL]) {
    const caps = generationCapabilities(modelId);
    assert.ok(caps, `${modelId} 必须有能力投影`);
    assert.equal(caps.maxBatchCount, MAX_REQUEST_BATCH_COUNT, `${modelId}.maxBatchCount 必须等于执行端 n 上限`);
  }
});

test("参考图上限只在模型真的收参考图时外露（不收 ⇒ 省略，不输出空能力宣称）", () => {
  const withRefs = generationCapabilities(IMAGE_MODEL);
  assert.equal(withRefs?.referenceImages, true);
  assert.equal(withRefs?.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES);

  const videoWithRefs = generationCapabilities(VIDEO_MODEL);
  assert.equal(videoWithRefs?.referenceImages, true);
  assert.equal(videoWithRefs?.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES);

  const without = generationCapabilities(NO_REFERENCE_MODEL);
  assert.equal(without?.referenceImages, false);
  assert.equal("maxReferenceImages" in (without ?? {}), false, "不收参考图的模型不得宣告参考上限");
  // 批次数仍必须在（它与参考图无关，每个模型都有）。
  assert.equal(without?.maxBatchCount, MAX_REQUEST_BATCH_COUNT);
});

test("全集扫描：对外目录的每个模型都有批次数，且全等同一颗常数（无硬写分歧）", async () => {
  const { GENERATION_MODEL_IDS } = await import("./generation-model-catalog.ts");
  assert.ok(GENERATION_MODEL_IDS.length > 0);
  for (const modelId of GENERATION_MODEL_IDS) {
    const caps = generationCapabilities(modelId);
    assert.ok(caps, `${modelId} 在对外目录内却没有能力投影`);
    assert.equal(caps.maxBatchCount, MAX_REQUEST_BATCH_COUNT, `${modelId} 的批次数与执行端常数不一致`);
    if (caps.referenceImages) {
      assert.equal(caps.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES, `${modelId} 有参考图能力却无上限值`);
    } else {
      assert.equal("maxReferenceImages" in caps, false, `${modelId} 不收参考图却宣告了上限`);
    }
  }
});