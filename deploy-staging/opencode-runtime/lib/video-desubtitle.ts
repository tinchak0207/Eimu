// 去字幕（Dramagic `clear_video_subtitle`，D27）——本机、零付费、零上游。
//
// 形态来源（不另造程序层）：程序层／探测／抽格／档案惯例逐条复用我方既有轮子
//   lib/video-evidence.ts 的 runProcess / probeMedia / requireVideo / cutFrame
//   ＋ ffmpeg 绝对路径惯例（同 lib/asr.ts:61-62）。
// 本档新增的只有「字幕带」这一格的量测与移除：
//   ① detectSubtitleBand：对画面下缘 region 抽样，逐列算**水平梯度能量**，
//      以跨帧 p80 取样判定「持续存在文字笔画」的连续列区段 ⇒ 有/无字幕带；
//   ② removeSubtitleBand：delogo（保留解析度的空间内插）或 crop（下裁）；
//   ③ measureBandChange / re-detect：前后同秒抽格的带内外像素差 + 移除后重侦测。
//
// 铁律：本档所有数字都是**量测事实**（像素能量、秒、杂凑），不是主观判断；
// 侦测不到字幕带一律回报 found:false（呼叫端转成具名错误码），不得静默回成功。

import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { cutFrame, probeMedia, requireVideo, runProcess, type MediaProbe } from "./video-evidence"

// ─────────────────────────────────────────── 执行档（惯例同 lib/asr.ts / lib/video-evidence.ts）

const BIN_DIR = "/opt/eimu-harness/bin"
const FFMPEG = process.env.FFMPEG_PATH || (existsSync(join(BIN_DIR, "ffmpeg")) ? join(BIN_DIR, "ffmpeg") : "ffmpeg")

const FFMPEG_TIMEOUT_MS = 600_000

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

export function sha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex")
}

// ─────────────────────────────────────────── 侦测

/** 侦测参数（预设值＝本轮对 1280x720／24fps 素材实测可用的值）。 */
export interface DetectOptions {
  /** 只看画面下缘这个比例（0.05..0.6）；字幕惯例在下缘。 */
  region?: number
  /** 抽样率（样本/秒）。 */
  sample_rate?: number
  /** 抽样上限（帧）。 */
  max_samples?: number
  /** 相对门槛：列的 p80 梯度能量须 ≥ max(sensitivity × 参考中位数, floor)。 */
  sensitivity?: number
  /** 绝对门槛（灰阶梯度单位 0..255 的平均值）。 */
  floor?: number
  /** 最小字幕带高度（像素）。 */
  min_band_height?: number
  /** 只量测前 N 秒（预设整支）。 */
  max_seconds?: number
}

export interface SubtitleBand {
  /** 带的左上角 y（整幅画面座标，像素）。 */
  y: number
  /** 带高（像素）。 */
  height: number
  width: number
  /** 带内列的 p80 梯度能量平均。 */
  band_energy: number
  /** 同 region 的参考中位数梯度能量（稳健底噪）。 */
  reference_energy: number
  /** band_energy / reference_energy。 */
  ratio: number
  /** 抽样几帧、样本率、region 像素范围。 */
  samples: number
  sample_rate: number
  region_top: number
  region_height: number
}

export interface DetectResult {
  found: boolean
  band?: SubtitleBand
  /** 量测事实（无论 found 与否都回，供人核对与调参）。 */
  measured: {
    width: number
    height: number
    duration: number
    frame_rate: number
    samples: number
    sample_rate: number
    region_top: number
    region_height: number
    reference_energy: number
    floor_energy: number
    /** 每个 region 列的 p80 能量（由 region_top 起算），供人工检视。 */
    row_profile: number[]
    best_run_height: number
    best_run_ratio: number
  }
  reason?: string
}

/**
 * 机械式字幕带侦测。回传的是**量测事实**：每个下缘列在抽样帧上的 p80 水平梯度能量，
 * 以及符合门槛的最长连续列区段。不是「看起来像字幕」的主观描述。
 */
