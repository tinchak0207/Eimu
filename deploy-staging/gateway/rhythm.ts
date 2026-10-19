/**
 * rhythm.ts — 节奏计算器（施工片 B3，2026-08-31，REQ-EDIT-02 规则版）。
 *
 * 需求源：《Eimu 剪辑体验 PRD v1.0》REQ-EDIT-02。全部规则可复现、定位到区间、
 * 建议指向具体 clip_id；不做任何「主观好不好看」评分。
 * 情绪曲线 = emotionTag 软输入：无任何标签时 climax=null 并诚实降级（不谎报）。
 *
 * 契约输入：./timeline getTimeline（B1 生命周期层）；有效时长 = clipLength
 * （(outSec-inSec)/speed，下限 0.1s），与 B1 逐字一致。
 * 节拍检测：./waveform + ./beatDetect（kunpeng-vendor @872a58b 逐行移植轮子）。
 *
 * 对白密度口径对照 vendor transcriptOps.ts：密度 = 窗口内字幕字数 / 窗口秒长
 * （长字幕按窗口覆盖比例拆分，可复现）。
 */
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, clipLength, totalDurationSec, type Timeline, type TimelineClip } from "./timeline"
import { getWaveform } from "./waveform"
import { detectBeats } from "./beatDetect"

// 与 timeline.ts L28 / index.ts L446 同值；env 可覆盖（测试用）。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/eimu-harness/workspace"

// ── 规则常数（PRD REQ-EDIT-02，全部可复现） ──────────────────────────────────
const WINDOW_SEC = 2                 // curve 滑动窗口长度与步进
const DENSITY_OVERLOAD = 6           // 字/秒，超过 → dialog_overload
const SHOT_TOO_LONG = 8              // 秒，单 clip 有效时长上限
const SHOT_TRIM_TARGET = 6           // 建议 trim 目标
const DEAD_AIR_MIN_GAP = 2           // 秒，连续无字幕且无音频 clip 的空档下限
const DEAD_AIR_TOTAL_RATIO = 0.15    // 空档总占比门槛
const PACE_FLAT_CV = 0.15            // avg_shot_len std/mean 低于此 → pace_flat
const CLIMAX_EXPECTED_FRAC = 0.75    // 高潮期望位置 = 总时长 × 0.75
const CLIMAX_TOLERANCE_FRAC = 0.1    // |offset| > 总时长 10% → flag
const CLIMAX_TAG_RE = /高潮|爆|climax|high/i

// ── 报告型别 ─────────────────────────────────────────────────────────────────

export interface RhythmCurvePoint {
  /** 窗口起点（秒） */
  t_sec: number
  /** 窗口内字幕字数密度（字/秒，比例拆分口径） */
  density: number
  /** 窗口内镜头有效时长的重叠加权均值（秒） */
  avg_shot_len: number
  /** 窗口重叠最长 clip 的情绪标签（软输入，无则省略） */
  emotion?: string
}

export type RhythmFlagType =
  | "dialog_overload"
  | "shot_too_long"
  | "dead_air"
  | "pace_flat"
  | "climax_off_expected"

export interface RhythmFlag {
  start_ms: number
  end_ms: number
  type: RhythmFlagType
  severity: "must" | "should"
  suggestion: string
  /** 规则直接绑定单 clip 时给（shot_too_long / climax_off_expected） */
  clip_id?: string
  /** 窗口/区间类规则给覆盖该区间的 clip ids，建议指向具体镜头 */
  clip_ids?: string[]
}

export interface RhythmClimax {
  position_ms: number
  expected_ms: number
  offset_ms: number
  clip_id: string
}

