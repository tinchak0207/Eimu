// 契约测试（2026-09-15）：母带导出指纹 / URL 守卫 / 字幕分屏。
// 设计来源 AID（MIT，copyright 光子讯息(杭州)科技有限公司），见两支被测档的档头注释。
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeExportFingerprint,
  normalizeMaterialPath,
  isForbiddenMaterialUrl,
  type ExportFingerprintInput,
} from "./material-fingerprint"
import {
  splitSubtitleForScreens,
  subtitleCharCount,
  SUBTITLE_MIN_SCREEN_CHARS,
  SUBTITLE_MAX_SCREEN_CHARS,
  SUBTITLE_DEFAULT_MAX_CHARS,
} from "./subtitle-splitter"

const baseInput = (): ExportFingerprintInput => ({
  clips: [
    { path: "/media/a.mp4", durationSec: 3 },
    { path: "/media/b.mp4", durationSec: 4.5 },
  ],
  audioClips: [
    { path: "/media/vo2.wav", durationSec: 2, startSec: 3 },
    { path: "/media/vo1.wav", durationSec: 3, startSec: 0 },
  ],
  subtitles: [
    { startSec: 3, endSec: 5, text: "第二句" },
    { startSec: 0, endSec: 2, text: "第一句" },
  ],
  bgm: { path: "/media/bgm.mp3", volume: 0.3 },
  aspect: "16:9",
  presetId: "landscape_169",
})

// ── computeExportFingerprint ────────────────────────────────────────────────

