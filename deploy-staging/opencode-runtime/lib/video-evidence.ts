// 影片證據面共用 lib（2026-09-28）。
//
// 職責：把「以影片為輸入、取得結構化證據」這一格做成本機、零付費、零上游的能力面——
//   probe（時長/串流/解析度/fps）、cut（單段或有序多段拼接）、frames（逐格 JPEG，附來源真實時間）、
//   tile/tiles（拼板，含分頁）、boundaries（機械式相鄰幀變化候選）、transcript 疊詞。
//
// 形態來源（逐條照抄，非自由設計）：競品 hypit 的
//   packages/video-cli/src/process.ts      → 本檔「外部程序」層
//   packages/video-cli/src/media.ts        → probeMedia / openAt / JPEG / GLYPHS / rasterLabel /
//                                            timecode / cutClip / cutProduction / writeCut / cutFrame /
//                                            tileFrameCount / tileSampleTimes / frameLabel / tileFrames /
//                                            visualBoundaries / sampleRange / sampleTimes / tiles
//   packages/video-cli/src/media-frames.ts → decodeMediaFrames
//   packages/video-cli/src/frame-grid.ts   → writeFrameGrid
//   packages/video-cli/src/transcript.ts   → readTranscript / wordsAt / phraseRanges
// 參數名、預設值、錯誤語義、ffmpeg 參數順序一律照它；本輪偏離處逐條列在交付回報 §5。
//
// 我方輪子複用：ffmpeg/ffprobe 絕對路徑慣例抄 lib/asr.ts:61-62；公網 blob 用 lib/img-composite.ts
// 的 uploadBlob/blobPath（本檔不自行上傳，由 tools/video_evidence.ts 呼叫）。
// 本檔不是 tool，不得 export tool 定義。

import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// 執行檔位置（VPS 現場：ffmpeg/ffprobe 不在 PATH；慣例同 lib/asr.ts:61-62）

const BIN_DIR = "/opt/agent-harness/bin"
const FFMPEG = process.env.FFMPEG_PATH || (existsSync(join(BIN_DIR, "ffmpeg")) ? join(BIN_DIR, "ffmpeg") : "ffmpeg")
const FFPROBE = process.env.FFPROBE_PATH || (existsSync(join(BIN_DIR, "ffprobe")) ? join(BIN_DIR, "ffprobe") : "ffprobe")

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// 外部程序層（移植 hypit process.ts：成功時 stderr 仍可攜帶工具 metadata，
// 例如被抽出的影格時間戳，故 runProcessOutput 必須把 stderr 交回呼叫端）

type ProcessInput = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>
export type ProcessOutput = { readonly stdout: Buffer; readonly stderr: string }

function run(
  executable: string,
  args: readonly string[],
  input: ProcessInput | undefined,
  timeoutMs: number,
  onStderrLine?: (line: string) => void,
): Promise<ProcessOutput> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, [...args], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true })
    const out: Buffer[] = []
    let err = ""
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveRun({ stdout: Buffer.concat(out), stderr: err })
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error(`${executable} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    let pendingLine = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      err = `${err}${text}`.slice(-100_000)
      if (onStderrLine !== undefined) {
        const lines = `${pendingLine}${text}`.split(/\r?\n/u)
        pendingLine = lines.pop()!
        for (const line of lines) onStderrLine(line)
      }
    })
    child.on("error", (error) => finish(new Error(`${executable} could not start: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) finish()
      else finish(new Error(`${executable} exited with ${code}: ${err.trim()}`))
    })
    if (input !== undefined && child.stdin !== null) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") finish(new Error(`${executable} input failed: ${error.message}`))
      })
      void (async () => {
        const chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array> = input instanceof Uint8Array ? [input] : input
        for await (const chunk of chunks) {
          if (!child.stdin!.write(chunk)) await once(child.stdin!, "drain")
        }
        child.stdin!.end()
      })().catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) {
          child.kill("SIGKILL")
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
  })
}

/** 跑完一支外部程序並回傳 stdout；stderr 進錯誤訊息。 */
export async function runProcess(executable: string, args: readonly string[], timeoutMs = 300_000): Promise<Buffer> {
  return (await run(executable, args, undefined, timeoutMs)).stdout
}

/** 成功時 stderr 仍可攜帶工具 metadata，例如被抽出的影格時間戳。 */
export function runProcessOutput(
  executable: string,
  args: readonly string[],
  timeoutMs = 300_000,
  onStderrLine?: (line: string) => void,
): Promise<ProcessOutput> {
  return run(executable, args, undefined, timeoutMs, onStderrLine)
}

