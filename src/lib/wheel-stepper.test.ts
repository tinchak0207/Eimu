import assert from "node:assert/strict";
import test from "node:test";
import { createWheelStepper, type WheelDecision } from "./wheel-stepper.ts";

/** 觸控板一滑：3 筆上升、之後指數衰減的慣性尾巴（每 16ms 一筆），可加抖動。 */
function swipe(t0: number, dir: 1 | -1, opts: { peak?: number; ms?: number; jitter?: (i: number) => number } = {}) {
  const peak = opts.peak ?? 120;
  const n = Math.round((opts.ms ?? 1100) / 16);
  const out: Array<{ t: number; delta: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const base = i < 3 ? peak * (0.4 + 0.3 * i) : peak * Math.exp(-(i - 3) / 14);
    const v = Math.max(1, Math.round(base * (opts.jitter ? opts.jitter(i) : 1)));
    out.push({ t: t0 + i * 16, delta: dir * v });
  }
  return out;
}

function run(samples: Array<{ t: number; delta: number }>, canStep: (dir: 1 | -1, t: number) => boolean = () => true) {
  const s = createWheelStepper();
  const decisions: WheelDecision[] = [];
  for (const sample of samples) decisions.push(s.feed(sample, (d) => canStep(d, sample.t)));
  return decisions;
}
const steps = (ds: WheelDecision[]) => ds.filter((d): d is { step: 1 | -1 } => typeof d === "object").map((d) => d.step);

test("一滑（含慣性尾巴）只換一檔，尾巴全被吃掉不放行頁面", () => {
  const ds = run(swipe(0, 1));
  assert.deepEqual(steps(ds), [1]);
  assert.ok(ds.every((d) => d !== "pass"));
});

test("抖動的觸控板（單筆尖峰到 2.5 倍）不會被當成新手勢", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const jitter = (i: number) => (i % 7 === 5 ? 2.5 : 0.6 + rnd() * 0.8);
  assert.deepEqual(steps(run(swipe(0, 1, { jitter }))), [1]);
});

test("尾巴還沒停就再滑一次（無空檔、明確再加速）＝第二檔；間隔停頓也行", () => {
  const a = swipe(0, 1, { ms: 1000 });
  const b = swipe(1000, 1, { ms: 1000 }); // 緊接著上一段的尾巴
  assert.deepEqual(steps(run([...a, ...b])), [1, 1]);
  const c = swipe(1400, 1); // 停頓 > 140ms
  assert.deepEqual(steps(run([...swipe(0, 1, { ms: 1100 }), ...c])), [1, 1]);
});

test("換檔後 700ms 內不會再換（即使立刻再滑）", () => {
  const ds = run([...swipe(0, 1, { ms: 200 }), ...swipe(400, 1, { ms: 200 })]);
  assert.deepEqual(steps(ds), [1]);
});

test("反向立即可換（往回滑）", () => {
  assert.deepEqual(steps(run([...swipe(0, 1, { ms: 900 }), ...swipe(900, -1, { ms: 900 })])), [1, -1]);
});

test("往回滑：捲頁面的那一滑進到舞台只停住（不換檔），緊接著的下一滑（無空檔）照樣換檔——不再「往回滑完全無效」", () => {
  const first = swipe(0, -1, { ms: 1200 });
  const second = swipe(1200, -1, { ms: 1200 });
  const ds = run([...first, ...second], (_d, t) => t > 300); // 300ms 之後舞台才完整入鏡
  assert.ok(ds.slice(0, 18).every((d) => d === "pass"));
  assert.deepEqual(steps(ds.slice(0, first.length)), []);
  assert.ok(ds.slice(19, first.length).every((d) => d === "consume"));
  assert.deepEqual(steps(ds.slice(first.length)), [-1]);
});

