// S8b：mix 执行器（确定性）。
// 轮子：mix.ts 的 applyMix（voice 侧链 ducking + amix + loudnorm 两遍），本档只负责
// 「工程图参数 → 时间线音频数据」的翻译：levels 折算成 clip.volume（dB→线性），
// ducking=false 时把 music/sfx 轨并入 voice 组以关闭侧链压缩（不改 mix.ts 一行），
// targetLufs≠-16 时在 applyMix 之后再跑一次同款 loudnorm 两遍法（配方抄自 mix.ts renderMix）。
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyMix, resolveSource, type MixReport } from "../../mix.ts"
import { totalDurationSec, type Timeline, type AudioClip, type AudioTrack } from "../../timeline.ts"
import type { AudioTrackKind } from "../../editor/adapter/editorStore"
import { parseEbur128 } from "../../film-qc"
import type { ExecContext, ExecResult, Json, NodeExecutor, Output } from "../types"
import { NODE_SPECS } from "../specs"
import { flattenInputs, isAudio, isJson, isObj, probeDurationSec, projectScratchDir, readJsonOutput, safeNodeKey } from "./timeline"

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
export const MIX_DEFAULT_LUFS = -16

const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`

async function runCmd(command: string, timeoutMs = 180_000): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const { invoke } = await import("../../editor/adapter/tauri-adapter")
  return invoke<{ stdout: string; stderr: string; exit_code: number }>("execute_command", { command, timeoutMs })
    .catch(() => ({ stdout: "", stderr: "", exit_code: 1 }))
}

function dbToGain(db: Json | undefined, fallbackDb: number): number {
  const v = typeof db === "number" && Number.isFinite(db) ? db : fallbackDb
  return Math.pow(10, v / 20)
}

function clampGain(g: number): number {
  if (!Number.isFinite(g) || g < 0) return 0
  return Math.min(4, g)
}

function levelGain(levels: Json, kind: string): number {
  if (!isObj(levels)) return 1
  const key = kind === "voice" ? "voice" : kind === "sfx" ? "sfx" : "music"
  const fallback = key === "voice" ? 0 : -18
  return clampGain(dbToGain(levels[key], fallback))
}

function duckingEnabled(ducking: Json | undefined): boolean {
  if (typeof ducking === "boolean") return ducking
  if (isObj(ducking)) {
    if (typeof ducking.enabled === "boolean") return ducking.enabled
    if (typeof ducking.amount === "number") return ducking.amount !== 0
  }
  return true
}

/** levels/ducking → 时间线音频数据（只改数据，滤镜图仍由 mix.ts 产生）。 */
export function applyMixParams(tl: Timeline, levels: Json, ducking: Json | undefined): Timeline {
  const duck = duckingEnabled(ducking)
  const trackKind = new Map<string, AudioTrackKind>((tl.audioTracks ?? []).map((t) => [t.id, t.kind]))
  const audioTracks: AudioTrack[] = (tl.audioTracks ?? []).map((t) => ({
    ...t,
    kind: duck || t.kind === "voice" ? t.kind : "voice",
  }))
  const audioClips: AudioClip[] = (tl.audioClips ?? []).map((c) => {
    const kind = trackKind.get(c.trackId) ?? "voice"
    return { ...c, volume: clampGain((typeof c.volume === "number" ? c.volume : 1) * levelGain(levels, kind)) }
  })
  return { ...tl, audioTracks, audioClips }
}

async function normalizeToTarget(ffmpeg: string, inPath: string, outPath: string, targetLufs: number): Promise<{ ok: boolean; lufs: number | null; note: string }> {
  const p1 = await runCmd(`${ffmpeg} -hide_banner -nostats -i ${shq(inPath)} -af 'loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json' -f null - 2>&1`, 180_000)
  const jm = (p1.stderr + p1.stdout).match(/\{[^{}]*"input_i"[^{}]*\}/)
  const p2 = await runCmd(
    jm
      ? (() => {
          const m = JSON.parse(jm[0]) as Record<string, string>
          const ln = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:linear=true`
          return `${ffmpeg} -y -hide_banner -loglevel error -i ${shq(inPath)} -af 'loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:${ln}' -ar 48000 -c:a pcm_s16le ${shq(outPath)}`
        })()
      : `${ffmpeg} -y -hide_banner -loglevel error -i ${shq(inPath)} -af 'loudnorm=I=${targetLufs}:TP=-1.5:LRA=11' -ar 48000 -c:a pcm_s16le ${shq(outPath)}`,
    180_000,
  )
  if (p2.exit_code !== 0) return { ok: false, lufs: null, note: `loudnorm 目标 ${targetLufs} LUFS 渲染失败：${(p2.stderr || "").slice(-160)}` }
  const measured = await runCmd(`${ffmpeg} -hide_banner -nostats -i ${shq(outPath)} -af 'ebur128=peak=true' -f null - 2>&1`, 120_000)
  const parsed = parseEbur128(measured.stderr + measured.stdout)
  return { ok: true, lufs: parsed.lufs, note: `loudnorm 目标 ${targetLufs} LUFS 完成（实测 ${parsed.lufs ?? "n/a"}）` }
}

