// B5（2026-08-31）混音后置 pass — REQ-EDIT-06 三轨（voice/music/sfx）+ ducking + 响度量测。
// 口径权威 = editor/composeEngine L1125（atrim/asetpts/volume/afade/adelay），本档不改轮子一字节。
// ducking 配方 orchestrator 实测：sidechaincompress threshold=0.05 ratio=8 attack=20 release=300（duck 深度 20.5dB）。
// 量测顺序铁律：先 duck 出纯压缩 bus、再与人声 amix——量 BGM 时人声能量会掩盖 duck 深度。
import { mkdir, access, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, totalDurationSec, TimelineValidationError, type Timeline, type AudioClip, type AudioTrack } from "./timeline"
import { detectFfmpeg } from "./editor/canvas/videoCompose"
import { invoke } from "./editor/adapter/tauri-adapter"

interface CommandResult { stdout: string; stderr: string; exit_code: number }

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/eimu-harness/workspace"
const TMP_DIR = path.join(WORKSPACE_DIR, "tmp")

export interface DuckingEvent { at_ms: number; end_ms: number; depth_db: number | null; track: string }
export interface SyncError { clip_id: string; type: string; detail: string }
export interface MixReport {
  layers: { voice: number; music: number; sfx: number }
  measured: { integrated_lufs: number | null; true_peak_dbtp: number | null; lra: number | null }
  compliant: boolean
  ducking_events: DuckingEvent[]
  sync_errors: SyncError[]
  notes: string[]
}

const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
const r3 = (n: number) => Math.round(n * 1000) / 1000

async function run(cmd: string, timeoutMs = 300_000): Promise<CommandResult> {
  return invoke<CommandResult>("execute_command", { command: cmd, timeoutMs }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }) as CommandResult)
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

/** 素材解析：本地档直用；http(s) 下载到 tmp。返回 {path} 或 null（不可达）。B6 master 导出复用。 */
export async function resolveSource(src: string, idx: number, ext: string, downloadDir = TMP_DIR): Promise<{ path: string } | null> {
  if (/^https?:\/\//.test(src)) {
    await mkdir(downloadDir, { recursive: true })
    const dst = path.join(downloadDir, `mix-${Date.now()}-${idx}.${ext.replace(/[^a-z0-9]/gi, "") || "wav"}`)
    const r = await run(`curl -fsSL --max-time 60 -o ${shq(dst)} ${shq(src)}`, 90_000)
    if (r.exit_code !== 0) {
      await rm(dst, { force: true }).catch(() => {})
      return null
    }
    return { path: dst }
  }
  return (await fileExists(src)) ? { path: src } : null
}

/** 已有试听窗（in/out 或 preview）才截 BGM；没有这些字段就不发明窗口，仍从 0 铺到全片。 */
function bgmAudibleSpan(bgm: object, total: number): { startSec: number; inSec: number; outSec: number; duration: number } {
  const raw = bgm as Record<string, unknown>
  const preview = raw.preview
  const host = preview && typeof preview === "object" && !Array.isArray(preview) ? (preview as Record<string, unknown>) : raw
  const hasWindow = preview != null || "in" in raw || "out" in raw || "inSec" in raw || "outSec" in raw
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const inn = num(host.inSec) ?? num(host.in)
  const out = num(host.outSec) ?? num(host.out)
  if (!hasWindow || inn === null || out === null || !(out > inn)) {
    return { startSec: 0, inSec: 0, outSec: total, duration: total }
  }
  const start = Math.max(0, Math.min(num(host.startSec) ?? inn, total))
  const end = Math.max(start, Math.min(out, total))
  const span = Math.max(0.01, end - start)
  const sourceIn = num(host.inSec) ?? 0
  return { startSec: start, inSec: sourceIn, outSec: sourceIn + span, duration: span }
}

/** 单 clip 音频图（时间线座标）：atrim→asetpts→volume→afade→adelay（composeEngine L1125 口径）。 */
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

/** ebur128 summary 解析（peak=true 时 Peak 行即 true peak，单位 dBTP 口径）。
 *  只解析 Summary 块：live 遥测行也有 "I: x LUFS"，开头静音的节目首行 running I=-70 会污染量测（0831 B5 实测）。 */
