import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 剪輯聲明生成器（2026-08-31 片1 實裝）：鏡頭清單 → ffmpeg 兼容 edit decision list。
// 純代碼（零 LLM 零扣費，不執行 ffmpeg，只產聲明）。
// 格式對齊 VPS gateway assembleFilmNode（/opt/agent-harness/gateway/index.ts L1483+）：
// - harness_clips 欄位形狀 = gateway setHarnessState clips（id/path/label/duration/inSec/outSec/transitionAfter）
// - concat 聲明 = `-f concat -safe 0 -i list.txt`（file '...' 行）
// - 歸一化→concat copy、混流 `-map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart`、
//   成片時長 ≥ 輸入總長 90% 校驗門，全部同口徑。

interface Clip {
  url: string
  label: string
  duration: number
}

function parseClips(input: string): { clips?: Clip[]; reason?: string } {
  const t = input.trim()
  if (!t) return { reason: "clips 為空" }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return { reason: "clips 必須是 JSON 陣列字串：[{\"url\",\"label\",\"duration\"}]" }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).clips)
      ? ((parsed as Record<string, unknown>).clips as unknown[])
      : null
  if (!list || !list.length) return { reason: "clips 解析後為空陣列" }
  const clips: Clip[] = []
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] as Record<string, unknown>
    const url = typeof r?.url === "string" ? r.url.trim() : typeof r?.path === "string" ? String(r.path).trim() : ""
    const label = typeof r?.label === "string" && r.label.trim() ? r.label.trim() : `seg${i}`
    const duration = typeof r?.duration === "number" ? r.duration : typeof r?.duration === "string" ? Number(r.duration) : NaN
    if (!url) return { reason: `clips[${i}] 缺 url/path` }
    if (!Number.isFinite(duration) || duration <= 0) return { reason: `clips[${i}]（${label}）缺合法 duration（秒，>0）——拒絕盲拼` }
    clips.push({ url, label, duration: Math.round(duration * 1000) / 1000 })
  }
  return { clips }
}

const RES: Record<string, [number, number]> = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720] }

export default tool({
  description:
    "剪輯聲明生成器（純代碼，產 ffmpeg edit decision list，不執行剪輯不扣費）。clips 填鏡頭清單 JSON 陣列字串：[{\"url\":\"...\",\"label\":\"shot1\",\"duration\":4.2}]（url 或 path，duration 必填秒數）。可選 aspect（16:9/9:16/1:1，默認 16:9）、fps（默認 24）、audio_urls（TTS 音軌數組 JSON）。輸出：concat 聲明文本（file 行，同 gateway 口徑）、時間軸 timeline、harness_clips（gateway setHarnessState 直接可用形狀）、ffmpeg 命令組（歸一化 concat / copy concat / 音軌混流 -movflags +faststart）。成片環拼接由 gateway 執行，本工具只出聲明與校驗（缺時長即拒絕，不盲拼）。",
  args: {
    clips: tool.schema.string().describe('鏡頭清單 JSON 陣列字串：[{"url","label","duration"}]'),
    aspect: tool.schema.string().optional().describe("目標畫幅 16:9/9:16/1:1，默認 16:9"),
    fps: tool.schema.number().int().min(12).max(60).optional().describe("幀率，默認 24（對齊 gateway 成片導出）"),
    audio_urls: tool.schema.string().optional().describe("可選：TTS 音軌 URL JSON 陣列字串，成片後混流"),
  },
  async execute(args) {
    const parsed = parseClips(String(args.clips ?? ""))
    if (!parsed.clips) return fail("invalid_clips", parsed.reason || "clips 無法解析", { title: "輸入非法" })
    const clips = parsed.clips
    const aspect = args.aspect && RES[args.aspect] ? args.aspect : "16:9"
    const [W, H] = RES[aspect]
    const fps = args.fps ?? 24

    let cursor = 0
    const timeline = clips.map((c, i) => {
      const start = Math.round(cursor * 1000) / 1000
      cursor += c.duration
      return { index: i, id: `h${i}`, label: c.label, url: c.url, duration: c.duration, start, end: Math.round(cursor * 1000) / 1000 }
    })
    const total = Math.round(cursor * 1000) / 1000

    const concatList = clips.map((c) => `file '${c.url.replace(/'/g, "'\\''")}'\nduration ${c.duration}`).join("\n") + `\nfile '${clips[clips.length - 1].url.replace(/'/g, "'\\''")}'\n`
    const shq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`
    const inputs = clips.map((c) => `-i ${shq(c.url)}`).join(" ")
    const filters = clips.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`).join(";")
    const concatRefs = clips.map((_, i) => `[v${i}]`).join("")
    const normalizeConcat = `ffmpeg -y ${inputs} -filter_complex "${filters};${concatRefs}concat=n=${clips.length}:v=1:a=0[outv]" -map "[outv]" -c:v libx264 -preset medium -pix_fmt yuv420p film.mp4`
    const copyConcat = `ffmpeg -y -f concat -safe 0 -i ${shq("concat-list.txt")} -c copy film-copy.mp4`

    let audioUrls: string[] = []
    if (args.audio_urls) {
      try {
        const j = JSON.parse(args.audio_urls)
        if (Array.isArray(j)) audioUrls = j.filter((x): x is string => typeof x === "string" && x.trim())
      } catch {
        return fail("invalid_audio_urls", "audio_urls 必須是 URL 的 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    const audioMerge = audioUrls.length > 1 ? `ffmpeg -y -f concat -safe 0 -i ${shq("audio-list.txt")} -c:a aac audio-merged.m4a` : null
    const audioMix = audioUrls.length
      ? `ffmpeg -y -i ${shq("film.mp4")} -i ${shq(audioUrls.length > 1 ? "audio-merged.m4a" : audioUrls[0])} -map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart film-mixed.mp4`
      : null

    return ok({
      title: `剪輯聲明：${clips.length} 段/${total}s/${aspect}`,
      aspect,
      fps,
      total_duration_seconds: total,
      timeline,
      harness_clips: clips.map((c, i) => ({
        id: `h${i}`,
        path: c.url,
        label: c.label,
        duration: c.duration,
        inSec: 0,
        outSec: c.duration,
        transitionAfter: { type: "none", duration: 0 },
      })),
      concat_list: concatList,
      ffmpeg_commands: {
        normalize_concat: normalizeConcat,
        copy_concat: copyConcat,
        audio_merge: audioMerge,
        audio_mix: audioMix,
      },
      validation: {
        gateway_parity: "harness_clips/concat/混流命令與 gateway assembleFilmNode 同口徑",
        min_output_seconds: Math.floor(total * 0.9),
        note: "成片時長低於輸入總長 90% 應判失敗（gateway 校驗門同規則）",
      },
    })
  },
})
