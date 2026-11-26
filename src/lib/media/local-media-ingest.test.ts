// local-media-ingest 单元测试（runner：npx --yes tsx --test）。
//
// 环境无 DOM：只测纯逻辑（计划帧数／时间点／边长／位元组加总／音轨判定），
// 加上用可注入的假 LocalMediaSession 覆盖执行层的成功与各条降级路径。
// 真正的 <video>/<canvas> 解码不在这里（见回报的待 E2E 清单）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DERIVED_UPLOAD_BYTES,
  MAX_LOCAL_KEYFRAMES,
  MIN_LOCAL_KEYFRAMES,
  computeDerivedBytes,
  detectHasAudio,
  estimateProbeJsonBytes,
  frameEdgePx,
  ingestMediaLocally,
  isIngestUsable,
  planKeyframeCount,
  planKeyframeTimes,
  runLocalMediaIngest,
  toDerivedFiles,
  type LocalMediaIngest,
  type LocalMediaKeyframe,
  type LocalMediaMetadata,
  type LocalMediaProbe,
  type LocalMediaSession,
} from "./local-media-ingest.ts";

// ─────────────────────────── 测试辅助

function makeFile(bytes: number): File {
  return new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });
}

function makeBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "image/jpeg" });
}

function keyframe(tSec: number, size: number, edgePx = 512): LocalMediaKeyframe {
  return { tSec, blob: makeBlob(size), edgePx };
}

