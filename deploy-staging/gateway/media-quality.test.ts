// media-quality.test.ts — gateway 侧事后产物硬检（确定性量测）的真行为验收（2026-10-03）。
//
// 定位：量测**只**覆盖技术正确性（容器/视讯流/宽高/时长/音轨/非静音/可解析），**不**审美。
// 验收要点（照任务）：
//   ① 量测成功 → 以 score+scoreSource:"measured" 写进 critic_verdicts；
//   ② ffprobe 不可用／量测失败 → 维持 null，且**不 throw**（交付旁路）；
//   ③ 量测失败时数值阈值不误触（来源非 measured／分数为 null）。
// 跑法：cd deploy-staging/gateway && bun test media-quality.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  evaluateMediaQuality,
  scoreFromVerdict,
  measuredScoreFromVerdicts,
  extractMediaTargets,
  policyForUrl,
  measureMediaScore,
  QUALITY_POLICIES,
  type MediaProbe,
} from "./media-quality.ts"

// persistence 于模组载入时固定 DB 路径 → 先设 env 再动态 import（不碰生产 sessions.db）。
process.env.SESSIONS_DB_PATH = join(mkdtempSync(join(tmpdir(), "mq-gate-")), "sessions.db")
// 预设 OFF：确认我们不靠 env 也能用注入的 prober 测；真实 probe 路径（ffprobeAvailable）
// 在本机有 ffprobe，故不在此触发。
delete process.env.MEDIA_QUALITY_GATE
const persistence = await import("./persistence")
const gate = await import("./delivery-gate.ts")
persistence.initPersistence()

const AUDIO_URL = "https://store.tinchak0207.xyz/image-data/files/uploads/demo.mp3"
const VIDEO_URL = "https://store.tinchak0207.xyz/image-data/files/uploads/demo.mp4"

function okVideoProbe(): MediaProbe {
  return {
    status: "ok",
    error: null,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSec: 5,
    sizeBytes: 500_000,
    video: { codec: "h264", width: 1280, height: 720 },
    audio: { codec: "aac", meanVolumeDb: -18, maxVolumeDb: -3 },
  }
}

function okAudioProbe(): MediaProbe {
  return {
    status: "ok",
    error: null,
    container: "mp3",
    durationSec: 30,
    sizeBytes: 480_000,
    video: null,
    audio: { codec: "mp3", meanVolumeDb: -20, maxVolumeDb: -4 },
  }
}

const unavailableProbe = (): MediaProbe => ({
  status: "probe_unavailable",
  error: "ffprobe 不存在（系统未安装）",
  container: null,
  durationSec: null,
  sizeBytes: null,
  video: null,
  audio: null,
})

describe("media-quality 纯函式（政策/failure code/技术分）", () => {
  test("good 影片通过 video_default；good 音讯通过 audio_default", () => {
    const v = evaluateMediaQuality(okVideoProbe(), QUALITY_POLICIES.video_default)
    expect(v.ok).toBe(true)
    expect(v.failures).toEqual([])
    const a = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.audio_default)
    expect(a.ok).toBe(true)
  })

  test("缺视觉流：video_default 判 fail（video_stream_missing），非未知→pass", () => {
    const v = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.video_default)
    expect(v.ok).toBe(false)
    expect(v.failures.map((f) => f.code)).toContain("video_stream_missing")
  })

  test("probe 不可用 → 未知≠通过：failures 带 probe_unavailable，技术分为 null（不是 0）", () => {
    const v = evaluateMediaQuality(unavailableProbe(), QUALITY_POLICIES.audio_default)
    expect(v.ok).toBe(false)
    expect(v.failures[0].code).toBe("probe_unavailable")
    expect(scoreFromVerdict(v)).toBeNull()
    expect(measuredScoreFromVerdicts([v])).toBeNull()
  })

  test("技术分确定性：全通过=10；缺音轨=5（<7 会触发阈值）；取多件最低", () => {
    const ok = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.audio_default)
    expect(scoreFromVerdict(ok)).toBe(10)
    const bad = evaluateMediaQuality({ ...okAudioProbe(), audio: null }, QUALITY_POLICIES.audio_default)
    expect(scoreFromVerdict(bad)).toBe(5)
    const vd = evaluateMediaQuality(okVideoProbe(), QUALITY_POLICIES.video_default)
    expect(measuredScoreFromVerdicts([ok, vd])).toBe(10)
    expect(measuredScoreFromVerdicts([ok, bad])).toBe(5)
  })

  test("extractMediaTargets：抽 video/audio，去重、忽略非媒体、封顶 4", () => {
    const text = [
      `audio_url: ${AUDIO_URL}`,
      `video_url: ${VIDEO_URL}`,
      `dup: ${AUDIO_URL}`,
      "https://example.com/page.html",
      "https://example.com/a.png",
      "https://example.com/b.mp3",
      "https://example.com/c.wav",
      "https://example.com/d.m4a",
      "https://example.com/e.ogg",
    ].join("\n")
    const got = extractMediaTargets(text)
    expect(got).toContain(AUDIO_URL)
    expect(got).toContain(VIDEO_URL)
    expect(got.filter((u) => u === AUDIO_URL).length).toBe(1)
    expect(got).not.toContain("https://example.com/page.html")
    expect(got.length).toBeLessThanOrEqual(4)
  })

  test("policyForUrl：依副档名选政策；未知型别回 null（不猜）", () => {
    expect(policyForUrl(AUDIO_URL)?.id).toBe("audio_default")
    expect(policyForUrl(VIDEO_URL)?.id).toBe("video_default")
    expect(policyForUrl("https://example.com/x.png")?.id).toBe("image_default")
    expect(policyForUrl("https://example.com/x.txt")).toBeNull()
  })
})

