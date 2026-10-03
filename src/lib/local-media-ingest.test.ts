// local-media-ingest 單元測試（runner：npx --yes tsx --test）。
//
// 環境無 DOM：只測純邏輯（計劃幀數／時間點／邊長／位元組加總／音軌判定），
// 加上用可注入的假 LocalMediaSession 覆蓋執行層的成功與各條降級路徑。
// 真正的 <video>/<canvas> 解碼不在這裡（見回報的待 E2E 清單）。

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

// ─────────────────────────── 測試輔助

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

test("planKeyframeCount：非法／非正時長回下限", () => {
  assert.equal(planKeyframeCount(0), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(-5), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(Number.NaN), MIN_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(Number.POSITIVE_INFINITY), MIN_LOCAL_KEYFRAMES);
});

test("planKeyframeCount：隨時長增加、夾在下限與上限之間", () => {
  assert.equal(planKeyframeCount(1), MIN_LOCAL_KEYFRAMES); // 短於一單位仍取下限
  assert.equal(planKeyframeCount(60), 4);
  assert.equal(planKeyframeCount(75), 5);
  assert.equal(planKeyframeCount(150), 10);
  assert.equal(planKeyframeCount(180), MAX_LOCAL_KEYFRAMES);
  assert.equal(planKeyframeCount(600), MAX_LOCAL_KEYFRAMES); // 40 → 封頂 12
});

// ─────────────────────────── planKeyframeTimes（複用 planFrameExtraction）

test("planKeyframeTimes：60 秒 → 4 個等距中點，落在 (0, duration) 且嚴格遞增", () => {
  const plan = planKeyframeTimes(60);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timesSec.length, 4);
  assert.deepEqual(plan.timesSec, [7.5, 22.5, 37.5, 52.5]);
  for (let i = 0; i < plan.timesSec.length; i++) {
    const t = plan.timesSec[i];
    assert.ok(t > 0 && t < 60, `time ${t} 應在 (0,60)`);
    if (i > 0) assert.ok(t > plan.timesSec[i - 1], "應嚴格遞增");
  }
});

test("planKeyframeTimes：時長 0 → ok:false（不產生非法時間點）", () => {
  const plan = planKeyframeTimes(0);
  assert.equal(plan.ok, false);
});

test("planKeyframeTimes：超過 600 秒上限 → ok:false（沿用 video-frames 的閘門）", () => {
  const plan = planKeyframeTimes(601);
  assert.equal(plan.ok, false);
});

// ─────────────────────────── frameEdgePx

test("frameEdgePx：大於上限縮到 512，小於上限維持原長邊", () => {
  assert.equal(frameEdgePx(1920, 1080), 512);
  assert.equal(frameEdgePx(512, 288), 512);
  assert.equal(frameEdgePx(400, 300), 400);
  assert.equal(frameEdgePx(0, 0), 0);
  assert.equal(frameEdgePx(Number.NaN, 100), 100);
});

// ─────────────────────────── computeDerivedBytes

test("computeDerivedBytes：只加有效位元組，忽略 NaN／負值／0", () => {
  assert.equal(computeDerivedBytes([10, 20, Number.NaN, -5, 0]), 30);
  assert.equal(computeDerivedBytes([]), 0);
  assert.equal(computeDerivedBytes([Number.POSITIVE_INFINITY]), 0);
});

// ─────────────────────────── estimateProbeJsonBytes

test("estimateProbeJsonBytes：等於實際 JSON 的 UTF-8 位元組數", () => {
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

test("isIngestUsable：null／降級／零關鍵幀皆不可用，正常結果可用", () => {
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

test("toDerivedFiles：關鍵幀 → poster → probe，命名與 mime 正確，空 poster 不送", async () => {
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

test("detectHasAudio：Firefox mozHasAudio 為權威；0 解碼位元組回 null 不冒充", () => {
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
  // Chromium 未解碼時 webkitAudioDecodedByteCount 恆為 0：未知，不可當「無音軌」。
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

// ─────────────────────────── runLocalMediaIngest：成功路徑

test("runLocalMediaIngest：成功 → probe 齊全、位元率＝size*8/duration、derivedBytes 正確、無 degraded", async () => {
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
  // run 不負責 dispose（由外層 ingestMediaLocally 收尾）。
  assert.equal(session.disposed, false);
});

// ─────────────────────────── runLocalMediaIngest：降級路徑

test("runLocalMediaIngest：metadata 失敗 → 不拋出，degraded 記因，無關鍵幀", async () => {
  const session = new FakeSession({ metadata: "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("metadata"));
  assert.equal(result.keyframes.length, 0);
  assert.equal(result.probe.durationSec, null);
  assert.equal(session.extractCalls, 0); // 沒時長就不抽幀
  // 設計：單步失敗不中斷整條流程，海報仍會嘗試（真瀏覽器多半也在此步失敗 → 一併記因）。
  assert.equal(session.posterCalls, 1);
  assert.equal(result.poster.size, 50);
});

test("runLocalMediaIngest：抽幀失敗但海報成功 → 記 frames、保留海報、不拋出", async () => {
  const session = new FakeSession({ onExtract: () => "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("frames"));
  assert.equal(result.keyframes.length, 0);
  assert.equal(result.poster.size, 50);
  assert.equal(session.posterCalls, 1);
});

test("runLocalMediaIngest：海報失敗 → 退回第一張關鍵幀當海報，記 poster", async () => {
  const session = new FakeSession({ poster: "throw" });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("poster"));
  assert.equal(result.keyframes.length, 4);
  assert.equal(result.poster, result.keyframes[0].blob);
});

test("runLocalMediaIngest：時長未知（null）→ 記 plan，不抽幀也不拋出", async () => {
  const session = new FakeSession({
    metadata: { durationSec: null, width: 100, height: 100, hasAudio: null },
  });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("plan"));
  assert.equal(session.extractCalls, 0);
});

test("runLocalMediaIngest：衍生檔超過上行閘門 → 記 derived_too_large", async () => {
  const perFrame = Math.ceil(MAX_DERIVED_UPLOAD_BYTES / 2); // 4 幀遠超閘門
  const session = new FakeSession({
    onExtract: (times) => times.map((t, i) => keyframe(t, perFrame + i)),
    poster: makeBlob(10),
  });
  const result = await runLocalMediaIngest(makeFile(1000), session);

  assert.ok(result.degraded?.includes("derived_too_large"));
  assert.equal(result.keyframes.length, 4);
});

test("runLocalMediaIngest：signal 已 abort → 記 aborted，完全不碰 session", async () => {
  const controller = new AbortController();
  controller.abort();
  const session = new FakeSession();
  const result = await runLocalMediaIngest(makeFile(1000), session, { signal: controller.signal });

  assert.ok(result.degraded?.includes("aborted"));
  assert.equal(session.metadataCalls, 0);
  assert.equal(session.extractCalls, 0);
  assert.equal(session.posterCalls, 0);
});

test("runLocalMediaIngest：onProgress 拋錯不弄壞管線", async () => {
  const session = new FakeSession();
  const result = await runLocalMediaIngest(makeFile(1000), session, {
    onProgress: () => {
      throw new Error("ui-boom");
    },
  });
  assert.equal(result.degraded, undefined);
  assert.equal(result.keyframes.length, 4);
});
