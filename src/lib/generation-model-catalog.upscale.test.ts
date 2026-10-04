// 超分档位的能力宣告通道（P1-4／对称差 D10）：catalog → 能力投射（`/v1/models` 读的就是它）。
//
// 验的是真函式与真资料（catalog 条目、当下有效的 pricing 覆写层），不是源码字串。
// 重点是两条同时成立：「宣告可被查到」与「不外露提交时会被具名拒收的档位」。

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

/** env 开关是全域状态：每个用到 4K 的断言都自己设／自己清，不靠执行顺序。 */
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

test("catalog 宣告 pixai-upscale 的超分档位契约（含 4K），非超分模型不宣告", () => {
  assert.deepEqual([...declaredUpscaleTiers(PIXAI_UPSCALE_MODEL_ID)], ["1k", "2k", "4k"]);
  assert.deepEqual([...declaredUpscaleTiers("gpt-image-2")], [], "普通生图模型不得宣告超分档位");
  assert.deepEqual([...declaredUpscaleTiers("seedance-2.0")], [], "视频模型不得宣告超分档位");
  // 4K 契约的参数化是 (size="2k", factor=4)，不是把 "4k" 塞进 size 送上游。
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].bridgeSize, "2k");
  assert.equal(UPSCALE_TIER_CONTRACTS["4k"].factor, 4);
});

test("能力投射只外露**可提交**档位：4K 未校准前不外露，校准后外露且预设即 4K", () => {
  withFourKUpstream(undefined, () => {
    assert.deepEqual([...(generationCapabilities(PIXAI_UPSCALE_MODEL_ID)?.upscaleTiers ?? [])], ["1k", "2k"]);
    assert.equal(generationCapabilities("gpt-image-2")?.upscaleTiers, undefined, "不输出空能力宣称");
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

test("能力投射是非超分模型的原样：新增栏位不动既有模型的能力面（无回归）", () => {
  const caps = generationCapabilities("gpt-image-2");
  assert.equal(caps?.mediaType, "image");
  assert.deepEqual(caps?.resolutions, ["1k", "2k", "4k"]);
  assert.equal("upscaleTiers" in (caps ?? {}), false, "未宣告超分的模型不得出现该栏位");
  const video = generationCapabilities("seedance-2.5-720p");
  assert.deepEqual([...video?.videoGenerationTypes ?? []], ["generate", "extend_video", "edit_video"]);
  assert.equal("upscaleTiers" in (video ?? {}), false);
});

test("已知缺口（用真资料钉住）：upscale 是服务定价条目，不在 /v1/models 的模型清单来源内", () => {
  // `/v1/models`（src/app/api/v1/models/route.ts:67）与 `/v1/object_info` 都只列
  // SUPPORTED_GENERATION_MODEL_IDS；pixai-upscale 依 image-model-ids.js:22-28 的惯例是
  // 「服务类定价条目」，不入 SUPPORTED_* ⇒ 今日没有任何 B 端端点外露超分档位。
  // 本断言把缺口钉成事实：若哪天它进了清单（＝缺口被补），这里会红，逼人改成验 payload。
  assert.equal(GENERATION_MODEL_IDS.includes(PIXAI_UPSCALE_MODEL_ID), false);
  // 缺口之外，能力面本身是可查的（这条才是本刀交付的能力宣告）：
  assert.ok(generationCapabilities(PIXAI_UPSCALE_MODEL_ID)?.upscaleTiers?.length);
});