const GOOD_METADATA: LocalMediaMetadata = {
  durationSec: 60,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

interface FakeSessionOptions {
  metadata?: LocalMediaMetadata | "throw";
  onExtract?: (timesSec: readonly number[]) => LocalMediaKeyframe[] | "throw";
  poster?: Blob | "throw";
}

class FakeSession implements LocalMediaSession {
  disposed = false;
  metadataCalls = 0;
  extractCalls = 0;
  posterCalls = 0;
  lastTimes: readonly number[] = [];

  constructor(private readonly opts: FakeSessionOptions = {}) {}

  async readMetadata(): Promise<LocalMediaMetadata> {
    this.metadataCalls += 1;
    if (this.opts.metadata === "throw") throw new Error("boom-metadata");
    return this.opts.metadata ?? GOOD_METADATA;
  }

  async extractFrames(
    timesSec: readonly number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<LocalMediaKeyframe[]> {
    this.extractCalls += 1;
    this.lastTimes = timesSec;
    if (this.opts.onExtract) {
      const out = this.opts.onExtract(timesSec);
      if (out === "throw") throw new Error("boom-frames");
      onProgress?.(out.length, out.length);
      return out;
    }
    const frames = timesSec.map((t, i) => keyframe(t, 100 + i));
    onProgress?.(frames.length, frames.length);
    return frames;
  }

  async capturePoster(): Promise<Blob> {
    this.posterCalls += 1;
    if (this.opts.poster === "throw") throw new Error("boom-poster");
    return this.opts.poster ?? makeBlob(50);
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ─────────────────────────── planKeyframeCount

test("planKeyframeCount：非法／非正时长回下限", () => {
  assert.equal(planKeyframeCount(0), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(-5), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(Number.NaN), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(Number.POSITIVE_INFINITY), MIN_LOCAL_KEYFRAMES);
});

test("planKeyframeCount：随时长增加、夹在下限与上限之间", () => {
  assert.equal(planKeyframeCount(1), MIN_LOCAL_KEYFRAMES); // 短于一单位仍取下限
  assert.equal(planKeyframeCount(60), 4);
  assert.equal(planKeyframeCount(75), 5);
  assert.equal(planKeyframeCount(150), 10);
  assert.equal(planKeyframeCount(180), MAX_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(600), MAX_LOCAL_KEYFRAMES); // 40 → 封顶 12
});

// ─────────────────────────── planKeyframeTimes（复用 planFrameExtraction）

test("planKeyframeTimes：60 秒 → 4 个等距中点，落在 (0, duration) 且严格递增", () => {
  const plan = planKeyframeTimes(60);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timesSec.length, 4);
  assert.deepEqual(plan.timesSec, [7.5, 22.5, 37.5, 52.5]);
  for (let i = 0; i < plan.timesSec.length; i++) {
    const t = plan.timesSec[i];
    assert.ok(t > 0 && t < 60, `time ${t} 应在 (0,60)`);
    if (i > 0) assert.ok(t > plan.timesSec[i - 1], "应严格递增");
  }
});

test("planKeyframeTimes：时长 0 → ok:false（不产生非法时间点）", () => {
  const plan = planKeyframeTimes(0);
  assert.equal(plan.ok, false);
});

test("planKeyframeTimes：超过 600 秒上限 → ok:false（沿用 video-frames 的闸门）", () => {
  const plan = planKeyframeTimes(601);
  assert.equal(plan.ok, false);
});

// ─────────────────────────── frameEdgePx

test("frameEdgePx：大于上限缩到 512，小于上限维持原长边", () => {
  assert.equal(frameEdgePx(1920, 1080), 512);
  assert.equal(frameEdgePx(512, 288), 512);
  assert.equal(frameEdgePx(400, 300), 400);
  assert.equal(frameEdgePx(0, 0), 0);
  assert.equal(frameEdgePx(Number.NaN, 100), 100);
});

// ─────────────────────────── computeDerivedBytes

test("computeDerivedBytes：只加有效位元组，忽略 NaN／负值／0", () => {
  assert.equal(computeDerivedBytes([10, 20, Number.NaN, -5, 0]), 30);
  assert.equal(computeDerivedBytes([]), 0);
  assert.equal(computeDerivedBytes([Number.POSITIVE_INFINITY]), 0);
});

// ─────────────────────────── estimateProbeJsonBytes

test("estimateProbeJsonBytes：等于实际 JSON 的 UTF-8 位元组数", () => {
  const probe: LocalMediaProbe = {
    durationSec: 60,
    width: 1920,
    height: 1080,
    hasAudio: true,
    sizeBytes: 12_345,
  };
  const expected = new TextEncoder().encode(JSON.stringify(probe)).length;
  assert.equal(estimateProbeJsonBytes(probe), expected);
  assert.ok(estimateProbeJsonBytes(probe) > 0);
});

// ─────────────────────────── isIngestUsable

test("isIngestUsable：null／降级／零关键帧皆不可用，正常结果可用", () => {
  const base: LocalMediaIngest = {
    probe: {
      durationSec: 60,
      width: 1920,
      height: 1080,
      hasAudio: true,
      sizeBytes: 1000,
    },
    keyframes: [keyframe(7.5, 100)],
    poster: makeBlob(50),
    derivedBytes: 150,
    sourceBytes: 1000,
  };
  assert.equal(isIngestUsable(null), false);
  assert.equal(isIngestUsable(undefined), false);
  assert.equal(isIngestUsable({ ...base, degraded: "boom" }), false);
  assert.equal(isIngestUsable({ ...base, keyframes: [] }), false);
  assert.equal(isIngestUsable(base), true);
});

// ─────────────────────────── toDerivedFiles

test("toDerivedFiles：关键帧 → poster → probe，命名与 mime 正确，空 poster 不送", async () => {
  const result: LocalMediaIngest = {
    probe: {
      durationSec: 60,
      width: 1920,
      height: 1080,
      hasAudio: null,
      sizeBytes: 1000,
    },
    keyframes: [keyframe(7.5, 100), keyframe(22.5, 120)],
    poster: makeBlob(50),
    derivedBytes: 270,
    sourceBytes: 1000,
  };
  const files = toDerivedFiles(result, "my clip.mp4");
  assert.deepEqual(
    files.map((f) => f.name),
    ["my clip-keyframe-1.jpg", "my clip-keyframe-2.jpg", "my clip-poster.jpg", "my clip-probe.json"],
  );
  assert.equal(files[0].type, "image/jpeg");
  assert.equal(files[2].type, "image/jpeg");
  assert.equal(files[3].type, "application/json");
  assert.equal(await files[3].text(), JSON.stringify(result.probe));

  const noPoster = toDerivedFiles({ ...result, poster: makeBlob(0) }, "a.webm");
  assert.deepEqual(
    noPoster.map((f) => f.name),
    ["a-keyframe-1.jpg", "a-keyframe-2.jpg", "a-probe.json"],
  );
});

// ─────────────────────────── detectHasAudio

test("detectHasAudio：Firefox mozHasAudio 为权威；0 解码位元组回 null 不冒充", () => {
  assert.equal(detectHasAudio({ mozHasAudio: true } as unknown as HTMLVideoElement), true);
  assert.equal(detectHasAudio({ mozHasAudio: false } as unknown as HTMLVideoElement), false);
  assert.equal(
    detectHasAudio({ audioTracks: { length: 1 } } as unknown as HTMLVideoElement),
    true,
  );
  assert.equal(
    detectHasAudio({ audioTracks: { length: 0 } } as unknown as HTMLVideoElement),
    false,
  );
  // Chromium 未解码时 webkitAudioDecodedByteCount 恒为 0：未知，不可当「无音轨」。
  assert.equal(
    detectHasAudio({ webkitAudioDecodedByteCount: 0 } as unknown as HTMLVideoElement),
    null,
  );
  assert.equal(
    detectHasAudio({ webkitAudioDecodedByteCount: 4096 } as unknown as HTMLVideoElement),
    true,
  );
  assert.equal(detectHasAudio({} as unknown as HTMLVideoElement), null);
});

// ─────────────────────────── runLocalMediaIngest：成功路径

test("runLocalMediaIngest：成功 → probe 齐全、位元率＝size*8/duration、derivedBytes 正确、无 degraded", async () => {
  const file = makeFile(1_200_000);
  const session = new FakeSession();
  const stages: string[] = [];
  const result = await runLocalMediaIngest(file, session, {
    onProgress: (stage) => stages.push(stage),
  });

  assert.equal(result.degraded, undefined);
  assert.equal(result.sourceBytes, 1_200_000);
  assert.equal(result.probe.durationSec, 60);
  assert.equal(result.probe.width, 1920);
  assert.equal(result.probe.height, 1080);
  assert.equal(result.probe.hasAudio, true);
  assert.equal(result.probe.bitrate, Math.round((1_200_000 * 8) / 60));
  assert.equal(result.keyframes.length, 4);
  assert.equal(result.poster.size, 50);
  assert.ok(result.keyframes.every((k) => k.edgePx === 512));
  const expectedDerived = computeDerivedBytes([
    ...result.keyframes.map((k) => k.blob.size),
    result.poster.size,
    estimateProbeJsonBytes(result.probe),
  ]);
  assert.equal(result.derivedBytes, expectedDerived);
  assert.ok(stages.includes("metadata"));
  assert.ok(stages.includes("frames"));
  assert.ok(stages.includes("poster"));
  assert.ok(stages.includes("done"));
  // run 不负责 dispose（由外层 ingestMediaLocally 收尾）。
  assert.equal(session.disposed, false);
});

// ─────────────────────────── runLocalMediaIngest：降级路径

test("runLocalMediaIngest：metadata 失败 → 不抛出，degraded 记因，无关键帧", async () => {
  const session = new FakeSession({ metadata: "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("metadata"));
  assert.equal(result.keyframes.length, 0);
  assert.equal(result.probe.durationSec, null);
  assert.equal(session.extractCalls, 0); // 没时长就不抽帧
  // 设计：单步失败不中断整条流程，海报仍会尝试（真浏览器多半也在此步失败 → 一并记因）。
  assert.equal(session.posterCalls, 1);
  assert.equal(result.poster.size, 50);
});

test("runLocalMediaIngest：抽帧失败但海报成功 → 记 frames、保留海报、不抛出", async () => {
  const session = new FakeSession({ onExtract: () => "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("frames"));
  assert.equal(result.keyframes.length, 0);
  assert.equal(result.poster.size, 50);
  assert.equal(session.posterCalls, 1);
});

test("runLocalMediaIngest：海报失败 → 退回第一张关键帧当海报，记 poster", async () => {
  const session = new FakeSession({ poster: "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("poster"));
  assert.equal(result.keyframes.length, 4);
  assert.equal(result.poster, result.keyframes[0].blob);
});

test("runLocalMediaIngest：时长未知（null）→ 记 plan，不抽帧也不抛出", async () => {
  const session = new FakeSession({
    metadata: { durationSec: null, width: 100, height: 100, hasAudio: null },
  });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("plan"));
  assert.equal(session.extractCalls, 0);
});

test("runLocalMediaIngest：衍生档超过上行闸门 → 记 derived_too_large", async () => {
  const perFrame = Math.ceil(MAX_DERIVED_UPLOAD_BYTES / 2); // 4 帧远超闸门
  const session = new FakeSession({
    onExtract: (times) => times.map((t, i) => keyframe(t, perFrame + i)),
    poster: makeBlob(10),
  });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("derived_too_large"));
  assert.equal(result.keyframes.length, 4);
});

test("runLocalMediaIngest：signal 已 abort → 记 aborted，完全不碰 session", async () => {
  const controller = new AbortController();
  controller.abort();
  const session = new FakeSession();
  const result = await runLocalMediaIngest(makeFile(1000), session, { signal: controller.signal });

  assert.ok(result.degraded?.includes("aborted"));
  assert.equal(session.metadataCalls, 0);
  assert.equal(session.extractCalls, 0);
  assert.equal(session.posterCalls, 0);
});

test("runLocalMediaIngest：onProgress 抛错不弄坏管线", async () => {
  const session = new FakeSession();
  const result = await runLocalMediaIngest(makeFile(1000), session, {
    onProgress: () => {
      throw new Error("ui-boom");
    },
  });
  assert.equal(result.degraded, undefined);
  assert.equal(result.keyframes.length, 4);
});

// ─────────────────────── BUG-1 端到端（假 DOM）：ingestMediaLocally 绝不永久 pending
//
// 这里用最小假 <video>/<canvas> 与假 document/URL 走真正的 createBrowserMediaSession，
// 精确重现「error 只发一次、第二次等待」的原始卡死情境。

type VideoDomMode = "error-once" | "seek-hang";

interface FakeDomVideo {
  readyState: number;
  error: { code: number } | null;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  preload: string;
  muted: boolean;
  playsInline: boolean;
  currentTime: number;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  removeAttribute(): void;
  load(): void;
  listenerCount(type: string): number;
  fire(type: string): void;
}

function makeFakeVideo(mode: VideoDomMode): FakeDomVideo {
  const listeners = new Map<string, Set<() => void>>();
  const v = {
    readyState: 0,
    error: null as { code: number } | null,
    duration: Number.NaN,
    videoWidth: 0,
    videoHeight: 0,
    preload: "",
    muted: false,
    playsInline: false,
    currentTime: 0,
    _src: "",
    addEventListener(type: string, cb: () => void): void {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    },
    removeEventListener(type: string, cb: () => void): void {
      listeners.get(type)?.delete(cb);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
    fire(type: string): void {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    removeAttribute(): void {},
    load(): void {},
  };
  Object.defineProperty(v, "src", {
    get(): string {
      return v._src;
    },
    set(val: string): void {
      v._src = val;
      if (mode === "error-once") {
        // 真实浏览器：error 只发一次，且发前先设 video.error（readyState 停在 0）。
        queueMicrotask(() => {
          v.error = { code: 4 };
          v.fire("error");
        });
      } else {
        // seek-hang：metadata 正常（readyState=HAVE_METADATA），但不发 seeked。
        v.readyState = 1;
        v.duration = 10;
        v.videoWidth = 640;
        v.videoHeight = 480;
      }
    },
  });
  return v as unknown as FakeDomVideo;
}

function installFakeVideoDom(mode: VideoDomMode): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const origDoc = g.document;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage(): void {} }),
    toBlob: (cb: (b: Blob | null) => void): void => cb(new Blob([], { type: "image/jpeg" })),
  };
  g.document = { createElement: (tag: string) => (tag === "video" ? makeFakeVideo(mode) : canvas) };
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
  return () => {
    if (origDoc === undefined) delete g.document;
    else g.document = origDoc;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  };
}

test(
  "BUG-1：不可解码档（error 只发一次）→ ingestMediaLocally 立即回 degraded，绝不永久 pending",
  { timeout: 5000 },
  async () => {
    const restore = installFakeVideoDom("error-once");
    try {
      const started = Date.now();
      const result = await ingestMediaLocally(makeFile(1500));
      const elapsed = Date.now() - started;
      assert.ok(result.degraded, "坏档必须带 degraded，呼叫端才知道退回原档路径");
      assert.match(result.degraded!, /metadata/);
      assert.equal(result.keyframes.length, 0);
      assert.ok(
        elapsed < 1000,
        `必须立即回（实测 ${elapsed}ms）；不得靠 10s timeout 才 settle，更不能无限 pending`,
      );
    } finally {
      restore();
    }
  },
);

test(
  "BUG-1：某一阶段卡死（永不 seeked）→ 总 timeout 兜底回 degraded，不永久 pending",
  { timeout: 5000 },
  async () => {
    const restore = installFakeVideoDom("seek-hang");
    try {
      const started = Date.now();
      const result = await ingestMediaLocally(makeFile(1500), { timeoutMs: 40 });
      const elapsed = Date.now() - started;
      assert.ok(result.degraded, "逾时必须带 degraded");
      assert.match(result.degraded!, /timeout/);
      assert.ok(elapsed >= 30 && elapsed < 2000, `应在 timeout 附近回（实测 ${elapsed}ms）`);
    } finally {
      restore();
    }
  },
);
