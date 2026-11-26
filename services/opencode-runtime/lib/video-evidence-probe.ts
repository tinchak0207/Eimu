import { link, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { FFMPEG, FFPROBE, assert, clamp, exists, round } from "./video-evidence-process"
import { runProcess, runProcessOutput, runProcessWithInput } from "./video-evidence-process"

// ---------------------------------------------------------------------------
// probe

export type VideoProbe = {
  readonly hasVideo: true
  readonly width: number
  readonly height: number
  readonly frameRate: number
}

export type MediaProbe = {
  readonly duration: number
  readonly hasAudio: boolean
} & (VideoProbe | { readonly hasVideo: false })

export function requireVideo(info: MediaProbe, path: string): asserts info is MediaProbe & VideoProbe {
  assert(info.hasVideo, `${path}: no video stream`)
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const raw = await runProcess(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate:stream_disposition=attached_pic", "-of", "json", path,
  ])
  const parsed = JSON.parse(raw.toString("utf8")) as {
    format?: { duration?: string }
    streams?: readonly {
      codec_type?: string; width?: number; height?: number; r_frame_rate?: string
      disposition?: { attached_pic?: number }
    }[]
  }
  const video = parsed.streams?.find((item) => item.codec_type === "video" && item.disposition?.attached_pic !== 1)
  const duration = Number(parsed.format?.duration)
  assert(Number.isFinite(duration) && duration > 0, `${path}: duration is unavailable`)
  const hasAudio = parsed.streams?.some((item) => item.codec_type === "audio") ?? false
  assert(video !== undefined || hasAudio, `${path}: no audio or video stream`)
  if (video === undefined) return { duration: round(duration), hasVideo: false, hasAudio }
  assert(video.width !== undefined && video.height !== undefined, `${path}: video dimensions are unavailable`)
  // ffprobe 以比例回报帧率；静态图没有比例。
  const ratio = (video.r_frame_rate ?? "").split("/")
  const rate = Number(ratio[0]) / Number(ratio[1] ?? 1)
  return {
    duration: round(duration),
    hasVideo: true,
    width: video.width,
    height: video.height,
    frameRate: Number.isFinite(rate) && rate > 0 ? round(rate) : 0,
    hasAudio,
  }
}

// ---------------------------------------------------------------------------
// ffmpeg 配方

/**
 * 在 `at` 秒的那一格开启 `source`。
 *
 * 单独把 `-ss` 放在 `-i` 之后会解码到该标记之前的每一格；单独放在 `-i` 之前只会落在它前面的
 * 关键帧。提早两秒跳入再解码这一小段 run-up 才会落在精确的那一格：实测于一段 1080p、九分钟
 * 处的来源，同样的 JPEG 逐位元相同，11.6 秒降到 0.2 秒。
 */
const SEEK_RUN_UP = 2

function openAt(source: string, at: number): readonly string[] {
  const jump = Math.max(0, at - SEEK_RUN_UP)
  const runUp = at - jump
  return [...(jump > 0 ? ["-ss", String(round(jump))] : []), "-i", source, ...(runUp > 0 ? ["-ss", String(round(runUp))] : [])]
}

// JPEG 是全范围格式；网路影片的 YUV 惯例也是全范围，编码器除非被明确告知否则拒收
// （`Non full-range YUV is non-standard`）。
const JPEG = ["-pix_fmt", "yuvj420p", "-q:v", "3"] as const

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00100", "00100"],
}

export function timecode(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const wholeSeconds = Math.floor(milliseconds / 1_000) % 60
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`
}

type RasterLabel = {
  readonly width: number
  readonly height: number
  readonly bytes: Buffer
}

/** 一支内建的小型数字字面，让证据标签在 ffmpeg 缺少 drawtext 时仍然可用（现场实测无 drawtext）。 */
function rasterLabel(text: string, requestedWidth?: number): RasterLabel {
  const scale = requestedWidth === undefined
    ? 3
    : clamp(Math.min(Math.floor((requestedWidth - 8) / (text.length * 6)), Math.floor(requestedWidth / 240) + 1), 1, 3)
  const padding = scale * 2
  const naturalWidth = padding * 2 + text.length * 6 * scale - scale
  const width = Math.max(requestedWidth ?? naturalWidth, naturalWidth)
  const rawHeight = padding * 2 + 7 * scale
  const height = rawHeight + rawHeight % 2
  const bytes = Buffer.alloc(width * height * 3, 12)
  let left = padding
  for (const character of text) {
    const glyph = GLYPHS[character]
    assert(glyph !== undefined, `cannot draw time label character ${character}`)
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row]!.length; column += 1) {
        if (glyph[row]![column] !== "1") continue
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const pixel = ((padding + row * scale + y) * width + left + column * scale + x) * 3
            bytes[pixel] = 245
            bytes[pixel + 1] = 245
            bytes[pixel + 2] = 245
          }
        }
      }
    }
    left += 6 * scale
  }
  return { width, height, bytes }
}

function rawVideoInput(label: RasterLabel, frameRate: number): readonly string[] {
  return [
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${label.width}x${label.height}`,
    "-framerate", String(frameRate), "-i", "pipe:0",
  ]
}

