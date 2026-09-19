/**
 * lint.ts — 剪輯診斷器信號層（施工片 B4，2026-08-31，REQ-EDIT-03 可復現子集）。
 *
 * 需求源：《Eimu 剪輯體驗 PRD v1.0》REQ-EDIT-03（電影語言 linter）。本檔只做信號層：
 * 全部檢測對 clip 的 trim 窗口 [inSec,outSec] 跑 ffmpeg 濾鏡（-ss/-t 精確 seek），
 * 結果座標為**時間線系**（timeline 偏移 = 前序 clip 有效時長累加，口徑同 B1 clipLength）。
 * 語義層（越軸/動作連續性/光不一致/角色臉一致性/口型同步）當前行業無可復現檢測
 * → 誠實寫進 skipped，不謊報（暴君已批准妥協）。
 *
 * 契約輸入：./timeline getTimeline（B1 生命週期層）；ffmpeg 真源 detectFfmpeg
 * （./editor/canvas/videoCompose，候選表第一位 ~/.kunpeng/bin/ffmpeg，7.0.2 靜態）。
 * 素材 path 為 http(s) URL 時先下載到 $WORKSPACE_DIR/tmp（同款於 B3 rhythm.ts
 * resolveBgmLocal 的下載邏輯，白名單複製，不改 rhythm.ts 本體）。
 *
 * 閾值口徑（全部可復現，構造樣本實錘見 PRD 驗收）：
 * - black_frame:  blackdetect=d=0.1:pix_th=0.10
 * - white_flash:  signalstats YAVG>240 連續 ≥3 幀（limited-range 內容最高 Y=235，
 *                 240 只抓真·過曝/全白，零誤報口徑）
 * - audio_clip:   astats Peak level dB > -0.5（削頂風險）
 * - av_mismatch:  clip outSec > ffprobe 實測源時長 + 0.1s（尾段會黑/凍）
 * - no_audio_track: 源無音軌且非顯式靜音設計（volume!==0）且時間線無覆蓋配音/BGM
 * - silence_gap:  silencedetect=n=-40dB:d=1.5（比 vendor transcriptOps.detectAudioSilences
 *                 的 noise=-35dB:d=0.8 更嚴，避免把正常句間停頓誤報；解析同款
 *                 silence_start/silence_end，並補 vendor 未處理的「尾部靜音無 silence_end」）
 * - volume_jump:  相鄰（均有音軌）clip astats RMS 差 > 12dB → 標後者起點
 * - freeze:       freezedetect=n=-60dB:d=2
 *
 * 性能：clip 級並發 ≤3（VPS 2 核，勿打滿）；單 clip 檢測超時 60s → issue
 * type=lint_timeout severity=should，不炸全場。視頻三濾鏡（blackdetect/freezedetect/
 * signalstats+metadata=print）鏈式合併為單次解碼；音頻兩濾鏡（astats/silencedetect）
 * 合併為單次解碼，降低重複 CPU。
 */
import { spawn } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, clipLength, type Timeline, type TimelineClip } from "./timeline"
import { detectFfmpeg } from "./editor/canvas/videoCompose"

// 與 timeline.ts L28 / index.ts L446 同值；env 可覆蓋（測試用）。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"

// ── 檢測常數（PRD REQ-EDIT-03 信號層，全部可復現） ────────────────────────────
const CONCURRENCY = 3            // clip 級並發上限（VPS 2 核）
const CLIP_TIMEOUT_MS = 60_000   // 單 clip 檢測超時
const AV_EPSILON_SEC = 0.1       // av_mismatch 容差（幀量化/容器取整）
const BLACK_D = 0.1
const BLACK_PIX_TH = 0.1
const WHITE_YAVG_TH = 240
const WHITE_MIN_FRAMES = 3
const PEAK_CLIP_DB = -0.5
const SILENCE_NOISE_DB = -40
const SILENCE_MIN_DUR = 1.5
const RMS_JUMP_DB = 12
const FREEZE_D = 2

