// 去字幕（Dramagic `clear_video_subtitle`，D27）——本機、零付費、零上游。
//
// 形態來源（不另造程序層）：程序層／探測／抽格／檔案慣例逐條複用我方既有輪子
//   lib/video-evidence.ts 的 runProcess / probeMedia / requireVideo / cutFrame
//   ＋ ffmpeg 絕對路徑慣例（同 lib/asr.ts:61-62）。
// 本檔新增的只有「字幕帶」這一格的量測與移除：
//   ① detectSubtitleBand：對畫面下緣 region 抽樣，逐列算**水平梯度能量**，
//      以跨幀 p80 取樣判定「持續存在文字筆畫」的連續列區段 ⇒ 有/無字幕帶；
//   ② removeSubtitleBand：delogo（保留解析度的空間內插）或 crop（下裁）；
//   ③ measureBandChange / re-detect：前後同秒抽格的帶內外像素差 + 移除後重偵測。
//
// 鐵律：本檔所有數字都是**量測事實**（像素能量、秒、雜湊），不是主觀判斷；
// 偵測不到字幕帶一律回報 found:false（呼叫端轉成具名錯誤碼），不得靜默回成功。

import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { cutFrame, probeMedia, requireVideo, runProcess, type MediaProbe } from "./video-evidence"

// ─────────────────────────────────────────── 執行檔（慣例同 lib/asr.ts / lib/video-evidence.ts）

const BIN_DIR = "/opt/agent-harness/bin"
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

// ─────────────────────────────────────────── 偵測

/** 偵測參數（預設值＝本輪對 1280x720／24fps 素材實測可用的值）。 */
export interface DetectOptions {
  /** 只看畫面下緣這個比例（0.05..0.6）；字幕慣例在下緣。 */
  region?: number
  /** 抽樣率（樣本/秒）。 */
  sample_rate?: number
  /** 抽樣上限（幀）。 */
  max_samples?: number
  /** 相對門檻：列的 p80 梯度能量須 ≥ max(sensitivity × 參考中位數, floor)。 */
  sensitivity?: number
  /** 絕對門檻（灰階梯度單位 0..255 的平均值）。 */
  floor?: number
  /** 最小字幕帶高度（像素）。 */
  min_band_height?: number
  /** 只量測前 N 秒（預設整支）。 */
  max_seconds?: number
}

export interface SubtitleBand {
  /** 帶的左上角 y（整幅畫面座標，像素）。 */
  y: number
  /** 帶高（像素）。 */
  height: number
  width: number
  /** 帶內列的 p80 梯度能量平均。 */
  band_energy: number
  /** 同 region 的參考中位數梯度能量（穩健底噪）。 */
  reference_energy: number
  /** band_energy / reference_energy。 */
  ratio: number
  /** 抽樣幾幀、樣本率、region 像素範圍。 */
  samples: number
  sample_rate: number
  region_top: number
  region_height: number
}

export interface DetectResult {
  found: boolean
  band?: SubtitleBand
  /** 量測事實（無論 found 與否都回，供人核對與調參）。 */
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
    /** 每個 region 列的 p80 能量（由 region_top 起算），供人工檢視。 */
    row_profile: number[]
    best_run_height: number
    best_run_ratio: number
  }
  reason?: string
}

/**
 * 機械式字幕帶偵測。回傳的是**量測事實**：每個下緣列在抽樣幀上的 p80 水平梯度能量，
 * 以及符合門檻的最長連續列區段。不是「看起來像字幕」的主觀描述。
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
  assert(frames.length >= 2, `${source}: 抽樣幀不足（拿到 ${frames.length} 幀），無法做跨幀判定`)

  // 逐列、逐幀的水平梯度能量 → 每列取 p80（文字存在時的典型能量，容忍字幕間歇出現）。
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

  // 最長連續候選列區段（且不得吃掉整個 region：那不是「帶」而是整片高頻質感）。
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
      reason: `下緣 ${Math.round(region * 100)}% 抽 ${frames.length} 幀未找到 ≥${minHeight}px 的持續文字列區段`
        + `（最長 ${bestLength}px，p80 中位數能量 ${round(reference)}，門檻 ${round(threshold)}）`,
    }
  }
  if (coverage > 0.8) {
    return {
      found: false, measured,
      reason: `候選區段覆蓋 region ${(coverage * 100).toFixed(1)}%（>80%）⇒ 判為整片高頻質感而非字幕帶`,
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
  /** delogo 的外擴像素（預設 6）；字幕筆畫常貼著偵測邊界。 */
  pad?: number
  keep_audio?: boolean
}