/** 同一個程序邊界，當確定性位元流是程式的輸入之一時使用（位圖字型疊字）。 */
export async function runProcessWithInput(
  executable: string,
  args: readonly string[],
  input: ProcessInput,
  timeoutMs = 300_000,
): Promise<Buffer> {
  return (await run(executable, args, input, timeoutMs)).stdout
}

// ---------------------------------------------------------------------------
// sharp 探測（拼板文字標籤；現場 vips 8.18.7 可用，text/pango 實測可渲染）

type SharpFactory = ((input: unknown, options?: unknown) => any) & { versions?: { vips?: string } }

let sharpPromise: Promise<SharpFactory | null> | null = null

/** 探測 sharp 是否可用；不可用回 null（呼叫端決定是明示失敗還是退化）。 */
export function loadSharp(): Promise<SharpFactory | null> {
  if (sharpPromise === null) {
    sharpPromise = (async (): Promise<SharpFactory | null> => {
      try {
        const mod = (await import("sharp")) as unknown as { default?: SharpFactory }
        const factory = (mod.default ?? (mod as unknown as SharpFactory)) as SharpFactory
        return typeof factory === "function" ? factory : null
      } catch {
        return null
      }
    })()
  }
  return sharpPromise
}

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
  // ffprobe 以比例回報幀率；靜態圖沒有比例。
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
 * 在 `at` 秒的那一格開啟 `source`。
 *
 * 單獨把 `-ss` 放在 `-i` 之後會解碼到該標記之前的每一格；單獨放在 `-i` 之前只會落在它前面的
 * 關鍵幀。提早兩秒跳入再解碼這一小段 run-up 才會落在精確的那一格：實測於一段 1080p、九分鐘
 * 處的來源，同樣的 JPEG 逐位元相同，11.6 秒降到 0.2 秒。
 */
const SEEK_RUN_UP = 2
function openAt(source: string, at: number): readonly string[] {
  const jump = Math.max(0, at - SEEK_RUN_UP)
  const runUp = at - jump
  return [...(jump > 0 ? ["-ss", String(round(jump))] : []), "-i", source, ...(runUp > 0 ? ["-ss", String(round(runUp))] : [])]
}

// JPEG 是全範圍格式；網路影片的 YUV 慣例也是全範圍，編碼器除非被明確告知否則拒收
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

/** 一支內建的小型數字字面，讓證據標籤在 ffmpeg 缺少 drawtext 時仍然可用（現場實測無 drawtext）。 */
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

/** 影格抽取：回傳實際解到的來源時間（不是請求時間）。 */
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

/** 解碼被選中的段落一次，把它們接到一個新的本地時鐘上，只保留真的存在的串流。 */
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

/** 原子發佈完成的剪輯，不覆蓋另一個程序期間可能已建立的檔案。 */
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
 * cut 命令本體（單段或有序多段）：驗證 → 原子寫出 → 回量測到的實際秒數與串流。
 * 回傳 actualSeconds 是**重新 probe 輸出檔**的時長（不是請求值）。
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
// tile 命令本體（單張拼板；目的地不得已存在）

/** 單張拼板：`--every` 從 start 起不含 end；`--frames` 取等距中點。 */
export async function writeTile(
  source: string,
  times: readonly number[],
  target: string,
  cellWidth: number,
  columns: number,
  words?: readonly TranscriptWord[],
): Promise<readonly SampledFrame[]> {
  assert(!(await exists(target)), `Destination ${target} already exists`)
  await mkdir(dirname(target), { recursive: true })
  return tileFrames(source, times, target, cellWidth, columns, words)
}

// ---------------------------------------------------------------------------
// 逐格解碼（media-frames.ts）

export type DecodedFrame = { readonly at: number; readonly path: string }

/** 解碼一次來源區間，保留每一格的實際來源時間戳。 */
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

// ---------------------------------------------------------------------------
// 拼板（frame-grid.ts）

/**
 * 排列已抓到的證據。解碼與時間選擇屬於呼叫端。
 * 標籤是 Pre-rendered 的 PNG Buffer（由 frameLabel 產生）；未給標籤時該列不留標籤條。
 */
