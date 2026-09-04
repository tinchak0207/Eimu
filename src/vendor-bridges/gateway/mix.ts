// B5（2026-08-31）混音後置 pass — REQ-EDIT-06 三軌（voice/music/sfx）+ ducking + 響度量測。
// 口徑權威 = editor/composeEngine L1125（atrim/asetpts/volume/afade/adelay），本檔不改輪子一字節。
// ducking 配方 orchestrator 實測：sidechaincompress threshold=0.05 ratio=8 attack=20 release=300（duck 深度 20.5dB）。
// 量測順序鐵律：先 duck 出純壓縮 bus、再與人聲 amix——量 BGM 時人聲能量會掩蓋 duck 深度。
import { mkdir, access, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, totalDurationSec, TimelineValidationError, type Timeline, type AudioClip, type AudioTrack } from "./timeline"
import { detectFfmpeg } from "./editor/canvas/videoCompose"
import { invoke } from "./editor/adapter/tauri-adapter"

interface CommandResult { stdout: string; stderr: string; exit_code: number }

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
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

/** 素材解析：本地檔直用；http(s) 下載到 tmp。返回 {path, downloaded} 或 null（不可達）。B6 master 導出複用。 */
export async function resolveSource(src: string, idx: number, ext: string): Promise<{ path: string } | null> {
  if (/^https?:\/\//.test(src)) {
    await mkdir(TMP_DIR, { recursive: true })
    const dst = path.join(TMP_DIR, `mix-${Date.now()}-${idx}.${ext.replace(/[^a-z0-9]/gi, "") || "wav"}`)
    const r = await run(`curl -fsSL --max-time 60 -o ${shq(dst)} ${shq(src)}`, 90_000)
    if (r.exit_code !== 0) return null
    return { path: dst }
  }
  return (await fileExists(src)) ? { path: src } : null
}

/** 單 clip 音頻圖（時間線座標）：atrim→asetpts→volume→afade→adelay（composeEngine L1125 口徑）。 */
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

