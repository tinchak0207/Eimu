// 能力契約的「數量上限」通道（對稱差 D23／P1-7）：`/v1/models` 的 `x_capabilities`
// 逐模型揭露**批次數**與**參考圖上限**，補上對手 `ListModelCapabilities` 有、我方缺的兩格。
//
// 驗的是真函式與真常數（不是源碼字串）：能力投射讀到的數字必須**就是執行端擋人的那顆**，
// 而執行端的閘門必須真的在擋（後者在 route.test.ts 用真請求驗，本檔驗同源）。

import test from "node:test";
import assert from "node:assert/strict";

import { generationCapabilities } from "./generation-model-catalog.ts";
import { MAX_REQUEST_BATCH_COUNT, MAX_REQUEST_REFERENCE_IMAGES } from "./generation-core/request-limits.ts";
// 執行端常數（真的擋人的那一端）：能力值與它們同值才叫「揭露＝行為」。
import { MAX_BATCH_ITEM_N } from "./generation-core/batch-service.ts";
import { MAX_REFERENCE_IMAGES } from "./biz-image-references.ts";

const IMAGE_MODEL = "gpt-image-2";
const VIDEO_MODEL = "seedance-2.0";
/** catalog 明文 `referenceImages: false`：不收參考圖的模型。 */
const NO_REFERENCE_MODEL = "adobe-firefly";

test("單點常數沒有第二份：B 端參考圖閘門與批量閘門都只是引用點", () => {
  assert.equal(MAX_REFERENCE_IMAGES, MAX_REQUEST_REFERENCE_IMAGES);
  assert.equal(MAX_BATCH_ITEM_N, MAX_REQUEST_BATCH_COUNT);
});

test("每個模型都揭露批次數，且值＝執行端常數（圖／視頻同尺）", () => {
  for (const modelId of [IMAGE_MODEL, VIDEO_MODEL]) {
    const caps = generationCapabilities(modelId);
    assert.ok(caps, `${modelId} 必須有能力投影`);
    assert.equal(caps.maxBatchCount, MAX_REQUEST_BATCH_COUNT, `${modelId}.maxBatchCount 必須等於執行端 n 上限`);
  }
});

test("參考圖上限只在模型真的收參考圖時外露（不收 ⇒ 省略，不輸出空能力宣稱）", () => {
  const withRefs = generationCapabilities(IMAGE_MODEL);
  assert.equal(withRefs?.referenceImages, true);
  assert.equal(withRefs?.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES);

  const videoWithRefs = generationCapabilities(VIDEO_MODEL);
  assert.equal(videoWithRefs?.referenceImages, true);
  assert.equal(videoWithRefs?.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES);

  const without = generationCapabilities(NO_REFERENCE_MODEL);
  assert.equal(without?.referenceImages, false);
  assert.equal("maxReferenceImages" in (without ?? {}), false, "不收參考圖的模型不得宣告參考上限");
  // 批次數仍必須在（它與參考圖無關，每個模型都有）。
  assert.equal(without?.maxBatchCount, MAX_REQUEST_BATCH_COUNT);
});

test("全集掃描：對外目錄的每個模型都有批次數，且全等同一顆常數（無硬寫分歧）", async () => {
  const { GENERATION_MODEL_IDS } = await import("./generation-model-catalog.ts");
  assert.ok(GENERATION_MODEL_IDS.length > 0);
  for (const modelId of GENERATION_MODEL_IDS) {
    const caps = generationCapabilities(modelId);
    assert.ok(caps, `${modelId} 在對外目錄內卻沒有能力投影`);
    assert.equal(caps.maxBatchCount, MAX_REQUEST_BATCH_COUNT, `${modelId} 的批次數與執行端常數不一致`);
    if (caps.referenceImages) {
      assert.equal(caps.maxReferenceImages, MAX_REQUEST_REFERENCE_IMAGES, `${modelId} 有參考圖能力卻無上限值`);
    } else {
      assert.equal("maxReferenceImages" in caps, false, `${modelId} 不收參考圖卻宣告了上限`);
    }
  }
});