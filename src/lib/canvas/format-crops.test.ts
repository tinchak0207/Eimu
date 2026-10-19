// 一稿多版位几何层测试：**真几何断言**（给定源尺寸 → 逐版位比对裁切框/扩图边/损失比），
// 不是源码字串断言。
//
// 执行器双轨：本仓测试主体是 node:test（`npm test` = `tsx --test`），但本档也必须能
// 被 `npx vitest run src/lib/canvas/format-crops.test.ts` 直接跑（vitest.config.mts 开
// globals）。故 test 取 `globalThis.test`（vitest 注入）优先、fallback `node:test` 的
// test；断言一律 `node:assert/strict`，不引入第二套断言库。
// 注意：不能用 top-level await 取执行器——tsx 会把 .ts 转 CJS，top-level await 直接编译失败。

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import sharp from "sharp";
import { AD_SIZE_OPTIONS, ratioOfSizeId } from "../ad-formats";
import { MAX_CROP_LOSS, planFormatCrops, summarizeFormatCrops, type FormatCropPlan } from "./format-crops";
import { cropImage, readSourceImageInfo } from "./format-crops-exec";

type TestFn = (name: string, fn: () => void | Promise<void>) => unknown;
const test = (globalThis as unknown as { test?: TestFn }).test ?? (nodeTest.test as unknown as TestFn);

const SQUARE = { width: 1024, height: 1024 };

/** 版位 id 的像素比例（用 ad-formats 的 ratioOfSizeId 为唯一口径）。 */
function targetRatio(plan: FormatCropPlan): number {
  const [width, height] = plan.ratio.split(":").map(Number);
  assert.ok(Number.isFinite(width) && Number.isFinite(height), `比例无法解析：${plan.ratio}`);
  return width / height;
}

/** 成图比例误差（px）：|宽 − 高×目标比例|。≤1px 视为对齐。 */
function ratioErrorPx(plan: FormatCropPlan): number {
  const ratio = targetRatio(plan);
  const dims =
    plan.mode === "crop" && plan.cropRect
      ? { width: plan.cropRect.width, height: plan.cropRect.height }
      : { width: plan.outputWidth, height: plan.outputHeight };
  return Math.abs(dims.width - dims.height * ratio);
}

function byId(plans: FormatCropPlan[], id: string): FormatCropPlan {
  const plan = plans.find((p) => p.id === id);
  assert.ok(plan, `缺版位 ${id}`);
  return plan;
}

test("1024×1024 源 × 13 版位：逐版位有 plan、无 rejected、成图比例误差 ≤1px", () => {
  const plans = planFormatCrops(SQUARE.width, SQUARE.height);
  assert.equal(plans.length, 13);
  assert.deepEqual(
    plans.map((p) => p.id),
    AD_SIZE_OPTIONS.map((o) => o.id),
  );
  for (const plan of plans) {
    assert.notEqual(plan.mode, "rejected", `${plan.id} 不应被拒绝`);
    assert.equal(plan.ratio, ratioOfSizeId(plan.id), `${plan.id} 比例口径应同 ratioOfSizeId`);
    assert.ok(ratioErrorPx(plan) <= 1, `${plan.id} 比例误差 ${ratioErrorPx(plan)}px > 1px`);
  }
});

test("crop 版位：置中、像素对齐、不越界、lossRatio 等于实际裁掉面积比", () => {
  const plans = planFormatCrops(SQUARE.width, SQUARE.height);
  const crops = plans.filter((p) => p.mode === "crop");
  assert.ok(crops.length > 0, "1024×1024 源至少要有可内接裁切的版位");
  for (const plan of crops) {
    const rect = plan.cropRect;
    assert.ok(rect, `${plan.id} crop 必须有 cropRect`);
    assert.deepEqual(plan.outpaintEdges, null, `${plan.id} crop 不应有 outpaintEdges`);
    assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y), `${plan.id} 座标必须整数`);
    assert.ok(Number.isInteger(rect.width) && Number.isInteger(rect.height), `${plan.id} 尺寸必须整数`);
    assert.ok(rect.x >= 0 && rect.y >= 0, `${plan.id} 不可负座标`);
    assert.ok(rect.x + rect.width <= SQUARE.width, `${plan.id} 右边越界`);
    assert.ok(rect.y + rect.height <= SQUARE.height, `${plan.id} 下边越界`);
    const leftMargin = rect.x;
    const rightMargin = SQUARE.width - (rect.x + rect.width);
    const topMargin = rect.y;
    const bottomMargin = SQUARE.height - (rect.y + rect.height);
    assert.ok(Math.abs(leftMargin - rightMargin) <= 1, `${plan.id} 未水平置中`);
    assert.ok(Math.abs(topMargin - bottomMargin) <= 1, `${plan.id} 未垂直置中`);
    // 独立重算损失比（不信任实作回传值）。
    const expected = 1 - (rect.width * rect.height) / (SQUARE.width * SQUARE.height);
    assert.ok(Math.abs(plan.lossRatio - expected) < 1e-6, `${plan.id} lossRatio ${plan.lossRatio} ≠ ${expected}`);
    assert.ok(plan.lossRatio <= MAX_CROP_LOSS + 1e-9, `${plan.id} crop 损失超过阈值`);
    assert.equal(plan.outputWidth, rect.width);
    assert.equal(plan.outputHeight, rect.height);
  }
});