export async function detectSubtitleBand(source: string, opts: DetectOptions = {}): Promise<DetectResult> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const video = info as MediaProbe & { width: number; height: number; frameRate: number }

  const region = opts.region ?? 0.35
  assert(Number.isFinite(region) && region >= 0.05 && region <= 0.6, `region must be between 0.05 and 0.6, got ${region}`)
  const sampleRate = opts.sample_rate ?? 1
  assert(Number.isFinite(sampleRate) && sampleRate >= 0.05 && sampleRate <= 30, `sample_rate must be between 0.05 and 30, got ${sampleRate}`)
  const sensitivity = opts.sensitivity ?? 2
  assert(Number.isFinite(sensitivity) && sensitivity >= 1 && sensitivity <= 20, `sensitivity must be between 1 and 20, got ${sensitivity}`)
  const floor = opts.floor ?? 1.5
  assert(Number.isFinite(floor) && floor >= 0 && floor <= 255, `floor must be between 0 and 255, got ${floor}`)
  const minHeight = opts.min_band_height ?? Math.max(6, Math.round(video.height * 0.012))
  assert(Number.isSafeInteger(minHeight) && minHeight >= 3, `min_band_height must be an integer >= 3, got ${opts.min_band_height}`)

  const width = even(video.width)
  const regionHeight = even(video.height * region)
  const regionTop = even(video.height - regionHeight)
  const usableHeight = even(video.height - regionTop)
  const duration = opts.max_seconds === undefined ? info.duration : Math.min(info.duration, opts.max_seconds)
  const maxSamples = opts.max_samples ?? 24
  const samples = Math.max(2, Math.min(maxSamples, Math.max(2, Math.ceil(duration * sampleRate))))

  const bytes = await runProcess(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", source,
    "-vf", `fps=${sampleRate},crop=${width}:${usableHeight}:0:${regionTop},format=gray`,
    "-frames:v", String(samples),
    "-f", "rawvideo", "-",
  ], FFMPEG_TIMEOUT_MS)

  const frameBytes = width * usableHeight
  const frames: Uint8Array[] = []
  for (let index = 0; index + frameBytes <= bytes.byteLength; index += frameBytes) {
    frames.push(bytes.subarray(index, index + frameBytes))
  }
  assert(frames.length >= 2, `${source}: 抽样帧不足（拿到 ${frames.length} 帧），无法做跨帧判定`)

  // 逐列、逐帧的水平梯度能量 → 每列取 p80（文字存在时的典型能量，容忍字幕间歇出现）。
  const rowProfile: number[] = []
  for (let row = 0; row < usableHeight; row += 1) {
    const energies: number[] = []
    for (const frame of frames) {
      const offset = row * width
      let total = 0
      for (let column = 0; column + 1 < width; column += 1) {
        total += Math.abs(frame[offset + column + 1]! - frame[offset + column]!)
      }
      energies.push(total / (width - 1))
    }
    energies.sort((a, b) => a - b)
    rowProfile.push(round(energies[Math.min(energies.length - 1, Math.floor(energies.length * 0.8))]!))
  }

  const sorted = [...rowProfile].sort((a, b) => a - b)
  const reference = sorted[Math.floor(sorted.length / 2)] ?? 0
  const threshold = Math.max(sensitivity * reference, floor)

  // 最长连续候选列区段（且不得吃掉整个 region：那不是「带」而是整片高频质感）。
  let bestStart = -1
  let bestLength = 0
  let start = -1
  for (let row = 0; row <= rowProfile.length; row += 1) {
    const hot = row < rowProfile.length && rowProfile[row]! >= threshold
    if (hot && start < 0) start = row
    if (!hot && start >= 0) {
      const length = row - start
      if (length > bestLength) {
        bestLength = length
        bestStart = start
      }
      start = -1
    }
  }

  let bandEnergy = 0
  if (bestStart >= 0) {
    const slice = rowProfile.slice(bestStart, bestStart + bestLength)
    bandEnergy = round(slice.reduce((total, value) => total + value, 0) / slice.length)
  }
  const ratio = reference > 0 ? round(bandEnergy / reference) : (bandEnergy > 0 ? Infinity : 0)
  const coverage = bestLength / usableHeight

  const measured = {
    width, height: video.height, duration: round(info.duration), frame_rate: video.frameRate,
    samples: frames.length, sample_rate: sampleRate,
    region_top: regionTop, region_height: usableHeight,
    reference_energy: round(reference), floor_energy: round(threshold),
    row_profile: rowProfile, best_run_height: bestLength, best_run_ratio: ratio,
  }

  if (bestStart < 0 || bestLength < minHeight) {
    return {
      found: false, measured,
      reason: `下缘 ${Math.round(region * 100)}% 抽 ${frames.length} 帧未找到 ≥${minHeight}px 的持续文字列区段`
        + `（最长 ${bestLength}px，p80 中位数能量 ${round(reference)}，门槛 ${round(threshold)}）`,
    }
  }
  if (coverage > 0.8) {
    return {
      found: false, measured,
      reason: `候选区段覆盖 region ${(coverage * 100).toFixed(1)}%（>80%）⇒ 判为整片高频质感而非字幕带`,
    }
  }

  const band: SubtitleBand = {
    y: regionTop + bestStart,
    height: bestLength,
    width: video.width,
    band_energy: bandEnergy,
    reference_energy: round(reference),
    ratio,
    samples: frames.length,
    sample_rate: sampleRate,
    region_top: regionTop,
    region_height: usableHeight,
  }
  return { found: true, band, measured }
}

