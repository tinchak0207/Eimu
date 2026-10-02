// 2026-10-02 e2e 成片評測整改：final_cut 導出前後質檢（響度正規化 + 結尾凍結/黑幀修剪）。
// 評測實錘：成片整合響度 -38.5 LUFS 未正規化、結尾 ~1.3s 凍結，CAPABILITIES 卻宣稱「質檢把關」。
// 本模組：分析 → 能修則修（loudnorm 兩遍 + 尾部修剪）→ 複測驗證 → 修不了/修壞了誠實回報（回原片 + 註記）。
// 零 gateway import（可在 tsx 直跑）；只依賴 ffmpeg/ffprobe 可執行檔路徑。
import { execFile } from "node:child_process"

export const QC_TARGET_LUFS = -16
export const QC_TARGET_TP = -1.5
const LOUD_TOLERANCE_LU = 1.5

export type FilmQcReport = {
  durationSec: number
  hasAudio: boolean
  lufs: number | null
  truePeakDb: number | null
  /** 尾部凍結/黑幀起點（秒）；無則 null。 */
  tailFreezeStart: number | null
  tailBlackStart: number | null
  /** 非尾部的凍結/黑幀段（只報告不修）。 */
  midIssues: string[]
}

function run(bin: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** 純解析：ebur128 summary → { lufs, tp }。 */
export function parseEbur128(stderr: string): { lufs: number | null; truePeakDb: number | null } {
  const sum = stderr.slice(Math.max(0, stderr.lastIndexOf("Summary:")))
  const i = sum.match(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  const p = sum.match(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/)
  return { lufs: i ? Number(i[1]) : null, truePeakDb: p ? Number(p[1]) : null }
}

/** 純解析：freezedetect/blackdetect 日誌 → 段落 [{start,end|null}]。 */
export function parseSegments(stderr: string, kind: "freeze" | "black"): { start: number; end: number | null }[] {
  const segs: { start: number; end: number | null }[] = []
  if (kind === "freeze") {
    for (const m of stderr.matchAll(/freeze_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
      const v = Number(m[2])
      if (m[1] === "start") segs.push({ start: v, end: null })
      else if (segs.length) segs[segs.length - 1]!.end = v
    }
  } else {
    for (const m of stderr.matchAll(/black_start:(-?\d+(?:\.\d+)?)\s+black_end:(-?\d+(?:\.\d+)?)/g)) {
      segs.push({ start: Number(m[1]), end: Number(m[2]) })
    }
  }
  return segs
}

/** 純決策：段落是否貼尾（延伸到片尾 ±0.15s）且長度可修剪。 */
export function tailSegmentStart(segs: { start: number; end: number | null }[], dur: number): number | null {
  for (const s of segs) {
    const reachesEnd = s.end === null || s.end >= dur - 0.15
    if (reachesEnd && dur - s.start >= 0.5) return s.start
  }
  return null
}

export async function analyzeFilm(ffmpeg: string, file: string, opts: { limitSec?: number } = {}): Promise<FilmQcReport> {
  const ffprobe = ffmpeg.replace(/ffmpeg$/, "ffprobe")
  const pr = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], 30_000)
  let durationSec = 0
  let hasAudio = false
  try {
    const j = JSON.parse(pr.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }
    durationSec = Number(j.format?.duration ?? 0) || 0
    hasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio")
  } catch { /* 留 0 */ }
  const lim = opts.limitSec ? ["-t", String(opts.limitSec)] : []
  let lufs: number | null = null
  let truePeakDb: number | null = null
  if (hasAudio) {
    const a = await run(ffmpeg, ["-hide_banner", "-nostats", ...lim, "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"])
    ;({ lufs, truePeakDb } = parseEbur128(a.stderr))
  }
  const v = await run(ffmpeg, ["-hide_banner", "-nostats", ...lim, "-i", file, "-an", "-vf", "freezedetect=n=-50dB:d=0.5,blackdetect=d=0.3:pix_th=0.1", "-f", "null", "-"])
  const effDur = opts.limitSec ? Math.min(durationSec, opts.limitSec) : durationSec
  const freeze = parseSegments(v.stderr, "freeze")
  const black = parseSegments(v.stderr, "black")
  const tailFreezeStart = tailSegmentStart(freeze, effDur)
  const tailBlackStart = tailSegmentStart(black, effDur)
  const midIssues: string[] = []
  for (const s of freeze) if (s.start !== tailFreezeStart && (s.end ?? effDur) - s.start >= 1.5) midIssues.push(`中段凍結 ${s.start.toFixed(1)}s–${(s.end ?? effDur).toFixed(1)}s`)
  for (const s of black) if (s.start !== tailBlackStart) midIssues.push(`中段黑幀 ${s.start.toFixed(1)}s–${(s.end ?? effDur).toFixed(1)}s`)
  return { durationSec: effDur, hasAudio, lufs, truePeakDb, tailFreezeStart, tailBlackStart, midIssues }
}

export type FilmQcResult = {
  /** 最終應交付的檔案（修好＝outPath；沒動或修壞回退＝inPath）。 */
  path: string
  changed: boolean
  before: FilmQcReport
  after: FilmQcReport | null
  /** 給用戶看的誠實註記（空陣列＝全合格無需說明）。 */
  notes: string[]
}

const fmt = (n: number | null) => (n === null ? "n/a" : n.toFixed(1))

/**
 * 質檢 + 修復。永不拋錯：任何一步失敗都回原片並註記。
 * 修剪上限：尾部問題 ≤ min(3s, 15% 片長) 才剪（再長視為內容而非尾巴，只告知）。
 */
export async function qcAndFixFilm(ffmpeg: string, inPath: string, outPath: string): Promise<FilmQcResult> {
  let before: FilmQcReport
  try {
    before = await analyzeFilm(ffmpeg, inPath)
  } catch (e) {
    return { path: inPath, changed: false, before: { durationSec: 0, hasAudio: false, lufs: null, truePeakDb: null, tailFreezeStart: null, tailBlackStart: null, midIssues: [] }, after: null, notes: [`質檢未能執行（${String((e as Error).message ?? e).slice(0, 80)}），成片未經響度/凍結檢查`] }
  }
  const notes: string[] = []
  const dur = before.durationSec
  const tailStarts = [before.tailFreezeStart, before.tailBlackStart].filter((x): x is number => x !== null)
  const tailStart = tailStarts.length ? Math.min(...tailStarts) : null
  const maxTrim = Math.min(3, dur * 0.15)
  const trimTo = tailStart !== null && dur - tailStart <= maxTrim ? Math.max(tailStart + 0.1, 1) : null
  if (tailStart !== null && trimTo === null) notes.push(`結尾 ${(dur - tailStart).toFixed(1)}s 凍結/黑幀過長，未自動修剪，請人工確認`)
  const needLoud = before.hasAudio && before.lufs !== null && before.lufs > -70 && Math.abs(before.lufs - QC_TARGET_LUFS) > LOUD_TOLERANCE_LU
  if (before.hasAudio && (before.lufs === null || before.lufs <= -70)) notes.push("成片音軌近乎靜音，無法正規化")
  if (!before.hasAudio) notes.push("成片無音軌")
  for (const m of before.midIssues) notes.push(`${m}（未自動處理）`)

  if (!needLoud && trimTo === null) return { path: inPath, changed: false, before, after: null, notes }

  const tArgs = trimTo !== null ? ["-t", trimTo.toFixed(3)] : []
  const args = ["-y", "-hide_banner", "-nostats", ...tArgs, "-i", inPath]
  try {
    if (needLoud) {
      const m = await run(ffmpeg, ["-hide_banner", "-nostats", ...tArgs, "-i", inPath, "-vn", "-af", `loudnorm=I=${QC_TARGET_LUFS}:TP=${QC_TARGET_TP}:LRA=11:print_format=json`, "-f", "null", "-"])
      const jm = m.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/)
      const j = jm ? (JSON.parse(jm[0]) as Record<string, string>) : null
      const ok = j && ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].every((k) => Number.isFinite(Number(j[k])))
      const af = ok
        ? `loudnorm=I=${QC_TARGET_LUFS}:TP=${QC_TARGET_TP}:LRA=11:measured_I=${j!.input_i}:measured_TP=${j!.input_tp}:measured_LRA=${j!.input_lra}:measured_thresh=${j!.input_thresh}:offset=${j!.target_offset}:linear=true`
        : `loudnorm=I=${QC_TARGET_LUFS}:TP=${QC_TARGET_TP}:LRA=11`
      args.push("-af", af)
    }
    // 修剪必須重編碼視頻（流複製只能切在關鍵幀）；僅響度則視頻流複製、零畫質損失。
    if (trimTo !== null) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p")
    else args.push("-c:v", "copy")
    if (before.hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000")
    args.push("-movflags", "+faststart", outPath)
    const r = await run(ffmpeg, args)
    if (r.code !== 0) throw new Error(`ffmpeg exit ${r.code}: ${r.stderr.slice(-160)}`)
    const after = await analyzeFilm(ffmpeg, outPath)
    // 複測驗證：不採信「命令成功」。時長不得縮水超過預期，響度須落進容差（放寬到 ±2.5 LU：loudnorm 對極低電平素材可能達不到）。
    const expectDur = trimTo ?? dur
    if (Math.abs(after.durationSec - expectDur) > 0.6 && after.durationSec < expectDur) throw new Error(`修復後時長異常 ${after.durationSec}s`)
    if (needLoud && (after.lufs === null || Math.abs(after.lufs - QC_TARGET_LUFS) > 2.5)) {
      notes.push(`響度正規化後仍為 ${fmt(after.lufs)} LUFS（目標 ${QC_TARGET_LUFS}），已交付修復版但未完全達標`)
    }
    if (needLoud) notes.unshift(`響度已正規化 ${fmt(before.lufs)} → ${fmt(after.lufs)} LUFS`)
    if (trimTo !== null) notes.unshift(`已修剪結尾 ${(dur - trimTo).toFixed(1)}s 凍結/黑幀（${dur.toFixed(2)}s → ${after.durationSec.toFixed(2)}s）`)
    return { path: outPath, changed: true, before, after, notes }
  } catch (e) {
    notes.unshift(`成片自動修復失敗，已交付未修復原片（響度 ${fmt(before.lufs)} LUFS${tailStart !== null ? `、結尾 ${(dur - tailStart).toFixed(1)}s 凍結` : ""}）：${String((e as Error).message ?? e).slice(0, 100)}`)
    return { path: inPath, changed: false, before, after: null, notes }
  }
}
