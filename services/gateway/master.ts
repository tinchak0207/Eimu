// B6（2026-08-31）母带检查+导出闸 — REQ-EDIT-07 聚合收尾。
// check = 时长/解析度/画幅 + B4 lint must + B5 mix sync_errors 聚合；blockers 非空拒导。
// 导出 = concat（trim→变速→scale/pad 画幅→clip.filter 调色）+ mix.wav 音轨 + 字幕 ASS 烧录（失败即拒导，不静默拿掉字幕）
//   + 封面帧 + probeRenderedVideo 强校验（轮子：composeEngine probeRenderedVideo；解析度口径 EXPORT_RESOLUTIONS）。
// 2026-09-15 补三项（AID 产品层对称差，见 ./material-fingerprint.ts 档头）：
//   check 加素材 URL 结构守卫（blocker source="url"）；export 回填素材集合 fingerprint。
//   复用逻辑待接持久层（本片只算指纹，不跨次调用复用）。
// 妥协（诚实 notes）：xfade 转场 v1 不烧录（transitionAfter 留给前端 composeEngine 渲染）；mix 响度不达标不是 blocker（POST /timeline/mix loudnorm 可矫正）。
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
import { computeExportFingerprint, isForbiddenMaterialUrl } from "./material-fingerprint"

interface CommandResult { stdout: string; stderr: string; exit_code: number }

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
const TMP_DIR = path.join(WORKSPACE_DIR, "tmp")

const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
const r3 = (n: number) => Math.round(n * 1000) / 1000
const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "m4v", "avi", "mpg", "mpeg", "ts", "m2ts", "wmv", "flv", "ogv", "3gp"])
function evenDim(n: number): number {
  const v = Math.max(2, Math.floor(n))
  return v - (v % 2)
}
/** subtitles 滤镜路径：冒号、反斜杠、单引号都要转义，否则滤镜被截断。 */
function escapeSubtitlesPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
}

async function run(cmd: string, timeoutMs = 600_000): Promise<CommandResult> {
  return invoke<CommandResult>("execute_command", { command: cmd, timeoutMs }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }) as CommandResult)
}

/** 导出预设（解析度口径对齐 EXPORT_RESOLUTIONS 1080p；影院 2.39:1 = 1920x804 偶数近似 2.388:1） */
export const MASTER_PRESETS = {
  portrait_916: { label: "竖版 9:16", aspect: "9:16", w: 1080, h: 1920 },
  landscape_169: { label: "横版 16:9", aspect: "16:9", w: 1920, h: 1080 },
  cinema_239: { label: "影院 2.39:1", aspect: "21:9", w: 1920, h: 804 },
} as const
export type MasterPresetId = keyof typeof MASTER_PRESETS

export interface MasterBlocker { source: "lint" | "mix" | "timeline" | "url"; detail: string }

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