// ─────────────────────────────────────────── 移除

export type RemoveMethod = "delogo" | "crop"

export interface RemoveOptions {
  method?: RemoveMethod
  /** delogo 的外扩像素（预设 6）；字幕笔画常贴著侦测边界。 */
  pad?: number
  keep_audio?: boolean
}

export interface RemoveResult {
  method: RemoveMethod
  filter: string
  /** delogo 实际使用的矩形（clamp 到画面内且留 1px 边界）。 */
  rect: { x: number; y: number; width: number; height: number }
  output_duration: number
  output_width: number
  output_height: number
}

/**
 * 移除侦测到的字幕带。`delogo` 对该矩形做空间内插（解析度不变、矩形外逐位元不动）；
 * `crop` 直接下裁（解析度变小，但完全不动其他像素的内容分布）。
 */
export async function removeSubtitleBand(
  source: string,
  target: string,
  band: SubtitleBand,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const video = info as MediaProbe & { width: number; height: number; frameRate: number }
  const method: RemoveMethod = opts.method ?? "delogo"
  const keepAudio = opts.keep_audio !== false

  assert(band.height >= 1 && band.y >= 0 && band.y + band.height <= video.height,
    `字幕带 [${band.y}, ${band.y + band.height}) 超出画面高 ${video.height}`)

  if (method === "crop") {
    // 带贴下缘 ⇒ 裁掉下缘；否则裁掉带以上的部分（保留带以下）。
    const keepTop = band.y >= video.height - (band.y + band.height)
    const cropHeight = even(keepTop ? band.y : video.height - band.y - band.height)
    assert(cropHeight >= 16, `crop 后高度 ${cropHeight}px 过小，拒绝执行`)
    const cropY = even(keepTop ? 0 : band.y + band.height)
    const filter = `crop=${even(video.width)}:${cropHeight}:0:${cropY}`
    await runProcess(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      ...(keepAudio ? ["-c:a", "copy"] : ["-an"]), "-movflags", "+faststart", target,
    ], FFMPEG_TIMEOUT_MS)
    const out = await probeMedia(target)
    return {
      method, filter,
      rect: { x: 0, y: cropY, width: video.width, height: cropHeight },
      output_duration: out.duration,
      output_width: (out as MediaProbe & { width?: number }).width ?? 0,
      output_height: (out as MediaProbe & { height?: number }).height ?? 0,
    }
  }

  // delogo：外扩 pad 后 clamp，并确保四周各留 1px（delogo 要求矩形在画面内）。
  const pad = opts.pad ?? 6
  assert(Number.isFinite(pad) && pad >= 0 && pad <= 64, `pad must be between 0 and 64, got ${pad}`)
  const x = 1
  const y = Math.min(Math.max(1, band.y - pad), video.height - 3)
  const width = Math.max(2, video.width - 2)
  const height = Math.max(2, Math.min(band.height + pad * 2, video.height - y - 1))
  const rect = { x, y, width, height }
  const filter = `delogo=x=${rect.x}:y=${rect.y}:w=${rect.width}:h=${rect.height}`
  await runProcess(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(keepAudio ? ["-c:a", "copy"] : ["-an"]), "-movflags", "+faststart", target,
  ], FFMPEG_TIMEOUT_MS)
  const out = await probeMedia(target)
  return {
    method, filter, rect,
    output_duration: out.duration,
    output_width: (out as MediaProbe & { width?: number }).width ?? 0,
    output_height: (out as MediaProbe & { height?: number }).height ?? 0,
  }
}

