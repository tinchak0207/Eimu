// 2026-10-02 e2e 成片评测整改：final_cut 导出前后质检（响度正规化 + 结尾冻结/黑帧修剪）。
// 评测实锤：成片整合响度 -38.5 LUFS 未正规化、结尾 ~1.3s 冻结，CAPABILITIES 却宣称「质检把关」。
// 本模组：分析 → 能修则修（loudnorm 两遍 + 尾部修剪）→ 复测验证 → 修不了/修坏了诚实回报（回原片 + 注记）。
// 零 gateway import（可在 tsx 直跑）；只依赖 ffmpeg/ffprobe 可执行档路径。
import { execFile } from "node:child_process"

export const QC_TARGET_LUFS = -16
export const QC_TARGET_TP = -1.5
const LOUD_TOLERANCE_LU = 1.5

export type FilmQcReport = {
  durationSec: number
  hasAudio: boolean
  lufs: number | null
  truePeakDb: number | null
  /** 尾部冻结/黑帧起点（秒）；无则 null。 */
  tailFreezeStart: number | null
  tailBlackStart: number | null
  /** 非尾部的冻结/黑帧段（只报告不修）。 */
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

/** 纯解析：ebur128 summary → { lufs, tp }。 */
export function parseEbur128(stderr: string): { lufs: number | null; truePeakDb: number | null } {
  const sum = stderr.slice(Math.max(0, stderr.lastIndexOf("Summary:")))
  const i = sum.match(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  const p = sum.match(/Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/)
  return { lufs: i ? Number(i[1]) : null, truePeakDb: p ? Number(p[1]) : null }
}

/** 纯解析：freezedetect/blackdetect 日志 → 段落 [{start,end|null}]。 */
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

/** 纯决策：段落是否贴尾（延伸到片尾 ±0.15s）且长度可修剪。 */
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
  for (const s of freeze) if (s.start !== tailFreezeStart && (s.end ?? effDur) - s.start >= 1.5) midIssues.push(`中段冻结 ${s.start.toFixed(1)}s–${(s.end ?? effDur).toFixed(1)}s`)
  for (const s of black) if (s.start !== tailBlackStart) midIssues.push(`中段黑帧 ${s.start.toFixed(1)}s–${(s.end ?? effDur).toFixed(1)}s`)
  return { durationSec: effDur, hasAudio, lufs, truePeakDb, tailFreezeStart, tailBlackStart, midIssues }
}

export type FilmQcResult = {
  /** 最终应交付的档案（修好＝outPath；没动或修坏回退＝inPath）。 */
  path: string
  changed: boolean
  before: FilmQcReport
  after: FilmQcReport | null
  /** 给用户看的诚实注记（空阵列＝全合格无需说明）。 */
  notes: string[]
}

const fmt = (n: number | null) => (n === null ? "n/a" : n.toFixed(1))

/**
 * 质检 + 修复。永不抛错：任何一步失败都回原片并注记。
 * 修剪上限：尾部问题 ≤ min(3s, 15% 片长) 才剪（再长视为内容而非尾巴，只告知）。
 */
export async function qcAndFixFilm(ffmpeg: string, inPath: string, outPath: string): Promise<FilmQcResult> {
  let before: FilmQcReport
  try {
    before = await analyzeFilm(ffmpeg, inPath)
  } catch (e) {
    return { path: inPath, changed: false, before: { durationSec: 0, hasAudio: false, lufs: null, truePeakDb: null, tailFreezeStart: null, tailBlackStart: null, midIssues: [] }, after: null, notes: [`质检未能执行（${String((e as Error).message ?? e).slice(0, 80)}），成片未经响度/冻结检查`] }
  }
  const notes: string[] = []
  const dur = before.durationSec
  const tailStarts = [before.tailFreezeStart, before.tailBlackStart].filter((x): x is number => x !== null)
  const tailStart = tailStarts.length ? Math.min(...tailStarts) : null
  const maxTrim = Math.min(3, dur * 0.15)
  const trimTo = tailStart !== null && dur - tailStart <= maxTrim ? Math.max(tailStart + 0.1, 1) : null
  if (tailStart !== null && trimTo === null) notes.push(`结尾 ${(dur - tailStart).toFixed(1)}s 冻结/黑帧过长，未自动修剪，请人工确认`)
  const needLoud = before.hasAudio && before.lufs !== null && before.lufs > -70 && Math.abs(before.lufs - QC_TARGET_LUFS) > LOUD_TOLERANCE_LU
  if (before.hasAudio && (before.lufs === null || before.lufs <= -70)) notes.push("成片音轨近乎静音，无法正规化")
  if (!before.hasAudio) notes.push("成片无音轨")
  for (const m of before.midIssues) notes.push(`${m}（未自动处理）`)

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
    // 修剪必须重编码视频（流复制只能切在关键帧）；仅响度则视频流复制、零画质损失。
    if (trimTo !== null) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p")
    else args.push("-c:v", "copy")
    if (before.hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000")
    args.push("-movflags", "+faststart", outPath)
    const r = await run(ffmpeg, args)
    if (r.code !== 0) throw new Error(`ffmpeg exit ${r.code}: ${r.stderr.slice(-160)}`)
    const after = await analyzeFilm(ffmpeg, outPath)
    // 复测验证：不采信「命令成功」。时长不得缩水超过预期，响度须落进容差（放宽到 ±2.5 LU：loudnorm 对极低电平素材可能达不到）。
    const expectDur = trimTo ?? dur
    if (Math.abs(after.durationSec - expectDur) > 0.6 && after.durationSec < expectDur) throw new Error(`修复后时长异常 ${after.durationSec}s`)
    if (needLoud && (after.lufs === null || Math.abs(after.lufs - QC_TARGET_LUFS) > 2.5)) {
      notes.push(`响度正规化后仍为 ${fmt(after.lufs)} LUFS（目标 ${QC_TARGET_LUFS}），已交付修复版但未完全达标`)
    }
    if (needLoud) notes.unshift(`响度已正规化 ${fmt(before.lufs)} → ${fmt(after.lufs)} LUFS`)
    if (trimTo !== null) notes.unshift(`已修剪结尾 ${(dur - trimTo).toFixed(1)}s 冻结/黑帧（${dur.toFixed(2)}s → ${after.durationSec.toFixed(2)}s）`)
    return { path: outPath, changed: true, before, after, notes }
  } catch (e) {
    notes.unshift(`成片自动修复失败，已交付未修复原片（响度 ${fmt(before.lufs)} LUFS${tailStart !== null ? `、结尾 ${(dur - tailStart).toFixed(1)}s 冻结` : ""}）：${String((e as Error).message ?? e).slice(0, 100)}`)
    return { path: inPath, changed: false, before, after: null, notes }
  }
}