/** GET /agent/v1/timeline/master：母带检查报告（只检查不导出）。 */
export async function masterCheck(sessionId: string): Promise<MasterCheck> {
  const tl = await getTimeline(sessionId)
  const total = totalDurationSec(tl)
  const notes: string[] = []
  const blockers: MasterBlocker[] = []

  const lint = await lintTimeline(sessionId)
  const lintMust = lint.issues.filter((i) => i.severity === "must")
  for (const i of lintMust) blockers.push({ source: "lint", detail: `must ${i.type} @ ${i.clip_id}（${i.evidence.slice(0, 120)}）→ ${i.fix_hint}` })
  if (lint.issues.some((i) => i.severity === "should")) notes.push(`should 级 ${lint.issues.filter((i) => i.severity === "should").length} 条不挡导出，明细见 /timeline/lint`)

  const mix = await analyzeMix(sessionId)
  for (const e of mix.sync_errors) blockers.push({ source: "mix", detail: `sync_errors: ${e.clip_id} ${e.type} ${e.detail}` })
  if (mix.sync_errors.length) notes.push("mix sync_errors 会同样拦下导出；先按 clip_id 修时间线")
  if (!mix.compliant && !mix.sync_errors.length && mix.measured.integrated_lufs !== null) {
    notes.push(`raw 响度未达 -16 LUFS（实测 ${mix.measured.integrated_lufs}）：不是 blocker，POST /timeline/mix loudnorm 两遍法可矫正`)
  }

  if (!tl.clips.length) blockers.push({ source: "timeline", detail: "时间线无视频 clip，无母带可导出" })
  if (total <= 0) blockers.push({ source: "timeline", detail: "时间线总长为 0" })

  // 素材 URL 结构守卫（AID MaterialUrlGuard 口径）：blob:/data:/嵌套协议/非 http(s) 一律拒导。
  // 零 I/O 快检，不触网；本地相对路径合法（可达性由导出级 resolveSource 决定）。
  const urlTargets: { label: string; url: string | undefined | null }[] = [
    ...tl.clips.map((c) => ({ label: `clip ${c.id}`, url: c.path })),
    ...tl.audioClips.map((a) => ({ label: `audioClip ${a.id}`, url: a.path })),
    ...(tl.bgm ? [{ label: "bgm", url: tl.bgm.path }] : []),
  ]
  for (const t of urlTargets) {
    if (isForbiddenMaterialUrl(t.url ?? "")) {
      blockers.push({ source: "url", detail: `${t.label} 素材地址结构非法：${String(t.url).slice(0, 160)}（blob:/data:/嵌套协议/非 http(s) 服务端无法访问，请改用已上传的素材地址）` })
    }
  }

  // 首个可达视频源解析度（检查级不强制下载；http 素材在导出级才解析）
  let video_resolution: { width: number; height: number } | null = null
  const ffmpeg = await detectFfmpeg()
  if (ffmpeg) {
    for (const c of tl.clips) {
      if (/^https?:\/\//.test(c.path)) { notes.push(`clip ${c.id} 为 http 素材，检查级不下载；导出级解析`); continue }
      video_resolution = await probeVideoSize(ffmpeg, c.path).catch(() => null)
      if (video_resolution) break
      notes.push(`clip ${c.id} 源不可读（${c.path.slice(0, 80)}）`)
    }
  } else {
    notes.push("ffmpeg 不可用，解析度探测跳过")
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
  /** G4（2026-09-17）：导出档的公网 URL（/agent/v1/masters/<sid>/master_<preset>.mp4）。
   *  由 index.ts 的 registerMasterExport 回填——档案落盘即存在，与索引登记成败无关。 */
  public_url: string | null
  /** G4：控制面索引行 id（/v1/internal/masters/ingest 回传 artifact_id）；登记失败/重放命中时 null。 */
  master_artifact_id: string | null
  preset: { id: string; label: string; aspect: string; width: number; height: number }
  probe: { codec: string; width: number; height: number; duration_sec: number; size: number } | null
  timeline_version: number
  expected_duration_sec: number
  probe_error: string | null
  notes: string[]
  /** 素材集合指纹（sha256 hex）：素材没变则指纹不变。复用判定待接持久层，见 masterExport 档头。 */
  fingerprint?: string
  /** 跨次调用复用标记：本片恒 undefined（无持久层，只算指纹不回填）。 */
  reused?: boolean
}

function clipChain(c: TimelineClip, idx: number, w: number, h: number): string {
  const inS = Math.max(0, c.inSec ?? 0)
  const outS = Math.min(c.outSec ?? c.duration, c.duration)
  const speed = c.speed && c.speed > 0 ? c.speed : 1
  const parts = [`[${idx}:v]trim=start=${inS.toFixed(3)}:end=${outS.toFixed(3)}`, "setpts=PTS-STARTPTS"]
  if (speed !== 1) parts.push(`setpts=PTS/${speed.toFixed(4)}`)
  const ew = evenDim(w)
  const eh = evenDim(h)
  parts.push(
    `scale=${ew}:${eh}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${ew}:${eh}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2`,
    "setsar=1",
  )
  const tone = filterToFfmpeg(c.filter ?? null)
  if (tone) parts.push(tone)
  return parts.join(",") + "[v" + idx + "]"
}

/**
 * POST /agent/v1/timeline/master：导出闸（blockers 非空抛 TimelineValidationError → 400）。
 *
 * 导出指纹（2026-09-15，AID `computeExportFingerprint` 口径）：本函式计算并回填 `fingerprint`。
 * **复用逻辑待接持久层**——跨次调用「指纹相同且上次成功 → 直接复用不再合成不再扣费」需要一个
 * 持久化的 fingerprint→成功产物 映射（AID 落在 `aid_episode_editor.export_fingerprint`），
 * 本片不实作；`reused` 恒为 undefined。
 */
export async function masterExport(sessionId: string, presetId: MasterPresetId = "landscape_169", withCover = true): Promise<MasterExportResult> {
  const check = await masterCheck(sessionId)
  if (!check.ok) {
    throw new TimelineValidationError(`导出被闸门拦下（blockers ${check.blockers.length} 条，先修再导）：` + JSON.stringify(check.blockers))
  }
  const notes = [...check.notes]
  const tl: Timeline = await getTimeline(sessionId)
  const preset = MASTER_PRESETS[presetId]
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) throw new TimelineValidationError("ffmpeg 不可用，无法导出")

  // 素材集合指纹（纯计算，零 I/O）：clips 保序（拼接顺序即语义）；durationSec 取时间线有效时长
  // clipLength（含 trim/变速），比源档总长更贴近实际入片素材。
  const fingerprint = computeExportFingerprint({
    clips: tl.clips.map((c) => ({ path: c.path, durationSec: clipLength(c) })),
    audioClips: (tl.audioClips ?? []).map((a) => ({ path: a.path, durationSec: a.duration, startSec: a.startSec })),
    subtitles: (tl.subtitles ?? []).map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
    bgm: tl.bgm ? { path: tl.bgm.path, volume: tl.bgm.volume } : null,
    aspect: preset.aspect,
    presetId,
  })

  // 素材解析（复用 mix.resolveSource：本地直用、http 下载到 tmp），失败=诚实拒导
  const workDir = path.join(TMP_DIR, `master-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const inputs: string[] = []
    const chains: string[] = []
    const srcByClip: { clip: TimelineClip; path: string }[] = []
    let idx = 0
    for (const c of tl.clips) {
      const rawName = c.path.split("?")[0]
      const suffix = rawName.includes(".") ? (rawName.split(".").pop() || "").replace(/[^a-z0-9]/gi, "").toLowerCase() : ""
      const ext = suffix || "bin"
      const s = await resolveSource(c.path, idx, ext, workDir)
      if (!s) throw new TimelineValidationError(`clip ${c.id} 素材不可达：${c.path.slice(0, 120)}`)
      // 静帧素材（2026-09-28 漫剧评测实锤）：单张 png/jpg 不带 -loop 1 只解出 1 帧，trim 后视频轨
      // 只剩 0.08 秒、音轨照样 60 秒——容器时长骗过 probe，成片实为坏片。静帧一律 -loop 1 成连续流，
      // -t 以 outSec 封顶（多留一帧余量给 trim），动态素材路径不变。
      // 已知视频后缀才当动态素材；无后缀或未知后缀按静帧，避免无 -loop 只解出 1 帧。
      const isStill = !VIDEO_EXT.has(suffix)
      const stillSec = Math.max(0.1, Math.min(c.outSec ?? c.duration, c.duration)) + 0.1
      inputs.push(isStill ? `-loop 1 -framerate 25 -t ${stillSec.toFixed(3)} -i ${shq(s.path)}` : `-i ${shq(s.path)}`)
      chains.push(clipChain(c, idx, preset.w, preset.h))
      srcByClip.push({ clip: c, path: s.path })
      idx++
    }
    const expectedDur = tl.clips.reduce((acc, c) => acc + clipLength(c), 0)
    const outDur = Math.max(0.1, expectedDur).toFixed(3)

    // 视频侧：concat（v1 妥协：xfade 不烧录）
    const transitions = tl.clips.filter((c) => c.transitionAfter && c.transitionAfter.type !== "cut" && c.transitionAfter.type !== "fade").length
    if (transitions) notes.push(`${transitions} 处转场 v1 未烧录（transitionAfter 留给前端 composeEngine 渲染，母带为硬切拼接）`)
    let fc = chains.join(";") + ";"
    fc += tl.clips.map((_, i) => `[v${i}]`).join("") + `concat=n=${tl.clips.length}:v=1:a=0[vcat]`
    // 视频侧不能用 apad（纯音频滤镜，接到视频 pad 上=media type mismatch）；时长帽用 trim=duration
    fc += `;[vcat]trim=duration=${outDur},setpts=PTS-STARTPTS[vmain]`

    // 字幕烧录（ASS 落档；失败直接拒导，不交无字幕片）
    const ass = subtitlesAss(tl)
    let burnSub = false
    let assFile: string | null = null
    if (ass.trim()) {
      assFile = path.join(workDir, "subs.ass")
      await writeFile(assFile, ass)
      burnSub = true
    }

    // 音频侧：mix.wav 若存在则挂音轨
    const mixPath = path.join(WORKSPACE_DIR, "timelines", sessionId, "mix.wav")
    let hasAudio = false
    if (await access(mixPath).then(() => true).catch(() => false)) {
      inputs.push(`-i ${shq(mixPath)}`)
      fc += `;[${idx}:a]apad,atrim=0:${outDur},asetpts=PTS-STARTPTS[amain]`
      hasAudio = true
    } else {
      notes.push("mix.wav 不存在：母带无音轨（先跑 timeline_mix apply=true 再导出可带混音）")
    }

    const outPath = path.join(WORKSPACE_DIR, "timelines", sessionId, `master_${presetId}.mp4`)
    const doRender = async (withSub: boolean): Promise<CommandResult> => {
      const fcFinal = withSub && assFile
        ? fc + `;[vmain]subtitles='${escapeSubtitlesPath(assFile)}'[vout]`
        : fc + ";[vmain]null[vout]"
      const fcFile = path.join(workDir, "filtergraph.txt")
      await writeFile(fcFile, fcFinal)
      // 单输出档：两个 -map（视频+音频）都归它，无 B5 双输出的逐档 map 问题；fc 一律 -filter_complex_script 落档传递
      const cmd = `${ffmpeg} -y -hide_banner -loglevel error ${inputs.join(" ")} -filter_complex_script ${shq(fcFile)} -map "[vout]"${hasAudio ? ` -map "[amain]"` : ""} -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart${hasAudio ? " -c:a aac -b:a 192k" : ""} ${shq(outPath)}`
      return run(cmd, 600_000)
    }
    const r = await doRender(burnSub)
    if (r.exit_code !== 0) {
      throw new TimelineValidationError(`母带渲染失败：${(r.stderr || "unknown").slice(-400)}`)
    }

    // 封面帧
    let coverPath: string | null = null
    if (withCover) {
      coverPath = path.join(WORKSPACE_DIR, "timelines", sessionId, `master_${presetId}_cover.jpg`)
      const rc = await run(`${ffmpeg} -y -hide_banner -loglevel error -i ${shq(outPath)} -map 0:v:0 -frames:v 1 -q:v 3 ${shq(coverPath)}`, 60_000)
      if (rc.exit_code !== 0) { notes.push("封面帧提取失败（不挡交付）"); coverPath = null }
    }

    // probeRenderedVideo 强校验（轮子）：容器/解析度/时长/首帧解码全门
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
      notes.push(`probeRenderedVideo 校验未过：${probe_error}`)
    }

    return {
      exported: probe !== null,
      out_path: outPath,
      cover_path: coverPath,
      public_url: null,
      master_artifact_id: null,
      preset: { id: presetId, label: preset.label, aspect: preset.aspect, width: preset.w, height: preset.h },
      probe,
      timeline_version: tl.version,
      expected_duration_sec: r3(expectedDur),
      probe_error,
      notes,
      fingerprint,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
