import test from "node:test";
import assert from "node:assert/strict";
import { modelAspectRatios } from "./generation-model-catalog.ts";
import { aspectRatioDeviation, aspectRatioValue, nearestAspectRatio } from "./generation-model-catalog/resolution.ts";
import type { AspectRatio } from "./generation-model-catalog.ts";

test("nearestAspectRatio maps a landscape certificate to the closest supported ratio", () => {
  // 用户反馈原案例：A4 横向奖状（√2 ≈ 1.414）→ gpt-image-2 清单里 4:3≈1.333
  // （相对差 ≈0.057）比 3:2=1.5（≈0.061）更接近。
  const supported = modelAspectRatios("gpt-image-2");
  assert.equal(nearestAspectRatio(Math.SQRT2, supported), "4:3" as AspectRatio);
});

test("nearestAspectRatio snaps portraits and exact matches", () => {
  const supported: readonly AspectRatio[] = ["1:1", "4:3", "3:2", "3:4", "2:3", "9:16"];
  assert.equal(nearestAspectRatio(9 / 16, supported), "9:16");
  // 0.7 位于 3:4=0.75 与 2:3≈0.667 之间，到 2:3 差 0.033、到 3:4 差 0.05 → 2:3 更近。
  assert.equal(nearestAspectRatio(0.7, supported), "2:3");
  assert.equal(nearestAspectRatio(1, supported), "1:1");
  // 1.35 位于 4:3≈1.333 与 3:2=1.5 之间，到 4:3 差 0.017 → 4:3 更近。
  assert.equal(nearestAspectRatio(1.35, supported), "4:3");
});

test("nearestAspectRatio falls back to 1:1 on invalid input or empty list", () => {
  const supported: readonly AspectRatio[] = ["16:9", "4:3"];
  assert.equal(nearestAspectRatio(Number.NaN, supported), "16:9"); // 非法目标回清单首档
  assert.equal(nearestAspectRatio(0, supported), "16:9");
  assert.equal(nearestAspectRatio(Number.POSITIVE_INFINITY, supported), "16:9");
  assert.equal(nearestAspectRatio(1.5, []), "1:1");
});

test("aspectRatioValue parses ratio strings and rejects garbage", () => {
  assert.equal(aspectRatioValue("3:2"), 1.5);
  assert.equal(aspectRatioValue("1:1"), 1);
  assert.equal(aspectRatioValue("bad" as AspectRatio), 1);
});

test("aspectRatioDeviation measures relative gap honestly", () => {
  assert.equal(aspectRatioDeviation(1, "1:1"), 0);
  // 目标 1.414 → 3:2=1.5：相对差 |1.5-1.414|/1.414 ≈ 0.0607（<15%，不提示差距）
  assert.ok(aspectRatioDeviation(Math.SQRT2, "3:2") < 0.15);
  // 目标 1:1 → 9:16=0.5625：相对差 0.4375（>15%，UI 必须提示「最接近的支持比例」）
  assert.ok(aspectRatioDeviation(1, "9:16") > 0.15);
  assert.equal(aspectRatioDeviation(Number.NaN, "1:1"), 0);
});