/** 影格抽取：回传实际解到的来源时间（不是请求时间）。 */
export async function cutFrame(source: string, at: number, target: string, labelTime = false): Promise<number> {
  if (!labelTime) {
    const jump = Math.max(0, at - SEEK_RUN_UP)
    const output = await runProcessOutput(FFMPEG, [
      "-hide_banner", "-loglevel", "info", "-y", "-copyts", "-start_at_zero",
      ...(jump > 0 ? ["-ss", String(jump)] : []), "-i", source,
      "-vf", `trim=start=${at},showinfo`, "-frames:v", "1", "-fps_mode", "passthrough", ...JPEG, target,
    ])
    const base = /config in time_base:\s*(\d+)\/(\d+)/u.exec(output.stderr)
    const pts = /\bn:\s*0\s+pts:\s*(-?\d+)/u.exec(output.stderr)
    assert(base !== null && pts !== null, `no video frame exists at or after ${at} s`)
    return Number(pts[1]) * Number(base[1]) / Number(base[2])
  }
  const temporary = await mkdtemp(join(tmpdir(), "eimu-labeled-frame-"))
  const clean = join(temporary, "clean.jpg")
  try {
    const actual = await cutFrame(source, at, clean)
    const label = rasterLabel(timecode(actual))
    await runProcessWithInput(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", clean, ...rawVideoInput(label, 1),
      "-filter_complex", "[0:v][1:v]overlay=8:8[out]", "-map", "[out]", "-frames:v", "1", ...JPEG, target,
    ], label.bytes)
    return actual
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function cutClip(
  source: string,
  start: number,
  end: number,
  target: string,
  labelInfo?: Pick<VideoProbe, "frameRate">,
): Promise<void> {
  assert(end > start, `the clip must end after it starts (${start} to ${end})`)
  const seconds = round(end - start)
  const common = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"]
  if (labelInfo === undefined) {
    await runProcess(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", ...openAt(source, start), "-t", String(seconds), ...common, target,
    ])
    return
  }
  const temporary = await mkdtemp(join(tmpdir(), "eimu-labeled-clip-"))
  const clean = join(temporary, "clean.mp4")
  try {
    await cutClip(source, start, end, clean)
    const rate = clamp(Math.ceil(labelInfo.frameRate || 10), 1, 30)
    const count = Math.max(1, Math.ceil(seconds * rate))
    const first = rasterLabel(timecode(start))
    function* labels(): Iterable<Uint8Array> {
      yield first.bytes
      for (let index = 1; index < count; index += 1) yield rasterLabel(timecode(start + index / rate)).bytes
    }
    await runProcessWithInput(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", clean, ...rawVideoInput(first, rate),
      "-t", String(seconds), "-filter_complex", "[0:v][1:v]overlay=8:8:eof_action=repeat[v]",
      "-map", "[v]", "-map", "0:a?", ...common, target,
    ], labels())
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export type CutSpan = { readonly start: number; readonly end: number }

/** 解码被选中的段落一次，把它们接到一个新的本地时钟上，只保留真的存在的串流。 */
async function cutProduction(source: string, spans: readonly CutSpan[], target: string, info: MediaProbe): Promise<void> {
  const seek = Math.max(0, spans[0]!.start - SEEK_RUN_UP)
  const labels: string[] = []
  const filters: string[] = []
  const videoInputs = spans.map((_, index) => `vsrc${index}`)
  const audioInputs = spans.map((_, index) => `asrc${index}`)
  if (info.hasVideo && spans.length > 1) filters.push(`[0:v:0]split=${spans.length}${videoInputs.map((item) => `[${item}]`).join("")}`)
  if (info.hasAudio && spans.length > 1) filters.push(`[0:a:0]asplit=${spans.length}${audioInputs.map((item) => `[${item}]`).join("")}`)
  for (const [index, span] of spans.entries()) {
    const start = round(span.start - seek)
    const end = round(span.end - seek)
    if (info.hasVideo) filters.push(`[${spans.length === 1 ? "0:v:0" : videoInputs[index]}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`)
    if (info.hasAudio) filters.push(`[${spans.length === 1 ? "0:a:0" : audioInputs[index]}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`)
    labels.push(`${info.hasVideo ? `[v${index}]` : ""}${info.hasAudio ? `[a${index}]` : ""}`)
  }
  if (spans.length > 1) filters.push(`${labels.join("")}concat=n=${spans.length}:v=${info.hasVideo ? 1 : 0}:a=${info.hasAudio ? 1 : 0}${info.hasVideo ? "[v]" : ""}${info.hasAudio ? "[a]" : ""}`)
  const videoLabel = spans.length === 1 ? "[v0]" : "[v]"
  const audioLabel = spans.length === 1 ? "[a0]" : "[a]"
  await runProcess(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    ...(seek > 0 ? ["-ss", String(round(seek))] : []), "-i", source,
    "-filter_complex", filters.join(";"),
    ...(info.hasVideo ? ["-map", videoLabel, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-fps_mode", "vfr",
      ...([".mp4", ".mov"].includes(extname(target).toLowerCase()) ? ["-movflags", "+faststart"] : [])] : []),
    ...(info.hasAudio ? ["-map", audioLabel, "-c:a", ...(info.hasVideo ? ["aac", "-b:a", "192k"] : ["pcm_s24le"])] : []),
    target,
  ])
}

