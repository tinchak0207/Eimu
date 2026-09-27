// video-frames 纯函数测试（D-16 抽帧规格 + 节点动作抽帧计划）。
// 与仓库其余测试一致走 node:test（npm test = tsx --test）；vitest.config.ts 开了
// globals，这里以 globalThis.test 优先、fallback node:test.test，让同一份测试在
// 两种执行器下都能注册。浏览器侧的 extractVideoFrames 不在此测。

import assert from "node:assert/strict";
import * as nodeTest from "node:test";

type TestFn = (name: string, fn: () => void | Promise<void>) => unknown;
const test = ((globalThis as unknown as { test?: TestFn }).test ??
  (nodeTest.test as unknown as TestFn));
import {
  FRAME_COUNT,
  LAST_FRAME_SEEK_BACKOFF_S,
  MAX_SEQUENCE_FRAMES,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FILE_BYTES,
  computeFrameTimestamps,
  formatBytes,
  planFrameExtraction,
  validateVideoFile,
} from "./video-frames";

// ─────────────────────────── 抽帧时间点

test("60 秒影片按 0 / 1/3 / 2/3 / 末尾抽 4 帧", () => {
  const ts = computeFrameTimestamps(60);
  assert.equal(ts.length, FRAME_COUNT);
  assert.deepEqual(
    ts.map((t) => Math.round(t.time * 100) / 100),
    [0, 20, 40, 60 - LAST_FRAME_SEEK_BACKOFF_S],
  );
  assert.deepEqual(
    ts.map((t) => t.index),
    [0, 1, 2, 3],
  );
});

test("最后一帧回退，绝不 seek 到 duration 本身", () => {
  for (const d of [1, 7.5, 60]) {
    const last = computeFrameTimestamps(d)[FRAME_COUNT - 1];
    assert.ok(last.time < d, `${d}s 的末帧应回退到 duration 之前`);
    assert.equal(Math.round(last.time * 1000) / 1000, Math.round((d - LAST_FRAME_SEEK_BACKOFF_S) * 1000) / 1000);
  }
});

test("常规时长的时间点严格递增（顺序即帧序）", () => {
  for (const d of [1, 3, 12.34, 60]) {
    const times = computeFrameTimestamps(d).map((t) => t.time);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1], `${d}s: t${i} 必须大于 t${i - 1}`);
    }
  }
});

test("时间点永不越界，且始终给满 FRAME_COUNT 帧", () => {
  for (const d of [0, 0.01, 0.05, 0.2, 1, 60, 3600]) {
    const ts = computeFrameTimestamps(d);
    assert.equal(ts.length, FRAME_COUNT, `${d}s 应给满 ${FRAME_COUNT} 帧`);
    for (const t of ts) {
      assert.ok(Number.isFinite(t.time), `${d}s: 时间点必须是有限数`);
      assert.ok(t.time >= 0, `${d}s: 时间点不能为负`);
      assert.ok(t.time <= d, `${d}s: 时间点不能超过时长`);
    }
  }
});

test("时长非法（NaN / Infinity / 负数）时全部落在 0，不产生 NaN seek", () => {
  for (const d of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const ts = computeFrameTimestamps(d);
    assert.equal(ts.length, FRAME_COUNT);
    assert.deepEqual(
      ts.map((t) => t.time),
      [0, 0, 0, 0],
      `${String(d)} 应全部退回首帧`,
    );
  }
});

test("时长小于回退量时坍缩为四张首帧（不依赖 seek 失败兜底）", () => {
  const ts = computeFrameTimestamps(0.02);
  assert.deepEqual(
    ts.map((t) => t.time),
    [0, 0, 0, 0],
  );
});

test("label 是给 alt 用的中文文案，保留一位小数", () => {
  const ts = computeFrameTimestamps(10);
  assert.equal(ts[0].label, "约 0 秒");
  assert.match(ts[1].label, /^约 3\.3 秒$/);
  for (const t of ts) assert.match(t.label, /^约 [\d.]+ 秒$/);
});

// ─────────────────────────── 上限校验（超限拒收，不静默截断）

test("刚好踩在上限上放行（60 秒 / 100 MB）", () => {
  assert.equal(
    validateVideoFile({ size: MAX_VIDEO_FILE_BYTES, duration: MAX_VIDEO_DURATION_SECONDS }),
    null,
  );
});

test("超时长给出原因，并说明超出多少", () => {
  const reason = validateVideoFile({ size: 1024, duration: 75 });
  assert.ok(reason, "超限必须给原因");
  assert.match(reason, /时长/);
  assert.match(reason, /60 秒/);
  assert.match(reason, /15/); // 超出 15 秒
});