// ── 契約型別 ─────────────────────────────────────────────────────────────────

export type LintIssueType =
  | "black_frame"
  | "white_flash"
  | "audio_clip"
  | "av_mismatch"
  | "no_audio_track"
  | "silence_gap"
  | "volume_jump"
  | "freeze"
  | "lint_timeout"

export interface LintIssue {
  /** 時間線座標（毫秒，非源素材座標） */
  t_start_ms: number
  t_end_ms: number
  clip_id: string
  type: LintIssueType
  severity: "must" | "should"
  evidence: string
  fix_hint: string
}

export interface LintResult {
  session_id: string
  issues: LintIssue[]
  /** 布爾：must 級為零即 true */
  passed: boolean
  /** 誠實跳過清單：語義層五項（當前行業無可復現檢測）+ 逐 clip 降級說明 */
  skipped: string[]
}

/** 語義層妥協清單（PRD 暴君已批准）：固定寫進每次結果，不謊報 */
const SEMANTIC_SKIPS: string[] = [
  "cross_axis 越軸：語義層，當前行業無可復現檢測，誠實跳過",
  "action_continuity 動作連續性：語義層，當前行業無可復現檢測，誠實跳過",
  "lighting_consistency 光不一致：語義層，當前行業無可復現檢測，誠實跳過",
  "face_consistency 角色臉一致性：語義層，當前行業無可復現檢測，誠實跳過",
  "lip_sync 口型同步：語義層，當前行業無可復現檢測，誠實跳過",
]

// ── 內部工具 ─────────────────────────────────────────────────────────────────

interface Placed {
  clip: TimelineClip
  /** 時間軸起點/終點（主軌順序累加，秒） */
  start: number
  end: number
  /** 有效時長 = clipLength */
  len: number
  speed: number
}

function placeClips(tl: Timeline): Placed[] {
  let t = 0
  return tl.clips.map((clip) => {
    const len = clipLength(clip)
    const p: Placed = { clip, start: t, end: t + len, len, speed: clip.speed && clip.speed > 0 ? clip.speed : 1 }
    t += len
    return p
  })
}

const ms = (sec: number): number => Math.round(sec * 1000)

/** 源窗口內秒（-ss 後輸出時間軸，0=窗口起點）→ 時間線秒 */
function toTimelineSec(p: Placed, windowSec: number): number {
  return p.start + windowSec / p.speed
}

interface FFRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** spawn 執行 ffmpeg/ffprobe（args 數組，無 shell 引號問題），超時 SIGKILL */
function runFF(bin: string, args: string[], timeoutMs: number): Promise<FFRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const to = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch { /* noop */ }
    }, Math.max(1000, timeoutMs))
    child.stdout?.on("data", (d) => { if (stdout.length < 4_000_000) stdout += String(d) })
    child.stderr?.on("data", (d) => { if (stderr.length < 2_000_000) stderr += String(d) })
    child.on("error", (e) => {
      clearTimeout(to)
      resolve({ code: -1, stdout, stderr: (e instanceof Error ? e.message : String(e)) + "\n" + stderr, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(to)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** 素材解析：本地路徑直用；http(s) URL 下載到 $WORKSPACE_DIR/tmp（同款 B3 rhythm.ts 口徑） */
async function resolveLocal(src: string): Promise<string> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`素材下載失敗 HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 100 * 1024 * 1024) throw new Error("素材下載超過 100MB 上限")
    const ext = (path.extname(new URL(src).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "")
    const dir = path.join(WORKSPACE_DIR, "tmp")
    await mkdir(dir, { recursive: true })
    const local = path.join(dir, `lint-clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    await writeFile(local, new Uint8Array(buf))
    return local
  }
  await access(src)
  return src
}

interface Probe {
  duration: number
  hasAudio: boolean
}

async function probeMedia(ffprobe: string, file: string): Promise<Probe | null> {
  const r = await runFF(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], 15_000)
  if (r.code !== 0) return null
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
    const duration = Number(j?.format?.duration)
    if (!isFinite(duration) || duration <= 0) return null
    const hasAudio = Array.isArray(j?.streams) && j.streams.some((s) => s?.codec_type === "audio")
    return { duration, hasAudio }
  } catch {
    return null
  }
}

