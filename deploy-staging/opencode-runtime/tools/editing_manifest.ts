import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 剪辑声明生成器（2026-08-31 片1 实装）：镜头清单 → ffmpeg 兼容 edit decision list。
// 纯代码（零 LLM 零扣费，不执行 ffmpeg，只产声明）。
// 格式对齐 VPS gateway assembleFilmNode（/opt/agent-harness/gateway/index.ts L1483+）：
// - harness_clips 栏位形状 = gateway setHarnessState clips（id/path/label/duration/inSec/outSec/transitionAfter）
// - concat 声明 = `-f concat -safe 0 -i list.txt`（file '...' 行）
// - 归一化→concat copy、混流 `-map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart`、
//   成片时长 ≥ 输入总长 90% 校验门，全部同口径。

interface Clip {
  url: string
  label: string
  duration: number
}

function parseClips(input: string): { clips?: Clip[]; reason?: string } {
  const t = input.trim()
  if (!t) return { reason: "clips 为空" }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return { reason: "clips 必须是 JSON 阵列字串：[{\"url\",\"label\",\"duration\"}]" }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).clips)
      ? ((parsed as Record<string, unknown>).clips as unknown[])
      : null
  if (!list || !list.length) return { reason: "clips 解析后为空阵列" }
  const clips: Clip[] = []
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] as Record<string, unknown>
    const url = typeof r?.url === "string" ? r.url.trim() : typeof r?.path === "string" ? String(r.path).trim() : ""
    const label = typeof r?.label === "string" && r.label.trim() ? r.label.trim() : `seg${i}`
    const duration = typeof r?.duration === "number" ? r.duration : typeof r?.duration === "string" ? Number(r.duration) : NaN
    if (!url) return { reason: `clips[${i}] 缺 url/path` }
    if (!Number.isFinite(duration) || duration <= 0) return { reason: `clips[${i}]（${label}）缺合法 duration（秒，>0）——拒绝盲拼` }
    clips.push({ url, label, duration: Math.round(duration * 1000) / 1000 })
  }
  return { clips }
}

const RES: Record<string, [number, number]> = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720] }

export default tool({
  description:
    "剪辑声明生成器（纯代码，产 ffmpeg edit decision list，不执行剪辑不扣费）。clips 填镜头清单 JSON 阵列字串：[{\"url\":\"...\",\"label\":\"shot1\",\"duration\":4.2}]（url 或 path，duration 必填秒数）。可选 aspect（16:9/9:16/1:1，默认 16:9）、fps（默认 24）、audio_urls（TTS 音轨数组 JSON）。输出：concat 声明文本（file 行，同 gateway 口径）、时间轴 timeline、harness_clips（gateway setHarnessState 直接可用形状）、ffmpeg 命令组（归一化 concat / copy concat / 音轨混流 -movflags +faststart）。成片环拼接由 gateway 执行，本工具只出声明与校验（缺时长即拒绝，不盲拼）。",
  args: {
    clips: tool.schema.string().describe('镜头清单 JSON 阵列字串：[{"url","label","duration"}]'),
    aspect: tool.schema.string().optional().describe("目标画幅 16:9/9:16/1:1，默认 16:9"),
    fps: tool.schema.number().int().min(12).max(60).optional().describe("帧率，默认 24（对齐 gateway 成片导出）"),
    audio_urls: tool.schema.string().optional().describe("可选：TTS 音轨 URL JSON 阵列字串，成片后混流"),
  },
  async execute(args) {
    const parsed = parseClips(String(args.clips ?? ""))
    if (!parsed.clips) return fail("invalid_clips", parsed.reason || "clips 无法解析", { title: "输入非法" })
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
        return fail("invalid_audio_urls", "audio_urls 必须是 URL 的 JSON 阵列字串", { title: "输入非法" })
      }
    }
    const audioMerge = audioUrls.length > 1 ? `ffmpeg -y -f concat -safe 0 -i ${shq("audio-list.txt")} -c:a aac audio-merged.m4a` : null
    const audioMix = audioUrls.length
      ? `ffmpeg -y -i ${shq("film.mp4")} -i ${shq(audioUrls.length > 1 ? "audio-merged.m4a" : audioUrls[0])} -map 0:v -map 1:a -c:v copy -c:a aac -movflags +faststart film-mixed.mp4`
      : null

    return ok({
      title: `剪辑声明：${clips.length} 段/${total}s/${aspect}`,
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
        gateway_parity: "harness_clips/concat/混流命令与 gateway assembleFilmNode 同口径",
        min_output_seconds: Math.floor(total * 0.9),
        note: "成片时长低于输入总长 90% 应判失败（gateway 校验门同规则）",
      },
    })
  },
})