export interface RhythmReport {
  session_id: string
  total_duration_sec: number
  /** 2s 滑动窗口节奏曲线 */
  curve: RhythmCurvePoint[]
  flags: RhythmFlag[]
  /** 无任何 emotionTag 时 null（诚实降级，见 notes） */
  climax: RhythmClimax | null
  /** 仅在有 bgm 时出现；检测失败为 null，不炸整份报告 */
  beats?: number[] | null
  notes: string[]
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

interface PlacedClip {
  clip: TimelineClip
  /** 时间轴起点（主轨顺序累加，秒） */
  start: number
  end: number
  /** 有效时长 = clipLength */
  len: number
}

function placeClips(tl: Timeline): PlacedClip[] {
  let t = 0
  return tl.clips.map((clip) => {
    const len = clipLength(clip)
    const p: PlacedClip = { clip, start: t, end: t + len, len }
    t += len
    return p
  })
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

const ms = (sec: number): number => Math.round(sec * 1000)

/** 字幕 cue 在窗口内的字数贡献：字数 ×（窗口覆盖时长 / cue 时长），比例拆分可复现 */
function windowDensity(tl: Timeline, t0: number, t1: number): number {
  let chars = 0
  for (const s of tl.subtitles) {
    if (s.disabled) continue
    const dur = s.endSec - s.startSec
    if (dur <= 0) continue
    const ov = Math.min(t1, s.endSec) - Math.max(t0, s.startSec)
    if (ov <= 0) continue
    chars += [...s.text].length * (ov / dur)
  }
  return chars / (t1 - t0)
}

/** 窗口内 avg_shot_len：clip 有效时长按重叠秒加权；无覆盖返回 0 */
function windowAvgShotLen(placed: PlacedClip[], t0: number, t1: number): number {
  let wsum = 0
  let vsum = 0
  for (const p of placed) {
    const ov = Math.min(t1, p.end) - Math.max(t0, p.start)
    if (ov <= 0) continue
    wsum += ov
    vsum += ov * p.len
  }
  return wsum > 0 ? vsum / wsum : 0
}

/** 窗口重叠最长 clip 的 emotionTag（软输入） */
function windowEmotion(placed: PlacedClip[], t0: number, t1: number): string | undefined {
  let best: PlacedClip | undefined
  let bestOv = 0
  for (const p of placed) {
    const ov = Math.min(t1, p.end) - Math.max(t0, p.start)
    if (ov > bestOv && p.clip.emotionTag) {
      bestOv = ov
      best = p
    }
  }
  return best?.clip.emotionTag
}

function clipsInSpan(placed: PlacedClip[], t0: number, t1: number): string[] {
  return placed.filter((p) => Math.min(t1, p.end) - Math.max(t0, p.start) > 0).map((p) => p.clip.id)
}

/** 音频 clip 在时间轴的覆盖区间（口径同 timeline.ts totalDurationSec 尾端公式） */
function audioSpans(tl: Timeline): Array<[number, number]> {
  return tl.audioClips
    .filter((a) => !a.disabled)
    .map((a) => [a.startSec, a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)] as [number, number])
}

/** 连续 ≥minGap 的无字幕无音频空档列表（[0,total] 上对字幕∪音频覆盖求补集） */
function deadAirGaps(tl: Timeline, total: number, minGap: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [
    ...tl.subtitles.filter((s) => !s.disabled).map((s) => [Math.max(0, s.startSec), Math.min(total, s.endSec)] as [number, number]),
    ...audioSpans(tl).map(([a, b]) => [Math.max(0, a), Math.min(total, b)] as [number, number]),
  ].filter(([a, b]) => b > a)
  spans.sort((x, y) => x[0] - y[0])
  const gaps: Array<[number, number]> = []
  let cursor = 0
  for (const [a, b] of spans) {
    if (a - cursor >= minGap) gaps.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (total - cursor >= minGap) gaps.push([cursor, total])
  return gaps
}

/** bgm 参数解析：本地路径直用；http(s) URL 下载到 $WORKSPACE_DIR/tmp。失败抛错由调用方降级 */
async function resolveBgmLocal(bgm: string): Promise<string> {
  if (/^https?:\/\//i.test(bgm)) {
    const res = await fetch(bgm, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`bgm 下载失败 HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 100 * 1024 * 1024) throw new Error("bgm 下载超过 100MB 上限")
    const ext = (path.extname(new URL(bgm).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "")
    const dir = path.join(WORKSPACE_DIR, "tmp")
    await mkdir(dir, { recursive: true })
    const local = path.join(dir, `rhythm-bgm-${Date.now().toString(36)}${ext}`)
    await writeFile(local, new Uint8Array(buf))
    return local
  }
  await access(bgm)
  return bgm
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function analyzeRhythm(sessionId: string, opts: { bgmPath?: string } = {}): Promise<RhythmReport> {
  const tl = await getTimeline(sessionId)
  const placed = placeClips(tl)
  const total = totalDurationSec(tl)
  const notes: string[] = []
  const flags: RhythmFlag[] = []

  // ── curve：2s 滑动窗口 ──
  const curve: RhythmCurvePoint[] = []
  const nWin = total > 0 ? Math.ceil(total / WINDOW_SEC) : 0
  for (let w = 0; w < nWin; w++) {
    const t0 = w * WINDOW_SEC
    const t1 = Math.min(t0 + WINDOW_SEC, total)
    const pt: RhythmCurvePoint = {
      t_sec: round3(t0),
      density: round3(windowDensity(tl, t0, t1)),
      avg_shot_len: round3(windowAvgShotLen(placed, t0, t1)),
    }
    const emo = windowEmotion(placed, t0, t1)
    if (emo) pt.emotion = emo
    curve.push(pt)

    // dialog_overload：窗口密度 > 6 字/秒（逐窗口出 flag，定位到窗口区间）
    if (pt.density > DENSITY_OVERLOAD) {
      flags.push({
        start_ms: ms(t0),
        end_ms: ms(t1),
        type: "dialog_overload",
        severity: "should",
        suggestion: `窗口 ${t0.toFixed(1)}-${t1.toFixed(1)}s 对白密度 ${pt.density} 字/秒（> ${DENSITY_OVERLOAD}），删减台词或拉长镜头（clip: ${clipsInSpan(placed, t0, t1).join(", ") || "无"}）`,
        clip_ids: clipsInSpan(placed, t0, t1),
      })
    }
  }

  // ── shot_too_long：单 clip 有效时长 > 8s ──
  for (const p of placed) {
    if (p.len > SHOT_TOO_LONG) {
      flags.push({
        start_ms: ms(p.start),
        end_ms: ms(p.end),
        type: "shot_too_long",
        severity: "should",
        clip_id: p.clip.id,
        suggestion: `镜头 ${p.clip.id} 有效时长 ${round3(p.len)}s（> ${SHOT_TOO_LONG}s），trim 至 ~${SHOT_TRIM_TARGET}s 或拆分`,
      })
    }
  }

  // ── dead_air：连续 ≥2s 无字幕且无音频 clip，且空档总占比 >15% 才出 flag ──
  if (total > 0) {
    const gaps = deadAirGaps(tl, total, DEAD_AIR_MIN_GAP)
    const gapSum = gaps.reduce((s, [a, b]) => s + (b - a), 0)
    if (gapSum / total > DEAD_AIR_TOTAL_RATIO) {
      for (const [a, b] of gaps) {
        flags.push({
          start_ms: ms(a),
          end_ms: ms(b),
          type: "dead_air",
          severity: "should",
          clip_ids: clipsInSpan(placed, a, b),
          suggestion: `留白超额：${a.toFixed(1)}-${b.toFixed(1)}s 无字幕无音频（空档总占比 ${round3((gapSum / total) * 100)}% > 15%），考虑加速或删除（clip: ${clipsInSpan(placed, a, b).join(", ") || "无"}）`,
        })
      }
    }
  }

  // ── pace_flat：全片 avg_shot_len 变异系数过小 ──
  if (placed.length >= 2 && curve.length >= 2) {
    const vals = curve.map((c) => c.avg_shot_len)
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    if (mean > 0) {
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length)
      if (std / mean < PACE_FLAT_CV) {
        flags.push({
          start_ms: 0,
          end_ms: ms(total),
          type: "pace_flat",
          severity: "should",
          suggestion: `节奏平铺（avg_shot_len ${round3(mean)}s，std/mean=${round3(std / mean)} < ${PACE_FLAT_CV}），考虑长短交错`,
        })
      }
    }
  }

  // ── climax：emotionTag 序列最后一个高潮标签 clip 中点（软输入，缺失诚实降级） ──
  let climax: RhythmClimax | null = null
  const tagged = placed.filter((p) => p.clip.emotionTag)
  const climaxHits = placed.filter((p) => p.clip.emotionTag && CLIMAX_TAG_RE.test(p.clip.emotionTag!))
  if (climaxHits.length > 0) {
    const last = climaxHits[climaxHits.length - 1]
    const position = (last.start + last.end) / 2
    const expected = total * CLIMAX_EXPECTED_FRAC
    const offset = position - expected
    climax = { position_ms: ms(position), expected_ms: ms(expected), offset_ms: ms(offset), clip_id: last.clip.id }
    if (Math.abs(offset) > total * CLIMAX_TOLERANCE_FRAC) {
      flags.push({
        start_ms: ms(last.start),
        end_ms: ms(last.end),
        type: "climax_off_expected",
        severity: "should",
        clip_id: last.clip.id,
        suggestion: `高潮镜头 ${last.clip.id} 位于 ${round3(position)}s，偏离期望位置 ${round3(expected)}s（总时长 ${(CLIMAX_EXPECTED_FRAC * 100).toFixed(0)}%）达 ${round3(offset)}s，考虑前移/后移或调整前后镜头长短`,
      })
    }
  } else if (tagged.length === 0) {
    notes.push("降级：无任何 clip 标注 emotionTag，情绪曲线软输入缺失，climax=null（不谎报）")
  } else {
    notes.push(`降级：emotionTag 序列中无高潮标签（${CLIMAX_TAG_RE.source}），climax=null`)
  }

  // ── beats：bgm（参数优先，退回 timeline.bgm.path）存在时才跑；失败降级不炸报告 ──
  let beats: number[] | null | undefined = undefined
  const bgmCandidate = (opts.bgmPath || "").trim() || (tl.bgm?.path || "").trim()
  if (bgmCandidate) {
    try {
      const local = await resolveBgmLocal(bgmCandidate)
      const peaks = await getWaveform(local)
      if (!peaks || peaks.length === 0) throw new Error("bgm 无可解码音轨")
      beats = await detectBeats(local)
    } catch (e) {
      beats = null
      notes.push(`降级：节拍检测失败（不影响其他规则）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    session_id: sessionId,
    total_duration_sec: round3(total),
    curve,
    flags,
    climax,
    ...(beats !== undefined ? { beats } : {}),
    notes,
  }
}