export async function writeFrameGrid(
  frames: readonly { readonly path: string; readonly label?: Buffer }[],
  target: string, cellWidth: number, columns: number,
): Promise<void> {
  if (frames.length === 0) throw new Error("A frame grid needs at least one image")
  const sharp = await loadSharp()
  if (sharp === null) throw new Error("sharp is unavailable: frame grids need the sharp module (probe with loadSharp())")
  const cells: { picture: Buffer; height: number; label?: Buffer; labelHeight: number }[] = []
  for (const frame of frames) {
    const picture = await sharp(frame.path).resize({ width: cellWidth }).png().toBuffer({ resolveWithObject: true })
    const labelHeight = frame.label === undefined ? 0 : ((await sharp(frame.label).metadata()).height ?? 0)
    cells.push({ picture: picture.data, height: picture.info.height, ...(frame.label === undefined ? {} : { label: frame.label }), labelHeight })
  }
  const pictureHeight = Math.max(...cells.map((cell) => cell.height))
  const rowHeight = pictureHeight + Math.max(...cells.map((cell) => cell.labelHeight))
  const rows = Math.ceil(cells.length / columns)
  await sharp({ create: {
    width: columns * (cellWidth + 8) + 8, height: rows * (rowHeight + 8) + 8,
    channels: 3, background: "#0c0c0c",
  } }).composite(cells.flatMap((cell, index) => {
    const left = 8 + index % columns * (cellWidth + 8)
    const top = 8 + Math.floor(index / columns) * (rowHeight + 8)
    const parts: unknown[] = [{ input: cell.picture, left, top }]
    if (cell.label !== undefined) parts.push({ input: cell.label, left, top: top + pictureHeight })
    return parts
  })).toFile(target)
}

// ---------------------------------------------------------------------------
// 拼板排數/取樣（排數語義照它）

const TILE_COLUMNS = 3
const TILE_CELL_WIDTH = 480
/** 緊湊總覽的預設值。變化快時呼叫端自己指定更密的取樣。 */
export function tileFrameCount(seconds: number): number {
  return clamp(Math.round(seconds * 1.5), 4, 9)
}

/** 等距中點取樣（--frames 語義）。 */
export function tileSampleTimes(start: number, end: number, frameCount: number): number[] {
  assert(end > start, `the stretch must end after it starts (${start} to ${end})`)
  assert(Number.isSafeInteger(frameCount) && frameCount >= 2, "a grid needs at least two frames")
  return Array.from({ length: frameCount }, (_, index) => round(start + (index + 0.5) * (end - start) / frameCount))
}

/** 從 start 起、不含 end（--every 語義）；every 下限 0.001 秒。 */
export function intervalSamples(start: number, end: number, every: number): number[] {
  assert(Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start, "a sample range needs 0 <= start < end")
  assert(Number.isFinite(every) && every >= 0.001, "--every must be at least 0.001 seconds")
  return Array.from({ length: Math.ceil((end - start) / every) }, (_, index) => round(start + index * every))
    .filter((time) => time < end)
}

function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** 標籤條：第一行時間碼，第二行活動詞（或明示沒有），第三行上下文（活動詞高亮）。 */
async function frameLabel(at: number, width: number, words?: FrameWords): Promise<Buffer> {
  const sharp = await loadSharp()
  if (sharp === null) throw new Error("sharp is unavailable: transcript frame labels need the sharp module")
  const lines = [timecode(at)]
  if (words !== undefined) {
    lines.push(words.active.length === 0 ? "No timed word at this frame" : words.active.map((word) =>
      `<b>${escapeMarkup(word.text)}</b>  ${word.start!.toFixed(3)}–${word.end!.toFixed(3)} s`).join("\n"))
    if (words.context.length > 0) lines.push(words.context.map((word) => words.active.includes(word)
      ? `<span foreground="#ffdc80"><b>${escapeMarkup(word.text)}</b></span>` : escapeMarkup(word.text)).join(" "))
  }
  const text = await sharp({ text: {
    text: `<span foreground="#f5f5f5">${lines.join("\n")}</span>`,
    font: `sans ${Math.max(12, Math.round(width / 28))}`, width: width - 16, rgba: true, wrap: "word-char",
  } }).png().toBuffer({ resolveWithObject: true })
  return sharp({ create: { width, height: text.info.height + 16, channels: 3, background: "#0c0c0c" } })
    .composite([{ input: text.data, left: 8, top: 8 }]).png().toBuffer()
}

export type SampledFrame = { readonly requestedAt: number; readonly at: number; readonly words?: FrameWords }

