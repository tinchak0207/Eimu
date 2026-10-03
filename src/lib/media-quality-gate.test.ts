// media-quality-gate 測試（2026-10-03）——用**真 fixture**，不是 mock 斷言。
//
// 測試期用本機 ffmpeg 生成 1 秒素材到 os.tmpdir()，再餵給 probeMedia 實測；
// 若本機無 ffmpeg 則整組 skip（並在測試名標明）。runner：
//   npx --yes tsx --test src/lib/media-quality-gate.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateMediaQuality, probeMedia, QUALITY_POLICIES, type QualityPolicy } from "./media-quality-gate";

const FFMPEG = "/usr/sbin/ffmpeg";
const FFPROBE = "/usr/sbin/ffprobe";
const FFMPEG_PRESENT = existsSync(FFMPEG) && existsSync(FFPROBE);

let dir = "";
let videoWithAudio = "";
let videoNoAudio = "";
let silentWav = "";
let toneWav = "";
let imagePng = "";

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg fixture 生成失敗（${r.status}）：${r.stderr?.slice(-400)}`);
}

before(() => {
  if (!FFMPEG_PRESENT) return;
  dir = mkdtempSync(path.join(os.tmpdir(), "mq-gate-"));
  videoWithAudio = path.join(dir, "with-audio.mp4");
  videoNoAudio = path.join(dir, "no-audio.mp4");
  silentWav = path.join(dir, "silent.wav");
  toneWav = path.join(dir, "tone.wav");
  imagePng = path.join(dir, "img.png");

  ff(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoWithAudio]);
  ff(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", videoNoAudio]);
  ff(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", silentWav]);
  ff(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", toneWav]);
  ff(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=512x512:duration=1", "-frames:v", "1", imagePng]);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function override(base: QualityPolicy, patch: Partial<QualityPolicy>): QualityPolicy {
  return { ...base, ...patch };
}

test("正常影片（有音軌）：probe 實測 + video_default pass", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const probe = await probeMedia(videoWithAudio);
  assert.equal(probe.status, "ok");
  assert.equal(probe.video?.width, 640);
  assert.equal(probe.video?.height, 480);
  assert.equal(probe.video?.codec, "h264");
  assert.ok(probe.audio, "應偵測到音軌");
  assert.ok(probe.durationSec !== null && Math.abs(probe.durationSec - 1) < 0.2, `時長應約 1s，實測 ${probe.durationSec}`);
  assert.ok((probe.sizeBytes ?? 0) > 0);

  const verdict = evaluateMediaQuality(probe, QUALITY_POLICIES.video_default);
  assert.equal(verdict.ok, true, `failures=${JSON.stringify(verdict.failures)}`);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.policyId, "video_default");
  assert.equal(verdict.measured.width, 640);
});

test("無音軌影片：video_with_audio fail（audio_stream_missing）", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const probe = await probeMedia(videoNoAudio);
  assert.equal(probe.status, "ok");
  assert.equal(probe.audio, null, "無音軌影片不應有 audio");

  const strict = evaluateMediaQuality(probe, QUALITY_POLICIES.video_with_audio);
  assert.equal(strict.ok, false);
  assert.ok(strict.failures.some((f) => f.code === "audio_stream_missing"), JSON.stringify(strict.failures));

  // 同一檔在「音軌可選」的政策下應 pass——證明是政策在判，不是硬編碼。
  const lax = evaluateMediaQuality(probe, QUALITY_POLICIES.video_default);
  assert.equal(lax.ok, true, JSON.stringify(lax.failures));
});

test("時長超界：fail duration_above_max / below_min", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const probe = await probeMedia(videoWithAudio);
  const tooShort = override(QUALITY_POLICIES.video_default, { id: "test_max_0_5", maxDurationSec: 0.5 });
  const v1 = evaluateMediaQuality(probe, tooShort);
  assert.equal(v1.ok, false);
  assert.ok(v1.failures.some((f) => f.code === "duration_above_max"), JSON.stringify(v1.failures));

  const tooLong = override(QUALITY_POLICIES.video_default, { id: "test_min_5", minDurationSec: 5 });
  const v2 = evaluateMediaQuality(probe, tooLong);
  assert.equal(v2.ok, false);
  assert.ok(v2.failures.some((f) => f.code === "duration_below_min"), JSON.stringify(v2.failures));
});

test("解析度不足：fail width_below_min + height_below_min", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const probe = await probeMedia(videoWithAudio);
  const hiRes = override(QUALITY_POLICIES.video_default, { id: "test_1080p", minWidth: 1920, minHeight: 1080 });
  const verdict = evaluateMediaQuality(probe, hiRes);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.code === "width_below_min"), JSON.stringify(verdict.failures));
  assert.ok(verdict.failures.some((f) => f.code === "height_below_min"), JSON.stringify(verdict.failures));
});

test("probe 不可用（路徑不存在）：ok 必須 false 且帶 probe_unavailable", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const missing = path.join(dir, "does-not-exist-1234567890.mp4");
  const probe = await probeMedia(missing);
  assert.equal(probe.status, "probe_unavailable", `error=${probe.error}`);
  assert.ok(probe.error && probe.error.length > 0);

  const verdict = evaluateMediaQuality(probe, QUALITY_POLICIES.video_default);
  assert.equal(verdict.ok, false, "未知不可當通過");
  assert.ok(verdict.failures.some((f) => f.code === "probe_unavailable"), JSON.stringify(verdict.failures));
});

test("音訊：靜音 fail（silent_audio）、有聲 pass", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");

  const silentProbe = await probeMedia(silentWav);
  assert.equal(silentProbe.status, "ok");
  assert.ok(silentProbe.audio, "應偵測到音軌");
  const silentVerdict = evaluateMediaQuality(silentProbe, QUALITY_POLICIES.audio_default);
  assert.equal(silentVerdict.ok, false, `measured=${JSON.stringify(silentVerdict.measured)}`);
  assert.ok(silentVerdict.failures.some((f) => f.code === "silent_audio"), JSON.stringify(silentVerdict.failures));

  const toneProbe = await probeMedia(toneWav);
  const toneVerdict = evaluateMediaQuality(toneProbe, QUALITY_POLICIES.audio_default);
  assert.equal(toneVerdict.ok, true, JSON.stringify(toneVerdict.failures));
  assert.ok(typeof toneProbe.audio?.meanVolumeDb === "number" && (toneProbe.audio?.meanVolumeDb ?? -Infinity) > -60);
});

test("圖片：image_default pass（無時長/音軌也能過）", async (t) => {
  if (!FFMPEG_PRESENT) return t.skip("本機無 ffmpeg，跳過（檔名標明）");
  const probe = await probeMedia(imagePng);
  assert.equal(probe.status, "ok");
  assert.equal(probe.video?.width, 512);
  assert.equal(probe.video?.height, 512);
  assert.equal(probe.audio, null);
  const verdict = evaluateMediaQuality(probe, QUALITY_POLICIES.image_default);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
});
