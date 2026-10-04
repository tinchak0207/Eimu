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
  FRAME_CAPTURE_TIMEOUT_MS,
  FRAME_COUNT,
  LAST_FRAME_SEEK_BACKOFF_S,
  MAX_SEQUENCE_FRAMES,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_FILE_BYTES,
  METADATA_WAIT_TIMEOUT_MS,
  SEEK_TIMEOUT_MS,
  TILE_CELL_WIDTH,
  TILE_COLUMNS,
  captureFrame,
  computeFrameTimestamps,
  formatBytes,
  frameFileName,
  intervalSamples,
  planFrameExtraction,
  planTileLayout,
  seekTo,
  tileFrameCount,
  tileSampleTimes,
  validateVideoFile,
  waitForMetadata,
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

test("刚好踩在上限上放行（600 秒 / 100 MB）", () => {
  assert.equal(MAX_VIDEO_DURATION_SECONDS, 600);
  assert.equal(
    validateVideoFile({ size: MAX_VIDEO_FILE_BYTES, duration: MAX_VIDEO_DURATION_SECONDS }),
    null,
  );
});

test("超时长给出原因，并说明超出多少", () => {
  // 契约变更（2026-09-28）：时长上限 60 → 600，所以「超限」样例跟着上移到 675 秒。
  const reason = validateVideoFile({ size: 1024, duration: 675 });
  assert.ok(reason, "超限必须给原因");
  assert.match(reason, /时长/);
  assert.match(reason, /600 秒/);
  assert.match(reason, /75/); // 超出 75 秒
});

test("超文件大小给出原因，并说明超出多少", () => {
  const reason = validateVideoFile({ size: MAX_VIDEO_FILE_BYTES + 20 * 1024 * 1024, duration: 3 });
  assert.ok(reason);
  assert.match(reason, /100 MB/);
  assert.match(reason, /20\.0 MB/);
});

test("两项都超时一次列全，不只报第一条", () => {
  const reason = validateVideoFile({ size: MAX_VIDEO_FILE_BYTES * 2, duration: 1200 });
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

test("序列帧：duration=10 interval=2 → 5 个时间点逐位元等于预期（不含片尾）", () => {
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
  assert.ok(plan.timesSec.every((t) => t < 10), "interval 路径绝不含 end 本身");
});

test("序列帧：count=5 duration=10 → 等距中点（契约变更：旧端点语义 → 竞品中点语义）", () => {
  const plan = planFrameExtraction({ durationSec: 10, mode: "sequence", count: 5 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timesSec.length, 5);
  // 旧值 [0, 2.5, 5, 7.5, 9.95]（端点+末帧回退）→ 新值 = 5 等份的中点
  assert.deepEqual(plan.timesSec, [1, 3, 5, 7, 9]);
  assert.equal(plan.timesSec[0], 1, "首点是第一等份中点，不再是 0");
  assert.ok(plan.timesSec[4] < 10, "末点仍严格小于 duration");
});

test("序列帧 count 下限 2（竞品 a grid needs at least two frames；单帧请用 current）", () => {
  for (const count of [1, 0, -3, 2.5]) {
    const plan = planFrameExtraction({ durationSec: 10, mode: "sequence", count });
    assert.equal(plan.ok, false, `count=${count} 应被拒绝`);
    if (plan.ok) continue;
    assert.match(plan.reason, /不小于 2/);
  }
});

test("超上限 / interval=0：回拒绝理由而非例外", () => {
  const zero = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 0 });
  assert.equal(zero.ok, false);
  if (zero.ok) return;
  assert.match(zero.reason, /正数/);
  assert.match(zero.reason, /0\.001/);

  const tooMany = planFrameExtraction({ durationSec: 10, mode: "sequence", count: MAX_SEQUENCE_FRAMES + 1 });
  assert.equal(tooMany.ok, false);
  if (tooMany.ok) return;
  assert.match(tooMany.reason, /上限/);
  assert.match(tooMany.reason, new RegExp(String(MAX_SEQUENCE_FRAMES)));
  assert.match(tooMany.reason, /服务器端抽帧/);

  // 契约变更：上限 24 → 600 后，interval=0.1 / 10 秒只剩 100 帧（旧值会超 24 上限）。
  // 会超限的样例改为竞品下限间隔 0.001 秒 → 10000 帧。
  const dense = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 0.001 });
  assert.equal(dense.ok, false);
  if (dense.ok) return;
  assert.match(dense.reason, /超过上限/);
  assert.match(dense.reason, /服务器端抽帧/);

  // 600 帧正好放行（上限是「到顶明确拒绝」，不是「到顶之前拒绝」）
  const atCap = planFrameExtraction({ durationSec: 10, mode: "sequence", intervalSec: 0.0166666667 });
  assert.equal(atCap.ok, true);
  if (!atCap.ok) return;
  assert.equal(atCap.timesSec.length, MAX_SEQUENCE_FRAMES);
});