/** 抽 N 格 + 疊標籤 → 一張拼板。回傳每格實際解到的來源時間。 */
export async function tileFrames(
  source: string,
  times: readonly number[],
  target: string,
  cellWidth: number,
  columns: number,
  words?: readonly TranscriptWord[],
): Promise<readonly SampledFrame[]> {
  assert(times.length >= 1, "a grid needs at least one frame")
  const temporary = await mkdtemp(join(tmpdir(), "eimu-tile-"))
  try {
    const frames: SampledFrame[] = []
    const cells: { path: string; label: Buffer }[] = []
    for (let index = 0; index < times.length; index += 1) {
      const at = times[index]!
      const path = join(temporary, `${index}.jpg`)
      const actual = await cutFrame(source, at, path)
      const frameWords = words === undefined ? undefined : wordsAt(words, actual)
      frames.push({ requestedAt: at, at: actual, ...(frameWords === undefined ? {} : { words: frameWords }) })
      cells.push({ path, label: await frameLabel(actual, cellWidth, frameWords) })
    }
    await writeFrameGrid(cells, target, cellWidth, columns)
    return frames
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 相鄰幀變化候選（boundaries）

/**
 * 機械式的相鄰幀視覺變化候選。分數是機械證據，不是剪輯判讀的鏡頭標籤。
 */
const DEFAULT_BOUNDARY_RATE = 12
const DEFAULT_BOUNDARY_THRESHOLD = 0.1
export type VisualBoundary = { readonly at: number; readonly score: number }

export async function visualBoundaries(
  source: string,
  sampleRate = DEFAULT_BOUNDARY_RATE,
  threshold = DEFAULT_BOUNDARY_THRESHOLD,
): Promise<VisualBoundary[]> {
  const bytes = await runProcess(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", source, "-vf", `fps=${sampleRate},scale=32:32,format=rgb24`, "-f", "rawvideo", "-",
  ])
  const stride = 32 * 32 * 3
  const frames: Uint8Array[] = []
  for (let index = 0; index + stride <= bytes.byteLength; index += stride) frames.push(bytes.subarray(index, index + stride))
  const candidates: VisualBoundary[] = []
  for (let index = 1; index < frames.length; index += 1) {
    const before = frames[index - 1]!
    const after = frames[index]!
    let total = 0
    for (let byte = 0; byte < after.length; byte += 1) total += Math.abs(after[byte]! - before[byte]!)
    const score = total / after.length / 255
    if (score >= threshold) candidates.push({ at: round(index / sampleRate), score: round(score) })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// 區間/取樣選擇（sampleRange / sampleTimes，照它）

const SAMPLE_OPTIONS = ["--start", "--end", "--at", "--every", "--transcript", "--around", "--occurrence", "--padding"] as const

/** 已解析的取樣請求（tool 層把 args 正規化成這個形狀；語義與 hypit CLI 選項一一對應）。 */
export interface SampleRequest {
  readonly start?: number
  readonly end?: number
  readonly at?: readonly number[]
  readonly every?: number
  readonly frames?: number
  readonly around?: string
  readonly occurrence?: number
  readonly padding?: number
  readonly words?: readonly TranscriptWord[]
}

export function sampleRange(request: SampleRequest, duration: number): { start: number; end: number } {
  const { around } = request
  if (around !== undefined) {
    const words = request.words
    assert(words !== undefined, "--around requires --transcript")
    assert(request.start === undefined && request.end === undefined, "choose --around or --start/--end")
    const matches = phraseRanges(words, around)
    assert(matches.length > 0, `No timed phrase matches ${JSON.stringify(around)}`)
    assert(matches.length === 1 || request.occurrence !== undefined,
      `The phrase occurs ${matches.length} times: ${matches.map((match, index) => `${index + 1}: ${match.start}–${match.end}s`).join(", ")}. Choose --occurrence <n> or --start/--end.`)
    const occurrence = request.occurrence ?? 1
    assert(Number.isSafeInteger(occurrence) && occurrence >= 1, `--occurrence must be a whole number of at least 1, got ${occurrence}`)
    const match = matches[occurrence - 1]
    assert(match !== undefined, `--occurrence ${occurrence} is beyond the ${matches.length} matches`)
    const padding = request.padding ?? 0.3
    assert(Number.isFinite(padding) && padding >= 0, `--padding must be a non-negative number of seconds, got ${padding}`)
    const start = Math.max(0, round(match.start - padding))
    const end = Math.min(duration, round(match.end + padding))
    assert(end > start, "the phrase lies outside the input media; use its matching transcript")
    return { start, end }
  }
  assert(request.occurrence === undefined && request.padding === undefined, "--occurrence and --padding apply to --around")
  const start = request.start ?? 0
  const end = request.end ?? duration
  assert(Number.isFinite(start) && start >= 0, `--start must be a non-negative number of seconds, got ${request.start}`)
  assert(Number.isFinite(end) && end >= 0, `--end must be a non-negative number of seconds, got ${request.end}`)
  assert(end > start && end <= duration, `range must satisfy 0 <= start < end <= ${duration} s`)
  return { start, end }
}

export function sampleTimes(request: SampleRequest, duration: number, requireEvery = false): number[] {
  const at = request.at
  if (at !== undefined) {
    for (const key of ["start", "end", "every", "frames", "around", "occurrence", "padding"] as const) {
      assert(request[key] === undefined, `--at cannot be combined with --${key}`)
    }
    const times = [...at]
    assert(times.length >= 1 && times.every((time) => Number.isFinite(time)), `--at must list non-negative seconds`)
    assert(times.every((time) => time >= 0), `--at must list non-negative seconds`)
    assert(times.every((time) => time < duration), `a frame time must be before the end of the file (${duration} s)`)
    assert(times.every((time, index) => index === 0 || time > times[index - 1]!), "sample times must be strictly increasing")
    return times
  }
  const { start, end } = sampleRange(request, duration)
  const every = request.every
  assert(every === undefined || request.frames === undefined, "choose --every or --frames")
  assert(!requireEvery || every !== undefined, "frames requires --at <s,s,…> or --every <seconds>")
  if (every !== undefined) assert(Number.isFinite(every) && every >= 0.001, "--every must be at least 0.001 seconds")
  const times = every === undefined
    ? tileSampleTimes(start, end, request.frames ?? tileFrameCount(end - start))
    : intervalSamples(start, end, every)
  assert(times.length > 0 && times.every((time) => time < duration), "the range needs sample times before the media ends")
  assert(times.every((time, index) => index === 0 || time > times[index - 1]!), "sample times must be distinct to the nearest millisecond")
  return times
}

export { SAMPLE_OPTIONS, TILE_COLUMNS, TILE_CELL_WIDTH }

// ---------------------------------------------------------------------------
// frames 命令本體

/** 逐格 JPEG（--at / --every），檔名帶來源時間；目錄不得已存在，寫入以 rename 原子發佈。 */
export async function writeFrames(
  source: string,
  times: readonly number[],
  dir: string,
  labelTime: boolean,
  words?: readonly TranscriptWord[],
): Promise<{ at: number; path: string; requestedAt: number }[]> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  assert(times.length >= 1, "at least one frame time is required")
  assert(times.every((time, index) => index === 0 || time > times[index - 1]!), "sample times must be strictly increasing")
  assert(times.every((time) => time < info.duration), `a frame time must be before the end of the file (${info.duration} s)`)
  assert(!(await exists(dir)), `Destination ${dir} already exists`)
  await mkdir(dirname(dir), { recursive: true })
  const staging = await mkdtemp(join(dirname(dir), ".eimu-frames-"))
  const labeled = labelTime || words !== undefined
  const written: (SampledFrame & { readonly path: string })[] = []
  try {
    for (const time of times) {
      const name = `frame-${time.toFixed(3).replace(".", "_")}s.jpg`
      const frame = words === undefined
        ? { requestedAt: time, at: await cutFrame(source, time, join(staging, name), labeled) }
        : (await tileFrames(source, [time], join(staging, name), info.width, 1, words))[0]!
      written.push({ ...frame, path: join(dir, name) })
    }
    await rename(staging, dir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return written
}

export interface NativeFrameOptions {
  readonly grid?: boolean
  readonly labelTime?: boolean
  readonly words?: readonly TranscriptWord[]
  readonly cell?: number
  readonly columns?: number
  readonly rows?: number
  readonly width?: number
}

/** 原生逐格觀察：每個請求區間只解碼一次，再分頁；每格寫入其實際來源時間戳。 */
export async function nativeFrames(
  source: string,
  ranges: readonly SampleRangeInput[],
  dir: string,
  options: NativeFrameOptions = {},
): Promise<{ frames: { at: number; path: string }[]; grids: { path: string; frames: { at: number }[] }[] }> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const grid = options.grid ?? false
  const words = options.words
  const cell = options.cell ?? Math.max(80, Math.min(TILE_CELL_WIDTH, info.width))
  assert(Number.isSafeInteger(cell) && cell >= 80, `--cell must be a whole number of at least 80`)
  const columns = options.columns ?? TILE_COLUMNS
  assert(Number.isSafeInteger(columns) && columns >= 1, `--columns must be a whole number of at least 1`)
  const rows = options.rows ?? 3
  assert(Number.isSafeInteger(rows) && rows >= 1, `--rows must be a whole number of at least 1`)
  assert(ranges.length > 0, "at least one range is required")
  assert(!(await exists(dir)), `Destination ${dir} already exists`)
  await mkdir(dirname(dir), { recursive: true })
  const staging = await mkdtemp(join(dirname(dir), ".eimu-native-"))
  const written: { at: number; path: string }[] = []
  const grids: { path: string; frames: { at: number }[] }[] = []
  try {
    for (const [rangeIndex, range] of ranges.entries()) {
      const decodedDirectory = join(staging, "decoded")
      const decoded = await decodeMediaFrames(source, range.start, range.end, decodedDirectory)
      if (grid) {
        const perPage = columns * rows
        for (let offset = 0; offset < decoded.length; offset += perPage) {
          const page = decoded.slice(offset, offset + perPage)
          const cells: { path: string; label: Buffer }[] = []
          for (const frame of page) cells.push({ path: frame.path, label: await frameLabel(frame.at, cell,
            words === undefined ? undefined : wordsAt(words, frame.at)) })
          const name = `${String(rangeIndex + 1).padStart(3, "0")}-${range.id ?? "frames"}-p${String(offset / perPage + 1).padStart(3, "0")}.jpg`
          await writeFrameGrid(cells, join(staging, name), cell, columns)
          grids.push({ path: join(dir, name), frames: page.map((frame) => ({ at: frame.at })) })
        }
      } else for (const [index, frame] of decoded.entries()) {
        const name = `frame-${String(index).padStart(9, "0")}.jpg`
        const target = join(staging, name)
        if (options.labelTime === true || words !== undefined) await writeFrameGrid([{ path: frame.path,
          label: await frameLabel(frame.at, info.width, words === undefined ? undefined : wordsAt(words, frame.at)) }], target, info.width, 1)
        else await copyFile(frame.path, target)
        written.push({ at: frame.at, path: join(dir, name) })
      }
      await rm(decodedDirectory, { recursive: true, force: true })
    }
    await rename(staging, dir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { frames: written, grids }
}

/** --every-frame 的預設路徑：不解標籤，只把原生幀連續解碼後落地。 */
export async function writeEveryFrame(
  source: string, start: number, end: number, dir: string,
): Promise<{ at: number; path: string }[]> {
  const decoded = await nativeFrames(source, [{ start, end }], dir, { grid: false })
  return decoded.frames
}

// ---------------------------------------------------------------------------
// tiles 命令本體

export interface SampleRangeInput {
  readonly id?: string
  readonly start: number
  readonly end: number
  readonly frames?: number
  readonly every?: number
}

/** 一個 range 物件（ranges JSON 的元素）的驗證，逐條照它。 */
export function parseTileRange(value: unknown, index: number, duration: number): SampleRangeInput {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `range ${index + 1} must be an object`)
  const raw = value as Record<string, unknown>
  assert(typeof raw.start === "number" && Number.isFinite(raw.start) && raw.start >= 0, `range ${index + 1}.start must be non-negative seconds`)
  assert(typeof raw.end === "number" && Number.isFinite(raw.end) && raw.end > (raw.start as number), `range ${index + 1}.end must be after its start`)
  assert((raw.end as number) <= duration, `range ${index + 1}.end is past the end of the file (${duration} s)`)
  assert(raw.id === undefined || (typeof raw.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.id)), `range ${index + 1}.id must be a safe file name`)
  assert(raw.frames === undefined || (Number.isSafeInteger(raw.frames) && (raw.frames as number) >= 2), `range ${index + 1}.frames must be a whole number of at least 2`)
  assert(raw.every === undefined || (typeof raw.every === "number" && Number.isFinite(raw.every) && raw.every >= 0.001), `range ${index + 1}.every must be at least 0.001 seconds`)
  assert(raw.frames === undefined || raw.every === undefined, `range ${index + 1} must choose frames or every`)
  return { ...(raw.id === undefined ? {} : { id: raw.id as string }), start: raw.start as number, end: raw.end as number,
    ...(raw.frames === undefined ? {} : { frames: raw.frames as number }), ...(raw.every === undefined ? {} : { every: raw.every as number }) }
}

export interface TileRangeSpec extends SampleRangeInput {
  readonly times: readonly number[]
}

/** 分頁拼板（預設 3 列）。目錄不得已存在，寫入以 rename 原子發佈。 */
export async function writeTiles(
  source: string,
  ranges: readonly TileRangeSpec[],
  dir: string,
  options: { readonly cell: number; readonly columns: number; readonly rows: number; readonly words?: readonly TranscriptWord[] },
): Promise<{ id?: string; start: number; end: number; samples: readonly number[]; path: string; frames: readonly SampledFrame[] }[]> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const { cell, columns, rows, words } = options
  assert(Number.isSafeInteger(cell) && cell >= 80, `--cell must be a whole number of at least 80`)
  assert(Number.isSafeInteger(columns) && columns >= 1, `--columns must be a whole number of at least 1`)
  assert(Number.isSafeInteger(rows) && rows >= 1, `--rows must be a whole number of at least 1`)
  assert(!(await exists(dir)), `Destination ${dir} already exists`)
  const ids = ranges.flatMap((range) => range.id === undefined ? [] : [range.id])
  assert(new Set(ids).size === ids.length, "range ids must be unique")
  await mkdir(dirname(dir), { recursive: true })
  const perPage = columns * rows
  const staging = await mkdtemp(join(dirname(dir), ".eimu-tiles-"))
  const written: { id?: string; start: number; end: number; samples: readonly number[]; path: string; frames: readonly SampledFrame[] }[] = []
  try {
    for (const [index, range] of ranges.entries()) {
      const stem = range.id ?? `${range.start.toFixed(3).replace(".", "_")}s-${range.end.toFixed(3).replace(".", "_")}s`
      for (let offset = 0; offset < range.times.length; offset += perPage) {
        const times = range.times.slice(offset, offset + perPage)
        const page = range.times.length > perPage ? `-p${String(offset / perPage + 1).padStart(3, "0")}` : ""
        const name = `${String(index + 1).padStart(3, "0")}-${stem}${page}.jpg`
        const frames = await tileFrames(source, times, join(staging, name), cell, columns, words)
        written.push({ ...(range.id === undefined ? {} : { id: range.id }), start: range.start, end: range.end,
          samples: times, path: join(dir, name), frames })
      }
    }
    await rename(staging, dir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return written
}

// ---------------------------------------------------------------------------
// transcript（transcript.ts）：每詞必須有 text；缺時間的詞保持缺，不編造。

/** 我方格式名（欄位名照 hypit：passages[].words[].{text,start_seconds,end_seconds}）。 */
export const TRANSCRIPT_FORMAT = "eimu.transcript@1"

export type TranscriptWord = {
  readonly text: string
  readonly start?: number
  readonly end?: number
}

export type FrameWords = {
  readonly active: TranscriptWord[]
  readonly context: TranscriptWord[]
}

/** 驗證一份已解析的 transcript 物件（inline JSON 與檔案共用同一套驗證）。 */
export function parseTranscript(rawIn: unknown, label: string): TranscriptWord[] {
  const raw = rawIn as { format?: unknown; passages?: unknown }
  assert(raw?.format === TRANSCRIPT_FORMAT, `${label}: expected ${TRANSCRIPT_FORMAT}`)
  assert(Array.isArray(raw.passages), `${label}: expected ${TRANSCRIPT_FORMAT}`)
  return (raw.passages as { words?: unknown }[]).flatMap((passage) => {
    assert(passage !== null && Array.isArray(passage.words), `${label}: each passage needs words`)
    return (passage.words as Record<string, unknown>[]).map((word) => {
      assert(word !== null && typeof word.text === "string", `${label}: each word needs text`)
      const start = word.start_seconds
      const end = word.end_seconds
      assert(start === undefined || (typeof start === "number" && Number.isFinite(start) && start >= 0), `${label}: invalid word start`)
      assert(end === undefined || (typeof end === "number" && Number.isFinite(end) && end >= 0), `${label}: invalid word end`)
      assert(start === undefined || end === undefined || (end as number) >= (start as number), `${label}: word end precedes start`)
      return { text: word.text as string, ...(start === undefined ? {} : { start: start as number }), ...(end === undefined ? {} : { end: end as number }) }
    })
  })
}

export async function readTranscript(path: string): Promise<TranscriptWord[]> {
  return parseTranscript(JSON.parse(await readFile(path, "utf8")) as unknown, path)
}

export function wordsAt(words: readonly TranscriptWord[], at: number): FrameWords {
  const active = words.filter((word) => word.start !== undefined && word.end !== undefined && word.start <= at && at < word.end)
  let anchor = active.length > 0 ? words.indexOf(active[0]!) : -1
  if (anchor < 0) {
    let distance = Infinity
    for (const [index, word] of words.entries()) {
      const time = word.start ?? word.end
      if (time !== undefined && Math.abs(time - at) < distance) { anchor = index; distance = Math.abs(time - at) }
    }
  }
  const last = active.length > 0 ? words.indexOf(active.at(-1)!) : anchor
  return { active, context: anchor < 0 ? [] : words.slice(Math.max(0, anchor - 3), last + 4) }
}

function searchable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "")
}

/** 找出整段連續的轉寫詞；標點與大小寫不影響比對。 */
export function phraseRanges(words: readonly TranscriptWord[], text: string): { start: number; end: number }[] {
  const query = searchable(text)
  assert(query.length > 0, "--around needs a word or phrase")
  const matches: { start: number; end: number }[] = []
  for (let first = 0; first < words.length; first += 1) {
    if (searchable(words[first]!.text).length === 0) continue
    let joined = ""
    for (let last = first; last < words.length && joined.length < query.length; last += 1) {
      joined += searchable(words[last]!.text)
      if (joined !== query) continue
      const start = words[first]!.start
      const end = words[last]!.end
      assert(start !== undefined && end !== undefined, `The phrase ${JSON.stringify(text)} has missing boundary times; inspect its passage and choose --start/--end`)
      matches.push({ start, end })
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// fetch 的 yt-dlp 政策（§D：釘版＋獨立環境＋顯式 prepare＋版本斷言；
// 本輪只實作「未就緒就誠實失敗」，不在 fetch 時自動安裝）
//
// `yt-dlp` 因為在追持續改動的站點而頻繁發版，未釘版的一份會讓同一個連結在兩台機器上抓出不同的結果。

/** 釘版 Python 環境的落點（尚未建立；prepare 由外部顯式執行）。 */
export const YTDLP_HOME = "/opt/agent-harness/workspace/.opencode/ytdlp"
export const YTDLP_PIN_FILE = join(YTDLP_HOME, "PINNED_VERSION")
export const YTDLP_BIN = join(YTDLP_HOME, "venv", "bin", "yt-dlp")

/** 建議的 prepare 指令（顯式、可複核；本輪不代為執行）。 */
export function ytDlpPrepareCommand(pin = "<版本>", python = "python3"): string {
  return [
    `mkdir -p ${YTDLP_HOME}`,
    `printf '%s' '${pin}' > ${YTDLP_PIN_FILE}`,
    `${python} -m venv ${YTDLP_HOME}/venv`,
    `${YTDLP_HOME}/venv/bin/pip install --upgrade pip`,
    `${YTDLP_HOME}/venv/bin/pip install 'yt-dlp==${pin}'`,
    `${YTDLP_BIN} --version`,
  ].join(" && ")
}

export class YtDlpUnavailableError extends Error {
  readonly code = "video_fetch_unavailable"
  readonly prepare: string
  constructor(detail: string, prepare: string) {
    super(detail)
    this.name = "YtDlpUnavailableError"
    this.prepare = prepare
  }
}

export function isVideoUrl(value: string): boolean {
  return /^https?:\/\/\S+$/u.test(value)
}

/**
 * 把一個網址變成檔案（影片＋音訊一起）。政策：只使用釘版的獨立環境，
 * 使用前斷言 `--version` **完全相符**，絕不在 fetch 時自動安裝。
 */
export async function fetchVideo(url: string, target: string): Promise<void> {
  const prepare = ytDlpPrepareCommand()
  assert(isVideoUrl(url), "name an http or https link first")
  assert([".mp4", ".mkv", ".webm", ".mov"].includes(extname(target).toLowerCase()), "--to must end in .mp4, .mkv, .webm or .mov")
  assert(!(await exists(target)), `Destination ${target} already exists`)
  if (!existsSync(YTDLP_BIN)) throw new YtDlpUnavailableError(`yt-dlp is not prepared at ${YTDLP_BIN}`, prepare)
  const pinned = (await readFile(YTDLP_PIN_FILE, "utf8").catch(() => "")).trim()
  if (pinned.length === 0) throw new YtDlpUnavailableError(`no pinned yt-dlp version recorded at ${YTDLP_PIN_FILE}`, prepare)
  const version = (await runProcess(YTDLP_BIN, ["--version"])).toString("utf8").trim()
  if (version !== pinned) {
    throw new YtDlpUnavailableError(`yt-dlp ${version} does not match the pinned ${pinned}; run prepare again instead of fetching with an unpinned copy`, prepare)
  }
  await mkdir(dirname(target), { recursive: true })
  await runProcess(YTDLP_BIN, ["--no-playlist", "-f", "bv*+ba/b", "-o", target, url], 900_000)
}