/** 单 clip 音频图（与 mix.ts clipFilter 逐字同口径：atrim→asetpts→volume→afade→adelay）。 */
function clipFilter(c: AudioClip): string {
  const dur = Math.max(0.01, (c.outSec ?? c.duration) - (c.inSec ?? 0))
  const parts = [
    `atrim=${(c.inSec ?? 0).toFixed(3)}:${(c.outSec ?? c.duration).toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
    `volume=${(c.volume ?? 1).toFixed(3)}`,
  ]
  if (c.fadeInSec && c.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${c.fadeInSec.toFixed(3)}`)
  if (c.fadeOutSec && c.fadeOutSec > 0) parts.push(`afade=t=out:st=${Math.max(0, dur - c.fadeOutSec).toFixed(3)}:d=${c.fadeOutSec.toFixed(3)}`)
  parts.push(`adelay=${Math.round((c.startSec ?? 0) * 1000)}:all=1`)
  return parts.join(",")
}

/**
 * 后备混音（只在宿主机 ffmpeg 缺 -filter_complex_script 时走，ffmpeg ≥9 移除了该选项）：
 * 滤镜图逐段抄自 mix.ts buildMixFlow（voice 侧链 ducking + bus amix + atrim），
 * 差别仅是把图串直接放进 -filter_complex（单引号包住，不经 shell 层切割）。
 * 轮子本身（mix.ts）不改；生产老 ffmpeg 仍走 applyMix。
 */
async function renderMixFallback(
  tl: Timeline,
  ffmpeg: string,
  workDir: string,
  targetLufs: number,
): Promise<{ ok: true; path: string; notes: string[]; lufs: number | null } | { ok: false; message: string }> {
  const total = totalDurationSec(tl)
  if (!(total > 0)) return { ok: false, message: "时间线总长为 0，无混音可渲染" }
  const trackById = new Map<string, AudioTrack>((tl.audioTracks ?? []).map((t) => [t.id, t]))
  const groups: Record<"voice" | "music" | "sfx", AudioClip[]> = { voice: [], music: [], sfx: [] }
  for (const c of tl.audioClips ?? []) {
    const kind = trackById.get(c.trackId)?.kind
    if (!kind) return { ok: false, message: `音轨缺失：clip ${c.id} 的 trackId=${c.trackId} 无对应音轨` }
    groups[kind === "voice" ? "voice" : kind === "bgm" ? "music" : "sfx"].push(c)
  }
  const sources = new Map<string, string>()
  for (const c of [...groups.voice, ...groups.music, ...groups.sfx]) {
    const ext = c.path.split("?")[0].split(".").pop() || "wav"
    const s = await resolveSource(c.path, sources.size, ext, workDir)
    if (!s) return { ok: false, message: `素材不可达：${c.path.slice(0, 160)}` }
    sources.set(c.id, s.path)
  }
  const inputs: string[] = []
  const chains: string[] = []
  const addInput = (c: AudioClip): string => {
    const inIdx = inputs.length
    inputs.push(`-i ${shq(sources.get(c.id)!)}`)
    const lb = `c${inIdx}`
    chains.push(`[${inIdx}:a]${clipFilter(c)}[${lb}f]`)
    return `${lb}f`
  }
  const amixChain = (labels: string[], out: string): string =>
    labels.length === 1
      ? `[${labels[0]}]anull[${out}]`
      : `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled[${out}]`
  const voiceLabels = groups.voice.map(addInput)
  const busLabels = [...groups.music, ...groups.sfx].map(addInput)
  const tail = `atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS[mix]`
  let fc = chains.length ? chains.join(";") + ";" : ""
  if (voiceLabels.length) fc += amixChain(voiceLabels, "voiceMix") + ";"
  if (busLabels.length) fc += amixChain(busLabels, "bus") + ";"
  if (voiceLabels.length && busLabels.length) {
    fc += `[voiceMix]asplit=2[voiceSc][voiceFin];[bus][voiceSc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[ducked];[ducked][voiceFin]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled[mixfull];[mixfull]${tail}`
  } else if (voiceLabels.length) {
    fc += `[voiceMix]${tail}`
  } else {
    fc += `[bus]${tail}`
  }
  const mixRaw = path.join(workDir, "mix_raw.wav")
  const r = await runCmd(`${ffmpeg} -y -hide_banner -loglevel error ${inputs.join(" ")} -filter_complex ${shq(fc)} -map "[mix]" ${shq(mixRaw)}`, 300_000)
  if (r.exit_code !== 0) return { ok: false, message: `混音渲染失败：${(r.stderr || "unknown").slice(-400)}` }
  const out = path.join(workDir, "mix.wav")
  const norm = await normalizeToTarget(ffmpeg, mixRaw, out, targetLufs)
  if (!norm.ok) return { ok: false, message: norm.note }
  return { ok: true, path: out, notes: [`后备混音（宿主机 ffmpeg 无 -filter_complex_script）：${norm.note}`], lufs: norm.lufs }
}