test("时长超过 600 秒：明确拒绝并提示裁剪/服务器端，不静默只用前 600 秒", () => {
  const plan = planFrameExtraction({ durationSec: 601, mode: "sequence", intervalSec: 5 });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /600 秒/);
  assert.match(plan.reason, /裁剪/);
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

// ─────────────────────────── 照抄正确性验收（竞品公式手算 vs 实作输出）

test("intervalSamples 逐字对齐竞品公式（手算 0/10/2.5 → [0,2.5,5,7.5]，不含 end）", () => {
  // 手算：ceil((10-0)/2.5) = 4；time_i = 0 + i*2.5 = 0,2.5,5,7.5；全部 < 10 → 4 项。
  assert.deepEqual(intervalSamples(0, 10, 2.5), [0, 2.5, 5, 7.5]);
  // 手算（every=3）：ceil(10/3)=4；0,3,6,9；9 < 10 → 4 项。
  assert.deepEqual(intervalSamples(0, 10, 3), [0, 3, 6, 9]);
  // end 恰为 every 的整数倍时：ceil(10/2)=5；0..8，10 被 filter(time<end) 剔掉。
  assert.deepEqual(intervalSamples(0, 10, 2), [0, 2, 4, 6, 8]);
  assert.ok(!intervalSamples(0, 10, 2).includes(10));
  // 起点不为 0 时照公式平移（我方路由只用 start=0，纯函数语义照竞品保留）
  assert.deepEqual(intervalSamples(1, 5, 2), [1, 3]);
});

test("tileSampleTimes 逐字对齐竞品公式（手算等距中点 0/10/4 → [1.25,3.75,6.25,8.75]）", () => {
  // 手算：每份宽 (10-0)/4 = 2.5；中点 = (i+0.5)*2.5 → 1.25, 3.75, 6.25, 8.75。
  assert.deepEqual(tileSampleTimes(0, 10, 4), [1.25, 3.75, 6.25, 8.75]);
  // 首项不是 0、末项不是 10 —— 中点语义的判定特征
  const mid = tileSampleTimes(0, 10, 4);
  assert.ok(mid[0] > 0 && mid[3] < 10);
  // 网格至少两帧（竞品 assert 原文）：< 2 抛错
  assert.throws(() => tileSampleTimes(0, 10, 1), /a grid needs at least two frames/);
  assert.throws(() => intervalSamples(0, 10, 0.0005), /--every must be at least 0.001 seconds/);
  assert.throws(() => intervalSamples(5, 5, 1), /a sample range needs 0 <= start < end/);
});

test("tileFrameCount = clamp(round(seconds*1.5), 4, 9)", () => {
  assert.equal(tileFrameCount(0.5), 4); // round(0.75)=1 → 夹到 4
  assert.equal(tileFrameCount(2), 4); // round(3)=3 → 夹到 4
  assert.equal(tileFrameCount(3), 5); // round(4.5)=5
  assert.equal(tileFrameCount(6), 9); // round(9)=9
  assert.equal(tileFrameCount(60), 9); // round(90)=90 → 夹到 9
  // 诚实边界：竞品对 NaN 会算出 NaN 格数，我方回下限 4（不产生 NaN）
  assert.equal(tileFrameCount(Number.NaN), 4);
  assert.equal(tileFrameCount(0), 4);
});

test("planTileLayout：默认 3 列、480 格宽，rows=ceil(count/columns)", () => {
  assert.deepEqual(planTileLayout({ count: 9 }), { columns: TILE_COLUMNS, rows: 3, cellWidth: TILE_CELL_WIDTH });
  assert.deepEqual(planTileLayout({ count: 10 }), { columns: 3, rows: 4, cellWidth: 480 });
  assert.deepEqual(planTileLayout({ count: 1 }), { columns: 3, rows: 1, cellWidth: 480 });
  // columns 下限 1（竞品 --columns 语义）
  assert.equal(planTileLayout({ count: 4, columns: 0 }).columns, 1);
  assert.equal(planTileLayout({ count: 4, columns: -2 }).columns, 1);
  assert.deepEqual(planTileLayout({ count: 4, columns: 2 }), { columns: 2, rows: 2, cellWidth: 480 });
});

test("planTileLayout：cell 宽度照竞品 cell 预设 max(80, min(480, width))", () => {
  // 来源宽 1920 → 夹到 480；200 → 200；50 → 下限 80。
  assert.equal(planTileLayout({ count: 4, sourceWidth: 1920 }).cellWidth, 480);
  assert.equal(planTileLayout({ count: 4, sourceWidth: 200 }).cellWidth, 200);
  assert.equal(planTileLayout({ count: 4, sourceWidth: 50 }).cellWidth, 80);
  // 显式 cellWidth 优先，并保留下限 80
  assert.equal(planTileLayout({ count: 4, cellWidth: 320, sourceWidth: 1920 }).cellWidth, 320);
  assert.equal(planTileLayout({ count: 4, cellWidth: 10 }).cellWidth, 80);
  // 两个宽度都没给 → 竞品预设 480（不猜）
  assert.equal(planTileLayout({ count: 4 }).cellWidth, 480);
});

test("frameFileName 照竞品档名规则：frame-2_500s.jpg", () => {
  assert.equal(frameFileName(2.5), "frame-2_500s.jpg");
  assert.equal(frameFileName(0), "frame-0_000s.jpg");
  assert.equal(frameFileName(2.345), "frame-2_345s.jpg");
  assert.equal(frameFileName(12), "frame-12_000s.jpg");
  // 档名与计划时间点同源（毫秒对齐后不再有浮点尾巴）
  const plan = planFrameExtraction({ durationSec: 10, mode: "sequence", count: 5 });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(plan.timesSec.map(frameFileName), [
    "frame-1_000s.jpg",
    "frame-3_000s.jpg",
    "frame-5_000s.jpg",
    "frame-7_000s.jpg",
    "frame-9_000s.jpg",
  ]);
});

// ─────────────────────────── mode:"at"（竞品 --at 的验证语义）

test("at 模式：合法清单逐位元回传，且严格递增、全部 < duration", () => {
  const plan = planFrameExtraction({ durationSec: 10, mode: "at", atSec: [0, 2.5, 9.999] });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.timesSec, [0, 2.5, 9.999]);
  // 给清单就必须严格照给（不做 rounding 之外的加工）
  const single = planFrameExtraction({ durationSec: 3, mode: "at", atSec: [1.5] });
  assert.deepEqual(single, { ok: true, timesSec: [1.5] });
});

