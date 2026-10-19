// local-media-worker 单元测试（runner：npx --yes tsx --test）。
//
// 只测 adapter 的行为边界（无真 ffmpeg、无真桌面壳）：
//   1. 无 window.eimuLocal ⇒ hasLocalMediaWorker() false，且三个操作回 { ok:false } 不 throw。
//   2. 有 worker 但 ffmpeg:false ⇒ 同上（reason 为 ffmpeg_unavailable）。
//   3. worker reject ⇒ { ok:false, reason }（原样带回 worker 的讯息）。
//   4. 成功路径 ⇒ 回传形状正确。
//   5. capabilities() 自身 reject ⇒ 不可用且附 capabilities_failed（不 throw）。
// 真正的桌面壳内 ffmpeg 抽帧／转码属 GUI E2E，需真人在壳内验（见回报未验清单）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_CAPABILITIES_FAILED,
  LOCAL_FFMPEG_UNAVAILABLE,
  LOCAL_WORKER_ABSENT,
  extractFramesLocally,
  hasLocalMediaWorker,
  probeLocally,
  transcodeLocally,
  type EimuLocalApi,
  type EimuLocalCapabilities,
} from "./local-media-worker.ts";

// ─────────────────────────── 测试辅助

type GlobalWithLocal = typeof globalThis & { eimuLocal?: EimuLocalApi };

function setWorker(api: EimuLocalApi | undefined): void {
  const g = globalThis as GlobalWithLocal;
  if (api) g.eimuLocal = api;
  else delete g.eimuLocal;
}

const READY_CAPS: EimuLocalCapabilities = { ffmpeg: true, version: "ffmpeg version 6.0", platform: "linux" };
const NO_FFMPEG_CAPS: EimuLocalCapabilities = { ffmpeg: false, version: "", platform: "linux" };

interface ApiOptions {
  caps?: EimuLocalCapabilities | "reject";
  probe?: EimuLocalApi["probe"];
  extractFrames?: EimuLocalApi["extractFrames"];
  transcode?: EimuLocalApi["transcode"];
  onCapabilities?: () => void;
}

function makeApi(opts: ApiOptions = {}): EimuLocalApi {
  const caps = opts.caps ?? READY_CAPS;
  return {
    async capabilities() {
      opts.onCapabilities?.();
      if (caps === "reject") throw new Error("E_INTERNAL: capabilities boom");
      return caps;
    },
    probe:
      opts.probe ??
      (async (path) => ({
        path,
        format: "mp4",
        durationSec: 12.5,
        sizeBytes: 2048,
        streams: [],
      })),
    extractFrames:
      opts.extractFrames ?? (async () => [{ tSec: 0, path: "/tmp/eimu-local-output/frames-a/f0.jpg" }]),
    transcode: opts.transcode ?? (async () => ({ outputPath: "/tmp/eimu-local-output/out.eimu.a1.mp4" })),
  };
}

// ─────────────────────────── 1. 无 eimuLocal

test("无 window.eimuLocal：hasLocalMediaWorker() 为 false", async () => {
  setWorker(undefined);
  assert.equal(await hasLocalMediaWorker(), false);
});

test("无 window.eimuLocal：三个操作均回 { ok:false } 且不 throw", async () => {
  setWorker(undefined);
  const probe = await probeLocally("/tmp/x.mp4");
  const frames = await extractFramesLocally("/tmp/x.mp4");
  const transcode = await transcodeLocally("/tmp/x.mp4");
  assert.deepEqual(probe, { ok: false, reason: LOCAL_WORKER_ABSENT });
  assert.deepEqual(frames, { ok: false, reason: LOCAL_WORKER_ABSENT });
  assert.deepEqual(transcode, { ok: false, reason: LOCAL_WORKER_ABSENT });
});

// ─────────────────────────── 2. 有 worker 但 ffmpeg:false

test("worker 存在但 ffmpeg:false：hasLocalMediaWorker() 为 false，操作回 ffmpeg_unavailable", async () => {
  setWorker(makeApi({ caps: NO_FFMPEG_CAPS }));
  assert.equal(await hasLocalMediaWorker(), false);
  assert.deepEqual(await probeLocally("/tmp/x.mp4"), { ok: false, reason: LOCAL_FFMPEG_UNAVAILABLE });
  assert.deepEqual(await extractFramesLocally("/tmp/x.mp4"), { ok: false, reason: LOCAL_FFMPEG_UNAVAILABLE });
  assert.deepEqual(await transcodeLocally("/tmp/x.mp4"), { ok: false, reason: LOCAL_FFMPEG_UNAVAILABLE });
});