test("超文件大小给出原因，并说明超出多少", () => {
  const reason = validateVideoFile({ size: MAX_VIDEO_FILE_BYTES + 20 * 1024 * 1024, duration: 3 });
  assert.ok(reason);
  assert.match(reason, /100 MB/);
  assert.match(reason, /20\.0 MB/);
});

test("两项都超时一次列全，不只报第一条", () => {
  const reason = validateVideoFile({ size: MAX_VIDEO_FILE_BYTES * 2, duration: 120 });
  assert.ok(reason);
  assert.match(reason, /时长/);
  assert.match(reason, /文件/);
});

// ─────────────────────────── 体积文案

test("formatBytes 按量级切换单位", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("formatBytes 对非有限值给可读兜底而不是 NaN", () => {
  assert.equal(formatBytes(Number.NaN), "未知大小");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "未知大小");
});

// ─────────────────────────── 节点动作：planFrameExtraction 真行为断言

test("序列帧：duration=10 interval=2 → 5 个时间点逐位元等于预期", () => {
  const plan = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 2 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.timesSec, [0, 2, 4, 6, 8]);
  // 逐位元复核（不是只看长度）
  assert.equal(plan.timesSec[0], 0);
  assert.equal(plan.timesSec[1], 2);
  assert.equal(plan.timesSec[2], 4);
  assert.equal(plan.timesSec[3], 6);
  assert.equal(plan.timesSec[4], 8);
});

test("序列帧：count=5 duration=10 → 5 点，首尾在合理范围", () => {
  const plan = planFrameExtraction({ durationSec: 10, mode: "sequence", count: 5 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timesSec.length, 5);
  assert.deepEqual(plan.timesSec, [0, 2.5, 5, 7.5, 9.95]);
  assert.equal(plan.timesSec[0], 0, "首点必须是 0");
  assert.ok(plan.timesSec[4] < 10 && plan.timesSec[4] >= 9.9, `末点应在片尾附近但不等于 duration，实际 ${plan.timesSec[4]}`);
});

test("超上限 / interval=0：回拒绝理由而非例外", () => {
  const zero = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 0 });
  assert.equal(zero.ok, false);
  if (zero.ok) return;
  assert.match(zero.reason, /正数/);

  const tooMany = planFrameExtraction({ durationSec: 10, mode: "sequence", count: MAX_SEQUENCE_FRAMES + 1 });
  assert.equal(tooMany.ok, false);
  if (tooMany.ok) return;
  assert.match(tooMany.reason, /上限/);
  assert.match(tooMany.reason, new RegExp(String(MAX_SEQUENCE_FRAMES)));

  const dense = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 0.1 });
  assert.equal(dense.ok, false);
  if (dense.ok) return;
  assert.match(dense.reason, /超过上限/);
});

test("浮点对齐：interval=0.1 不产生 0.30000000000000004", () => {
  const plan = planFrameExtraction({ durationSec: 0.5, mode: "sequence", intervalSec: 0.1 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.timesSec, [0, 0.1, 0.2, 0.3, 0.4]);
});

test("截帧：current 取指定时刻；落在片尾时回退，超长度时拒绝", () => {
  const mid = planFrameExtraction({ durationSec: 10, mode: "current", atSec: 3 });
  assert.deepEqual(mid, { ok: true, timesSec: [3] });

  const end = planFrameExtraction({ durationSec: 10, mode: "current", atSec: 10 });
  assert.equal(end.ok, true);
  if (!end.ok) return;
  assert.deepEqual(end.timesSec, [Math.round((10 - LAST_FRAME_SEEK_BACKOFF_S) * 1000) / 1000]);

  const over = planFrameExtraction({ durationSec: 10, mode: "current", atSec: 11 });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.match(over.reason, /超过视频长度/);
});

test("非法时长的多种输入一律回 ok:false，绝不抛例外", () => {
  const cases = [
    { durationSec: Number.NaN, mode: "sequence", intervalSec: 1 },
    { durationSec: 10, mode: "sequence" },
    { durationSec: 10, mode: "sequence", intervalSec: 1, count: 3 },
    { durationSec: 10, mode: "sequence", count: -3 },
    { durationSec: 10, mode: "sequence", count: 2.5 },
  ] as const;
  for (const input of cases) {
    const result = planFrameExtraction(input as never);
    assert.equal(result.ok, false, `${JSON.stringify(input)} 应被拒绝`);
    if (result.ok) continue;
    assert.ok(result.reason.length > 0, "拒绝必须给理由");
  }
});