// ─────────────────────────────────────────── 前后量测（证据）

async function grayFrameAt(path: string, at: number, width: number, height: number): Promise<Uint8Array> {
  const jump = Math.max(0, at - 2)
  const bytes = await runProcess(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-copyts", "-start_at_zero",
    ...(jump > 0 ? ["-ss", String(round(jump))] : []), "-i", path,
    "-vf", `trim=start=${at},format=gray`, "-frames:v", "1", "-fps_mode", "passthrough",
    "-f", "rawvideo", "-",
  ], FFMPEG_TIMEOUT_MS)
  assert(bytes.byteLength >= width * height, `${path}: 抽格不足（${bytes.byteLength} < ${width * height}）`)
  return bytes.subarray(0, width * height)
}

export interface BandChangeEvidence {
  at: number
  before: { path: string; sha256: string }
  after: { path: string; sha256: string }
  /** 带内（y..y+h）每像素灰阶平均绝对差。 */
  inside_band_mean_abs_diff: number
  /** 带外每像素灰阶平均绝对差。 */
  outside_band_mean_abs_diff: number
  /** 与带外相比的倍数（delogo 应该远大于 1；愈大＝改动愈集中在带内）。 */
  localization_ratio: number
  compared_rows: { inside: number; outside: number }
  note: string
}

/**
 * 同秒抽格前后对照：回传两张 JPEG 的本机路径与 SHA-256，以及带内／带外像素差。
 * 这是量测事实：`inside_band_mean_abs_diff >> outside_band_mean_abs_diff` 才证明
 * 「改动集中在字幕带」，不是「我看起来干净了」。
 */
export async function measureBandChange(
  source: string,
  output: string,
  band: { y: number; height: number },
  dir: string,
  at: number,
): Promise<BandChangeEvidence> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const video = info as MediaProbe & { width: number; height: number; frameRate: number }
  const outInfo = await probeMedia(output)
  requireVideo(outInfo, output)
  const outVideo = outInfo as MediaProbe & { width: number; height: number; frameRate: number }
  assert(outVideo.width === video.width && outVideo.height === video.height,
    `前后解析度不同（${video.width}x${video.height} → ${outVideo.width}x${outVideo.height}）：逐像素差只在同解析度下有意义`)

  const beforePath = join(dir, `band-before-${round(at)}s.jpg`)
  const afterPath = join(dir, `band-after-${round(at)}s.jpg`)
  await cutFrame(source, at, beforePath)
  await cutFrame(output, at, afterPath)

  const beforeGray = await grayFrameAt(source, at, video.width, video.height)
  const afterGray = await grayFrameAt(output, at, video.width, video.height)

  const top = Math.max(0, Math.min(band.y, video.height - 1))
  const bottom = Math.max(top + 1, Math.min(band.y + band.height, video.height))
  let insideTotal = 0
  let insideCount = 0
  let outsideTotal = 0
  let outsideCount = 0
  for (let row = 0; row < video.height; row += 1) {
    const inside = row >= top && row < bottom
    const offset = row * video.width
    for (let column = 0; column < video.width; column += 1) {
      const delta = Math.abs(afterGray[offset + column]! - beforeGray[offset + column]!)
      if (inside) {
        insideTotal += delta
        insideCount += 1
      } else {
        outsideTotal += delta
        outsideCount += 1
      }
    }
  }
  const inside = insideCount > 0 ? insideTotal / insideCount : 0
  const outside = outsideCount > 0 ? outsideTotal / outsideCount : 0
  return {
    at: round(at),
    before: { path: beforePath, sha256: sha256(await readFile(beforePath)) },
    after: { path: afterPath, sha256: sha256(await readFile(afterPath)) },
    inside_band_mean_abs_diff: round(inside),
    outside_band_mean_abs_diff: round(outside),
    localization_ratio: outside > 0 ? round(inside / outside) : Infinity,
    compared_rows: { inside: bottom - top, outside: video.height - (bottom - top) },
    note: "量测事实：同一时间点的灰阶逐像素平均绝对差；带内远大于带外即证明改动集中在字幕带",
  }
}

