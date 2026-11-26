import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assert, clamp, exists, loadSharp, round } from "./video-evidence-process"
import { cutFrame, decodeMediaFrames, probeMedia, requireVideo } from "./video-evidence-probe"
import { type TranscriptWord, wordsAt } from "./video-evidence-transcript"

// ---------------------------------------------------------------------------
// tile 命令本体（单张拼板；目的地不得已存在）

/** 单张拼板：`--every` 从 start 起不含 end；`--frames` 取等距中点。 */
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
// 拼板（frame-grid.ts）

/**
 * 排列已抓到的证据。解码与时间选择属于呼叫端。
 * 标签是 Pre-rendered 的 PNG Buffer（由 frameLabel 产生）；未给标签时该列不留标签条。
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
// 拼板排数/取样（排数语义照它）

export const TILE_COLUMNS = 3
export const TILE_CELL_WIDTH = 480

/** 紧凑总览的预设值。变化快时呼叫端自己指定更密的取样。 */
export function tileFrameCount(seconds: number): number {
  return clamp(Math.round(seconds * 1.5), 4, 9)
}

/** 等距中点取样（--frames 语义）。 */
export function tileSampleTimes(start: number, end: number, frameCount: number): number[] {
  assert(end > start, `the stretch must end after it starts (${start} to ${end})`)
  assert(Number.isSafeInteger(frameCount) && frameCount >= 2, "a grid needs at least two frames")
  return Array.from({ length: frameCount }, (_, index) => round(start + (index + 0.5) * (end - start) / frameCount))
}

/** 从 start 起、不含 end（--every 语义）；every 下限 0.001 秒。 */
export function intervalSamples(start: number, end: number, every: number): number[] {
  assert(Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start, "a sample range needs 0 <= start < end")
  assert(Number.isFinite(every) && every >= 0.001, "--every must be at least 0.001 seconds")
  return Array.from({ length: Math.ceil((end - start) / every) }, (_, index) => round(start + index * every))
    .filter((time) => time < end)
}

function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** 标签条：第一行时间码，第二行活动词（或明示没有），第三行上下文（活动词高亮）。 */
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

/** 抽 N 格 + 叠标签 → 一张拼板。回传每格实际解到的来源时间。 */
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
// frames 命令本体

/** 逐格 JPEG（--at / --every），档名带来源时间；目录不得已存在，写入以 rename 原子发布。 */
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

/** 原生逐格观察：每个请求区间只解码一次，再分页；每格写入其实际来源时间戳。 */
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

/** --every-frame 的预设路径：不解标签，只把原生帧连续解码后落地。 */
export async function writeEveryFrame(
  source: string, start: number, end: number, dir: string,
): Promise<{ at: number; path: string }[]> {
  const decoded = await nativeFrames(source, [{ start, end }], dir, { grid: false })
  return decoded.frames
}

// ---------------------------------------------------------------------------
// tiles 命令本体

export interface SampleRangeInput {
  readonly id?: string
  readonly start: number
  readonly end: number
  readonly frames?: number
  readonly every?: number
}

/** 一个 range 物件（ranges JSON 的元素）的验证，逐条照它。 */
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

/** 分页拼板（预设 3 列）。目录不得已存在，写入以 rename 原子发布。 */
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