/** 從 astats 輸出提取所有 Peak/RMS dB（多聲道取最大；"-inf" 過濾） */
function parseAstats(stderr: string): { peak: number | null; rms: number | null } {
  const nums = (label: string): number[] => {
    const out: number[] = []
    const re = new RegExp(`${label}:\\s*(-?[\\d.]+|inf|-inf)`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(stderr))) {
      const v = Number(m[1])
      if (isFinite(v)) out.push(v)
    }
    return out
  }
  const peaks = nums("Peak level dB")
  const rmss = nums("RMS level dB")
  return {
    peak: peaks.length ? Math.max(...peaks) : null,
    rms: rmss.length ? Math.max(...rmss) : null,
  }
}

/** 配對解析 start/end 事件（blackdetect/freezedetect/silencedetect 共用；尾部無 end 補 endFallback） */
function parseSpans(stderr: string, startLabel: string, endLabel: string, endFallback: number): Array<[number, number]> {
  const starts = [...stderr.matchAll(new RegExp(`${startLabel}:\\s*([\\d.]+)`, "g"))].map((m) => Number(m[1]))
  const ends = [...stderr.matchAll(new RegExp(`${endLabel}:\\s*([\\d.]+)`, "g"))].map((m) => Number(m[1]))
  const spans: Array<[number, number]> = []
  for (let i = 0; i < starts.length; i++) {
    const e = i < ends.length && ends[i] >= starts[i] ? ends[i] : endFallback
    spans.push([starts[i], Math.max(e, starts[i])])
  }
  return spans
}

/** metadata=print 輸出解析：逐幀 (pts_time, YAVG)，YAVG>240 連續 ≥3 幀 → 區間 */
function parseWhiteFlash(stdout: string): Array<[number, number, number]> {
  const frames: Array<{ t: number; y: number }> = []
  let curT: number | null = null
  for (const line of stdout.split("\n")) {
    const pt = /pts_time:([\d.]+)/.exec(line)
    if (pt) { curT = Number(pt[1]); continue }
    const yv = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line)
    if (yv && curT !== null) { frames.push({ t: curT, y: Number(yv[1]) }); curT = null }
  }
  const hits: Array<[number, number, number]> = []
  let runStart = -1
  for (let i = 0; i <= frames.length; i++) {
    const over = i < frames.length && frames[i].y > WHITE_YAVG_TH
    if (over && runStart < 0) runStart = i
    if (!over && runStart >= 0) {
      const runLen = i - runStart
      if (runLen >= WHITE_MIN_FRAMES) {
        const t0 = frames[runStart].t
        const tLast = frames[i - 1].t
        const frameDur = runLen > 1 ? (tLast - t0) / (runLen - 1) : (frames.length > 1 ? frames[1].t - frames[0].t : 0.04)
        hits.push([t0, tLast + Math.max(frameDur, 0.001), runLen])
      }
      runStart = -1
    }
  }
  return hits
}

// ── 單 clip 檢測 ─────────────────────────────────────────────────────────────

interface ClipOutcome {
  placed: Placed
  issues: LintIssue[]
  /** astats RMS dB；null=無音軌/未測（volume_jump 用） */
  rms: number | null
  notes: string[]
}

