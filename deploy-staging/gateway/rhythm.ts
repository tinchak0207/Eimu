/**
 * rhythm.ts — 節奏計算器（施工片 B3，2026-08-31，REQ-EDIT-02 規則版）。
 *
 * 需求源：《Eimu 剪輯體驗 PRD v1.0》REQ-EDIT-02。全部規則可復現、定位到區間、
 * 建議指向具體 clip_id；不做任何「主觀好不好看」評分。
 * 情緒曲線 = emotionTag 軟輸入：無任何標籤時 climax=null 並誠實降級（不謊報）。
 *
 * 契約輸入：./timeline getTimeline（B1 生命週期層）；有效時長 = clipLength
 * （(outSec-inSec)/speed，下限 0.1s），與 B1 逐字一致。
 * 節拍檢測：./waveform + ./beatDetect（kunpeng-vendor @872a58b 逐行移植輪子）。
 *
 * 對白密度口徑對照 vendor transcriptOps.ts：密度 = 窗口內字幕字數 / 窗口秒長
 * （長字幕按窗口覆蓋比例拆分，可復現）。
 */
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, clipLength, totalDurationSec, type Timeline, type TimelineClip } from "./timeline"
import { getWaveform } from "./waveform"
import { detectBeats } from "./beatDetect"

// 與 timeline.ts L28 / index.ts L446 同值；env 可覆蓋（測試用）。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"

// ── 規則常數（PRD REQ-EDIT-02，全部可復現） ──────────────────────────────────
const WINDOW_SEC = 2                 // curve 滑動窗口長度與步進
const DENSITY_OVERLOAD = 6           // 字/秒，超過 → dialog_overload
const SHOT_TOO_LONG = 8              // 秒，單 clip 有效時長上限
const SHOT_TRIM_TARGET = 6           // 建議 trim 目標
const DEAD_AIR_MIN_GAP = 2           // 秒，連續無字幕且無音頻 clip 的空檔下限
const DEAD_AIR_TOTAL_RATIO = 0.15    // 空檔總占比門檻
const PACE_FLAT_CV = 0.15            // avg_shot_len std/mean 低於此 → pace_flat
const CLIMAX_EXPECTED_FRAC = 0.75    // 高潮期望位置 = 總時長 × 0.75
const CLIMAX_TOLERANCE_FRAC = 0.1    // |offset| > 總時長 10% → flag
const CLIMAX_TAG_RE = /高潮|爆|climax|high/i

// ── 報告型別 ─────────────────────────────────────────────────────────────────

export interface RhythmCurvePoint {
  /** 窗口起點（秒） */
  t_sec: number
  /** 窗口內字幕字數密度（字/秒，比例拆分口徑） */
  density: number
  /** 窗口內鏡頭有效時長的重疊加權均值（秒） */
  avg_shot_len: number
  /** 窗口重疊最長 clip 的情緒標籤（軟輸入，無則省略） */
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
  /** 規則直接綁定單 clip 時給（shot_too_long / climax_off_expected） */
  clip_id?: string
  /** 窗口/區間類規則給覆蓋該區間的 clip ids，建議指向具體鏡頭 */
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
  /** 2s 滑動窗口節奏曲線 */
  curve: RhythmCurvePoint[]
  flags: RhythmFlag[]
  /** 無任何 emotionTag 時 null（誠實降級，見 notes） */
  climax: RhythmClimax | null
  /** 僅在有 bgm 時出現；檢測失敗為 null，不炸整份報告 */
  beats?: number[] | null
  notes: string[]
}

// ── 內部工具 ─────────────────────────────────────────────────────────────────

interface PlacedClip {
  clip: TimelineClip
  /** 時間軸起點（主軌順序累加，秒） */
  start: number
  end: number
  /** 有效時長 = clipLength */
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

/** 字幕 cue 在窗口內的字數貢獻：字數 ×（窗口覆蓋時長 / cue 時長），比例拆分可復現 */
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

/** 窗口內 avg_shot_len：clip 有效時長按重疊秒加權；無覆蓋返回 0 */
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

/** 窗口重疊最長 clip 的 emotionTag（軟輸入） */
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

/** 音頻 clip 在時間軸的覆蓋區間（口徑同 timeline.ts totalDurationSec 尾端公式） */
function audioSpans(tl: Timeline): Array<[number, number]> {
  return tl.audioClips
    .filter((a) => !a.disabled)
    .map((a) => [a.startSec, a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)] as [number, number])
}