test("到頭：換到最後一檔那一滑的尾巴吃掉，下一滑才放行給頁面", () => {
  let index = 2; // 0..3，往下最多到 3
  const s = createWheelStepper();
  const feed = (samples: Array<{ t: number; delta: number }>) =>
    samples.map((x) => {
      const d = s.feed(x, (dir) => (dir > 0 ? index < 3 : index > 0));
      if (typeof d === "object") index += d.step;
      return d;
    });
  const first = feed(swipe(0, 1));
  assert.equal(index, 3);
  assert.ok(first.every((d) => d !== "pass"));
  const second = feed(swipe(1400, 1));
  assert.ok(second.every((d) => d === "pass"));
});

test("一直按著滑（無停頓）只換一檔，不會連跳；停一下再滑才換下一檔", () => {
  const n = Math.round(4000 / 16);
  const held = Array.from({ length: n }, (_, i) => ({ t: i * 16, delta: 40 }));
  assert.deepEqual(steps(run(held)), [1]);
  assert.deepEqual(steps(run([...held, ...swipe(4300, 1)])), [1, 1]);
});

test("實測回歸：換檔後 1.5s 抖動平台（20–60px 持續）不再跳檔", () => {
  const plateau = [-89, -120, -121, -129, -260, -81, -82, -103, -53, -71, -75, -158, -70, -58, -62, -41, -43, -56, -96, -25, -23, -30, -28, -34, -23, -58, -21, -23, -22, -22, -11, -13];
  const samples = plateau.map((delta, i) => ({ t: i * 50, delta }));
  assert.deepEqual(steps(run(samples)), [-1]);
});

test("慢衰減的長慣性尾巴（每筆 50ms、衰減 7%，持續 2 秒以上）不會再跳一檔", () => {
  const deltas = [48, 84, 120, 120, 112, 104, 97, 90, 84, 78, 73, 68, 63, 59, 55, 51, 47, 44, 41, 38, 36, 33, 31, 29, 27, 25, 23, 22, 20, 19, 17, 16, 15, 14, 13, 12, 11, 11, 10, 9, 9, 8, 7, 7];
  const samples = deltas.map((delta, i) => ({ t: i * 50, delta }));
  assert.deepEqual(steps(run(samples)), [1]);
});


test("實測回歸：抖動的長尾巴（瀏覽器實錄序列）只換一檔", () => {
  const recorded: Array<[number, number]> = [[4798, 29], [4837, 80], [4884, 102], [4988, 76], [5052, 144], [5117, 260], [5184, 90], [5235, 91], [5284, 82], [5334, 76], [5384, 60], [5434, 53], [5483, 158], [5534, 69], [5583, 39], [5634, 46], [5684, 51], [5737, 56], [5784, 37], [5834, 96], [5884, 24], [5934, 26], [5984, 37], [6033, 31], [6085, 28], [6133, 25], [6183, 58], [6233, 17], [6283, 17], [6334, 23], [6383, 11], [6434, 12], [6484, 16], [6534, 35], [6583, 15], [6633, 7], [6684, 10], [6734, 14], [6784, 10], [6884, 6], [6953, 21], [7016, 9], [7084, 10], [7134, 6]];
  assert.deepEqual(steps(run(recorded.map(([t, delta]) => ({ t, delta })))), [1]);
});

test("主線程忙：慣性尾巴中間冒出 > 140ms 的空檔，尾巴的小 delta 不會被當成新手勢", () => {
  const tail = swipe(0, 1, { ms: 1600 }).map((x, i) => ({ ...x, t: x.t + (i > 30 ? 200 : 0) + (i > 60 ? 200 : 0) }));
  assert.deepEqual(steps(run(tail)), [1]);
});

test("實測回歸：3D 頁面主線程忙（每 66ms 一筆）的慢衰減尾巴撐過 1.5s 也只換一檔", () => {
  const deltas = [140, 129, 119, 109, 100, 92, 85, 78, 72, 66, 61, 56, 52, 47, 44, 40, 37, 34, 31, 29, 26, 24, 22, 21, 19, 18, 16, 15, 14, 13];
  const samples = deltas.map((delta, i) => ({ t: i * 66, delta }));
  assert.deepEqual(steps(run(samples)), [1]);
});

