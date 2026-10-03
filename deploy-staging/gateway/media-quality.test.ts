// media-quality.test.ts — gateway 側事後產物硬檢（確定性量測）的真行為驗收（2026-10-03）。
//
// 定位：量測**只**覆蓋技術正確性（容器/視訊流/寬高/時長/音軌/非靜音/可解析），**不**審美。
// 驗收要點（照任務）：
//   ① 量測成功 → 以 score+scoreSource:"measured" 寫進 critic_verdicts；
//   ② ffprobe 不可用／量測失敗 → 維持 null，且**不 throw**（交付旁路）；
//   ③ 量測失敗時數值閾值不誤觸（來源非 measured／分數為 null）。
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

// persistence 於模組載入時固定 DB 路徑 → 先設 env 再動態 import（不碰生產 sessions.db）。
process.env.SESSIONS_DB_PATH = join(mkdtempSync(join(tmpdir(), "mq-gate-")), "sessions.db")
// 預設 OFF：確認我們不靠 env 也能用注入的 prober 測；真實 probe 路徑（ffprobeAvailable）
// 在本機有 ffprobe，故不在此觸發。
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
  error: "ffprobe 不存在（系統未安裝）",
  container: null,
  durationSec: null,
  sizeBytes: null,
  video: null,
  audio: null,
})

describe("media-quality 純函式（政策/failure code/技術分）", () => {
  test("good 影片通過 video_default；good 音訊通過 audio_default", () => {
    const v = evaluateMediaQuality(okVideoProbe(), QUALITY_POLICIES.video_default)
    expect(v.ok).toBe(true)
    expect(v.failures).toEqual([])
    const a = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.audio_default)
    expect(a.ok).toBe(true)
  })

  test("缺視覺流：video_default 判 fail（video_stream_missing），非未知→pass", () => {
    const v = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.video_default)
    expect(v.ok).toBe(false)
    expect(v.failures.map((f) => f.code)).toContain("video_stream_missing")
  })

  test("probe 不可用 → 未知≠通過：failures 帶 probe_unavailable，技術分為 null（不是 0）", () => {
    const v = evaluateMediaQuality(unavailableProbe(), QUALITY_POLICIES.audio_default)
    expect(v.ok).toBe(false)
    expect(v.failures[0].code).toBe("probe_unavailable")
    expect(scoreFromVerdict(v)).toBeNull()
    expect(measuredScoreFromVerdicts([v])).toBeNull()
  })

  test("技術分確定性：全通過=10；缺音軌=5（<7 會觸發閾值）；取多件最低", () => {
    const ok = evaluateMediaQuality(okAudioProbe(), QUALITY_POLICIES.audio_default)
    expect(scoreFromVerdict(ok)).toBe(10)
    const bad = evaluateMediaQuality({ ...okAudioProbe(), audio: null }, QUALITY_POLICIES.audio_default)
    expect(scoreFromVerdict(bad)).toBe(5)
    const vd = evaluateMediaQuality(okVideoProbe(), QUALITY_POLICIES.video_default)
    expect(measuredScoreFromVerdicts([ok, vd])).toBe(10)
    expect(measuredScoreFromVerdicts([ok, bad])).toBe(5)
  })

  test("extractMediaTargets：抽 video/audio，去重、忽略非媒體、封頂 4", () => {
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

  test("policyForUrl：依副檔名選政策；未知型別回 null（不猜）", () => {
    expect(policyForUrl(AUDIO_URL)?.id).toBe("audio_default")
    expect(policyForUrl(VIDEO_URL)?.id).toBe("video_default")
    expect(policyForUrl("https://example.com/x.png")?.id).toBe("image_default")
    expect(policyForUrl("https://example.com/x.txt")).toBeNull()
  })
})

describe("measureMediaScore 編排（可注入 prober）", () => {
  test("量測成功：回技術分與件數", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], { enabled: true, probe: async () => okAudioProbe() })
    expect(r).not.toBeNull()
    expect(r!.score).toBe(10)
    expect(r!.artifacts).toBe(1)
  })

  test("ffprobe 不可用（probe 回 unavailable）→ null 且不 throw", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], { enabled: true, probe: async () => unavailableProbe() })
    expect(r).toBeNull()
  })

  test("prober 直接拋錯 → 被吞、回 null、不 throw 到呼叫端", async () => {
    const r = await measureMediaScore([`audio_url: ${AUDIO_URL}`], {
      enabled: true,
      probe: async () => {
        throw new Error("boom")
      },
    })
    expect(r).toBeNull()
  })

  test("開關 OFF（預設）→ 不量測、回 null（不 spawn、不下載）", async () => {
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

  test("正文無媒體 URL → null", async () => {
    const r = await measureMediaScore(["没有任何链接"], { enabled: true, probe: async () => okAudioProbe() })
    expect(r).toBeNull()
  })
})

describe("measured 落地 critic_verdicts 與閾值語義", () => {
  test("量測成功 → score_source='measured'，meanScore 反映；閾值對低分強制、達標不強制", async () => {
    const runId = `mq-${Date.now().toString(36)}`
    // 端到端模擬 subagent.applyMeasuredMediaVerdict 的落地契約：
    // 先由 measureMediaScore 從交付正文量出技術分（此處注入「缺音軌」的音訊 probe → 5 分），
    // 再以該分數 + scoreSource:"measured" 寫入 critic_verdicts。
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

  test("量測失敗時維持 null（model_self 分類列）→ 閾值不誤觸", () => {
    const runId = `mq-null-${Date.now().toString(36)}`
    // subagent 先在 finishRun 同步寫 model_self/null；量測失敗時**不改寫**任何分數。
    persistence.saveCriticVerdict({ sessionId: "s-mq2", runId, agent: "critic", verdict: "pass", score: null, scoreSource: "model_self" })
    const got = persistence.getCriticVerdictByRun(runId)!
    expect(got.score).toBeNull()
    expect(got.score_source).toBe("model_self")
    expect(gate.evaluateCriticScoreThreshold({ value: got.score, source: got.score_source }).enforce).toBe(false)
  })
})
