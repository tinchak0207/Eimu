import { tool } from "@opencode-ai/plugin/tool"
import { randomBytes } from "node:crypto"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { fail, ok } from "../lib/client"
import { explainMissingPath } from "../lib/agent-paths"
import { blobPath, uploadBlob } from "../lib/img-composite"
import {
  TILE_COLUMNS,
  TILE_CELL_WIDTH,
  YtDlpUnavailableError,
  cutSpans,
  fetchVideo,
  isVideoUrl,
  nativeFrames,
  parseTileRange,
  parseTranscript,
  probeMedia,
  readTranscript,
  sampleRange,
  sampleTimes,
  visualBoundaries,
  writeFrames,
  writeTile,
  writeTiles,
  type SampleRangeInput,
  type TileRangeSpec,
  type TranscriptWord,
} from "../lib/video-evidence"

// 影片证据面（薄包）：业务逻辑全在 lib/video-evidence.ts，本档只做参数白名单、互斥检查、
// 公网 blob 发布与错误码转译。选择器/互斥语义逐条照竞品 hypit 的 media 子命令（本轮唯一真源）。

type Action = "probe" | "cut" | "frames" | "tile" | "tiles" | "boundaries" | "fetch"

/** 参数 → hypit 选项名（错误讯息与判读沿用它的命名）。 */
const NAME: Record<string, string> = {
  to: "--to", start: "--start", end: "--end", keeps: "--keep", at: "--at", every: "--every",
  frames: "--frames", every_frame: "--every-frame", transcript: "--transcript", around: "--around",
  occurrence: "--occurrence", padding: "--padding", label_time: "--label-time", cell: "--cell",
  columns: "--columns", rows: "--rows", ranges: "--ranges", rate: "--rate", threshold: "--threshold",
}

/** 每个 action 允许的取值选项（照 hypit 各子命令的 allowed 清单）。 */
const OPTIONS: Record<Action, readonly string[]> = {
  probe: [],
  cut: ["start", "end", "keeps", "to"],
  frames: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "to"],
  tile: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "frames", "cell", "columns", "to"],
  tiles: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "ranges", "frames", "cell", "columns", "rows", "to"],
  boundaries: ["rate", "threshold"],
  fetch: ["to"],
}

/** 每个 action 允许的布林旗标。 */
const FLAGS: Record<Action, readonly string[]> = {
  probe: [], cut: ["label_time"], frames: ["label_time", "every_frame"], tile: [], tiles: ["every_frame"], boundaries: [], fetch: [],
}

/** 正规化后的取样请求（args → lib 的 SampleRequest）。 */
type Request = {
  start?: number
  end?: number
  at?: number[]
  every?: number
  frames?: number
  around?: string
  occurrence?: number
  padding?: number
  words?: TranscriptWord[]
}

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".wav": "audio/wav", ".m4a": "audio/mp4",
}

const UPLOAD_LIMIT = 24
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

/** 错误码分类（hypit 没有码；这里把它的错误语义映成稳定码，不改讯息文字）。 */
function classify(message: string): string {
  if (/^Destination .* already exists/u.test(message)) return "destination_exists"
  if (/: no video stream$/u.test(message)) return "no_video_stream"
  if (/: no audio or video stream$/u.test(message)) return "no_media_stream"
  if (/: duration is unavailable$/u.test(message) || /Invalid data found/u.test(message)) return "not_media"
  if (/^cannot read /u.test(message)) return "unreadable_source"
  if (/exited with|timed out after|could not start/u.test(message)) return "ffmpeg_failed"
  return "bad_args"
}

