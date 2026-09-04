// B6（2026-08-31）母帶檢查+導出閘 — REQ-EDIT-07 聚合收尾。
// check = 時長/解析度/畫幅 + B4 lint must + B5 mix sync_errors 聚合；blockers 非空拒導。
// 導出 = concat（trim→變速→scale/pad 畫幅→clip.filter 調色）+ mix.wav 音軌 + 字幕 ASS 燒錄（失敗自動降級重試）
//   + 封面幀 + probeRenderedVideo 強校驗（輪子：composeEngine probeRenderedVideo；解析度口徑 EXPORT_RESOLUTIONS）。
// 妥協（誠實 notes）：xfade 轉場 v1 不燒錄（transitionAfter 留給前端 composeEngine 渲染）；mix 響度不達標不是 blocker（POST /timeline/mix loudnorm 可矯正）。
import { mkdir, rm, writeFile, access } from "node:fs/promises"
import path from "node:path"
import { getTimeline, totalDurationSec, clipLength, TimelineValidationError, type Timeline, type TimelineClip } from "./timeline"
import { lintTimeline, type LintIssue } from "./lint"
import { analyzeMix, resolveSource } from "./mix"
import { detectFfmpeg } from "./editor/canvas/videoCompose"
import { probeRenderedVideo } from "./editor/composeEngine"
import { filterToFfmpeg } from "./editor/presets/filterPresets"
import { invoke } from "./editor/adapter/tauri-adapter"
import { subtitlesAss } from "./style"

interface CommandResult { stdout: string; stderr: string; exit_code: number }

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
const TMP_DIR = path.join(WORKSPACE_DIR, "tmp")

const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
const r3 = (n: number) => Math.round(n * 1000) / 1000

async function run(cmd: string, timeoutMs = 600_000): Promise<CommandResult> {
  return invoke<CommandResult>("execute_command", { command: cmd, timeoutMs }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }) as CommandResult)
}

/** 導出預設（解析度口徑對齊 EXPORT_RESOLUTIONS 1080p；影院 2.39:1 = 1920x804 偶數近似 2.388:1） */
export const MASTER_PRESETS = {
  portrait_916: { label: "竖版 9:16", aspect: "9:16", w: 1080, h: 1920 },
  landscape_169: { label: "横版 16:9", aspect: "16:9", w: 1920, h: 1080 },
  cinema_239: { label: "影院 2.39:1", aspect: "21:9", w: 1920, h: 804 },
} as const
export type MasterPresetId = keyof typeof MASTER_PRESETS

export interface MasterBlocker { source: "lint" | "mix" | "timeline"; detail: string }

export interface MasterCheck {
  ok: boolean
  timeline_version: number
  duration_sec: number | null
  aspect: string
  clips: number
  video_resolution: { width: number; height: number } | null
  lint_passed: boolean
  lint_must: LintIssue[]
  lint_should_count: number
  mix_compliant: boolean
  mix_sync_errors: { clip_id: string; type: string; detail: string }[]
  blockers: MasterBlocker[]
  notes: string[]
}