/** 連續 ≥minGap 的無字幕無音頻空檔列表（[0,total] 上對字幕∪音頻覆蓋求補集） */
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

/** bgm 參數解析：本地路徑直用；http(s) URL 下載到 $WORKSPACE_DIR/tmp。失敗拋錯由調用方降級 */
async function resolveBgmLocal(bgm: string): Promise<string> {
  if (/^https?:\/\//i.test(bgm)) {
    const res = await fetch(bgm, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`bgm 下載失敗 HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 100 * 1024 * 1024) throw new Error("bgm 下載超過 100MB 上限")
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

  // ── curve：2s 滑動窗口 ──
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

    // dialog_overload：窗口密度 > 6 字/秒（逐窗口出 flag，定位到窗口區間）
    if (pt.density > DENSITY_OVERLOAD) {
      flags.push({
        start_ms: ms(t0),
        end_ms: ms(t1),
        type: "dialog_overload",
        severity: "should",
        suggestion: `窗口 ${t0.toFixed(1)}-${t1.toFixed(1)}s 對白密度 ${pt.density} 字/秒（> ${DENSITY_OVERLOAD}），刪減台詞或拉長鏡頭（clip: ${clipsInSpan(placed, t0, t1).join(", ") || "無"}）`,
        clip_ids: clipsInSpan(placed, t0, t1),
      })
    }
  }

  // ── shot_too_long：單 clip 有效時長 > 8s ──
  for (const p of placed) {
    if (p.len > SHOT_TOO_LONG) {
      flags.push({
        start_ms: ms(p.start),
        end_ms: ms(p.end),
        type: "shot_too_long",
        severity: "should",
        clip_id: p.clip.id,
        suggestion: `鏡頭 ${p.clip.id} 有效時長 ${round3(p.len)}s（> ${SHOT_TOO_LONG}s），trim 至 ~${SHOT_TRIM_TARGET}s 或拆分`,
      })
    }
  }

  // ── dead_air：連續 ≥2s 無字幕且無音頻 clip，且空檔總占比 >15% 才出 flag ──
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
          suggestion: `留白超額：${a.toFixed(1)}-${b.toFixed(1)}s 無字幕無音頻（空檔總占比 ${round3((gapSum / total) * 100)}% > 15%），考慮加速或刪除（clip: ${clipsInSpan(placed, a, b).join(", ") || "無"}）`,
        })
      }
    }
  }

  // ── pace_flat：全片 avg_shot_len 變異系數過小 ──
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
          suggestion: `節奏平鋪（avg_shot_len ${round3(mean)}s，std/mean=${round3(std / mean)} < ${PACE_FLAT_CV}），考慮長短交錯`,
        })
      }
    }
  }

  // ── climax：emotionTag 序列最後一個高潮標籤 clip 中點（軟輸入，缺失誠實降級） ──
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
        suggestion: `高潮鏡頭 ${last.clip.id} 位於 ${round3(position)}s，偏離期望位置 ${round3(expected)}s（總時長 ${(CLIMAX_EXPECTED_FRAC * 100).toFixed(0)}%）達 ${round3(offset)}s，考慮前移/後移或調整前後鏡頭長短`,
      })
    }
  } else if (tagged.length === 0) {
    notes.push("降級：無任何 clip 標註 emotionTag，情緒曲線軟輸入缺失，climax=null（不謊報）")
  } else {
    notes.push(`降級：emotionTag 序列中無高潮標籤（${CLIMAX_TAG_RE.source}），climax=null`)
  }

  // ── beats：bgm（參數優先，退回 timeline.bgm.path）存在時才跑；失敗降級不炸報告 ──
  let beats: number[] | null | undefined = undefined
  const bgmCandidate = (opts.bgmPath || "").trim() || (tl.bgm?.path || "").trim()
  if (bgmCandidate) {
    try {
      const local = await resolveBgmLocal(bgmCandidate)
      const peaks = await getWaveform(local)
      if (!peaks || peaks.length === 0) throw new Error("bgm 無可解碼音軌")
      beats = await detectBeats(local)
    } catch (e) {
      beats = null
      notes.push(`降級：節拍檢測失敗（不影響其他規則）：${e instanceof Error ? e.message : String(e)}`)
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