/** 原子发布完成的剪辑，不覆盖另一个程序期间可能已建立的档案。 */
async function writeCut(
  source: string, spans: readonly CutSpan[], target: string, info: MediaProbe, labeled: boolean,
): Promise<void> {
  const work = await mkdtemp(join(dirname(target), ".eimu-cut-"))
  const staged = join(work, `cut${extname(target)}`)
  try {
    if (labeled) {
      requireVideo(info, source)
      await cutClip(source, spans[0]!.start, spans[0]!.end, staged, info)
    } else await cutProduction(source, spans, staged, info)
    await link(staged, target)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * cut 命令本体（单段或有序多段）：验证 → 原子写出 → 回量测到的实际秒数与串流。
 * 回传 actualSeconds 是**重新 probe 输出档**的时长（不是请求值）。
 */
export async function cutSpans(
  source: string,
  spans: readonly CutSpan[],
  target: string,
  labeled: boolean,
): Promise<{ actualSeconds: number; hasVideo: boolean; hasAudio: boolean }> {
  assert(await exists(source), `cannot read ${resolve(source)}`)
  const info = await probeMedia(source)
  assert(spans.length > 0, "at least one interval is required")
  for (const [index, span] of spans.entries()) {
    assert(Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start && span.end <= info.duration + 0.001,
      `range must satisfy 0 <= start < end <= ${info.duration} s`)
    if (index > 0) assert(span.start >= spans[index - 1]!.end, "--keep intervals must be ordered and non-overlapping")
  }
  assert(!labeled || (info.hasVideo && spans.length === 1), "--label-time needs one video interval")
  assert(!(await exists(target)), `Destination ${target} already exists`)
  await mkdir(dirname(target), { recursive: true })
  if (!info.hasVideo) assert(extname(target).toLowerCase() === ".wav", "--to must end in .wav for audio-only media")
  await writeCut(source, spans, target, info, labeled)
  const output = await probeMedia(target)
  return { actualSeconds: output.duration, hasVideo: output.hasVideo, hasAudio: output.hasAudio }
}

// ---------------------------------------------------------------------------
// 逐格解码（media-frames.ts）

export type DecodedFrame = { readonly at: number; readonly path: string }

/** 解码一次来源区间，保留每一格的实际来源时间戳。 */
export async function decodeMediaFrames(source: string, start: number, end: number, directory: string): Promise<readonly DecodedFrame[]> {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) throw new Error("Native frames need 0 <= start < end")
  await mkdir(directory, { recursive: true })
  const times: number[] = []
  let numerator = 0, denominator = 0
  await runProcessOutput(FFMPEG, ["-hide_banner", "-loglevel", "info", "-nostdin", "-copyts", "-start_at_zero",
    ...(start > 0 ? ["-ss", String(start)] : []), "-i", source,
    "-map", "0:v:0", "-an", "-vf", `trim=start=${start}:end=${end},showinfo=checksum=0`,
    "-fps_mode", "passthrough", "-pix_fmt", "yuvj420p", "-q:v", "3", "-start_number", "0", join(directory, "%09d.jpg"),
  ], 300_000, (line) => {
    const base = /config in time_base:\s*(\d+)\/(\d+)/u.exec(line)
    if (base !== null) { numerator = Number(base[1]); denominator = Number(base[2]) }
    const pts = /\bn:\s*\d+\s+pts:\s*(-?\d+)/u.exec(line)
    if (pts !== null && denominator > 0) times.push(Number(pts[1]) * numerator / denominator)
  })
  if (times.length === 0) throw new Error(`No video frames in [${start}, ${end}) s`)
  return times.map((at, index) => ({ at, path: join(directory, `${String(index).padStart(9, "0")}.jpg`) }))
}