/** 无 timeline 产物时的退化时间线：audio 输入逐条铺 voice 轨（music 从 0 起）。 */function fallbackTimeline(sessionId: string, entries: ReturnType<typeof flattenInputs>): Timeline {
  const audioTracks: AudioTrack[] = []
  const audioClips: AudioClip[] = []
  let cursor = 0
  let i = 0
  for (const e of entries.filter((x) => isAudio(x.output))) {
    const sec = e.output.durationSec && e.output.durationSec > 0 ? e.output.durationSec : 1
    const label = `${e.name} ${e.from ?? ""}`.toLowerCase()
    const kind: AudioTrackKind = /music|bgm|score/.test(label) ? "bgm" : "voice"
    if (!audioTracks.some((t) => t.id === kind)) audioTracks.push({ id: kind, kind, muted: false })
    audioClips.push({
      id: `a_${e.from ?? i}`,
      trackId: kind,
      path: e.output.path,
      label: e.from ?? `audio${i}`,
      startSec: kind === "bgm" ? 0 : cursor,
      duration: sec,
      inSec: 0,
      outSec: sec,
      volume: 1,
    })
    if (kind === "voice") cursor += sec
    i += 1
  }
  return {
    session_id: sessionId,
    version: 0,
    clips: [],
    audioTracks,
    audioClips,
    subtitles: [],
    bgm: null,
    aspect: "16:9",
    updated_at: new Date(0).toISOString(),
  }
}