// ─────────────────────────── 3. worker reject ⇒ { ok:false, reason }

test("worker reject：probe/extractFrames/transcode 均收敛成 { ok:false, reason }，不 throw", async () => {
  setWorker(
    makeApi({
      probe: async () => {
        throw new Error("E_NOT_AUTHORIZED: 未经 pickFiles 授权");
      },
      extractFrames: async () => {
        throw new Error("E_FFMPEG_FAILED: exit 1");
      },
      transcode: async () => {
        throw "E_TIMEOUT: 逾时"; // 非 Error 的 reject 也要收敛
      },
    }),
  );
  assert.equal(await hasLocalMediaWorker(), true);
  assert.deepEqual(await probeLocally("/tmp/x.mp4"), {
    ok: false,
    reason: "E_NOT_AUTHORIZED: 未经 pickFiles 授权",
  });
  assert.deepEqual(await extractFramesLocally("/tmp/x.mp4"), { ok: false, reason: "E_FFMPEG_FAILED: exit 1" });
  assert.deepEqual(await transcodeLocally("/tmp/x.mp4"), { ok: false, reason: "E_TIMEOUT: 逾时" });
});

// ─────────────────────────── 4. 成功路径形状

test("成功路径：回传形状正确", async () => {
  let transcodeArgs: unknown[] = [];
  let extractArgs: unknown[] = [];
  setWorker(
    makeApi({
      extractFrames: async (path, plan) => {
        extractArgs = [path, plan];
        return [
          { tSec: 0, path: "/tmp/frames/f0.jpg" },
          { tSec: 3.5, path: "/tmp/frames/f1.jpg" },
        ];
      },
      transcode: async (path, opts) => {
        transcodeArgs = [path, opts];
        return { outputPath: "/tmp/out.mp4" };
      },
    }),
  );

  assert.equal(await hasLocalMediaWorker(), true);

  const probe = await probeLocally("/tmp/in.mp4");
  assert.equal(probe.ok, true);
  if (probe.ok) {
    assert.equal(probe.result.path, "/tmp/in.mp4");
    assert.equal(probe.result.format, "mp4");
    assert.equal(probe.result.durationSec, 12.5);
  }

  const plan = { count: 4 };
  const frames = await extractFramesLocally("/tmp/in.mp4", plan);
  assert.deepEqual(extractArgs, ["/tmp/in.mp4", plan]);
  assert.equal(frames.ok, true);
  if (frames.ok) {
    assert.equal(frames.result.length, 2);
    assert.deepEqual(frames.result[0], { tSec: 0, path: "/tmp/frames/f0.jpg" });
  }

  const opts = { format: "webm" as const, crf: 30 };
  const transcode = await transcodeLocally("/tmp/in.mp4", opts);
  assert.deepEqual(transcodeArgs, ["/tmp/in.mp4", opts]);
  assert.deepEqual(transcode, { ok: true, result: { outputPath: "/tmp/out.mp4" } });
});

// ─────────────────────────── 5. capabilities() reject

test("capabilities() reject：不可用且附 capabilities_failed，不 throw", async () => {
  setWorker(makeApi({ caps: "reject" }));
  assert.equal(await hasLocalMediaWorker(), false);
  const probe = await probeLocally("/tmp/x.mp4");
  assert.equal(probe.ok, false);
  if (!probe.ok) {
    assert.ok(probe.reason.startsWith(LOCAL_CAPABILITIES_FAILED));
    assert.match(probe.reason, /capabilities boom/);
  }
});

// ─────────────────────────── 6. 能力探测快取 + 参数防护

test("能力探测只跑一次（同一 api 物件快取）", async () => {
  let calls = 0;
  setWorker(makeApi({ onCapabilities: () => (calls += 1) }));
  await hasLocalMediaWorker();
  await probeLocally("/tmp/x.mp4");
  await transcodeLocally("/tmp/x.mp4");
  assert.equal(calls, 1);
});

test("空字串路径回 bad_file_path，不呼叫 worker", async () => {
  let probed = false;
  setWorker(
    makeApi({
      probe: async (path) => {
        probed = true;
        return { path, format: null, durationSec: null, sizeBytes: null, streams: [] };
      },
    }),
  );
  assert.deepEqual(await probeLocally(""), { ok: false, reason: "bad_file_path" });
  assert.equal(probed, false);
});

test.afterEach(() => {
  setWorker(undefined);
});
