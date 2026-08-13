import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pricingSource = readFileSync(new URL("./PricingClient.tsx", import.meta.url), "utf8");
const plansSource = readFileSync(new URL("../lib/plans.ts", import.meta.url), "utf8");
const mapaySource = readFileSync(new URL("../lib/mapay.ts", import.meta.url), "utf8");
const copy = [pricingSource, plansSource, mapaySource].join("\n");

test("pricing surfaces use coins plus GPT Image 2 equivalents instead of legacy image-count wording", () => {
  for (const legacy of [
    /张图片额度/,
    /点额度/,
    /到账[^\n]*张/,
    /\{plan\.coins\}\s*张/,
    /普通生成\s*1\s*币/,
    /nano-banana-pro/,
    /无限畅画/,
    /500000\s*=\s*1\s*张/,
  ]) {
    assert.doesNotMatch(copy, legacy);
  }

  assert.match(pricingSource, /约 \{referenceImages\} 张 \{PLAN_REFERENCE_MODEL_LABEL\}/);
  assert.match(pricingSource, /视频怎么扣金币/);
  assert.match(mapaySource, /\$\{plan\.coins\}金币/);
});