async function lintOneClip(
  ffmpeg: string,
  ffprobe: string,
  p: Placed,
  audioCovered: boolean,
): Promise<ClipOutcome> {
  const issues: LintIssue[] = []
  const notes: string[] = []
  const c = p.clip
  const deadline = Date.now() + CLIP_TIMEOUT_MS
  const budget = (): number => deadline - Date.now()

  const timeoutIssue = (pass: string): ClipOutcome => {
    issues.push({
      t_start_ms: ms(p.start),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "lint_timeout",
      severity: "should",
      evidence: `單 clip 檢測超時 ${CLIP_TIMEOUT_MS / 1000}s（${pass}），該 clip 其餘信號未驗`,
      fix_hint: "素材過長或解碼過慢：縮短 trim 窗口、降低解析度或重試",
    })
    return { placed: p, issues, rms: null, notes }
  }

  // 停用片段：導出不顯示原畫面，信號層不驗（佔位誠實記錄）
  if (c.disabled) {
    notes.push(`clip ${c.id}: disabled（導出不顯示原畫面），信號檢測跳過`)
    return { placed: p, issues: [], rms: null, notes }
  }

  let local: string
  try {
    local = await resolveLocal(c.path)
  } catch (e) {
    issues.push({
      t_start_ms: ms(p.start),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "lint_timeout",
      severity: "should",
      evidence: `素材不可達：${e instanceof Error ? e.message : String(e)}`,
      fix_hint: "檢查 clip.path（本地路徑或 http URL）是否有效",
    })
    return { placed: p, issues, rms: null, notes }
  }

  const probe = await probeMedia(ffprobe, local)
  if (!probe) {
    issues.push({
      t_start_ms: ms(p.start),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "lint_timeout",
      severity: "should",
      evidence: "ffprobe 探測失敗（不可解碼？）",
      fix_hint: "素材可能損壞或格式不支持，先本地 ffprobe 複核",
    })
    return { placed: p, issues, rms: null, notes }
  }

  const winDur = Math.max(0.001, c.outSec - c.inSec)
  const seekArgs = ["-hide_banner", "-ss", String(c.inSec), "-t", String(winDur)]

  // ── must 4: av_mismatch（outSec 超過源實測時長） ──
  if (c.outSec > probe.duration + AV_EPSILON_SEC) {
    const tailStart = Math.max(0, Math.min(winDur, probe.duration - c.inSec))
    issues.push({
      t_start_ms: ms(toTimelineSec(p, tailStart)),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "av_mismatch",
      severity: "must",
      evidence: `clip outSec=${c.outSec}s 超過源實測時長 ${probe.duration.toFixed(3)}s（宣告 duration=${c.duration}s），尾段 ${(c.outSec - probe.duration).toFixed(2)}s 導出將黑幀/凍幀`,
      fix_hint: `trim outSec 至 ${Math.floor(probe.duration * 10) / 10}s 以內，或換更長素材`,
    })
  }

  // ── must 5: no_audio_track（源無音軌且非顯式靜音設計） ──
  if (!probe.hasAudio) {
    if (c.volume === 0) {
      notes.push(`clip ${c.id}: 源無音軌但 volume=0（顯式靜音設計），no_audio_track 跳過`)
    } else if (audioCovered) {
      notes.push(`clip ${c.id}: 源無音軌但時間線有配音/BGM 覆蓋，no_audio_track 跳過`)
    } else {
      issues.push({
        t_start_ms: ms(p.start),
        t_end_ms: ms(p.end),
        clip_id: c.id,
        type: "no_audio_track",
        severity: "must",
        evidence: "源無音軌，且該區間無配音 clip/BGM 覆蓋（成片此段無聲硬傷）",
        fix_hint: "補配音或 BGM 覆蓋該區間；若刻意靜音設 clip.volume=0",
      })
    }
  }

  // ── 視頻信號單次解碼：blackdetect + freezedetect + signalstats/metadata ──
  const vPass = await runFF(
    ffmpeg,
    [
      ...seekArgs, "-i", local,
      "-vf", `blackdetect=d=${BLACK_D}:pix_th=${BLACK_PIX_TH},freezedetect=n=-60dB:d=${FREEZE_D},signalstats,metadata=print:file=-`,
      "-an", "-f", "null", "-",
    ],
    budget(),
  )
  if (vPass.timedOut) return timeoutIssue("視頻濾鏡鏈 blackdetect/freezedetect/signalstats")
  if (vPass.code !== 0) {
    notes.push(`clip ${c.id}: 視頻檢測 pass 失敗（exit ${vPass.code}）：${vPass.stderr.slice(-200)}`)
  } else {
    // must 1: black_frame
    for (const [a, b] of parseSpans(vPass.stderr, "black_start", "black_end", winDur)) {
      issues.push({
        t_start_ms: ms(toTimelineSec(p, a)),
        t_end_ms: ms(toTimelineSec(p, b)),
        clip_id: c.id,
        type: "black_frame",
        severity: "must",
        evidence: `blackdetect(d=${BLACK_D},pix_th=${BLACK_PIX_TH}) 命中源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s`,
        fix_hint: "剪掉黑幀段（trim）或替換素材",
      })
    }
    // should 8: freeze
    for (const [a, b] of parseSpans(vPass.stderr, "freeze_start", "freeze_end", winDur)) {
      issues.push({
        t_start_ms: ms(toTimelineSec(p, a)),
        t_end_ms: ms(toTimelineSec(p, b)),
        clip_id: c.id,
        type: "freeze",
        severity: "should",
        evidence: `freezedetect(n=-60dB,d=${FREEZE_D}) 命中源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s（凍幀）`,
        fix_hint: "剪掉凍幀段；若刻意定格效果可忽略",
      })
    }
    // must 2: white_flash
    for (const [a, b, n] of parseWhiteFlash(vPass.stdout)) {
      issues.push({
        t_start_ms: ms(toTimelineSec(p, a)),
        t_end_ms: ms(toTimelineSec(p, b)),
        clip_id: c.id,
        type: "white_flash",
        severity: "must",
        evidence: `signalstats YAVG>${WHITE_YAVG_TH} 連續 ${n} 幀（源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s）`,
        fix_hint: "閃白硬傷：縮短白幀段或加淡入淡出過渡",
      })
    }
  }

  // ── 音頻信號單次解碼：astats + silencedetect ──
  let rms: number | null = null
  if (!probe.hasAudio) {
    notes.push(`clip ${c.id}: 源無音軌，astats/silencedetect 跳過`)
    return { placed: p, issues, rms: null, notes }
  }
  if (c.volume === 0) {
    notes.push(`clip ${c.id}: volume=0（顯式靜音），音頻信號檢測跳過`)
    return { placed: p, issues, rms: null, notes }
  }
  const aPass = await runFF(
    ffmpeg,
    [
      ...seekArgs, "-i", local,
      "-af", `astats, silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DUR}`,
      "-vn", "-sn", "-f", "null", "-",
    ],
    budget(),
  )
  if (aPass.timedOut) return timeoutIssue("音頻濾鏡鏈 astats/silencedetect")
  if (aPass.code !== 0) {
    notes.push(`clip ${c.id}: 音頻檢測 pass 失敗（exit ${aPass.code}）：${aPass.stderr.slice(-200)}`)
    return { placed: p, issues, rms: null, notes }
  }
  const { peak, rms: rmsMeasured } = parseAstats(aPass.stderr)
  rms = rmsMeasured
  // must 3: audio_clip（爆音/削頂風險）
  if (peak !== null && peak > PEAK_CLIP_DB) {
    issues.push({
      t_start_ms: ms(p.start),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "audio_clip",
      severity: "must",
      evidence: `astats Peak level dB=${peak.toFixed(2)} > ${PEAK_CLIP_DB}（削頂風險）`,
      fix_hint: "降低該 clip 音量（volume 濾鏡）或加限幅（alimiter），重新導出音頻",
    })
  }
  // should 6: silence_gap
  for (const [a, b] of parseSpans(aPass.stderr, "silence_start", "silence_end", winDur)) {
    if (b - a < SILENCE_MIN_DUR - 0.01) continue
    issues.push({
      t_start_ms: ms(toTimelineSec(p, a)),
      t_end_ms: ms(toTimelineSec(p, b)),
      clip_id: c.id,
      type: "silence_gap",
      severity: "should",
      evidence: `silencedetect(n=${SILENCE_NOISE_DB}dB,d=${SILENCE_MIN_DUR}) 命中源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s（${(b - a).toFixed(2)}s 無聲）`,
      fix_hint: "剪掉長停頓或提速；刻意留白可忽略",
    })
  }
  return { placed: p, issues, rms, notes }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function lintTimeline(sessionId: string): Promise<LintResult> {
  const tl = await getTimeline(sessionId)
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) throw new Error("未檢測到 ffmpeg（~/.kunpeng/bin/ffmpeg），無法執行信號層診斷")
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1")

  const placed = placeClips(tl)
  const total = placed.length ? placed[placed.length - 1].end : 0

  // 外部音頻覆蓋（no_audio_track 豁免用）：enabled 且 volume>0 的 audioClips 區間 ∪ bgm
  const covers: Array<[number, number]> = tl.audioClips
    .filter((a) => !a.disabled && (a.volume ?? 1) > 0)
    .map((a) => [a.startSec, a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)] as [number, number])
  if (tl.bgm && (tl.bgm.volume ?? 1) > 0) covers.push([0, Infinity])
  const spanCovered = (s: number, e: number): boolean =>
    covers.some(([a, b]) => a <= s + 0.01 && b >= e - 0.01)

  const skipped: string[] = [...SEMANTIC_SKIPS]
  const results: ClipOutcome[] = new Array(placed.length)

  // clip 級並發 ≤3（VPS 2 核）
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= placed.length) return
      const p = placed[i]
      try {
        results[i] = await lintOneClip(ffmpeg, ffprobe, p, spanCovered(p.start, p.end))
      } catch (e) {
        results[i] = {
          placed: p,
          issues: [{
            t_start_ms: ms(p.start),
            t_end_ms: ms(p.end),
            clip_id: p.clip.id,
            type: "lint_timeout",
            severity: "should",
            evidence: `檢測異常降級：${e instanceof Error ? e.message : String(e)}`,
            fix_hint: "查看 gateway journal 定位根因",
          }],
          rms: null,
          notes: [],
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, placed.length) }, worker))

  const issues: LintIssue[] = []
  for (const r of results) {
    if (!r) continue
    issues.push(...r.issues)
    skipped.push(...r.notes)
  }

  // ── should 7: volume_jump（嚴格相鄰 clip 對，兩者均有可測 RMS 且差 > 12dB，標後者起點） ──
  for (let i = 1; i < results.length; i++) {
    const a = results[i - 1]
    const b = results[i]
    if (!a || !b || a.rms === null || b.rms === null) continue
    const diff = Math.abs(b.rms - a.rms)
    if (diff > RMS_JUMP_DB) {
      issues.push({
        t_start_ms: ms(b.placed.start),
        t_end_ms: ms(b.placed.start + 0.5),
        clip_id: b.placed.clip.id,
        type: "volume_jump",
        severity: "should",
        evidence: `相鄰 clip 響度突變：${a.placed.clip.id} RMS ${a.rms.toFixed(1)}dB → ${b.placed.clip.id} RMS ${b.rms.toFixed(1)}dB（差 ${diff.toFixed(1)}dB > ${RMS_JUMP_DB}）`,
        fix_hint: "用 volume/loudnorm 拉平兩段響度",
      })
    }
  }

  issues.sort((x, y) => x.t_start_ms - y.t_start_ms || x.clip_id.localeCompare(y.clip_id))
  void total
  return {
    session_id: sessionId,
    issues,
    passed: !issues.some((i) => i.severity === "must"),
    skipped,
  }
}