async function probeVideoSize(ffmpeg: string, p: string): Promise<{ width: number; height: number } | null> {
  const ffprobe = ffmpeg.replace(/ffmpeg$/, "ffprobe")
  const r = await run(`${ffprobe} -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${shq(p)}`, 20_000)
  const m = r.stdout.trim().match(/^(\d+),(\d+)$/m)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/** GET /agent/v1/timeline/master：母帶檢查報告（只檢查不導出）。 */
export async function masterCheck(sessionId: string): Promise<MasterCheck> {
  const tl = await getTimeline(sessionId)
  const total = totalDurationSec(tl)
  const notes: string[] = []
  const blockers: MasterBlocker[] = []

  const lint = await lintTimeline(sessionId)
  const lintMust = lint.issues.filter((i) => i.severity === "must")
  for (const i of lintMust) blockers.push({ source: "lint", detail: `must ${i.type} @ ${i.clip_id}（${i.evidence.slice(0, 120)}）→ ${i.fix_hint}` })
  if (lint.issues.some((i) => i.severity === "should")) notes.push(`should 級 ${lint.issues.filter((i) => i.severity === "should").length} 條不擋導出，明細見 /timeline/lint`)

  const mix = await analyzeMix(sessionId)
  for (const e of mix.sync_errors) blockers.push({ source: "mix", detail: `sync_errors: ${e.clip_id} ${e.type} ${e.detail}` })
  if (mix.sync_errors.length) notes.push("mix sync_errors 會同樣攔下導出；先按 clip_id 修時間線")
  if (!mix.compliant && !mix.sync_errors.length && mix.measured.integrated_lufs !== null) {
    notes.push(`raw 響度未達 -16 LUFS（實測 ${mix.measured.integrated_lufs}）：不是 blocker，POST /timeline/mix loudnorm 兩遍法可矯正`)
  }

  if (!tl.clips.length) blockers.push({ source: "timeline", detail: "時間線無視頻 clip，無母帶可導出" })
  if (total <= 0) blockers.push({ source: "timeline", detail: "時間線總長為 0" })

  // 首個可達視頻源解析度（檢查級不強制下載；http 素材在導出級才解析）
  let video_resolution: { width: number; height: number } | null = null
  const ffmpeg = await detectFfmpeg()
  if (ffmpeg) {
    for (const c of tl.clips) {
      if (/^https?:\/\//.test(c.path)) { notes.push(`clip ${c.id} 為 http 素材，檢查級不下載；導出級解析`); continue }
      video_resolution = await probeVideoSize(ffmpeg, c.path).catch(() => null)
      if (video_resolution) break
      notes.push(`clip ${c.id} 源不可讀（${c.path.slice(0, 80)}）`)
    }
  } else {
    notes.push("ffmpeg 不可用，解析度探測跳過")
  }

  return {
    ok: blockers.length === 0,
    timeline_version: tl.version,
    duration_sec: total > 0 ? r3(total) : null,
    aspect: tl.aspect,
    clips: tl.clips.length,
    video_resolution: video_resolution ? { width: video_resolution.width, height: video_resolution.height } : null,
    lint_passed: lint.passed,
    lint_must: lintMust,
    lint_should_count: lint.issues.filter((i) => i.severity === "should").length,
    mix_compliant: mix.compliant,
    mix_sync_errors: mix.sync_errors,
    blockers,
    notes,
  }
}

export interface MasterExportResult {
  exported: boolean
  out_path: string | null
  cover_path: string | null
  public_url: null
  preset: { id: string; label: string; aspect: string; width: number; height: number }
  probe: { codec: string; width: number; height: number; duration_sec: number; size: number } | null
  timeline_version: number
  expected_duration_sec: number
  probe_error: string | null
  notes: string[]
}

function clipChain(c: TimelineClip, idx: number, w: number, h: number): string {
  const inS = Math.max(0, c.inSec ?? 0)
  const outS = Math.min(c.outSec ?? c.duration, c.duration)
  const speed = c.speed && c.speed > 0 ? c.speed : 1
  const parts = [`[${idx}:v]trim=start=${inS.toFixed(3)}:end=${outS.toFixed(3)}`, "setpts=PTS-STARTPTS"]
  if (speed !== 1) parts.push(`setpts=PTS/${speed.toFixed(4)}`)
  parts.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "setsar=1")
  const tone = filterToFfmpeg(c.filter ?? null)
  if (tone) parts.push(tone)
  return parts.join(",") + "[v" + idx + "]"
}

/** POST /agent/v1/timeline/master：導出閘（blockers 非空拋 TimelineValidationError → 400）。 */
export async function masterExport(sessionId: string, presetId: MasterPresetId = "landscape_169", withCover = true): Promise<MasterExportResult> {
  const check = await masterCheck(sessionId)
  if (!check.ok) {
    throw new TimelineValidationError(`導出被閘門攔下（blockers ${check.blockers.length} 條，先修再導）：` + JSON.stringify(check.blockers))
  }
  const notes = [...check.notes]
  const tl: Timeline = await getTimeline(sessionId)
  const preset = MASTER_PRESETS[presetId]
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) throw new TimelineValidationError("ffmpeg 不可用，無法導出")

  // 素材解析（複用 mix.resolveSource：本地直用、http 下載到 tmp），失敗=誠實拒導
  const workDir = path.join(TMP_DIR, `master-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const inputs: string[] = []
    const chains: string[] = []
    const srcByClip: { clip: TimelineClip; path: string }[] = []
    let idx = 0
    for (const c of tl.clips) {
      const ext = (c.path.split("?")[0].split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4"
      const s = await resolveSource(c.path, idx, ext)
      if (!s) throw new TimelineValidationError(`clip ${c.id} 素材不可達：${c.path.slice(0, 120)}`)
      inputs.push(`-i ${shq(s.path)}`)
      chains.push(clipChain(c, idx, preset.w, preset.h))
      srcByClip.push({ clip: c, path: s.path })
      idx++
    }
    const expectedDur = tl.clips.reduce((acc, c) => acc + clipLength(c), 0)
    const outDur = Math.max(0.1, expectedDur).toFixed(3)

    // 視頻側：concat（v1 妥協：xfade 不燒錄）
    const transitions = tl.clips.filter((c) => c.transitionAfter && c.transitionAfter.type !== "cut" && c.transitionAfter.type !== "fade").length
    if (transitions) notes.push(`${transitions} 處轉場 v1 未燒錄（transitionAfter 留給前端 composeEngine 渲染，母帶為硬切拼接）`)
    let fc = chains.join(";") + ";"
    fc += tl.clips.map((_, i) => `[v${i}]`).join("") + `concat=n=${tl.clips.length}:v=1:a=0[vcat]`
    // 視頻側不能用 apad（純音頻濾鏡，接到視頻 pad 上=media type mismatch）；時長帽用 trim=duration
    fc += `;[vcat]trim=duration=${outDur},setpts=PTS-STARTPTS[vmain]`

    // 字幕燒錄（ASS 落檔；濾鏡失敗自動降級重試不燒錄）
    const ass = subtitlesAss(tl)
    let burnSub = false
    let assFile: string | null = null
    if (ass.trim()) {
      assFile = path.join(workDir, "subs.ass")
      await writeFile(assFile, ass)
      burnSub = true
    }

    // 音頻側：mix.wav 若存在則掛音軌
    const mixPath = path.join(WORKSPACE_DIR, "timelines", sessionId, "mix.wav")
    let hasAudio = false
    if (await access(mixPath).then(() => true).catch(() => false)) {
      inputs.push(`-i ${shq(mixPath)}`)
      fc += `;[${idx}:a]apad,atrim=0:${outDur},asetpts=PTS-STARTPTS[amain]`
      hasAudio = true
    } else {
      notes.push("mix.wav 不存在：母帶無音軌（先跑 timeline_mix apply=true 再導出可帶混音）")
    }

    const outPath = path.join(WORKSPACE_DIR, "timelines", sessionId, `master_${presetId}.mp4`)
    const doRender = async (withSub: boolean): Promise<CommandResult> => {
      const fcFinal = withSub && assFile
        ? fc + `;[vmain]subtitles=${assFile}[vout]`
        : fc + ";[vmain]null[vout]"
      const fcFile = path.join(workDir, "filtergraph.txt")
      await writeFile(fcFile, fcFinal)
      // 單輸出檔：兩個 -map（視頻+音頻）都歸它，無 B5 雙輸出的逐檔 map 問題；fc 一律 -filter_complex_script 落檔傳遞
      const cmd = `${ffmpeg} -y -hide_banner -loglevel error ${inputs.join(" ")} -filter_complex_script ${shq(fcFile)} -map "[vout]"${hasAudio ? ` -map "[amain]"` : ""} -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart${hasAudio ? " -c:a aac -b:a 192k" : ""} ${shq(outPath)}`
      return run(cmd, 600_000)
    }
    let r = await doRender(burnSub)
    if (r.exit_code !== 0 && burnSub) {
      notes.push(`字幕燒錄失敗（${(r.stderr || "").slice(-160).trim()}），自動降級為不燒錄重渲`)
      r = await doRender(false)
    }
    if (r.exit_code !== 0) {
      throw new TimelineValidationError(`母帶渲染失敗：${(r.stderr || "unknown").slice(-400)}`)
    }

    // 封面幀
    let coverPath: string | null = null
    if (withCover) {
      coverPath = path.join(WORKSPACE_DIR, "timelines", sessionId, `master_${presetId}_cover.jpg`)
      const rc = await run(`${ffmpeg} -y -hide_banner -loglevel error -i ${shq(outPath)} -map 0:v:0 -frames:v 1 -q:v 3 ${shq(coverPath)}`, 60_000)
      if (rc.exit_code !== 0) { notes.push("封面幀提取失敗（不擋交付）"); coverPath = null }
    }

    // probeRenderedVideo 強校驗（輪子）：容器/解析度/時長/首幀解碼全門
    let probe: MasterExportResult["probe"] = null
    let probe_error: string | null = null
    try {
      const p = await probeRenderedVideo(ffmpeg, outPath, {
        format: "mp4",
        width: preset.w,
        height: preset.h,
        durationSec: Math.max(0.1, expectedDur),
        durationToleranceSec: 0.8,
      })
      probe = { codec: p.codecName, width: p.width, height: p.height, duration_sec: r3(p.durationSec), size: p.size }
    } catch (e) {
      probe_error = (e as Error).message
      notes.push(`probeRenderedVideo 校驗未過：${probe_error}`)
    }

    return {
      exported: probe !== null,
      out_path: outPath,
      cover_path: coverPath,
      public_url: null,
      preset: { id: presetId, label: preset.label, aspect: preset.aspect, width: preset.w, height: preset.h },
      probe,
      timeline_version: tl.version,
      expected_duration_sec: r3(expectedDur),
      probe_error,
      notes,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
