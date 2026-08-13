// video-frames 纯函数测试（D-16 抽帧规格）。
// 运行器 node:test，与仓库其余测试一致；浏览器侧的 extractVideoFrames 不在此测。

import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_COUNT,
  LAST_FRAME_SEEK_BACKOFF_S,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FILE_BYTES,
  computeFrameTimestamps,
  formatBytes,
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