test("at 模式：空清单 / 非递增 / 越界 / 负数 / 非数字，逐条明确拒绝", () => {
  const cases: Array<{ input: never; pattern: RegExp }> = [
    { input: { durationSec: 10, mode: "at", atSec: [] } as never, pattern: /至少 1 个/ },
    { input: { durationSec: 10, mode: "at", atSec: undefined } as never, pattern: /至少 1 个/ },
    { input: { durationSec: 10, mode: "at", atSec: [1, 2, 2] } as never, pattern: /严格递增/ },
    { input: { durationSec: 10, mode: "at", atSec: [3, 1] } as never, pattern: /严格递增/ },
    // 照竞品：a frame time must be before the end of the file
    { input: { durationSec: 10, mode: "at", atSec: [10] } as never, pattern: /结束之前/ },
    { input: { durationSec: 10, mode: "at", atSec: [11] } as never, pattern: /结束之前/ },
    { input: { durationSec: 10, mode: "at", atSec: [-1] } as never, pattern: /不能为负/ },
    { input: { durationSec: 10, mode: "at", atSec: [1, Number.NaN] } as never, pattern: /不是有效数字/ },
    // 互斥：at 与 intervalSec / count 不能并用（照竞品「choose --every or --frames」的互斥精神）
    { input: { durationSec: 10, mode: "at", atSec: [1], intervalSec: 1 } as never, pattern: /互斥/ },
    { input: { durationSec: 10, mode: "at", atSec: [1], count: 3 } as never, pattern: /互斥/ },
  ];
  for (const { input, pattern } of cases) {
    const plan = planFrameExtraction(input as never);
    assert.equal(plan.ok, false, `${JSON.stringify(input)} 应被拒绝`);
    if (plan.ok) continue;
    assert.match(plan.reason, pattern);
  }
});

test("at 模式：清单长度超上限 600 明确拒绝（不静默截断）", () => {
  const list = Array.from({ length: MAX_SEQUENCE_FRAMES + 1 }, (_, i) => i * 0.01);
  const plan = planFrameExtraction({ durationSec: 600, mode: "at", atSec: list });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /超过上限 600/);
  assert.match(plan.reason, /服务器端抽帧/);
});

test("未知 mode 一律拒绝（含旧拼法 current/sequence 之外的值）", () => {
  const plan = planFrameExtraction({ durationSec: 10, mode: "frames" as never });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /未知的抽帧模式/);
});