test("1:1 版位：整张原图、零损失", () => {
  const plan = byId(planFormatCrops(SQUARE.width, SQUARE.height), "1024x1024");
  assert.equal(plan.mode, "crop");
  assert.deepEqual(plan.cropRect, { x: 0, y: 0, width: 1024, height: 1024 });
  assert.equal(plan.lossRatio, 0);
});

test("9:16 版位（1024x1792）从 1:1 源：必须 outpaint 或 crop，且 lossRatio 正确", () => {
  const plan = byId(planFormatCrops(SQUARE.width, SQUARE.height), "1024x1792");
  assert.ok(plan.mode === "outpaint" || plan.mode === "crop", `9:16 不得为 ${plan.mode}`);
  if (plan.mode === "crop") {
    assert.ok(plan.cropRect);
    const expected = 1 - (plan.cropRect.width * plan.cropRect.height) / (SQUARE.width * SQUARE.height);
    assert.ok(Math.abs(plan.lossRatio - expected) < 1e-6);
  } else {
    // 扩图不裁任何面积。
    assert.equal(plan.lossRatio, 0);
    assert.equal(plan.cropRect, null);
    assert.ok(plan.outpaintEdges);
    // 1:1 源要出 4:7 只能往上下补（左右不动），输出宽度＝源宽。
    assert.equal(plan.outpaintEdges.left, 0);
    assert.equal(plan.outpaintEdges.right, 0);
    assert.equal(plan.outpaintEdges.top, 384);
    assert.equal(plan.outpaintEdges.bottom, 384);
    assert.equal(plan.outputWidth, 1024);
    assert.equal(plan.outputHeight, 1792);
    assert.ok(ratioErrorPx(plan) <= 1);
  }
});

test("outpaint 版位：源图整张保留、只补一维、边界像素自洽", () => {
  const plans = planFormatCrops(SQUARE.width, SQUARE.height);
  const outpaints = plans.filter((p) => p.mode === "outpaint");
  assert.ok(outpaints.length > 0, "1024×1024 源应有需扩图的极端版位");
  for (const plan of outpaints) {
    const edges = plan.outpaintEdges;
    assert.ok(edges, `${plan.id} outpaint 必须有 outpaintEdges`);
    assert.equal(plan.cropRect, null);
    const horizontal = edges.left > 0 || edges.right > 0;
    const vertical = edges.top > 0 || edges.bottom > 0;
    assert.ok(horizontal !== vertical, `${plan.id} 只应补一维（实得 h=${horizontal} v=${vertical}）`);
    // 补边对称（奇数时右/下多 1px）。
    assert.ok(Math.abs(edges.left - edges.right) <= 1, `${plan.id} 左右补边不对称`);
    assert.ok(Math.abs(edges.top - edges.bottom) <= 1, `${plan.id} 上下补边不对称`);
    assert.equal(plan.outputWidth, SQUARE.width + edges.left + edges.right);
    assert.equal(plan.outputHeight, SQUARE.height + edges.top + edges.bottom);
    assert.ok(plan.outputWidth >= SQUARE.width && plan.outputHeight >= SQUARE.height, `${plan.id} 扩图不应缩小原图`);
    assert.ok(ratioErrorPx(plan) <= 1, `${plan.id} 扩图后比例误差 ${ratioErrorPx(plan)}px > 1px`);
  }
});

test("21:9 / 4:1 / 9:21 从 1:1 源：判定为 outpaint（裁切损失超阈值）", () => {
  const plans = planFormatCrops(SQUARE.width, SQUARE.height);
  for (const id of ["1792x768", "2048x512", "768x1792"]) {
    const plan = byId(plans, id);
    assert.equal(plan.mode, "outpaint", `${id} 应走扩图`);
    assert.equal(plan.lossRatio, 0);
    assert.ok(ratioErrorPx(plan) <= 1);
  }
  // 对照：这三个版位若硬裁，损失都远超阈值。
  for (const cropLoss of [1 - 439 / 1024, 1 - 256 / 1024, 1 - 439 / 1024]) {
    assert.ok(cropLoss > MAX_CROP_LOSS);
  }
});

