import { FFMPEG, round, runProcess } from "./video-evidence-process"
import { type MediaProbe, probeMedia, requireVideo } from "./video-evidence-probe"

// ---------------------------------------------------------------------------
// 相邻帧变化候选（boundaries）

/**
 * 机械式的相邻帧视觉变化候选。分数是机械证据，不是剪辑判读的镜头标签。
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
// 动态体检（motion）：帧间差分能量——「像不像 PPT」的量化 oracle

/**
 * 2026-10-20 实测基线（同一条 ffmpeg 配方）：
 * - 30s 动作戏参考片 median 12.37、static_ratio 9.9% → dynamic
 * - Eimu 现有成片 median 2.67、static_ratio 30.0% → static（观感即 PPT）
 * median 抗剪辑（单一剪辑点只会抬高 p95，不会把整片 median 拉过门槛）。
 */
export interface MotionThresholds {
  readonly median_dynamic: number
  readonly median_weak: number
  readonly static_ratio_max: number
}

export const MOTION_THRESHOLDS: MotionThresholds = Object.freeze({
  median_dynamic: 6,
  median_weak: 3,
  static_ratio_max: 0.2,
})

/** YAVG（0..255 的亮度平均绝对差）低于此值的帧视为静止/几乎静止。 */
const MOTION_STATIC_CUTOFF = 1.5
const MOTION_FILTER = "scale=320:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-"

export interface MotionStats {
  /** tblend 吃掉第一帧：这是总帧数 - 1（差分对数），如实标注。 */
  frame_count: number
  mean_diff: number
  median_diff: number
  p95_diff: number
  /** YAVG < 1.5 的帧占比（0..1）。 */
  static_ratio: number
  verdict: "dynamic" | "weak" | "static"
  thresholds: MotionThresholds
}

/** 线性插值百分位（与 numpy 预设一致）；输入须已升序。 */
function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const rank = (sorted.length - 1) * ratio
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]!
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low)
}

export function motionVerdict(
  medianDiff: number,
  staticRatio: number,
  thresholds: MotionThresholds = MOTION_THRESHOLDS,
): MotionStats["verdict"] {
  if (medianDiff >= thresholds.median_dynamic && staticRatio <= thresholds.static_ratio_max) return "dynamic"
  if (medianDiff >= thresholds.median_weak) return "weak"
  return "static"
}

/** 纯解析：metadata=print 的 stdout → 依出现顺序的 YAVG 序列。 */
export function parseMotionYavg(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(/^lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)$/gmu)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/**
 * 逐帧差分能量体检。单帧/单张美图/剪辑点不能替代：没有成对帧就明确失败。
 * 只读本机档案；URL 由 tool 层先落地（materialize），这里不另开下载路径。
 */
export async function measureMotion(source: string): Promise<MotionStats> {
  const info = await probeMedia(source)
  requireVideo(info, source)
  const bytes = await runProcess(FFMPEG, [
    "-v", "error", "-nostdin", "-i", source, "-vf", MOTION_FILTER, "-f", "null", "-",
  ])
  const diffs = parseMotionYavg(bytes.toString("utf8"))
  if (diffs.length === 0) throw new Error(`${source}: no video frames to difference (motion needs at least two frames)`)
  const sorted = [...diffs].sort((left, right) => left - right)
  const mean = diffs.reduce((total, value) => total + value, 0) / diffs.length
  const median = percentile(sorted, 0.5)
  const staticRatio = diffs.filter((value) => value < MOTION_STATIC_CUTOFF).length / diffs.length
  return {
    frame_count: diffs.length,
    mean_diff: round(mean),
    median_diff: round(median),
    p95_diff: round(percentile(sorted, 0.95)),
    static_ratio: round(staticRatio),
    verdict: motionVerdict(median, staticRatio),
    thresholds: MOTION_THRESHOLDS,
  }
}