// ─────────────────────────── waitForMetadata：BUG-1「error 只发一次 → 第二次等待永久卡死」

/** 假 <video>：精确重现浏览器语义——`error` 事件整个生命周期只发一次，
 *  `video.error` 一旦设了就保持（readyState 停在 0，不再有事件）。 */
class FakeVideo {
  readyState = 0;
  error: { code: number } | null = null;
  duration = Number.NaN;
  videoWidth = 0;
  videoHeight = 0;
  preload = "";
  muted = false;
  playsInline = false;
  currentTime = 0;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  removeAttribute(): void {}
  load(): void {}

  /** 只在此处派发事件；呼叫端只会呼叫一次 `fire("error")`（模拟真实浏览器）。 */
  fire(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  asVideo(): HTMLVideoElement {
    return this as unknown as HTMLVideoElement;
  }
}

test("BUG-1：error 只发一次，第二次 waitForMetadata 立即 reject（不靠等到 timeout）", async () => {
  const v = new FakeVideo();
  // 第一次等待：监听挂上后浏览器才发 error（真实时序）。
  const first = waitForMetadata(v.asVideo());
  v.error = { code: 4 }; // 浏览器在发 error 前会先设 video.error
  v.fire("error");
  await assert.rejects(first, /解码失败/);
  assert.equal(v.listenerCount("error"), 0, "第一次失败后不得残留监听");

  // 第二次等待：该 <video> 的 error 已消费、不会再发，readyState 仍为 0。
  const started = Date.now();
  await assert.rejects(waitForMetadata(v.asVideo()), /解码失败/);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 500,
    `第二次必须立即 reject（实测 ${elapsed}ms，timeout=${METADATA_WAIT_TIMEOUT_MS}ms）`,
  );
  assert.equal(v.listenerCount("error"), 0, "终态快查必须在挂监听前就挡掉，不得重挂");
  assert.equal(v.listenerCount("loadedmetadata"), 0, "第二次不得重挂 loadedmetadata");
});

test("BUG-1：元素已 error（事件早已被前次消费）→ 一进入就 reject，不挂任何监听", async () => {
  const v = new FakeVideo();
  v.error = { code: 4 };
  const started = Date.now();
  await assert.rejects(waitForMetadata(v.asVideo()), /解码失败/);
  assert.ok(Date.now() - started < 200, "已死元素必须立刻失败");
  assert.equal(v.listenerCount("error"), 0);
  assert.equal(v.listenerCount("loadedmetadata"), 0);
});

test("waitForMetadata：readyState 已 HAVE_METADATA → 立即 resolve，不挂监听", async () => {
  const v = new FakeVideo();
  v.readyState = 1;
  await waitForMetadata(v.asVideo());
  assert.equal(v.listenerCount("loadedmetadata"), 0);
  assert.equal(v.listenerCount("error"), 0);
});

test("waitForMetadata：元素永不反映终态时，timeout 兜底 reject", async () => {
  const v = new FakeVideo();
  const started = Date.now();
  await assert.rejects(waitForMetadata(v.asVideo(), 40), /超时/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 30 && elapsed < 1000, `timeout 兜底应在 ~40ms 生效（实测 ${elapsed}ms）`);
  assert.equal(v.listenerCount("error"), 0, "timeout 后必须清理监听");
  assert.equal(v.listenerCount("loadedmetadata"), 0);
});

// ─────────────────────────── seekTo：同 BUG-1 族「永不 seeked → 永久 pending」
//
// 画布节点动作（use-canvas-generation.ts）直接调用 extractFramesAtTimes → seekTo，
// 没有 local-media-ingest 的总 timeout 兜底；seekTo 一旦永久 pending，节点会永远停在
// 「取帧中…」。以下用假元素重现两种情境，并注入缩短的 timeout（不靠等真实 15s）。

test("seekTo：元素永不 seeked（readyState<2、无 error）→ timeout 兜底具名 reject，不永久 pending", async () => {
  const v = new FakeVideo();
  v.readyState = 1; // HAVE_METADATA：metadata 到了，但没有当前帧可解码
  const started = Date.now();
  await assert.rejects(seekTo(v.asVideo(), 5, 40), /定位超时/);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= 30 && elapsed < 1000,
    `timeout 应在 ~40ms 生效（实测 ${elapsed}ms，预设 ${SEEK_TIMEOUT_MS}ms）`,
  );
  assert.equal(v.listenerCount("seeked"), 0, "timeout 后必须清 seeked 监听");
  assert.equal(v.listenerCount("error"), 0, "timeout 后必须清 error 监听");
});

