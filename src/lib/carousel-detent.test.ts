import assert from "node:assert/strict";
import test from "node:test";

import { commitSteps, detent, undetent, DETENT_TUNING } from "./carousel-detent";

const STEP = 60; // 6 张卡的环，每格 60°

test("detent is identity on the卡位 and never pushes past the midpoint", () => {
  for (const n of [-2, -1, 0, 1, 2, 6]) {
    assert.equal(detent(n * STEP, STEP), n * STEP);
  }
  // 正好拖过一张卡宽 → 正好落一张卡。若这条不成立，手指与画面会累积漂移。
  assert.equal(detent(STEP, STEP), STEP);

  // 形变只在格内重分配，绝不越过中点跑到隔壁格去。
  for (const cell of [0.1, 0.25, 0.4, 0.49, -0.15, -0.45]) {
    const warped = detent(cell * STEP, STEP) / STEP;
    assert.ok(Math.abs(warped) <= 0.5 + 1e-9, `${cell} → ${warped} 越过中点`);
    assert.equal(Math.sign(warped), Math.sign(cell), "形变不该改变方向");
  }
});

test("detent pulls small offsets back toward the卡位 —— 这就是磁力本身", () => {
  // 输入走了 20% 一格，画面上只呈现更少 —— 环黏在卡位上。
  const warped = detent(0.2 * STEP, STEP) / STEP;
  assert.ok(warped < 0.2, `期望被往卡位拧回去，实际 ${warped}`);
  assert.ok(warped > 0.05, `拧得太狠会变成拖不动，实际 ${warped}`);

  // 越靠近格间中点，形变越弱 —— 所以「格间快速掠过」而不是整段都发黏。
  const near = 0.1 * STEP;
  const far = 0.45 * STEP;
  const pullNear = near - detent(near, STEP);
  const pullFar = far - detent(far, STEP);
  assert.ok(pullNear / near > pullFar / far, "磁力应随离卡位距离衰减");
});

test("undetent inverts detent so a drag can take over a flying spring cleanly", () => {
  for (const raw of [0, 7, -13, 22, -29, 59, 61, -121]) {
    const round = undetent(detent(raw, STEP), STEP);
    assert.ok(Math.abs(round - raw) < 1e-6, `${raw} → ${round}`);
  }
});

test("a gesture that moved at all always commits —— 绝不「滑了半张又弹回原位」", () => {
  // 用户抱怨的第一种症状：滑了 0.5 张，松手回到原点，等于白滑。
  assert.equal(commitSteps(0.5, 0), 1);
  assert.equal(commitSteps(-0.5, 0), -1);
  // 刚过门槛就该进一格。
  assert.equal(commitSteps(0.2, 0), 1);
  assert.equal(commitSteps(-0.2, 0), -1);
  // 真正的手抖/误触才留在原地。
  assert.equal(commitSteps(0.05, 0), 0);
  assert.equal(commitSteps(0, 0), 0);
});

test("flick can carry you into the next卡位 but never past it —— 绝不跳卡", () => {
  // 用户抱怨的第二种症状：拖 1.6 张 + 快甩 = 落 3 格，中间那张被跳过。
  assert.equal(commitSteps(1.6, 5), 2, "甩得再猛，拖了 1.6 格就只能落 2 格");
  assert.equal(commitSteps(0.6, 5), 1, "拖 0.6 格 + 猛甩 = 1 格，不是 2、3 格");
  assert.equal(commitSteps(-0.6, -5), -1);

  // 刻意拖过去的距离一律照数落格 —— 磁力不该妨碍「我就是要翻两张」。
  assert.equal(commitSteps(2.0, 0), 2);
  assert.equal(commitSteps(-2.0, 0), -2);

  // 反向甩（拖过去又往回甩）可以取消加成，但不会把方向倒过来。
  assert.equal(commitSteps(1.2, -5), 1);
});

test("a long gesture is never clamped backwards —— 落格不能倒退回起点附近", () => {
  /* 曾经这里有个「一次手势最多 3 格」的上限。连续滚过整段（≈6 格）时，
     落格会从当前位置倒退回 origin+3 —— 屏幕上是一次莫名的回弹。
     真实位移必须始终被完整兑现。 */
  for (const travel of [4, 5.4, 6, -5.8, -9]) {
    const steps = commitSteps(travel, 0);
    assert.ok(
      Math.abs(steps) >= Math.floor(Math.abs(travel)),
      `拖了 ${travel} 格却只落 ${steps} 格 —— 会往回弹`,
    );
    assert.equal(Math.sign(steps), Math.sign(travel));
  }
});

test("tuning stays inside the ranges the手感 depends on", () => {
  // flick 上限必须小于一格，否则「表达方向」会变成「表达翻几张」。
  assert.ok(DETENT_TUNING.FLICK_MAX_STEPS < 1);
  assert.ok(DETENT_TUNING.DETENT_EXP > 1, "指数 = 1 就没有磁力了");
  assert.ok(DETENT_TUNING.DETENT_EXP < 2, "指数过大会重新变成跟手延迟");
  assert.ok(DETENT_TUNING.COMMIT_MIN < 0.5, "0.5 = 传统「过半才算」，正是弹回原位的来源");
  assert.ok(DETENT_TUNING.COMMIT_MIN > 0.05, "门槛太低会让误触也翻页");
});