export const mixExecutor: NodeExecutor = {
  type: "mix",
  specVersion: NODE_SPECS.mix.specVersion,
  async estimate() { return 0 },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const params = ctx.params ?? {}
    const entries = flattenInputs(ctx)
    let tl: Timeline | null = null
    for (const e of entries.filter((x) => isJson(x.output))) {
      const v = await readJsonOutput(e.output)
      if (isObj(v) && Array.isArray(v.clips)) { tl = v as unknown as Timeline; break }
    }
    if (!tl) {
      if (!entries.some((e) => isAudio(e.output))) {
        return { ok: false, code: "bad_input", message: "mix 需要 timeline 产物（json）或音频输入：当前两者都没有", retryable: false }
      }
      tl = fallbackTimeline(ctx.sessionId, entries)
    }
    // 时间线快照没有音频轨但 mix 直接接了音频：按输入铺轨（与 timeline 执行器同口径）。
    if (!(tl.audioClips ?? []).length && entries.some((e) => isAudio(e.output))) {
      const fb = fallbackTimeline(ctx.sessionId, entries)
      tl = { ...tl, audioTracks: fb.audioTracks, audioClips: fb.audioClips }
    }
    const adjusted = applyMixParams(tl, params.levels ?? null, params.ducking)
    if (!adjusted.audioClips.length) {
      return { ok: false, code: "bad_input", message: "时间线没有音频素材（voice/music），无混音可做", retryable: false }
    }
    const targetLufs = typeof params.targetLufs === "number" && Number.isFinite(params.targetLufs) ? params.targetLufs : MIX_DEFAULT_LUFS

    const key = safeNodeKey(ctx.sessionId, "mix", ctx.node.id)
    const dir = path.join(WORKSPACE_DIR, "timelines", key)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "current.json"), JSON.stringify({ ...adjusted, session_id: key }, null, 2), "utf-8")

    const mixed = await applyMix(key)
    const report: MixReport = mixed.report
    if (report.sync_errors.length) {
      return { ok: false, code: "bad_input", message: `混音同步错误 ${report.sync_errors.length} 条：` + JSON.stringify(report.sync_errors).slice(0, 400), retryable: false }
    }

    let finalPath = mixed.outPath
    const notes = [...report.notes]
    if (!finalPath) {
      // ffmpeg ≥9 移除了 -filter_complex_script：轮子在本机跑不动时走同口径后备混音。
      const unsupported = notes.some((n) => /filter_complex_script|Unrecognized option/i.test(n))
      if (!unsupported) {
        return { ok: false, code: "bad_input", message: `混音没有产出：${notes.join("；").slice(0, 300) || "时间线无可用音频"}`, retryable: false }
      }
      const { detectFfmpeg } = await import("../../editor/canvas/videoCompose")
      const ffmpeg = await detectFfmpeg()
      if (!ffmpeg) return { ok: false, code: "bad_input", message: "ffmpeg 不可用，无法渲染混音", retryable: false }
      const fb = await renderMixFallback({ ...adjusted, session_id: key }, ffmpeg, dir, targetLufs)
      if (fb.ok !== true) return { ok: false, code: "bad_input", message: (fb as { message?: string }).message ?? "混音渲染失败", retryable: false }
      finalPath = fb.path
      notes.push(...fb.notes)
      report.measured = { ...report.measured, integrated_lufs: fb.lufs }
    } else if (Math.abs(targetLufs - MIX_DEFAULT_LUFS) > 0.1) {
      const { detectFfmpeg } = await import("../../editor/canvas/videoCompose")
      const ffmpeg = await detectFfmpeg()
      if (ffmpeg) {
        const targetPath = path.join(dir, "mix_target.wav")
        const norm = await normalizeToTarget(ffmpeg, mixed.outPath, targetPath, targetLufs)
        notes.push(norm.note)
        if (norm.ok) finalPath = targetPath
        if (norm.ok) report.measured = { ...report.measured, integrated_lufs: norm.lufs }
      } else {
        notes.push("ffmpeg 不可用：targetLufs 未重新正规化，保留 -16 LUFS 产物")
      }
    }

    const scratch = projectScratchDir(ctx.sessionId, `mix-${ctx.node.id}`)
    await mkdir(scratch, { recursive: true })
    const outPath = path.join(scratch, "mix.wav")
    await writeFile(outPath, await readFile(finalPath))
    const ingested = await ctx.ingest({ path: outPath }, { port: "out", mime: "audio/wav", origin: "derived" })
    const durationSec = ingested.durationSec ?? await probeDurationSec(outPath)
    const meta: Record<string, Json> = {
      targetLufs,
      levels: (isObj(params.levels) ? params.levels : null) as Json,
      ducking: duckingEnabled(params.ducking),
      measuredLufs: report.measured.integrated_lufs,
      truePeakDbtp: report.measured.true_peak_dbtp,
      compliant: report.compliant,
      duckingEvents: report.ducking_events.length,
      notes: notes.join("；").slice(0, 600),
      durationSec: durationSec || null,
    }
    const outputs: Output[] = [{ ...ingested, port: "out", durationSec: durationSec || undefined, meta }]
    return { ok: true, costCoins: 0, outputs }
  },
}