/** ebur128 summary 解析（peak=true 時 Peak 行即 true peak，單位 dBTP 口徑）。
 *  只解析 Summary 塊：live 遙測行也有 "I: x LUFS"，開頭靜音的節目首行 running I=-70 會污染量測（0831 B5 實測）。 */
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
  // 單引號包 -af 參數：filtergraph 經 shell 層時方括號/等號有被咬的實測風險（0831 B5 事故）
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
      syncErrors.push({ clip_id: c.id, type: "track_missing", detail: `trackId=${c.trackId} 無對應音軌` })
      continue
    }
    if (c.startSec + (c.outSec ?? c.duration) - (c.inSec ?? 0) > total + 0.05) {
      syncErrors.push({ clip_id: c.id, type: "beyond_timeline", detail: `endSec 超出時間線總長 ${total.toFixed(3)}s` })
      continue
    }
    groups[kind === "voice" ? "voice" : kind === "bgm" ? "music" : "sfx"].push(c)
  }
  // bgm 主軌（EditorBgm）視為 music 一枚 clip
  const bgmEntry: AudioClip | null = tl.bgm?.path
    ? { id: "bgm-virtual", trackId: "bgm-virtual", path: tl.bgm.path, label: tl.bgm.label || "bgm", startSec: 0, duration: total, inSec: 0, outSec: total, volume: tl.bgm.volume ?? 1 }
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
    notes.push("sync_errors 非空：先按 clip_id 修時間線再重跑（本規則不渲染不量測）")
    return { report, mixPath: null, workDir: "" }
  }
  if (!groups.voice.length && !groups.music.length && !groups.sfx.length) {
    notes.push("時間線無任何音頻素材，無混音可量測")
    return { report, mixPath: null, workDir: "" }
  }

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) { notes.push("ffmpeg 不可用，量測中止"); return { report, mixPath: null, workDir: "" } }

  const workDir = path.join(TMP_DIR, `mix-flow-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    // 素材解析（含下載），失敗進 sync_errors
    const sources = new Map<string, string>()
    let idx = 0
    let resolveFail = false
    for (const c of [...groups.voice, ...groups.music, ...groups.sfx]) {
      const ext = (c.path.split("?")[0].split(".").pop() || "wav")
      const s = await resolveSource(c.path, idx++, ext)
      if (!s) {
        syncErrors.push({ clip_id: c.id, type: "source_unreachable", detail: `素材不可達：${c.path.slice(0, 120)}` })
        resolveFail = true
        continue
      }
      sources.set(c.id, s.path)
    }
    if (resolveFail) {
      report.sync_errors = syncErrors
      notes.push("素材解析存在失敗，本輪不渲染不量測")
      return { report, mixPath: null, workDir }
    }

    // 濾鏡圖：voice 側鏈源 + bus（music+sfx），duck 後 amix
    const inputs: string[] = []
    const chains: string[] = []
    const addInput = (c: AudioClip): string => {
      const p = sources.get(c.id)!
      // 輸入 link 只能用裸索引 [N:a]；label 含冒號會被 ffmpeg 當 stream specifier 解析而 matches no streams
      const inIdx = inputs.length
      inputs.push(`-i ${shq(p)}`)
      const lb = `c${inIdx}`
      chains.push(`[${inIdx}:a]${clipFilter(c)}[${lb}f]`)
      return `${lb}f`
    }
  const amixChain = (labels: string[], out: string): string =>
    labels.length === 1 ? `[${labels[0]}]anull[${out}]` : `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[${out}]`

    const voiceLabels = groups.voice.map(addInput)
    const busLabels = [...groups.music, ...groups.sfx].map(addInput)
    const total3 = total.toFixed(3)
    const tail = `atrim=0:${total3},asetpts=PTS-STARTPTS[mix]`
    // 輸入鏈段（[N:a]atrim...[cNf]）是 filtergraph 的上游，必須先行拼接
    let fc = chains.length ? chains.join(";") + ";" : ""
    if (voiceLabels.length) fc += amixChain(voiceLabels, "voiceMix") + ";"
    if (busLabels.length) fc += amixChain(busLabels, "bus") + ";"
    let maps = ""
    if (voiceLabels.length && busLabels.length) {
      // label 單次消費：voiceMix/ducked 各 asplit 一份單獨輸出（sidechain 側鏈一份、終混一份）
      // 第二輸出檔 = ducked bus（純壓縮 BGM/SFX），duck 深度量測必須量它；量未壓縮 bus 恆為 0dB（0831 B5 實測坑）
      fc += `[voiceMix]asplit=2[voiceSc][voiceFin];[bus][voiceSc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[ducked];[ducked]asplit=2[duckMix][duckOnly];[duckMix][voiceFin]amix=inputs=2:duration=longest:normalize=0[mixfull];[mixfull]${tail}`
      maps = `-map "[mix]"`
    } else if (voiceLabels.length) {
      fc += `[voiceMix]${tail}`
      maps = `-map "[mix]"`
      notes.push("僅人聲軌：無 BGM/SFX 可壓，ducking_events 為空")
    } else {
      fc += `[bus]${tail}`
      maps = `-map "[mix]"`
    }
    const mixRaw = path.join(workDir, "mix_raw.wav")
    const duckOnly = path.join(workDir, "duck_bus.wav")
    const needBusOnly = Boolean(voiceLabels.length && busLabels.length)
    // filtergraph 落檔傳遞（-filter_complex_script）：0831 實測 fc 字串經 shell 層會被
    // 切斷（`[busMain]` 咬成 `[busMai`+`n]`→matches no streams），script 檔零引用風險
    const fcFile = path.join(workDir, "filtergraph.txt")
    await writeFile(fcFile, fc)
    // -map 只作用於緊隨其後的輸出檔：兩輸出必須各帶各的 -map，併排寫會把兩條流全塞進第一個 wav（wav muxer 拒多音軌）
    const cmd = `${ffmpeg} -y -hide_banner -loglevel error ${inputs.join(" ")} -filter_complex_script ${shq(fcFile)} ${maps} ${shq(mixRaw)}${needBusOnly ? ` -map "[duckOnly]" ${shq(duckOnly)}` : ""}`
    const r = await run(cmd, 300_000)
    if (r.exit_code !== 0) {
      notes.push(`混音渲染失敗：${(r.stderr || "unknown").slice(-600)}`)
      return { report, mixPath: null, workDir }
    }

    // ducking_events：量 ducked bus（純壓縮 BGM/SFX，無人聲污染）對比人聲窗口內外 RMS。
    // 基準窗必須落在無人聲區間——相鄰人聲時 start-1 會踩進上一段的鴨子區，基準=壓縮態→深度恆 0（0831 B5 實測）
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

    // 響度實測（raw 混合）
    report.measured = await measureEbur128(ffmpeg, mixRaw)
    report.compliant = report.measured.integrated_lufs !== null
      && report.measured.true_peak_dbtp !== null
      && Math.abs(report.measured.integrated_lufs + 16) <= 1.5
      && report.measured.true_peak_dbtp <= -1.0
    if (!report.compliant) notes.push("raw 混合未達 -16 LUFS/TP -1.0 門（applyMix 將 loudnorm 兩遍法矯正後複量）")
    return { report, mixPath: mixRaw, workDir }
  } catch (e) {
    notes.push(`混音流程異常：${(e as Error).message}`)
    return { report, mixPath: null, workDir }
  }
}

/** GET /agent/v1/timeline/mix：只量測不落盤。 */
export async function analyzeMix(sessionId: string): Promise<MixReport> {
  const { report, mixPath, workDir } = await buildMixFlow(sessionId)
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  return report
}

/** POST /agent/v1/timeline/mix：loudnorm 兩遍法渲染落盤 mix.wav。 */
export async function applyMix(sessionId: string): Promise<{ report: MixReport; outPath: string | null; publicUrl: string | null }> {
  const { report, mixPath, workDir } = await buildMixFlow(sessionId)
  if (report.sync_errors.length) {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    throw new TimelineValidationError(`sync_errors 非空（${report.sync_errors.length} 條），先修時間線再混音：` + JSON.stringify(report.sync_errors))
  }
  if (!mixPath) {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return { report, outPath: null, publicUrl: null }
  }
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { report, outPath: null, publicUrl: null }
  // loudnorm 兩遍：pass1 量 → pass2 注入（composeEngine 內建同款目標 I=-16/TP=-1.5/LRA=11）
  const p1 = await run(`${ffmpeg} -hide_banner -nostats -i ${shq(mixPath)} -af 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json' -f null - 2>&1`, 180_000)
  const jm = (p1.stderr + p1.stdout).match(/\{[^{}]*"input_i"[^{}]*\}/)
  if (!jm) {
    report.notes.push("loudnorm pass1 量測解析失敗，保留 raw 混合")
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
    report.notes.push(`loudnorm pass2 失敗：${(p2.stderr || "").slice(-200)}`)
    return { report, outPath: null, publicUrl: null }
  }
  const after = await measureEbur128(ffmpeg, dst)
  report.measured = after
  report.compliant = after.integrated_lufs !== null && after.true_peak_dbtp !== null
    && Math.abs(after.integrated_lufs + 16) <= 1.5 && after.true_peak_dbtp <= -1.0
  report.notes.push("loudnorm 兩遍法完成（I=-16/TP=-1.5 目標），publicUrl 暫不掛公網路由（本片決策：返回本地路徑）")
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  return { report, outPath: dst, publicUrl: null }
}