test("极端比例：1:4 从 16:9 源（1792×1024）不丢例外，输出边界自洽", () => {
  const long = AD_SIZE_OPTIONS.find((o) => o.id === "512x2048");
  assert.ok(long);
  const plans = planFormatCrops(1792, 1024, [long]);
  assert.equal(plans.length, 1);
  const plan = plans[0];
  assert.equal(plan.mode, "outpaint");
  assert.equal(plan.outputWidth, 1792);
  assert.equal(plan.outputHeight, 7168);
  assert.deepEqual(plan.outpaintEdges, { top: 3072, right: 0, bottom: 3072, left: 0 });
  assert.ok(ratioErrorPx(plan) <= 1);
  // 1:1 源下同一版位同样合法（不因源图形状而丢例外）。
  const squarePlan = byId(planFormatCrops(SQUARE.width, SQUARE.height), "512x2048");
  assert.equal(squarePlan.mode, "outpaint");
  assert.deepEqual(squarePlan.outpaintEdges, { top: 1536, right: 0, bottom: 1536, left: 0 });
});

test("源图尺寸未知：逐版位明确拒绝、不丢例外", () => {
  const badSources: [number, number][] = [
    [0, 0],
    [Number.NaN, 100],
    [-5, 100],
    [Number.POSITIVE_INFINITY, 100],
  ];
  for (const [width, height] of badSources) {
    const plans = planFormatCrops(width, height);
    assert.equal(plans.length, 13, `源图 ${width}×${height} 应仍逐版位回报`);
    for (const plan of plans) {
      assert.equal(plan.mode, "rejected");
      assert.equal(plan.reason, "unknown_source_size");
      assert.equal(plan.cropRect, null);
      assert.equal(plan.outpaintEdges, null);
      assert.equal(plan.outputWidth, 0);
    }
  }
  const summary = summarizeFormatCrops(0, 0);
  assert.equal(summary.sourceRatio, "");
  assert.equal(summary.rejectedCount, 13);
});

test("目标清单空 / 非阵列：明确输出空阵列", () => {
  assert.deepEqual(planFormatCrops(SQUARE.width, SQUARE.height, []), []);
  assert.deepEqual(planFormatCrops(SQUARE.width, SQUARE.height, "not-an-array" as unknown as typeof AD_SIZE_OPTIONS), []);
  // 不传 targets = 全部 13 版位（预设值）。
  assert.equal(planFormatCrops(SQUARE.width, SQUARE.height).length, 13);
});

test("版位 id 解析不出宽高：明确拒绝，不丢例外", () => {
  const weird = [
    { id: "auto", label: "自动", usage: "" },
    { id: "1024px", label: "坏 id", usage: "" },
    { id: "0x1024", label: "零宽", usage: "" },
  ];
  const plans = planFormatCrops(SQUARE.width, SQUARE.height, weird);
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.equal(plan.mode, "rejected");
    assert.equal(plan.reason, "unparsable_size_id");
    assert.equal(plan.cropRect, null);
    assert.equal(plan.outpaintEdges, null);
  }
});

test("摘要计数与 plan 一致（crop + outpaint + rejected = 版位数）", () => {
  const summary = summarizeFormatCrops(SQUARE.width, SQUARE.height);
  const plans = planFormatCrops(SQUARE.width, SQUARE.height);
  assert.equal(summary.plans.length, 13);
  assert.equal(summary.cropCount + summary.outpaintCount + summary.rejectedCount, 13);
  assert.equal(summary.cropCount, plans.filter((p) => p.mode === "crop").length);
  assert.equal(summary.sourceRatio, "1:1");
  assert.equal(summary.sourceWidth, 1024);
  assert.equal(summary.sourceHeight, 1024);
});

test("执行层（sharp）：真裁一张 PNG，断言输出像素尺寸", async () => {
  const source = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
  const info = await readSourceImageInfo(source);
  assert.deepEqual({ width: info.width, height: info.height }, { width: 100, height: 100 });
  assert.equal(info.autoOriented, false);

  const cropped = await cropImage(source, { x: 10, y: 20, width: 60, height: 40 }, { format: "png" });
  const croppedInfo = await readSourceImageInfo(cropped);
  assert.equal(croppedInfo.width, 60);
  assert.equal(croppedInfo.height, 40);

  // 越界框由 clampCropRect（既有轮子）收敛：框宽放得下就平移进图内（x 80→40、y 80→60），
  // 尺寸不变；框比原图大才缩到原图尺寸。
  const shifted = await cropImage(source, { x: 80, y: 80, width: 60, height: 40 }, { format: "png" });
  const shiftedInfo = await readSourceImageInfo(shifted);
  assert.deepEqual({ width: shiftedInfo.width, height: shiftedInfo.height }, { width: 60, height: 40 });

  const oversized = await cropImage(source, { x: 0, y: 0, width: 200, height: 200 }, { format: "png" });
  const oversizedInfo = await readSourceImageInfo(oversized);
  assert.deepEqual({ width: oversizedInfo.width, height: oversizedInfo.height }, { width: 100, height: 100 });
});

test("执行层（sharp）：EXIF 旋转 6 的源图回报自动旋转后尺寸", async () => {
  const rotated = await sharp({
    create: { width: 40, height: 100, channels: 3, background: { r: 30, g: 30, b: 200 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const info = await readSourceImageInfo(rotated);
  assert.equal(info.autoOriented, true);
  assert.deepEqual({ width: info.width, height: info.height }, { width: 100, height: 40 });
});