export { FFMPEG }

export interface CropChangeEvidence {
  at: number
  before: { path: string; sha256: string; height: number }
  after: { path: string; sha256: string; height: number }
  removed_rows: number
  band_height: number
  /** 保留区（输出前 `output_height` 列）每像素灰阶平均绝对差：只该有重新编码杂讯。 */
  kept_region_mean_abs_diff: number
  compared_rows: number
  /** 字幕带是否落在被裁掉的列范围内。 */
  band_removed: boolean
  note: string
}

/**
 * `crop` 法的证据：解析度变小，逐像素差只在「保留区」有意义。
 * 把来源抽格裁到输出的同尺寸再比对 ⇒ kept_region_mean_abs_diff 只该有重新编码杂讯
 * （证明裁切没有动到保留内容），并明示 band 是否落在被裁掉的列范围。
 */
export async function measureCropChange(
  source: string,
  output: string,
  band: { y: number; height: number },
  dir: string,
  at: number,
): Promise<CropChangeEvidence> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const video = info as MediaProbe & { width: number; height: number; frameRate: number }
  const outInfo = await probeMedia(output)
  requireVideo(outInfo, output)
  const outVideo = outInfo as MediaProbe & { width: number; height: number; frameRate: number }
  assert(outVideo.width === video.width, `crop 法的宽度不该改变（${video.width} → ${outVideo.width}）`)
  assert(outVideo.height < video.height, `crop 法输出高度必须小于来源（${outVideo.height} vs ${video.height}）`)

  const beforePath = join(dir, `crop-before-${round(at)}s.jpg`)
  const afterPath = join(dir, `crop-after-${round(at)}s.jpg`)
  await cutFrame(source, at, beforePath)
  await cutFrame(output, at, afterPath)

  const beforeGray = await grayFrameAt(source, at, video.width, video.height)
  const afterGray = await grayFrameAt(output, at, video.width, outVideo.height)

  let total = 0
  for (let row = 0; row < outVideo.height; row += 1) {
    const offset = row * video.width
    for (let column = 0; column < video.width; column += 1) {
      total += Math.abs(afterGray[offset + column]! - beforeGray[offset + column]!)
    }
  }
  const kept = total / (outVideo.height * video.width)
  const removedRows = video.height - outVideo.height
  return {
    at: round(at),
    before: { path: beforePath, sha256: sha256(await readFile(beforePath)), height: video.height },
    after: { path: afterPath, sha256: sha256(await readFile(afterPath)), height: outVideo.height },
    removed_rows: removedRows,
    band_height: band.height,
    kept_region_mean_abs_diff: round(kept),
    compared_rows: outVideo.height,
    band_removed: removedRows >= video.height - band.y,
    note:
      "量测事实：crop 法输出高度小于来源；保留区逐像素差只该有重新编码杂讯（证明裁切未动保留内容）；"
      + "band_removed 表示字幕带列是否落在被裁掉的范围内。",
  }
}