export interface RemoveResult {
  method: RemoveMethod
  filter: string
  /** delogo 實際使用的矩形（clamp 到畫面內且留 1px 邊界）。 */
  rect: { x: number; y: number; width: number; height: number }
  output_duration: number
  output_width: number
  output_height: number
}

/**
 * 移除偵測到的字幕帶。`delogo` 對該矩形做空間內插（解析度不變、矩形外逐位元不動）；
 * `crop` 直接下裁（解析度變小，但完全不動其他像素的內容分佈）。
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
    `字幕帶 [${band.y}, ${band.y + band.height}) 超出畫面高 ${video.height}`)

  if (method === "crop") {
    // 帶貼下緣 ⇒ 裁掉下緣；否則裁掉帶以上的部分（保留帶以下）。
    const keepTop = band.y >= video.height - (band.y + band.height)
    const cropHeight = even(keepTop ? band.y : video.height - band.y - band.height)
    assert(cropHeight >= 16, `crop 後高度 ${cropHeight}px 過小，拒絕執行`)
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

  // delogo：外擴 pad 後 clamp，並確保四周各留 1px（delogo 要求矩形在畫面內）。
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

// ─────────────────────────────────────────── 前後量測（證據）

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
  /** 帶內（y..y+h）每像素灰階平均絕對差。 */
  inside_band_mean_abs_diff: number
  /** 帶外每像素灰階平均絕對差。 */
  outside_band_mean_abs_diff: number
  /** 與帶外相比的倍數（delogo 應該遠大於 1；愈大＝改動愈集中在帶內）。 */
  localization_ratio: number
  compared_rows: { inside: number; outside: number }
  note: string
}

/**
 * 同秒抽格前後對照：回傳兩張 JPEG 的本機路徑與 SHA-256，以及帶內／帶外像素差。
 * 這是量測事實：`inside_band_mean_abs_diff >> outside_band_mean_abs_diff` 才證明
 * 「改動集中在字幕帶」，不是「我看起來乾淨了」。
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
    `前後解析度不同（${video.width}x${video.height} → ${outVideo.width}x${outVideo.height}）：逐像素差只在同解析度下有意義`)

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
    note: "量測事實：同一時間點的灰階逐像素平均絕對差；帶內遠大於帶外即證明改動集中在字幕帶",
  }
}

export { FFMPEG }

export interface CropChangeEvidence {
  at: number
  before: { path: string; sha256: string; height: number }
  after: { path: string; sha256: string; height: number }
  removed_rows: number
  band_height: number
  /** 保留區（輸出前 `output_height` 列）每像素灰階平均絕對差：只該有重新編碼雜訊。 */
  kept_region_mean_abs_diff: number
  compared_rows: number
  /** 字幕帶是否落在被裁掉的列範圍內。 */
  band_removed: boolean
  note: string
}

/**
 * `crop` 法的證據：解析度變小，逐像素差只在「保留區」有意義。
 * 把來源抽格裁到輸出的同尺寸再比對 ⇒ kept_region_mean_abs_diff 只該有重新編碼雜訊
 * （證明裁切沒有動到保留內容），並明示 band 是否落在被裁掉的列範圍。
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
  assert(outVideo.width === video.width, `crop 法的寬度不該改變（${video.width} → ${outVideo.width}）`)
  assert(outVideo.height < video.height, `crop 法輸出高度必須小於來源（${outVideo.height} vs ${video.height}）`)

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
      "量測事實：crop 法輸出高度小於來源；保留區逐像素差只該有重新編碼雜訊（證明裁切未動保留內容）；"
      + "band_removed 表示字幕帶列是否落在被裁掉的範圍內。",
  }
}