function parseEbur128(stderr: string): { i: number | null; tp: number | null; lra: number | null } {
  const sum = stderr.slice(stderr.lastIndexOf("Summary:"))
  const grab = (re: RegExp): number | null => {
    const m = sum.match(re)
    return m ? parseFloat(m[1]) : null
  }
  return {
    i: grab(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
    tp: grab(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
    lra: grab(/LRA:\s+(-?[\d.]+)\s+LU/),
  }
}
const num = (v: number | null): number | null => (v === null || Number.isNaN(v) ? null : v)
const negInf = (v: number | null): number | null => (v !== null && !isFinite(v) ? -100 : v)

async function measureEbur128(ffmpeg: string, file: string) {
  // 单引号包 -af 参数：filtergraph 经 shell 层时方括号/等号有被咬的实测风险（0831 B5 事故）
  const r = await run(`${ffmpeg} -hide_banner -nostats -i ${shq(file)} -af 'ebur128=peak=true' -f null - 2>&1`, 120_000)
  const e = parseEbur128(r.stderr + r.stdout)
  return { integrated_lufs: num(negInf(e.i)), true_peak_dbtp: num(negInf(e.tp)), lra: num(e.lra) }
}

async function measureRms(ffmpeg: string, file: string, startSec: number, durSec: number): Promise<number | null> {
  const r = await run(`${ffmpeg} -hide_banner -nostats -ss ${startSec.toFixed(3)} -t ${Math.max(0.05, durSec).toFixed(3)} -i ${shq(file)} -af 'astats' -f null - 2>&1`, 60_000)
  const m = (r.stderr + r.stdout).match(/RMS level dB:\s+(-?[\d.]+|-inf)/)
  if (!m) return null
  const v = parseFloat(m[1])
  return isFinite(v) ? v : -100
}

async function buildMixFlow(sessionId: string): Promise<{ report: MixReport; mixPath: string | null; workDir: string }> {
  const tl: Timeline = await getTimeline(sessionId)
  const total = totalDurationSec(tl)
  const notes: string[] = []
  const syncErrors: SyncError[] = []

  const trackById = new Map<string, AudioTrack>((tl.audioTracks ?? []).map((t) => [t.id, t]))
  const groups: Record<"voice" | "music" | "sfx", AudioClip[]> = { voice: [], music: [], sfx: [] }
  for (const c of tl.audioClips ?? []) {
    const kind = trackById.get(c.trackId)?.kind
    if (!kind) {
      syncErrors.push({ clip_id: c.id, type: "track_missing", detail: `trackId=${c.trackId} 无对应音轨` })
      continue
    }
    if (c.startSec + (c.outSec ?? c.duration) - (c.inSec ?? 0) > total + 0.05) {
      syncErrors.push({ clip_id: c.id, type: "beyond_timeline", detail: `endSec 超出时间线总长 ${total.toFixed(3)}s` })
      continue
    }
    groups[kind === "voice" ? "voice" : kind === "bgm" ? "music" : "sfx"].push(c)
  }
  // bgm 主轨（EditorBgm）视为 music 一枚 clip
  const bgmSpan = tl.bgm?.path ? bgmAudibleSpan(tl.bgm, total) : null
  const bgmEntry: AudioClip | null = tl.bgm?.path && bgmSpan
    ? { id: "bgm-virtual", trackId: "bgm-virtual", path: tl.bgm.path, label: tl.bgm.label || "bgm", startSec: bgmSpan.startSec, duration: bgmSpan.duration, inSec: bgmSpan.inSec, outSec: bgmSpan.outSec, volume: tl.bgm.volume ?? 1 }
    : null
  if (bgmEntry) groups.music.push(bgmEntry)

  const report: MixReport = {
    layers: { voice: groups.voice.length, music: groups.music.length, sfx: groups.sfx.length },
    measured: { integrated_lufs: null, true_peak_dbtp: null, lra: null },
    compliant: false,
    ducking_events: [],
    sync_errors: syncErrors,
    notes,
  }
  if (syncErrors.length) {
    notes.push("sync_errors 非空：先按 clip_id 修时间线再重跑（本规则不渲染不量测）")
    return { report, mixPath: null, workDir: "" }
  }
  if (!groups.voice.length && !groups.music.length && !groups.sfx.length) {
    notes.push("时间线无任何音频素材，无混音可量测")
    return { report, mixPath: null, workDir: "" }
  }

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) { notes.push("ffmpeg 不可用，量测中止"); return { report, mixPath: null, workDir: "" } }

  const workDir = path.join(TMP_DIR, `mix-flow-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    // 素材解析（含下载），失败进 sync_errors
    const sources = new Map<string, string>()
    let idx = 0
    let resolveFail = false
    for (const c of [...groups.voice, ...groups.music, ...groups.sfx]) {
      const ext = (c.path.split("?")[0].split(".").pop() || "wav")
      const s = await resolveSource(c.path, idx++, ext, workDir)
      if (!s) {
        syncErrors.push({ clip_id: c.id, type: "source_unreachable", detail: `素材不可达：${c.path.slice(0, 120)}` })
        resolveFail = true
        continue
      }
      sources.set(c.id, s.path)
    }
    if (resolveFail) {
      report.sync_errors = syncErrors
      notes.push("素材解析存在失败，本轮不渲染不量测")
      return { report, mixPath: null, workDir }
    }

    // 滤镜图：voice 侧链源 + bus（music+sfx），duck 后 amix
    const inputs: string[] = []
    const chains: string[] = []
    const addInput = (c: AudioClip): string => {
      const p = sources.get(c.id)!
      // 输入 link 只能用裸索引 [N:a]；label 含冒号会被 ffmpeg 当 stream specifier 解析而 matches no streams
      const inIdx = inputs.length
      inputs.push(`-i ${shq(p)}`)
      const lb = `c${inIdx}`
      chains.push(`[${inIdx}:a]${clipFilter(c)}[${lb}f]`)
      return `${lb}f`
    }
  const amixChain = (labels: string[], out: string): string =>
    labels.length === 1 ? `[${labels[0]}]anull[${out}]` : `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled[${out}]`

    const voiceLabels = groups.voice.map(addInput)
    const busLabels = [...groups.music, ...groups.sfx].map(addInput)
    const total3 = total.toFixed(3)
    const tail = `atrim=0:${total3},asetpts=PTS-STARTPTS[mix]`
    // 输入链段（[N:a]atrim...[cNf]）是 filtergraph 的上游，必须先行拼接
    let fc = chains.length ? chains.join(";") + ";" : ""
    if (voiceLabels.length) fc += amixChain(voiceLabels, "voiceMix") + ";"
    if (busLabels.length) fc += amixChain(busLabels, "bus") + ";"
    let maps = ""
    if (voiceLabels.length && busLabels.length) {
      // label 单次消费：voiceMix/ducked 各 asplit 一份单独输出（sidechain 侧链一份、终混一份）
      // 第二输出档 = ducked bus（纯压缩 BGM/SFX），duck 深度量测必须量它；量未压缩 bus 恒为 0dB（0831 B5 实测坑）
      fc += `[voiceMix]asplit=2[voiceSc][voiceFin];[bus][voiceSc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[ducked];[ducked]asplit=2[duckMix][duckOnly];[duckMix][voiceFin]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled[mixfull];[mixfull]${tail}`
      maps = `-map "[mix]"`
    } else if (voiceLabels.length) {
      fc += `[voiceMix]${tail}`
      maps = `-map "[mix]"`
      notes.push("仅人声轨：无 BGM/SFX 可压，ducking_events 为空")
    } else {
      fc += `[bus]${tail}`
      maps = `-map "[mix]"`
    }
    const mixRaw = path.join(workDir, "mix_raw.wav")
    const duckOnly = path.join(workDir, "duck_bus.wav")
    const needBusOnly = Boolean(voiceLabels.length && busLabels.length)
    // filtergraph 落档传递（-filter_complex_script）：0831 实测 fc 字串经 shell 层会被
    // 切断（`[busMain]` 咬成 `[busMai`+`n]`→matches no streams），script 档零引用风险
    const fcFile = path.join(workDir, "filtergraph.txt")
    await writeFile(fcFile, fc)
    // -map 只作用于紧随其后的输出档：两输出必须各带各的 -map，并排写会把两条流全塞进第一个 wav（wav muxer 拒多音轨）
    const cmd = `${ffmpeg} -y -hide_banner -loglevel error ${inputs.join(" ")} -filter_complex_script ${shq(fcFile)} ${maps} ${shq(mixRaw)}${needBusOnly ? ` -map "[duckOnly]" ${shq(duckOnly)}` : ""}`
    const r = await run(cmd, 300_000)
    if (r.exit_code !== 0) {
      notes.push(`混音渲染失败：${(r.stderr || "unknown").slice(-600)}`)
      return { report, mixPath: null, workDir }
    }

    // ducking_events：量 ducked bus（纯压缩 BGM/SFX，无人声污染）对比人声窗口内外 RMS。
    // 基准窗必须落在无人声区间——相邻人声时 start-1 会踩进上一段的鸭子区，基准=压缩态→深度恒 0（0831 B5 实测）
    if (needBusOnly) {
      const voiced = groups.voice.map((c) => ({ s: c.startSec, e: Math.min(c.startSec + ((c.outSec ?? c.duration) - (c.inSec ?? 0)), total) }))
      const overlapsVoice = (s: number, d: number) => voiced.some((v) => s < v.e - 1e-3 && s + d > v.s + 1e-3)
      for (const c of groups.voice) {
        const start = c.startSec
        const end = Math.min(start + ((c.outSec ?? c.duration) - (c.inSec ?? 0)), total)
        let baseStart = -1
        for (let k = 0; k <= Math.ceil(start / 0.25); k++) {
          const bs = Math.round((Math.max(0, start - 1) - k * 0.25) * 1000) / 1000
          if (bs < 0 || bs + 1 > total) break
          if (!overlapsVoice(bs, 1)) { baseStart = bs; break }
        }
        if (baseStart < 0) {
          for (let bs = Math.round((end + 0.25) * 1000) / 1000; bs + 1 <= total; bs = Math.round((bs + 0.25) * 1000) / 1000) {
            if (!overlapsVoice(bs, 1)) { baseStart = bs; break }
          }
        }
        if (baseStart < 0) {
          report.ducking_events.push({ at_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000), depth_db: null, track: "voice" })
          continue
        }
        const inside = await measureRms(ffmpeg, duckOnly, start, end - start)
        const outside = await measureRms(ffmpeg, duckOnly, baseStart, 1)
        const depth = inside !== null && outside !== null ? r3(outside - inside) : null
        report.ducking_events.push({ at_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000), depth_db: depth, track: "voice" })
      }
    }

    // 响度实测（raw 混合）
    report.measured = await measureEbur128(ffmpeg, mixRaw)
    report.compliant = report.measured.integrated_lufs !== null
      && report.measured.true_peak_dbtp !== null
      && Math.abs(report.measured.integrated_lufs + 16) <= 1.5
      && report.measured.true_peak_dbtp <= -1.0
    if (!report.compliant) notes.push("raw 混合未达 -16 LUFS/TP -1.0 门（applyMix 将 loudnorm 两遍法矫正后复量）")
    return { report, mixPath: mixRaw, workDir }
  } catch (e) {
    notes.push(`混音流程异常：${(e as Error).message}`)
    return { report, mixPath: null, workDir }
  }
}

/** GET /agent/v1/timeline/mix：只量测不落盘。 */
export async function analyzeMix(sessionId: string): Promise<MixReport> {
  const { report, mixPath, workDir } = await buildMixFlow(sessionId)
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  return report
}

/** POST /agent/v1/timeline/mix：loudnorm 两遍法渲染落盘 mix.wav。 */
export async function applyMix(sessionId: string): Promise<{ report: MixReport; outPath: string | null; publicUrl: string | null }> {
  const { report, mixPath, workDir } = await buildMixFlow(sessionId)
  try {
    return await renderMix(sessionId, report, mixPath)
  } finally {
    // 工作目录包括本轮下载，覆盖成功、提前返回和异常出口。
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function renderMix(sessionId: string, report: MixReport, mixPath: string | null): Promise<{ report: MixReport; outPath: string | null; publicUrl: string | null }> {
  if (report.sync_errors.length) {
    throw new TimelineValidationError(`sync_errors 非空（${report.sync_errors.length} 条），先修时间线再混音：` + JSON.stringify(report.sync_errors))
  }
  if (!mixPath) {
    return { report, outPath: null, publicUrl: null }
  }
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { report, outPath: null, publicUrl: null }
  // loudnorm 两遍：pass1 量 → pass2 注入（composeEngine 内建同款目标 I=-16/TP=-1.5/LRA=11）
  const p1 = await run(`${ffmpeg} -hide_banner -nostats -i ${shq(mixPath)} -af 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json' -f null - 2>&1`, 180_000)
  const jm = (p1.stderr + p1.stdout).match(/\{[^{}]*"input_i"[^{}]*\}/)
  if (!jm) {
    report.notes.push("loudnorm pass1 量测解析失败，保留 raw 混合")
    const outDir = path.join(WORKSPACE_DIR, "timelines", sessionId)
    await mkdir(outDir, { recursive: true })
    const dst = path.join(outDir, "mix.wav")
    await run(`${ffmpeg} -y -hide_banner -loglevel error -i ${shq(mixPath)} -c:a pcm_s16le ${shq(dst)}`, 120_000)
    return { report, outPath: (await fileExists(dst)) ? dst : null, publicUrl: null }
  }
  const m = JSON.parse(jm[0])
  const outDir = path.join(WORKSPACE_DIR, "timelines", sessionId)
  await mkdir(outDir, { recursive: true })
  const dst = path.join(outDir, "mix.wav")
  const lnArgs = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:linear=true`
  const p2 = await run(`${ffmpeg} -y -hide_banner -loglevel error -i ${shq(mixPath)} -af 'loudnorm=I=-16:TP=-1.5:LRA=11:${lnArgs}' -ar 48000 -c:a pcm_s16le ${shq(dst)}`, 180_000)
  if (p2.exit_code !== 0) {
    report.notes.push(`loudnorm pass2 失败：${(p2.stderr || "").slice(-200)}`)
    return { report, outPath: null, publicUrl: null }
  }
  const after = await measureEbur128(ffmpeg, dst)
  report.measured = after
  report.compliant = after.integrated_lufs !== null && after.true_peak_dbtp !== null
    && Math.abs(after.integrated_lufs + 16) <= 1.5 && after.true_peak_dbtp <= -1.0
  report.notes.push("loudnorm 两遍法完成（I=-16/TP=-1.5 目标），publicUrl 暂不挂公网路由（本片决策：返回本地路径）")
  return { report, outPath: dst, publicUrl: null }
}
