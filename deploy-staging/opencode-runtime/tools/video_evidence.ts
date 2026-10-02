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

// 影片證據面（薄包）：業務邏輯全在 lib/video-evidence.ts，本檔只做參數白名單、互斥檢查、
// 公網 blob 發佈與錯誤碼轉譯。選擇器/互斥語義逐條照競品 hypit 的 media 子命令（本輪唯一真源）。

type Action = "probe" | "cut" | "frames" | "tile" | "tiles" | "boundaries" | "fetch"

/** 參數 → hypit 選項名（錯誤訊息與判讀沿用它的命名）。 */
const NAME: Record<string, string> = {
  to: "--to", start: "--start", end: "--end", keeps: "--keep", at: "--at", every: "--every",
  frames: "--frames", every_frame: "--every-frame", transcript: "--transcript", around: "--around",
  occurrence: "--occurrence", padding: "--padding", label_time: "--label-time", cell: "--cell",
  columns: "--columns", rows: "--rows", ranges: "--ranges", rate: "--rate", threshold: "--threshold",
}

/** 每個 action 允許的取值選項（照 hypit 各子命令的 allowed 清單）。 */
const OPTIONS: Record<Action, readonly string[]> = {
  probe: [],
  cut: ["start", "end", "keeps", "to"],
  frames: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "to"],
  tile: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "frames", "cell", "columns", "to"],
  tiles: ["start", "end", "at", "every", "transcript", "around", "occurrence", "padding", "ranges", "frames", "cell", "columns", "rows", "to"],
  boundaries: ["rate", "threshold"],
  fetch: ["to"],
}

/** 每個 action 允許的布林旗標。 */
const FLAGS: Record<Action, readonly string[]> = {
  probe: [], cut: ["label_time"], frames: ["label_time", "every_frame"], tile: [], tiles: ["every_frame"], boundaries: [], fetch: [],
}

/** 正規化後的取樣請求（args → lib 的 SampleRequest）。 */
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

/** 錯誤碼分類（hypit 沒有碼；這裡把它的錯誤語義映成穩定碼，不改訊息文字）。 */
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
    "影片證據面（本機、零付費、零上游呼叫）：對一支影片取結構化證據，不是散文摘要。"
    + "action 1:1 對應 hypit 的 media 子命令——"
    + "probe（時長＋音/視訊串流，有 video 才給尺寸與 fps）、"
    + "cut（保留單段[start,end]或用 keeps 有序拼接多段，重新編碼並回實際輸出秒數；label_time 只在單段且有 video 時可疊來源時間碼）、"
    + "frames（--at 秒清單或 every 間隔抽逐格 JPEG，檔名帶來源時間；every_frame 改為連續解碼每個原生幀並保留其實際來源時間戳）、"
    + "tile（單張拼板，frames 取等距中點、every 從 start 起不含 end）、"
    + "tiles（分頁拼板，預設 3 列；ranges 收 {start,end,id?,frames?,every?} 陣列，id 需唯一）、"
    + "boundaries（**機械式相鄰幀變化候選＋分數，分數不是剪輯判讀，絕不是鏡頭標籤**）、"
    + "fetch（用釘版 yt-dlp 把連結變成檔案；未 prepare 時誠實失敗並回 code=video_fetch_unavailable）。"
    + "附 transcript（eimu.transcript@1，詞級 start/end 秒）時，拼板/逐格會在圖下疊時間碼、活動詞與上下文，"
    + "並可用 around 片語定位（需 occurrence 處理重複命中，padding 預設 0.3 秒）。"
    + "產物落工作區並（可用時）回公網 url；目的地已存在一律拒絕覆寫（code=destination_exists）。"
    + "逐格回傳的 at 是**實際解到的來源時間**，不是請求值。",
  args: {
    source: tool.schema.string().describe("本機絕對路徑或 http(s) URL（URL 會先落地暫存再處理；yt-dlp 專屬路徑仍走 action=fetch）。本機路徑請給 workspace 內絕對路徑——沙箱的 /tmp 是會話私有目錄，工具端看不到"),
    action: tool.schema
      .enum(["probe", "cut", "frames", "tile", "tiles", "boundaries", "fetch"])
      .describe("probe=探測；cut=剪輯/拼接；frames=逐格；tile=單張拼板；tiles=分頁拼板；boundaries=機械式變化候選；fetch=連結轉檔案"),
    to: tool.schema.string().optional().describe("輸出路徑（mp4/mov/webm/mkv/wav）或輸出目錄；frames/tiles 是目錄。已存在即拒絕"),
    start: tool.schema.number().min(0).optional().describe("區間起點（秒，含）；預設 0"),
    end: tool.schema.number().min(0).optional().describe("區間終點（秒，不含；--every 語義下不含片尾）；預設整支時長"),
    keeps: tool.schema
      .array(tool.schema.object({ start: tool.schema.number().min(0), end: tool.schema.number().min(0) }))
      .optional()
      .describe("cut 專用：有序且不重疊的多段 [{start,end}]（後段 start >= 前段 end），與 start/end 互斥"),
    at: tool.schema.array(tool.schema.number()).optional().describe("指定抽格的秒清單，嚴格遞增且每項 < 時長；與 start/end/every/frames/around/occurrence/padding 互斥"),
    every: tool.schema.number().min(0.001).optional().describe("取樣間隔（秒，下限 0.001）；從 start 起、不含 end；與 frames 互斥"),
    frames: tool.schema.number().int().min(2).optional().describe("等距中點取樣格數（整數 ≥2）；與 every 互斥"),
    every_frame: tool.schema.boolean().optional().describe("改為連續解碼每個原生幀（保留實際來源時間戳）；與 at/every/frames 互斥"),
    transcript: tool.schema.string().optional().describe("transcript JSON 的路徑或行內 JSON（format 須為 eimu.transcript@1）"),
    around: tool.schema.string().optional().describe("用 transcript 片語定位區間；需 transcript，且與 start/end 互斥"),
    occurrence: tool.schema.number().int().min(1).optional().describe("片語第幾次命中（1 起算）；片語重複時必填"),
    padding: tool.schema.number().min(0).optional().describe("around 兩側各加的秒數（預設 0.3），夾在 [0, 時長]"),
    label_time: tool.schema.boolean().optional().describe("把來源時間碼疊在圖/片上；cut 限單段且有 video，tile/tiles 不接受"),
    cell: tool.schema.number().int().min(80).optional().describe("拼板單格寬（px，下限 80；預設 min(480, 影片寬) 且至少 80）"),
    columns: tool.schema.number().int().min(1).optional().describe("拼板列數（預設 3）"),
    rows: tool.schema.number().int().min(1).optional().describe("tiles 每頁列數（預設 3）"),
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
      .describe("tiles 專用：區間陣列（或 JSON 字串／JSON 檔路徑），元素 {start,end,id?,frames?,every?}；id 需唯一"),
    rate: tool.schema.number().min(1).max(120).optional().describe("boundaries 取樣率（樣本/秒，1..120，預設 12）"),
    threshold: tool.schema.number().min(0).max(1).optional().describe("boundaries 分數門檻（0..1，預設 0.1）"),
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
            note: "機械式相鄰幀變化候選，分數不是剪輯判讀，也不是鏡頭標籤", warnings,
            title: `${candidates.length} 個變化候選` })
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
            title: `${to}（${result.actualSeconds}s${labeled ? "，含來源時間碼" : ""}）` })
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
              title: `${to}（${decoded.frames.length} 個原生幀）` })
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
            title: `${to}（${decoded.grids.length} 張拼板）` })
        }
        const specs = await tileSpecs(args.ranges, request, info.duration, cwd)
        const grids = await writeTiles(material.path, specs, to, { cell, columns, rows, words })
        const artifacts = await publish(grids.map((grid) => grid.path), warnings)
        return ok({ action, directory: to, columns, rows, cellWidth: cell, grids, artifacts, warnings,
          title: `${to}（${grids.length} 張拼板）` })
      } finally {
        if (material.temp) await rm(material.path, { force: true })
      }
    } catch (error) {
      if (error instanceof YtDlpUnavailableError) {
        return fail("video_fetch_unavailable", error.message, {
          title: "取得連結失敗（yt-dlp 未就緒）",
          prepare: error.prepare,
          preferred: "video_fetch action=prepare（釘版 yt-dlp venv，lib/video-fetch.ts；本輪並行交付）",
          source: args.source,
        })
      }
      const message = msgOf(error)
      return fail(classify(message), message, { title: "影片證據面失敗", action, source: args.source })
    }
  },
})

