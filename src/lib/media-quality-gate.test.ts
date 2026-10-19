// 本地路径不再交给 ffprobe。政策判断用合成 MediaProbe，探测入口只断言拒绝。

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMediaQuality, probeMedia, QUALITY_POLICIES, type MediaProbe, type QualityPolicy } from "./media-quality-gate";

function probe(patch: Partial<MediaProbe> = {}): MediaProbe {
  return {
    status: "ok",
    error: null,
    container: "mp4",
    durationSec: 1,
    sizeBytes: 4096,
    video: { codec: "h264", width: 640, height: 480 },
    audio: { codec: "aac", meanVolumeDb: -20, maxVolumeDb: -5 },
    ...patch,
  };
}

function override(base: QualityPolicy, patch: Partial<QualityPolicy>): QualityPolicy {
  return { ...base, ...patch };
}

test("正常影片：video_default pass", () => {
  const sample = probe();
  const verdict = evaluateMediaQuality(sample, QUALITY_POLICIES.video_default);
  assert.equal(verdict.ok, true, `failures=${JSON.stringify(verdict.failures)}`);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.policyId, "video_default");
  assert.equal(verdict.measured.width, 640);
});

test("无音轨影片：video_with_audio fail（audio_stream_missing）", () => {
  const sample = probe({ audio: null });
  const strict = evaluateMediaQuality(sample, QUALITY_POLICIES.video_with_audio);
  assert.equal(strict.ok, false);
  assert.ok(strict.failures.some((failure) => failure.code === "audio_stream_missing"), JSON.stringify(strict.failures));

  const lax = evaluateMediaQuality(sample, QUALITY_POLICIES.video_default);
  assert.equal(lax.ok, true, JSON.stringify(lax.failures));
});

test("时长超界：fail duration_above_max / below_min", () => {
  const sample = probe();
  const tooShort = override(QUALITY_POLICIES.video_default, { id: "test_max_0_5", maxDurationSec: 0.5 });
  const above = evaluateMediaQuality(sample, tooShort);
  assert.equal(above.ok, false);
  assert.ok(above.failures.some((failure) => failure.code === "duration_above_max"), JSON.stringify(above.failures));

  const tooLong = override(QUALITY_POLICIES.video_default, { id: "test_min_5", minDurationSec: 5 });
  const below = evaluateMediaQuality(sample, tooLong);
  assert.equal(below.ok, false);
  assert.ok(below.failures.some((failure) => failure.code === "duration_below_min"), JSON.stringify(below.failures));
});

test("解析度不足：fail width_below_min + height_below_min", () => {
  const sample = probe();
  const hiRes = override(QUALITY_POLICIES.video_default, { id: "test_1080p", minWidth: 1920, minHeight: 1080 });
  const verdict = evaluateMediaQuality(sample, hiRes);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((failure) => failure.code === "width_below_min"), JSON.stringify(verdict.failures));
  assert.ok(verdict.failures.some((failure) => failure.code === "height_below_min"), JSON.stringify(verdict.failures));
});

test("probe 不可用：ok 必须 false 且带 probe_unavailable", () => {
  const sample = probe({ status: "probe_unavailable", error: "拒绝", container: null, durationSec: null, sizeBytes: null, video: null, audio: null });
  const verdict = evaluateMediaQuality(sample, QUALITY_POLICIES.video_default);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((failure) => failure.code === "probe_unavailable"), JSON.stringify(verdict.failures));
});

test("音讯：静音 fail（silent_audio）、有声 pass", () => {
  const silent = probe({ video: null, audio: { codec: "pcm_s16le", meanVolumeDb: Number.NEGATIVE_INFINITY, maxVolumeDb: Number.NEGATIVE_INFINITY } });
  const silentVerdict = evaluateMediaQuality(silent, QUALITY_POLICIES.audio_default);
  assert.equal(silentVerdict.ok, false);
  assert.ok(silentVerdict.failures.some((failure) => failure.code === "silent_audio"), JSON.stringify(silentVerdict.failures));

  const tone = probe({ video: null, audio: { codec: "pcm_s16le", meanVolumeDb: -20, maxVolumeDb: -5 } });
  const toneVerdict = evaluateMediaQuality(tone, QUALITY_POLICIES.audio_default);
  assert.equal(toneVerdict.ok, true, JSON.stringify(toneVerdict.failures));
});

test("图片：image_default pass（无时长/音轨也能过）", () => {
  const sample = probe({ durationSec: null, audio: null, video: { codec: "png", width: 512, height: 512 } });
  const verdict = evaluateMediaQuality(sample, QUALITY_POLICIES.image_default);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
});

test("非 http(s) 与私网地址拒绝，不交给 ffprobe", async () => {
  const local = await probeMedia("/tmp/mq-local.mp4");
  assert.equal(local.status, "probe_unavailable");
  const fileUrl = await probeMedia("file:///tmp/mq-local.mp4");
  assert.equal(fileUrl.status, "probe_unavailable");
  const loopback = await probeMedia("http://127.0.0.1/a.mp4");
  assert.equal(loopback.status, "probe_unavailable");
  const metadata = await probeMedia("http://169.254.169.254/latest/meta-data");
  assert.equal(metadata.status, "probe_unavailable");
});
