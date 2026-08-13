import test from "node:test";
import assert from "node:assert/strict";
import { STYLE_PRESETS } from "./prompt-enhancer.ts";

test("style preset labels are simplified Chinese", () => {
  assert.deepEqual(STYLE_PRESETS.map((item) => item.label), [
    "真实摄影",
    "动漫美学",
    "潮流街拍",
    "产品视觉",
    "品牌海报",
    "水彩艺术",
  ]);
});
