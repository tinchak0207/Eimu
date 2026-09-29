// 超分檔位的能力宣告通道（P1-4／對稱差 D10）：catalog → 能力投射（`/v1/models` 讀的就是它）。
//
// 驗的是真函式與真資料（catalog 條目、當下有效的 pricing 覆寫層），不是源碼字串。
// 重點是兩條同時成立：「宣告可被查到」與「不外露提交時會被具名拒收的檔位」。

import test from "node:test";
import assert from "node:assert/strict";

import {
  GENERATION_MODEL_IDS,
  declaredUpscaleTiers,
  defaultUpscaleTierFor,
  generationCapabilities,
  modelUpscaleTiers,
  supportsUpscaleTier,
} from "./generation-model-catalog.ts";
import { UPSCALE_TIER_CONTRACTS } from "./generation-core/upscale-tier.ts";
import { PIXAI_UPSCALE_MODEL_ID } from "./image-model-ids.js";

/** env 開關是全域狀態：每個用到 4K 的斷言都自己設／自己清，不靠執行順序。 */
function withFourKUpstream<T>(value: string | undefined, run: () => T): T {
  const before = process.env.UPSCALE_4K_UPSTREAM;
  if (value === undefined) delete process.env.UPSCALE_4K_UPSTREAM;
  else process.env.UPSCALE_4K_UPSTREAM = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.UPSCALE_4K_UPSTREAM;
    else process.env.UPSCALE_4K_UPSTREAM = before;
  }
}

test("catalog 宣告 pixai-upscale 的超分檔位契約（含 4K），非超分模型不宣告", () => {
  assert.deepEqual([...declaredUpscaleTiers(PIXAI_UPSCALE_MODEL_ID)], ["1k", "2k", "4k"]);
  assert.deepEqual([...declaredUpscaleTiers("gpt-image-2")], [], "普通生圖模型不得宣告超分檔位");
  assert.deepEqual([...declaredUpscaleTiers("seedance-2.0")], [], "視頻模型不得宣告超分檔位");
  // 4K 契約的參數化是 (size="2k", factor=4)，不是把 "4k" 塞進 size 送上游。
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].bridgeSize, "2k");
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].factor, 4);
});

test("能力投射只外露**可提交**檔位：4K 未校準前不外露，校準後外露且預設即 4K", () => {
  withFourKUpstream(undefined, () => {
    assert.deepEqual([...(generationCapabilities(PIXAI_UPSCALE_MODEL_ID)?.upscaleTiers ?? [])], ["1k", "2k"]);
    assert.equal(generationCapabilities("gpt-image-2")?.upscaleTiers, undefined, "不輸出空能力宣稱");
    assert.equal(supportsUpscaleTier(PIXAI_UPSCALE_MODEL_ID, "4k"), false);
    assert.equal(supportsUpscaleTier(PIXAI_UPSCALE_MODEL_ID, "2k"), true);
    assert.equal(defaultUpscaleTierFor(PIXAI_UPSCALE_MODEL_ID), "2k");
    assert.equal(defaultUpscaleTierFor("gpt-image-2"), null);
  });
  withFourKUpstream("1", () => {
    assert.deepEqual([...modelUpscaleTiers(PIXAI_UPSCALE_MODEL_ID)], ["1k", "2k", "4k"]);
    assert.deepEqual([...(generationCapabilities(PIXAI_UPSCALE_MODEL_ID)?.upscaleTiers ?? [])], ["1k", "2k", "4k"]);
    assert.equal(supportsUpscaleTier(PIXAI_UPSCALE_MODEL_ID, "4k"), true);
    assert.equal(defaultUpscaleTierFor(PIXAI_UPSCALE_MODEL_ID), "4k");
  });
});

test("能力投射是非超分模型的原樣：新增欄位不動既有模型的能力面（無回歸）", () => {
  const caps = generationCapabilities("gpt-image-2");
  assert.equal(caps?.mediaType, "image");
  assert.deepEqual(caps?.resolutions, ["1k", "2k", "4k"]);
  assert.equal("upscaleTiers" in (caps ?? {}), false, "未宣告超分的模型不得出現該欄位");
  const video = generationCapabilities("seedance-2.5-720p");
  assert.deepEqual([...video?.videoGenerationTypes ?? []], ["generate", "extend_video", "edit_video"]);
  assert.equal("upscaleTiers" in (video ?? {}), false);
});

test("已知缺口（用真資料釘住）：upscale 是服務定價條目，不在 /v1/models 的模型清單來源內", () => {
  // `/v1/models`（src/app/api/v1/models/route.ts:67）與 `/v1/object_info` 都只列
  // SUPPORTED_GENERATION_MODEL_IDS；pixai-upscale 依 image-model-ids.js:22-28 的慣例是
  // 「服務類定價條目」，不入 SUPPORTED_* ⇒ 今日沒有任何 B 端端點外露超分檔位。
  // 本斷言把缺口釘成事實：若哪天它進了清單（＝缺口被補），這裡會紅，逼人改成驗 payload。
  assert.equal(GENERATION_MODEL_IDS.includes(PIXAI_UPSCALE_MODEL_ID), false);
  // 缺口之外，能力面本身是可查的（這條才是本刀交付的能力宣告）：
  assert.ok(generationCapabilities(PIXAI_UPSCALE_MODEL_ID)?.upscaleTiers?.length);
});