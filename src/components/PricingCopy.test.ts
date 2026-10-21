import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pricingSource = readFileSync(new URL("./PricingClient.tsx", import.meta.url), "utf8");
// 2026-09-07 carousel 化：方案卡面（含换算口径文案）迁入 PricingPlanCarousel。
// <1000 行重构：卡面/收银台迁入 PricingPlanCarousel/ 子模组，barrel 只剩装配。
const carouselSource = [
  "./PricingPlanCarousel.tsx",
  "./PricingPlanCarousel/card-faces.tsx",
  "./PricingPlanCarousel/geometry.ts",
  "./PricingPlanCarousel/plan-placeholder.ts",
  "./PricingPlanCarousel/slider-math.ts",
  "./PricingPlanCarousel/types.ts",
]
  .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"))
  .join("\n");
const plansSource = readFileSync(new URL("../lib/plans.ts", import.meta.url), "utf8");
const mapaySource = readFileSync(new URL("../lib/mapay.ts", import.meta.url), "utf8");
const copy = [pricingSource, carouselSource, plansSource, mapaySource].join("\n");

test("pricing surfaces use coins plus GPT Image 2 equivalents instead of legacy image-count wording", () => {
  for (const legacy of [
    /张图片额度/,
    /点额度/,
    /到账[^\n]*张/,
    /\{plan\.coins\}\s*张/,
    /普通生成\s*1\s*币/,
    // 2026-08-25：不再整体封禁 nano-banana-pro——plans.ts 现以 catalog 计价
    // 元数据引用该模型做旗舰档换算（合法）。「无限畅画」等旧话术仍封禁。
    /无限畅画/,
    /500000\s*=\s*1\s*张/,
  ]) {
    assert.doesNotMatch(copy, legacy);
  }

  // 2026-08-25：换算口径升级为「约 N 张 1024px 标准图 · GPT Image 2（1K）」
  // （N 用 span 强调），仍同时包含张数换算与基准模型名。2026-09-07 起卡面在 carousel。
  assert.match(carouselSource, /约 <span className="font-semibold">\{referenceImages\}<\/span> 张 1024px 标准图 · \{PLAN_REFERENCE_MODEL_LABEL\}/);
  assert.match(pricingSource, /视频怎么扣金币/);
  assert.match(mapaySource, /\$\{plan\.coins\}金币/);
});