export default tool({
  description:
    "影片证据面（本机、零付费、零上游呼叫）：对一支影片取结构化证据，不是散文摘要。"
    + "action 1:1 对应 hypit 的 media 子命令——"
    + "probe（时长＋音/视讯串流，有 video 才给尺寸与 fps）、"
    + "cut（保留单段[start,end]或用 keeps 有序拼接多段，重新编码并回实际输出秒数；label_time 只在单段且有 video 时可叠来源时间码）、"
    + "frames（--at 秒清单或 every 间隔抽逐格 JPEG，档名带来源时间；every_frame 改为连续解码每个原生帧并保留其实际来源时间戳）、"
    + "tile（单张拼板，frames 取等距中点、every 从 start 起不含 end）、"
    + "tiles（分页拼板，预设 3 列；ranges 收 {start,end,id?,frames?,every?} 阵列，id 需唯一）、"
    + "boundaries（**机械式相邻帧变化候选＋分数，分数不是剪辑判读，绝不是镜头标签**）、"
    + "fetch（抓取连结：直链媒体（video/*、.mp4 等）先走普通 HTTP 下载，不需要 yt-dlp；只有站点页连结才用钉版 yt-dlp。未 prepare 时诚实失败并回 code=video_fetch_unavailable）。"
    + "附 transcript（eimu.transcript@1，词级 start/end 秒）时，拼板/逐格会在图下叠时间码、活动词与上下文，"
    + "并可用 around 片语定位（需 occurrence 处理重复命中，padding 预设 0.3 秒）。"
    + "产物落工作区并（可用时）回公网 url；目的地已存在一律拒绝覆写（code=destination_exists）。"
    + "逐格回传的 at 是**实际解到的来源时间**，不是请求值。",
  args: {
    source: tool.schema.string().describe("本机绝对路径或 http(s) URL（URL 会先落地暂存再处理；yt-dlp 专属路径仍走 action=fetch）。本机路径请给 workspace 内绝对路径——沙箱的 /tmp 是会话私有目录，工具端看不到"),
    action: tool.schema
      .enum(["probe", "cut", "frames", "tile", "tiles", "boundaries", "fetch"])
      .describe("probe=探测；cut=剪辑/拼接；frames=逐格；tile=单张拼板；tiles=分页拼板；boundaries=机械式变化候选；fetch=连结转档案"),
    to: tool.schema.string().optional().describe("输出路径（mp4/mov/webm/mkv/wav）或输出目录；frames/tiles 是目录。已存在即拒绝"),
    start: tool.schema.number().min(0).optional().describe("区间起点（秒，含）；预设 0"),
    end: tool.schema.number().min(0).optional().describe("区间终点（秒，不含；--every 语义下不含片尾）；预设整支时长"),
    keeps: tool.schema
      .array(tool.schema.object({ start: tool.schema.number().min(0), end: tool.schema.number().min(0) }))
      .optional()
      .describe("cut 专用：有序且不重叠的多段 [{start,end}]（后段 start >= 前段 end），与 start/end 互斥"),
    at: tool.schema.array(tool.schema.number()).optional().describe("指定抽格的秒清单，严格递增且每项 < 时长；与 start/end/every/frames/around/occurrence/padding 互斥"),
    every: tool.schema.number().min(0.001).optional().describe("取样间隔（秒，下限 0.001）；从 start 起、不含 end；与 frames 互斥"),
    frames: tool.schema.number().int().min(2).optional().describe("等距中点取样格数（整数 ≥2）；与 every 互斥"),
    every_frame: tool.schema.boolean().optional().describe("改为连续解码每个原生帧（保留实际来源时间戳）；与 at/every/frames 互斥"),
    transcript: tool.schema.string().optional().describe("transcript JSON 的路径或行内 JSON（format 须为 eimu.transcript@1）"),
    around: tool.schema.string().optional().describe("用 transcript 片语定位区间；需 transcript，且与 start/end 互斥"),
    occurrence: tool.schema.number().int().min(1).optional().describe("片语第几次命中（1 起算）；片语重复时必填"),
    padding: tool.schema.number().min(0).optional().describe("around 两侧各加的秒数（预设 0.3），夹在 [0, 时长]"),
    label_time: tool.schema.boolean().optional().describe("把来源时间码叠在图/片上；cut 限单段且有 video，tile/tiles 不接受"),
    cell: tool.schema.number().int().min(80).optional().describe("拼板单格宽（px，下限 80；预设 min(480, 影片宽) 且至少 80）"),
    columns: tool.schema.number().int().min(1).optional().describe("拼板列数（预设 3）"),
    rows: tool.schema.number().int().min(1).optional().describe("tiles 每页列数（预设 3）"),
    ranges: tool.schema
      .union([
        tool.schema.array(
          tool.schema.object({
            start: tool.schema.number().min(0),
            end: tool.schema.number().min(0),
            id: tool.schema.string().optional(),
            frames: tool.schema.number().int().min(2).optional(),
            every: tool.schema.number().min(0.001).optional(),
          }),
        ),
        tool.schema.string(),
      ])
      .optional()
      .describe("tiles 专用：区间阵列（或 JSON 字串／JSON 档路径），元素 {start,end,id?,frames?,every?}；id 需唯一"),
    rate: tool.schema.number().min(1).max(120).optional().describe("boundaries 取样率（样本/秒，1..120，预设 12）"),
    threshold: tool.schema.number().min(0).max(1).optional().describe("boundaries 分数门槛（0..1，预设 0.1）"),
  },
  async execute(args, context) {
    const action = args.action as Action
    const warnings: string[] = []
    try {
      if (!(action in OPTIONS)) throw new Error(`unknown action ${String(args.action)}`)
      for (const [key, value] of Object.entries(args)) {
        if (key === "action" || key === "source" || value === undefined) continue
        if (OPTIONS[action].includes(key) || FLAGS[action].includes(key)) continue
        throw new Error(`unknown option ${NAME[key] ?? `--${key.replaceAll("_", "-")}`} for action ${action}`)
      }
      if (typeof args.source !== "string" || args.source.trim().length === 0) throw new Error("name the media file first")
      const cwd = process.cwd()
      const wantTo = (): string => {
        if (typeof args.to !== "string" || args.to.trim().length === 0) throw new Error("--to is required")
        return resolve(cwd, args.to)
      }
      const words = await loadWords(args.transcript, cwd)
      if (action === "fetch") {
        const to = wantTo()
        await fetchVideo(args.source, to)
        const info = await probeMedia(to)
        return ok({ action, source: args.source, path: to, ...info, warnings, title: `取得 ${to}（${info.duration}s）` })
      }
      const material = await materialize(args.source, cwd)
      try {
        if (action === "probe") {
          const info = await probeMedia(material.path)
          return ok({ action, path: material.path, ...info, warnings, title: `${info.duration}s`
            + (info.hasVideo ? ` ${info.width}x${info.height} ${info.frameRate > 0 ? `${info.frameRate}fps` : "still"}` : " audio only")
            + (info.hasAudio ? " with audio" : " no audio") })
        }
        if (action === "boundaries") {
          const info = await probeMedia(material.path)
          if (!info.hasVideo) throw new Error(`${material.path}: no video stream`)
          const rate = args.rate ?? 12
          const threshold = args.threshold ?? 0.1
          if (!Number.isFinite(rate) || rate < 1 || rate > 120) throw new Error(`--rate must be between 1 and 120, got ${args.rate}`)
          if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be between 0 and 1, got ${args.threshold}`)
          const candidates = await visualBoundaries(material.path, rate, threshold)
          return ok({ action, path: material.path, sampleRate: rate, threshold, candidates,
            note: "机械式相邻帧变化候选，分数不是剪辑判读，也不是镜头标签", warnings,
            title: `${candidates.length} 个变化候选` })
        }
        const request: Request = {
          start: args.start, end: args.end, at: args.at, every: args.every, frames: args.frames,
          around: args.around, occurrence: args.occurrence, padding: args.padding, words,
        }
        if (action === "cut") {
          const info = await probeMedia(material.path)
          const kept = args.keeps ?? []
          if (kept.length > 0 && (args.start !== undefined || args.end !== undefined)) throw new Error("choose --keep intervals or --start/--end")
          const spans = kept.length > 0 ? kept : [{ start: args.start ?? 0, end: args.end ?? info.duration }]
          const labeled = args.label_time === true
          const to = wantTo()
          const result = await cutSpans(material.path, spans, to, labeled)
          let outputAt = 0
          const mapping = spans.map((span) => {
            const item = { sourceStart: span.start, sourceEnd: span.end,
              nominalOutputStart: round(outputAt), nominalOutputEnd: round(outputAt + span.end - span.start) }
            outputAt += span.end - span.start
            return item
          })
          const artifacts = await publish([to], warnings)
          return ok({ action, path: to, spans, mapping, seconds: round(spans.reduce((total, span) => total + span.end - span.start, 0)),
            ...result, labeled, artifacts, warnings,
            title: `${to}（${result.actualSeconds}s${labeled ? "，含来源时间码" : ""}）` })
        }
        if (action === "frames") {
          const info = await probeMedia(material.path)
          if (!info.hasVideo) throw new Error(`${material.path}: no video stream`)
          const to = wantTo()
          const labeled = args.label_time === true || words !== undefined
          if (args.every_frame === true) {
            forbidEveryFrame(request)
            const range = sampleRange(request, info.duration)
            const decoded = await nativeFrames(material.path, [range], to,
              { grid: false, labelTime: args.label_time === true, words, width: info.width })
            const artifacts = await publish(decoded.frames.map((frame) => frame.path), warnings)
            return ok({ action, directory: to, labeled, range, frames: decoded.frames, artifacts, warnings,
              title: `${to}（${decoded.frames.length} 个原生帧）` })
          }
          const times = sampleTimes(request, info.duration, true)
          const written = await writeFrames(material.path, times, to, args.label_time === true, words)
          const artifacts = await publish(written.map((frame) => frame.path), warnings)
          return ok({ action, directory: to, labeled, frames: written, artifacts, warnings,
            title: `${to}（${written.length} 格 / ${written[0]!.at}s → ${written.at(-1)!.at}s）` })
        }
        if (action === "tile") {
          const info = await probeMedia(material.path)
          if (!info.hasVideo) throw new Error(`${material.path}: no video stream`)
          const times = sampleTimes(request, info.duration)
          const cell = args.cell ?? Math.max(80, Math.min(TILE_CELL_WIDTH, info.width))
          const columns = args.columns ?? TILE_COLUMNS
          const to = wantTo()
          const frames = await writeTile(material.path, times, to, cell, columns, words)
          const artifacts = await publish([to], warnings)
          return ok({ action, path: to, samples: times, columns, rows: Math.ceil(times.length / columns), cellWidth: cell,
            frames, artifacts, warnings, title: `${to}（${times.length} 格，${columns}x${Math.ceil(times.length / columns)}）` })
        }
        // tiles
        const info = await probeMedia(material.path)
        if (!info.hasVideo) throw new Error(`${material.path}: no video stream`)
        const cell = args.cell ?? Math.max(80, Math.min(TILE_CELL_WIDTH, info.width))
        const columns = args.columns ?? TILE_COLUMNS
        const rows = args.rows ?? 3
        const to = wantTo()
        if (args.every_frame === true) {
          forbidEveryFrame(request)
          const ranges = await nativeRanges(args.ranges, request, info.duration, cwd)
          const decoded = await nativeFrames(material.path, ranges, to,
            { grid: true, labelTime: true, words, cell, columns, rows, width: info.width })
          const artifacts = await publish(decoded.grids.map((grid) => grid.path), warnings)
          return ok({ action, directory: to, columns, rows, cellWidth: cell, grids: decoded.grids, artifacts, warnings,
            title: `${to}（${decoded.grids.length} 张拼板）` })
        }
        const specs = await tileSpecs(args.ranges, request, info.duration, cwd)
        const grids = await writeTiles(material.path, specs, to, { cell, columns, rows, words })
        const artifacts = await publish(grids.map((grid) => grid.path), warnings)
        return ok({ action, directory: to, columns, rows, cellWidth: cell, grids, artifacts, warnings,
          title: `${to}（${grids.length} 张拼板）` })
      } finally {
        if (material.temp) await rm(material.path, { force: true })
      }
    } catch (error) {
      if (error instanceof YtDlpUnavailableError) {
        return fail("video_fetch_unavailable", error.message, {
          title: "取得连结失败（yt-dlp 未就绪）",
          prepare: error.prepare,
          preferred: 'video_fetch { "action": "prepare" }',
          source: args.source,
        })
      }
      const message = msgOf(error)
      return fail(classify(message), message, { title: "影片证据面失败", action, source: args.source })
    }
  },
})

// ---------------------------------------------------------------------------
// 参数层辅助（薄）

/** transcript 收行内 JSON 或档案路径（相对 cwd）；缺时间的词保持缺。 */
async function loadWords(value: string | undefined, cwd: string): Promise<TranscriptWord[] | undefined> {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return parseTranscript(JSON.parse(trimmed) as unknown, "--transcript")
  return readTranscript(resolve(cwd, value))
}

/** source 收本机档或 http(s) URL；URL 先落地暂存（同 lib/asr.ts 的 200MB 硬顶口径）。 */
async function materialize(source: string, cwd: string): Promise<{ path: string; temp: boolean }> {
  if (!isVideoUrl(source)) {
    const path = resolve(cwd, source)
    const isFile = await stat(path).then((item) => item.isFile(), () => false)
    if (!isFile) throw new Error(`cannot read ${path}${explainMissingPath(path) ?? ""}`)
    return { path, temp: false }
  }
  const response = await fetch(source, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`download failed HTTP ${response.status} ${source}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`download was empty: ${source}`)
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`source ${bytes.byteLength} bytes exceeds ${MAX_DOWNLOAD_BYTES}`)
  const extension = extname(new URL(source).pathname) || ".mp4"
  const path = join(tmpdir(), `eimu-evidence-${Date.now()}-${randomBytes(3).toString("hex")}${extension}`)
  await writeFile(path, bytes)
  return { path, temp: true }
}

/** tiles 的区间规格（照 hypit：ranges 档与 --start/--end/--at 互斥；每段可自带 frames/every）。 */
async function tileSpecs(raw: unknown, request: Request, duration: number, cwd: string): Promise<TileRangeSpec[]> {
  const ranges = await readRanges(raw, cwd)
  if (ranges === undefined) {
    const times = sampleTimes(request, duration)
    const range = request.at !== undefined ? { start: times[0]!, end: times.at(-1)! } : sampleRange(request, duration)
    return [{ ...range, times }]
  }
  forbidWithRanges(request, ["start", "end", "at", "around", "padding", "occurrence"])
  if (request.frames !== undefined && request.every !== undefined) throw new Error("choose --frames or --every")
  return ranges.map((value, index) => {
    const range = parseTileRange(value, index, duration)
    const times = sampleTimes({
      start: range.start, end: range.end, words: request.words,
      frames: range.frames ?? (range.every === undefined ? request.frames : undefined),
      every: range.every ?? (range.frames === undefined ? request.every : undefined),
    }, duration)
    return { ...range, times }
  })
}

/** tiles + every_frame：每个区间连续解码一次（原生区间不得指定 frames/every）。 */
async function nativeRanges(raw: unknown, request: Request, duration: number, cwd: string): Promise<SampleRangeInput[]> {
  const ranges = await readRanges(raw, cwd)
  if (ranges === undefined) return [sampleRange(request, duration)]
  forbidWithRanges(request, ["start", "end", "around", "padding", "occurrence"])
  const parsed = ranges.map((value, index) => parseTileRange(value, index, duration))
  if (parsed.some((range) => range.frames !== undefined || range.every !== undefined)) {
    throw new Error("Native ranges cannot specify frames or every")
  }
  return parsed
}

function forbidWithRanges(request: Request, keys: readonly (keyof Request)[]): void {
  for (const key of keys) {
    if (request[key] !== undefined) throw new Error(`--ranges cannot be combined with ${NAME[key] ?? `--${String(key)}`}`)
  }
}

/** 照它：--every-frame 不可与 --at/--every/--frames 并用。 */
function forbidEveryFrame(request: Request): void {
  for (const key of ["at", "every", "frames"] as const) {
    if (request[key] !== undefined) throw new Error(`--every-frame cannot be combined with ${NAME[key]}`)
  }
}

/** ranges 收阵列、JSON 字串或 JSON 档路径。 */
async function readRanges(ranges: unknown, cwd: string): Promise<unknown[] | undefined> {
  if (ranges === undefined) return undefined
  let raw: unknown = ranges
  if (typeof ranges === "string") {
    const trimmed = ranges.trim()
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) raw = JSON.parse(trimmed) as unknown
    else raw = JSON.parse(await readFile(resolve(cwd, ranges), "utf8")) as unknown
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("--ranges must contain a non-empty JSON array")
  return raw
}

/** 产物发布：落档已在 lib，这里只（可用时）补公网 url；单次上限 24 个、单档上限 25MB。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths.slice(0, UPLOAD_LIMIT)) {
    const extension = extname(path).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超过公网上传上限 25MB，只回本机路径`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-evidence", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公网上传失败（${msgOf(error)}），只回本机路径`)
      published.push({ path })
    }
  }
  if (paths.length > UPLOAD_LIMIT) warnings.push(`另有 ${paths.length - UPLOAD_LIMIT} 个产物未上传（单次上限 ${UPLOAD_LIMIT}）`)
  return published
}