test("seekTo：error 事件早已发过（video.error 已设）→ 一进入即具名 reject，不挂任何监听", async () => {
  const v = new FakeVideo();
  v.error = { code: 4 };
  const started = Date.now();
  await assert.rejects(seekTo(v.asVideo(), 5, 40), /解码失败/);
  assert.ok(Date.now() - started < 200, "已死元素必须立刻失败，不靠 timeout");
  assert.equal(v.listenerCount("seeked"), 0);
  assert.equal(v.listenerCount("error"), 0);
});

test("seekTo：等待中发 error → reject 且清监听（不再静默 resolve 导致交付空帧）", async () => {
  const v = new FakeVideo();
  v.readyState = 1;
  const p = seekTo(v.asVideo(), 5, 40);
  v.error = { code: 4 };
  v.fire("error");
  await assert.rejects(p, /解码失败/);
  assert.equal(v.listenerCount("seeked"), 0);
  assert.equal(v.listenerCount("error"), 0);
});

test("seekTo：正常 seeked → resolve 且清监听；已在目标点且有帧 → 不挂监听直接 resolve", async () => {
  const v = new FakeVideo();
  v.readyState = 1;
  const p = seekTo(v.asVideo(), 5, 40);
  v.readyState = 2;
  v.fire("seeked");
  await p;
  assert.equal(v.listenerCount("seeked"), 0);
  assert.equal(v.listenerCount("error"), 0);

  const w = new FakeVideo();
  w.readyState = 2;
  w.currentTime = 5;
  await seekTo(w.asVideo(), 5, 40); // 终态快查：已在目标点
  assert.equal(w.listenerCount("seeked"), 0);
  assert.equal(w.listenerCount("error"), 0);
});

// ─────────────────────────── captureFrame：同族「toBlob 永不回调 → 永久 pending」
//
// canvas.toBlob 是回调式 API，没有事件/错误通道；回调不触发就永久 pending。
// 画布节点取帧（extractFramesAtTimes → captureFrame）没有外层总 timeout 兜底。
// 以下用最小 document/canvas 桩 + 注入缩短 timeout 重现，不靠等真实的 10s。

/** 装一个最小 document：createElement("canvas") 回一个可控 toBlob 的假 canvas。 */
function stubCanvasDocument(toBlob: (cb: (blob: Blob | null) => void) => void): () => void {
  const globals = globalThis as unknown as { document?: unknown };
  const original = globals.document;
  const ctx = { fillStyle: "", fillRect() {}, drawImage() {} };
  globals.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob,
    }),
  };
  return () => {
    globals.document = original;
  };
}

function videoWithFrame(): HTMLVideoElement {
  const v = new FakeVideo();
  v.videoWidth = 640;
  v.videoHeight = 360;
  return v.asVideo();
}

/** 保证 promise 在观察窗内 settle；未 settle 即以失败收场（红：修复前永久 pending）。 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("captureFrame：toBlob 永不回调 → timeout 具名 reject，不永久 pending", async () => {
  const restore = stubCanvasDocument(() => {
    /* 永不回调：模拟 canvas.toBlob 卡死 */
  });
  try {
    const started = Date.now();
    await assert.rejects(
      settlesWithin(captureFrame(videoWithFrame(), 40), 500),
      /取帧超时/,
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= 30 && elapsed < 1000,
      `timeout 应在 ~40ms 生效（实测 ${elapsed}ms，默认 ${FRAME_CAPTURE_TIMEOUT_MS}ms）`,
    );
  } finally {
    restore();
  }
});

test("captureFrame：toBlob 正常回调 → resolve 同一 blob（timeout 不误杀）", async () => {
  const frame = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
  const restore = stubCanvasDocument((cb) => cb(frame));
  try {
    const out = await captureFrame(videoWithFrame(), 500);
    assert.equal(out, frame);
  } finally {
    restore();
  }
});

test("captureFrame：toBlob 回调 null（导出失败）→ 具名 reject", async () => {
  const restore = stubCanvasDocument((cb) => cb(null));
  try {
    await assert.rejects(captureFrame(videoWithFrame(), 500), /无法导出图像/);
  } finally {
    restore();
  }
});

test("FRAME_CAPTURE_TIMEOUT_MS 与 metadata 等待同档（秒级，不误杀正常编码）", () => {
  assert.ok(FRAME_CAPTURE_TIMEOUT_MS >= 3_000, "上限不得短于 3 秒");
  assert.ok(FRAME_CAPTURE_TIMEOUT_MS <= 30_000, "上限不得长于 30 秒");
});