describe("measureMediaScore 编排（可注入 prober）", () => {
  test("量测成功：回技术分与件数", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], { enabled: true, probe: async () => okAudioProbe() })
    expect(r).not.toBeNull()
    expect(r!.score).toBe(10)
    expect(r!.artifacts).toBe(1)
  })

  test("ffprobe 不可用（probe 回 unavailable）→ null 且不 throw", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], { enabled: true, probe: async () => unavailableProbe() })
    expect(r).toBeNull()
  })

  test("prober 直接抛错 → 被吞、回 null、不 throw 到呼叫端", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], {
      enabled: true,
      probe: async () => {
        throw new Error("boom")
      },
    })
    expect(r).toBeNull()
  })

  test("开关 OFF（预设）→ 不量测、回 null（不 spawn、不下载）", async () => {
    let called = 0
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], {
      enabled: false,
      probe: async () => {
        called++
        return okAudioProbe()
      },
    })
    expect(r).toBeNull()
    expect(called).toBe(0)
  })

  test("正文无媒体 URL → null", async () => {
    const r = await measureMediaScore(["没有任何链接"], { enabled: true, probe: async () => okAudioProbe() })
    expect(r).toBeNull()
  })
})

describe("measured 落地 critic_verdicts 与阈值语义", () => {
  test("量测成功 → score_source='measured'，meanScore 反映；阈值对低分强制、达标不强制", async () => {
    const runId = `mq-${Date.now().toString(36)}`
    // 端到端模拟 subagent.applyMeasuredMediaVerdict 的落地契约：
    // 先由 measureMediaScore 从交付正文量出技术分（此处注入「缺音轨」的音讯 probe → 5 分），
    // 再以该分数 + scoreSource:"measured" 写入 critic_verdicts。
    const measured = await measureMediaScore([`audio_url: ${AUDIO_URL}`], {
      enabled: true,
      probe: async () => ({ ...okAudioProbe(), audio: null }),
    })
    expect(measured).not.toBeNull()
    expect(measured!.score).toBe(5)
    persistence.saveCriticVerdict({
      sessionId: "s-mq",
      runId,
      agent: "critic",
      verdict: "pass",
      score: measured!.score,
      scoreSource: "measured",
      judgeModel: "hardcheck/ffprobe",
      verdictText: measured!.detail,
    })
    const got = persistence.getCriticVerdictByRun(runId)!
    expect(got.score).toBe(5)
    expect(got.score_source).toBe("measured")
    expect(persistence.qualitySignalStats().meanScore).not.toBeNull()
    expect(gate.evaluateCriticScoreThreshold({ value: got.score, source: got.score_source }).enforce).toBe(true)
    expect(gate.evaluateCriticScoreThreshold({ value: 9, source: "measured" }).enforce).toBe(false)
  })

  test("量测失败时维持 null（model_self 分类列）→ 阈值不误触", () => {
    const runId = `mq-null-${Date.now().toString(36)}`
    // subagent 先在 finishRun 同步写 model_self/null；量测失败时**不改写**任何分数。
    persistence.saveCriticVerdict({ sessionId: "s-mq2", runId, agent: "critic", verdict: "pass", score: null, scoreSource: "model_self" })
    const got = persistence.getCriticVerdictByRun(runId)!
    expect(got.score).toBeNull()
    expect(got.score_source).toBe("model_self")
    expect(gate.evaluateCriticScoreThreshold({ value: got.score, source: got.score_source }).enforce).toBe(false)
  })
})
