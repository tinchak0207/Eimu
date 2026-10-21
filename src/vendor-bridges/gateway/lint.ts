/**
 * lint.ts — 剪辑诊断器信号层（施工片 B4，2026-08-31，REQ-EDIT-03 可复现子集）。
 *
 * 需求源：《Eimu 剪辑体验 PRD v1.0》REQ-EDIT-03（电影语言 linter）。本档只做信号层：
 * 全部检测对 clip 的 trim 窗口 [inSec,outSec] 跑 ffmpeg 滤镜（-ss/-t 精确 seek），
 * 结果座标为**时间线系**（timeline 偏移 = 前序 clip 有效时长累加，口径同 B1 clipLength）。
 * 语义层（越轴/动作连续性/光不一致/角色脸一致性/口型同步）当前行业无可复现检测
 * → 诚实写进 skipped，不谎报（暴君已批准妥协）。
 *
 * 契约输入：./timeline getTimeline（B1 生命周期层）；ffmpeg 真源 detectFfmpeg
 * （./editor/canvas/videoCompose，候选表第一位 ~/.kunpeng/bin/ffmpeg，7.0.2 静态）。
 * 素材 path 为 http(s) URL 时先下载到 $WORKSPACE_DIR/tmp（同款于 B3 rhythm.ts
 * resolveBgmLocal 的下载逻辑，白名单复制，不改 rhythm.ts 本体）。
 *
 * 阈值口径（全部可复现，构造样本实锤见 PRD 验收）：
 * - black_frame:  blackdetect=d=0.1:pix_th=0.10
 * - white_flash:  signalstats YAVG>240 连续 ≥3 帧（limited-range 内容最高 Y=235，
 *                 240 只抓真·过曝/全白，零误报口径）
 * - audio_clip:   astats Peak level dB > -0.5（削顶风险）
 * - av_mismatch:  clip outSec > ffprobe 实测源时长 + 0.1s（尾段会黑/冻）
 * - no_audio_track: 源无音轨且非显式静音设计（volume!==0）且时间线无覆盖配音/BGM
 * - silence_gap:  silencedetect=n=-40dB:d=1.5（比 vendor transcriptOps.detectAudioSilences
 *                 的 noise=-35dB:d=0.8 更严，避免把正常句间停顿误报；解析同款
 *                 silence_start/silence_end，并补 vendor 未处理的「尾部静音无 silence_end」）
 * - volume_jump:  相邻（均有音轨）clip astats RMS 差 > 12dB → 标后者起点
 * - freeze:       freezedetect=n=-60dB:d=2
 *
 * 性能：clip 级并发 ≤3（VPS 2 核，勿打满）；单 clip 检测超时 60s → issue
 * type=lint_timeout severity=should，不炸全场。视频三滤镜（blackdetect/freezedetect/
 * signalstats+metadata=print）链式合并为单次解码；音频两滤镜（astats/silencedetect）
 * 合并为单次解码，降低重复 CPU。
 */
import { spawn } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { getTimeline, clipLength, type Timeline, type TimelineClip } from "./timeline"
import { detectFfmpeg } from "./editor/canvas/videoCompose"

// 与 timeline.ts L28 / index.ts L446 同值；env 可覆盖（测试用）。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"

// ── 检测常数（PRD REQ-EDIT-03 信号层，全部可复现） ────────────────────────────
const CONCURRENCY = 3            // clip 级并发上限（VPS 2 核）
const CLIP_TIMEOUT_MS = 60_000   // 单 clip 检测超时
const AV_EPSILON_SEC = 0.1       // av_mismatch 容差（帧量化/容器取整）
const BLACK_D = 0.1
const BLACK_PIX_TH = 0.1
const WHITE_YAVG_TH = 240
const WHITE_MIN_FRAMES = 3
const PEAK_CLIP_DB = -0.5
const SILENCE_NOISE_DB = -40
const SILENCE_MIN_DUR = 1.5
const RMS_JUMP_DB = 12
const FREEZE_D = 2

// ── 契约型别 ─────────────────────────────────────────────────────────────────

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
  /** 时间线座标（毫秒，非源素材座标） */
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
  /** 布尔：must 级为零即 true */
  passed: boolean
  /** 诚实跳过清单：语义层五项（当前行业无可复现检测）+ 逐 clip 降级说明 */
  skipped: string[]
}

/** 语义层妥协清单（PRD 暴君已批准）：固定写进每次结果，不谎报 */
const SEMANTIC_SKIPS: string[] = [
  "cross_axis 越轴：语义层，当前行业无可复现检测，诚实跳过",
  "action_continuity 动作连续性：语义层，当前行业无可复现检测，诚实跳过",
  "lighting_consistency 光不一致：语义层，当前行业无可复现检测，诚实跳过",
  "face_consistency 角色脸一致性：语义层，当前行业无可复现检测，诚实跳过",
  "lip_sync 口型同步：语义层，当前行业无可复现检测，诚实跳过",
]