// ---------------------------------------------------------------------------
// 參數層輔助（薄）

/** transcript 收行內 JSON 或檔案路徑（相對 cwd）；缺時間的詞保持缺。 */
async function loadWords(value: string | undefined, cwd: string): Promise<TranscriptWord[] | undefined> {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return parseTranscript(JSON.parse(trimmed) as unknown, "--transcript")
  return readTranscript(resolve(cwd, value))
}

/** source 收本機檔或 http(s) URL；URL 先落地暫存（同 lib/asr.ts 的 200MB 硬頂口徑）。 */
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

/** tiles 的區間規格（照 hypit：ranges 檔與 --start/--end/--at 互斥；每段可自帶 frames/every）。 */
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

/** tiles + every_frame：每個區間連續解碼一次（原生區間不得指定 frames/every）。 */
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

/** 照它：--every-frame 不可與 --at/--every/--frames 併用。 */
function forbidEveryFrame(request: Request): void {
  for (const key of ["at", "every", "frames"] as const) {
    if (request[key] !== undefined) throw new Error(`--every-frame cannot be combined with ${NAME[key]}`)
  }
}

/** ranges 收陣列、JSON 字串或 JSON 檔路徑。 */
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

/** 產物發佈：落檔已在 lib，這裡只（可用時）補公網 url；單次上限 24 個、單檔上限 25MB。 */
async function publish(paths: string[], warnings: string[]): Promise<{ path: string; url?: string }[]> {
  const published: { path: string; url?: string }[] = []
  for (const path of paths.slice(0, UPLOAD_LIMIT)) {
    const extension = extname(path).toLowerCase()
    try {
      const bytes = await readFile(path)
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        warnings.push(`${path}: ${bytes.byteLength} bytes 超過公網上傳上限 25MB，只回本機路徑`)
        published.push({ path })
        continue
      }
      const url = await uploadBlob(blobPath("video-evidence", extension.replace(".", "") || "bin"), bytes,
        CONTENT_TYPE[extension] ?? "application/octet-stream")
      published.push({ path, url })
    } catch (error) {
      warnings.push(`${path}: 公網上傳失敗（${msgOf(error)}），只回本機路徑`)
      published.push({ path })
    }
  }
  if (paths.length > UPLOAD_LIMIT) warnings.push(`另有 ${paths.length - UPLOAD_LIMIT} 個產物未上傳（單次上限 ${UPLOAD_LIMIT}）`)
  return published
}