test("指纹：同输入两次 → 同值（64 hex）", () => {
  const a = computeExportFingerprint(baseInput())
  const b = computeExportFingerprint(baseInput())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test("指纹：序列化不受物件键序影响", () => {
  const a = computeExportFingerprint(baseInput())
  const shuffled = {
    presetId: "landscape_169",
    aspect: "16:9",
    subtitles: baseInput().subtitles,
    bgm: { volume: 0.3, path: "/media/bgm.mp3" },
    audioClips: baseInput().audioClips,
    clips: baseInput().clips,
  } as ExportFingerprintInput
  assert.equal(computeExportFingerprint(shuffled), a)
})

test("指纹：改任一栏位 → 不同值", () => {
  const base = computeExportFingerprint(baseInput())
  const mutations: Array<[string, ExportFingerprintInput]> = [
    ["clip 时长", { ...baseInput(), clips: [{ path: "/media/a.mp4", durationSec: 3.001 }, { path: "/media/b.mp4", durationSec: 4.5 }] }],
    ["clip 路径", { ...baseInput(), clips: [{ path: "/media/a2.mp4", durationSec: 3 }, { path: "/media/b.mp4", durationSec: 4.5 }] }],
    ["audio 路径", { ...baseInput(), audioClips: [{ path: "/media/voX.wav", durationSec: 2, startSec: 3 }, { path: "/media/vo1.wav", durationSec: 3, startSec: 0 }] }],
    ["audio 起始点", { ...baseInput(), audioClips: [{ path: "/media/vo2.wav", durationSec: 2, startSec: 9 }, { path: "/media/vo1.wav", durationSec: 3, startSec: 0 }] }],
    ["字幕文本", { ...baseInput(), subtitles: [{ startSec: 3, endSec: 5, text: "第二句改" }, { startSec: 0, endSec: 2, text: "第一句" }] }],
    ["字幕时间", { ...baseInput(), subtitles: [{ startSec: 3, endSec: 5, text: "第二句" }, { startSec: 0, endSec: 2.5, text: "第一句" }] }],
    ["BGM 音量", { ...baseInput(), bgm: { path: "/media/bgm.mp3", volume: 0.31 } }],
    ["BGM 路径", { ...baseInput(), bgm: { path: "/media/bgm2.mp3", volume: 0.3 } }],
    ["无 BGM", { ...baseInput(), bgm: null }],
    ["画幅", { ...baseInput(), aspect: "9:16" }],
    ["预设", { ...baseInput(), presetId: "portrait_916" }],
  ]
  for (const [label, input] of mutations) {
    assert.notEqual(computeExportFingerprint(input), base, `改「${label}」后指纹未变`)
  }
})

test("指纹：相对路径等价（全 URL 与相对路径视为同一素材）", () => {
  const withAbs = computeExportFingerprint({
    ...baseInput(),
    clips: [
      { path: "https://cdn.a.com/x/y.mp4", durationSec: 3 },
      { path: "/media/b.mp4", durationSec: 4.5 },
    ],
  })
  const withRel = computeExportFingerprint({
    ...baseInput(),
    clips: [
      { path: "/x/y.mp4", durationSec: 3 },
      { path: "/media/b.mp4", durationSec: 4.5 },
    ],
  })
  assert.equal(withAbs, withRel)
})

test("指纹：查询串（签名参数）不影响指纹", () => {
  const a = computeExportFingerprint({ ...baseInput(), bgm: { path: "https://cdn.a.com/media/bgm.mp3?Expires=111&Signature=aaa", volume: 0.3 } })
  const b = computeExportFingerprint({ ...baseInput(), bgm: { path: "https://cdn.a.com/media/bgm.mp3?Expires=999&Signature=zzz", volume: 0.3 } })
  assert.equal(a, b)
})

test("指纹：audioClips 顺序不影响（排序稳定）", () => {
  const a = computeExportFingerprint(baseInput())
  const reversed = baseInput()
  reversed.audioClips = [...reversed.audioClips].reverse()
  assert.equal(computeExportFingerprint(reversed), a)
  const subsReversed = baseInput()
  subsReversed.subtitles = [...subsReversed.subtitles].reverse()
  assert.equal(computeExportFingerprint(subsReversed), a)
})

test("指纹：clips 顺序影响（顺序即语义）", () => {
  const swapped = baseInput()
  swapped.clips = [...swapped.clips].reverse()
  assert.notEqual(computeExportFingerprint(swapped), computeExportFingerprint(baseInput()))
})

test("normalizeMaterialPath：剥离协议+host+查询串，空输入回空串", () => {
  assert.equal(normalizeMaterialPath("https://cdn.a.com/x/y.mp4"), "/x/y.mp4")
  assert.equal(normalizeMaterialPath("http://cdn.a.com/x/y.mp4?a=1#f"), "/x/y.mp4")
  assert.equal(normalizeMaterialPath("https://cdn.a.com/x/y.mp4?sig=1"), "/x/y.mp4")
  assert.equal(normalizeMaterialPath("/local/x.mp4"), "/local/x.mp4")
  assert.equal(normalizeMaterialPath("https://cdn.a.com"), "/")
  assert.equal(normalizeMaterialPath("   "), "")
  assert.equal(normalizeMaterialPath(""), "")
})

// ── isForbiddenMaterialUrl ──────────────────────────────────────────────────

test("URL 守卫：blob:/data:/非 http(s)/嵌套协议 → true", () => {
  const forbidden = [
    "blob:http://localhost:3001/abc-123",
    "data:video/mp4;base64,AAAA",
    "https://cdn.a.com/blob:http://localhost:3001/abc",
    "https://cdn.a.com/data:image/png;base64,AAAA",
    "ftp://cdn.a.com/x.mp4",
    "file:///home/u/x.mp4",
    "http://x.com/https://y.com/z.mp4",
    "https://cdn.a.com/https://y.com/z.mp4",
  ]
  for (const u of forbidden) assert.equal(isForbiddenMaterialUrl(u), true, `应判为禁用：${u}`)
})

test("URL 守卫：http(s) 与相对路径、空值 → false", () => {
  const allowed = ["https://ok/x.mp4", "http://ok/x.mp4", "/local/x.mp4", "local/x.mp4", "", "   "]
  for (const u of allowed) assert.equal(isForbiddenMaterialUrl(u), false, `应判为合法：${u}`)
})

// ── splitSubtitleForScreens ─────────────────────────────────────────────────

const stripWs = (s: string) => s.replace(/\s+/g, "")
const joined = (screens: string[]) => screens.join("")

test("分屏：常数口径 7/12/10", () => {
  assert.equal(SUBTITLE_MIN_SCREEN_CHARS, 7)
  assert.equal(SUBTITLE_MAX_SCREEN_CHARS, 12)
  assert.equal(SUBTITLE_DEFAULT_MAX_CHARS, 10)
})

test("分屏：空输入 → []；纯空白 → []", () => {
  assert.deepEqual(splitSubtitleForScreens(""), [])
  assert.deepEqual(splitSubtitleForScreens("   "), [])
  assert.deepEqual(splitSubtitleForScreens("\n\n \n"), [])
})

test("分屏：短文本原样单屏", () => {
  assert.deepEqual(splitSubtitleForScreens("你好"), ["你好"])
  assert.deepEqual(splitSubtitleForScreens("一二三四五六七八九十"), ["一二三四五六七八九十"])
})

test("分屏：长文本多屏，每屏 ≤ maxChars（预设 10 与显式入参）", () => {
  const long = "今天天气真的非常不错我们一起去公园散步然后回家吃饭"
  for (const limit of [SUBTITLE_DEFAULT_MAX_CHARS, 7, 11, 12, 0, -3, 99]) {
    const screens = splitSubtitleForScreens(long, limit)
    assert.ok(screens.length > 1, `limit=${limit} 应切多屏`)
    const effective = Math.max(SUBTITLE_MIN_SCREEN_CHARS, Math.min(limit > 0 ? limit : SUBTITLE_DEFAULT_MAX_CHARS, SUBTITLE_MAX_SCREEN_CHARS))
    for (const s of screens) {
      assert.ok(subtitleCharCount(s) <= effective, `limit=${limit} 屏超长：${s}`)
      assert.ok(s.trim().length > 0, "不应有纯空白屏")
    }
  }
})

test("分屏：字符守恒（去空白后拼接 === 去空白原文）", () => {
  const samples = [
    "今天天气真的非常不错，我们一起去公园散步，然后回家吃饭。",
    "你好，世界。今天天气真的非常不错啊，我们一起出去玩吧！",
    "第一行台词。\n第二行台词，稍微长一点点的内容在这里。\n\n第三行",
    "这是一句没有任何标点的超长台词需要靠均分硬切来分屏处理",
    "带 emoji 的台词😀真的很长啊，需要分屏处理才好看😀对吧",
    "短短",
    "。！？",
  ]
  for (const sample of samples) {
    const screens = splitSubtitleForScreens(sample)
    assert.equal(stripWs(joined(screens)), stripWs(sample), `字符不守恒：${sample}`)
  }
})

test("分屏：句末标点优先于句内停顿标点", () => {
  // 短句：句末切分 → ["你好，世界。"]；若走句内停顿会变 ["你好，","世界。"]
  assert.deepEqual(splitSubtitleForScreens("你好，世界。"), ["你好，世界。"])
  // 两句各含逗号但都不超屏：句末切分保留整句（若走句内停顿会多出一屏）
  const screens = splitSubtitleForScreens("你好，世界真的很好。我们，一起去公园。")
  assert.deepEqual(screens, ["你好，世界真的很好。", "我们，一起去公园。"])
  assert.equal(stripWs(joined(screens)), stripWs("你好，世界真的很好。我们，一起去公园。"))
})

test("分屏：无标点长句均分硬切且各屏尽量均等", () => {
  const screens = splitSubtitleForScreens("一二三四五六七八九十一二三四五六七八九十", 10)
  assert.deepEqual(screens, ["一二三四五六七八九十", "一二三四五六七八九十"])
})

test("分屏：rebalance 边界——13 字（AID 口径均衡为 7+6）", () => {
  const screens = splitSubtitleForScreens("一二三四五六七八九十一二三", 10)
  assert.equal(screens.length, 2)
  assert.equal(subtitleCharCount(screens[0]), 7)
  assert.equal(stripWs(joined(screens)), "一二三四五六七八九十一二三")
})

test("分屏：已知取舍——combined ∈ (limit, MAX] 时守 ≤maxChars，允许非末屏 <7", () => {
  // 11 字、limit=10：AID 会回单屏 11 字（守下限破配置上限）；本档硬守 ≤10 → 6+5。
  // 此取舍写在被测档档头「已知取舍」节，此测试即锁定该行为不被静默改动。
  const screens = splitSubtitleForScreens("一二三四五六七八九十甲", 10)
  assert.deepEqual(screens, ["一二三四五六", "七八九十甲"])
  assert.ok(screens.every((s) => subtitleCharCount(s) <= 10))
})