// ── 内部工具 ─────────────────────────────────────────────────────────────────

interface Placed {
  clip: TimelineClip
  /** 时间轴起点/终点（主轨顺序累加，秒） */
  start: number
  end: number
  /** 有效时长 = clipLength */
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

/** 源窗口内秒（-ss 后输出时间轴，0=窗口起点）→ 时间线秒 */
function toTimelineSec(p: Placed, windowSec: number): number {
  return p.start + windowSec / p.speed
}

interface FFRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** spawn 执行 ffmpeg/ffprobe（args 数组，无 shell 引号问题），超时 SIGKILL */
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

/** 素材解析：本地路径直用；http(s) URL 下载到 $WORKSPACE_DIR/tmp（同款 B3 rhythm.ts 口径） */
async function resolveLocal(src: string): Promise<string> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`素材下载失败 HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 100 * 1024 * 1024) throw new Error("素材下载超过 100MB 上限")
    const ext = (path.extname(new URL(src).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "")
    const dir = path.join(WORKSPACE_DIR, "tmp")
    await mkdir(dir, { recursive: true })
    const local = path.join(dir, `lint-clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    await writeFile(local, buf)
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

/** 从 astats 输出提取所有 Peak/RMS dB（多声道取最大；"-inf" 过滤） */
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

/** 配对解析 start/end 事件（blackdetect/freezedetect/silencedetect 共用；尾部无 end 补 endFallback） */
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

/** metadata=print 输出解析：逐帧 (pts_time, YAVG)，YAVG>240 连续 ≥3 帧 → 区间 */
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

// ── 单 clip 检测 ─────────────────────────────────────────────────────────────

interface ClipOutcome {
  placed: Placed
  issues: LintIssue[]
  /** astats RMS dB；null=无音轨/未测（volume_jump 用） */
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
      evidence: `单 clip 检测超时 ${CLIP_TIMEOUT_MS / 1000}s（${pass}），该 clip 其余信号未验`,
      fix_hint: "素材过长或解码过慢：缩短 trim 窗口、降低解析度或重试",
    })
    return { placed: p, issues, rms: null, notes }
  }

  // 停用片段：导出不显示原画面，信号层不验（占位诚实记录）
  if (c.disabled) {
    notes.push(`clip ${c.id}: disabled（导出不显示原画面），信号检测跳过`)
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
      evidence: `素材不可达：${e instanceof Error ? e.message : String(e)}`,
      fix_hint: "检查 clip.path（本地路径或 http URL）是否有效",
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
      evidence: "ffprobe 探测失败（不可解码？）",
      fix_hint: "素材可能损坏或格式不支持，先本地 ffprobe 复核",
    })
    return { placed: p, issues, rms: null, notes }
  }

  const winDur = Math.max(0.001, c.outSec - c.inSec)
  const seekArgs = ["-hide_banner", "-ss", String(c.inSec), "-t", String(winDur)]

  // ── must 4: av_mismatch（outSec 超过源实测时长） ──
  if (c.outSec > probe.duration + AV_EPSILON_SEC) {
    const tailStart = Math.max(0, Math.min(winDur, probe.duration - c.inSec))
    issues.push({
      t_start_ms: ms(toTimelineSec(p, tailStart)),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "av_mismatch",
      severity: "must",
      evidence: `clip outSec=${c.outSec}s 超过源实测时长 ${probe.duration.toFixed(3)}s（宣告 duration=${c.duration}s），尾段 ${(c.outSec - probe.duration).toFixed(2)}s 导出将黑帧/冻帧`,
      fix_hint: `trim outSec 至 ${Math.floor(probe.duration * 10) / 10}s 以内，或换更长素材`,
    })
  }

  // ── must 5: no_audio_track（源无音轨且非显式静音设计） ──
  if (!probe.hasAudio) {
    if (c.volume === 0) {
      notes.push(`clip ${c.id}: 源无音轨但 volume=0（显式静音设计），no_audio_track 跳过`)
    } else if (audioCovered) {
      notes.push(`clip ${c.id}: 源无音轨但时间线有配音/BGM 覆盖，no_audio_track 跳过`)
    } else {
      issues.push({
        t_start_ms: ms(p.start),
        t_end_ms: ms(p.end),
        clip_id: c.id,
        type: "no_audio_track",
        severity: "must",
        evidence: "源无音轨，且该区间无配音 clip/BGM 覆盖（成片此段无声硬伤）",
        fix_hint: "补配音或 BGM 覆盖该区间；若刻意静音设 clip.volume=0",
      })
    }
  }

  // ── 视频信号单次解码：blackdetect + freezedetect + signalstats/metadata ──
  const vPass = await runFF(
    ffmpeg,
    [
      ...seekArgs, "-i", local,
      "-vf", `blackdetect=d=${BLACK_D}:pix_th=${BLACK_PIX_TH},freezedetect=n=-60dB:d=${FREEZE_D},signalstats,metadata=print:file=-`,
      "-an", "-f", "null", "-",
    ],
    budget(),
  )
  if (vPass.timedOut) return timeoutIssue("视频滤镜链 blackdetect/freezedetect/signalstats")
  if (vPass.code !== 0) {
    notes.push(`clip ${c.id}: 视频检测 pass 失败（exit ${vPass.code}）：${vPass.stderr.slice(-200)}`)
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
        fix_hint: "剪掉黑帧段（trim）或替换素材",
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
        evidence: `freezedetect(n=-60dB,d=${FREEZE_D}) 命中源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s（冻帧）`,
        fix_hint: "剪掉冻帧段；若刻意定格效果可忽略",
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
        evidence: `signalstats YAVG>${WHITE_YAVG_TH} 连续 ${n} 帧（源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s）`,
        fix_hint: "闪白硬伤：缩短白帧段或加淡入淡出过渡",
      })
    }
  }

  // ── 音频信号单次解码：astats + silencedetect ──
  let rms: number | null = null
  if (!probe.hasAudio) {
    notes.push(`clip ${c.id}: 源无音轨，astats/silencedetect 跳过`)
    return { placed: p, issues, rms: null, notes }
  }
  if (c.volume === 0) {
    notes.push(`clip ${c.id}: volume=0（显式静音），音频信号检测跳过`)
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
  if (aPass.timedOut) return timeoutIssue("音频滤镜链 astats/silencedetect")
  if (aPass.code !== 0) {
    notes.push(`clip ${c.id}: 音频检测 pass 失败（exit ${aPass.code}）：${aPass.stderr.slice(-200)}`)
    return { placed: p, issues, rms: null, notes }
  }
  const { peak, rms: rmsMeasured } = parseAstats(aPass.stderr)
  rms = rmsMeasured
  // must 3: audio_clip（爆音/削顶风险）
  if (peak !== null && peak > PEAK_CLIP_DB) {
    issues.push({
      t_start_ms: ms(p.start),
      t_end_ms: ms(p.end),
      clip_id: c.id,
      type: "audio_clip",
      severity: "must",
      evidence: `astats Peak level dB=${peak.toFixed(2)} > ${PEAK_CLIP_DB}（削顶风险）`,
      fix_hint: "降低该 clip 音量（volume 滤镜）或加限幅（alimiter），重新导出音频",
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
      evidence: `silencedetect(n=${SILENCE_NOISE_DB}dB,d=${SILENCE_MIN_DUR}) 命中源窗口 ${a.toFixed(2)}-${b.toFixed(2)}s（${(b - a).toFixed(2)}s 无声）`,
      fix_hint: "剪掉长停顿或提速；刻意留白可忽略",
    })
  }
  return { placed: p, issues, rms, notes }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function lintTimeline(sessionId: string): Promise<LintResult> {
  const tl = await getTimeline(sessionId)
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) throw new Error("未检测到 ffmpeg（~/.kunpeng/bin/ffmpeg），无法执行信号层诊断")
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1")

  const placed = placeClips(tl)
  const total = placed.length ? placed[placed.length - 1].end : 0

  // 外部音频覆盖（no_audio_track 豁免用）：enabled 且 volume>0 的 audioClips 区间 ∪ bgm
  const covers: Array<[number, number]> = tl.audioClips
    .filter((a) => !a.disabled && (a.volume ?? 1) > 0)
    .map((a) => [a.startSec, a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)] as [number, number])
  if (tl.bgm && (tl.bgm.volume ?? 1) > 0) covers.push([0, Infinity])
  const spanCovered = (s: number, e: number): boolean =>
    covers.some(([a, b]) => a <= s + 0.01 && b >= e - 0.01)

  const skipped: string[] = [...SEMANTIC_SKIPS]
  const results: ClipOutcome[] = new Array(placed.length)

  // clip 级并发 ≤3（VPS 2 核）
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
            evidence: `检测异常降级：${e instanceof Error ? e.message : String(e)}`,
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

  // ── should 7: volume_jump（严格相邻 clip 对，两者均有可测 RMS 且差 > 12dB，标后者起点） ──
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
        evidence: `相邻 clip 响度突变：${a.placed.clip.id} RMS ${a.rms.toFixed(1)}dB → ${b.placed.clip.id} RMS ${b.rms.toFixed(1)}dB（差 ${diff.toFixed(1)}dB > ${RMS_JUMP_DB}）`,
        fix_hint: "用 volume/loudnorm 拉平两段响度",
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
