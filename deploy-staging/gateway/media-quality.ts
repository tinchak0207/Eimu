/**
 * media-quality.ts — gateway 侧「事后产物硬检」（确定性量测，2026-10-03）。
 *
 * 为什么是**移植**不是**共用**：站点侧 `src/lib/media-quality-gate.ts` 属 Next 服务端
 * runtime（其 import 图、tsconfig include、部署单元都在 image-app repo）；gateway 是独立
 * 部署单元（bun + bun:sqlite，`deploy-staging/gateway`，权威跑法
 * `bash deploy-staging/vps-tools/run-tests.sh`），tsconfig 只 include `./**`。跨 runtime
 * 相对 import 站点档会把两条建置链耦合成一条（gateway 起不来就拖垮站点，反之亦然），
 * 违反「gateway 是独立 runtime」的硬约束。故在此移植**核心判定逻辑**（政策表、failure
 * code、未知≠通过 的红线），语义与站点逐条对齐；spawn/逾时骨架照 `src/lib/music-tools.ts:187-216`
 * （ffprobe spawn / timeout / SIGKILL / ENOENT 判定）移植。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【本模组只覆盖**技术正确性**，不覆盖审美】
 * 量测维度＝容器/视讯流/宽高/时长/音轨存在/非静音/档案可解析。这是「成品是不是一个
 * 技术上可用的媒体」，**不是**「好不好看、符不符合意图」。以下把量测结果折算的 0–10
 * 分一律称「技术分（technical score）」，**不得**在回报/前端/记忆里讲成审美分数。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 红线：**未知 ≠ 通过**。ffprobe 不可用／逾时／下载失败／解析不出 → 该次**不产生分数**
 * （呼叫端维持 null），并记一笔可观测失败；绝不写 0、绝不写满分冒充通过。
 */

import { spawn } from "node:child_process"
import { rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ── 型别（与站点 media-quality-gate.ts 同形，failure code 语义逐字对齐） ──────────

export type ProbeStatus = "ok" | "probe_unavailable" | "unparsable"

export interface MediaVideoStream {
  codec: string
  width: number | null
  height: number | null
}

export interface MediaAudioStream {
  codec: string
  /** volumedetect 实测平均音量 dB；纯数位静音为 -Infinity；量不到为 null。 */
  meanVolumeDb: number | null
  maxVolumeDb: number | null
}

export interface MediaProbe {
  status: ProbeStatus
  error: string | null
  container: string | null
  durationSec: number | null
  sizeBytes: number | null
  video: MediaVideoStream | null
  audio: MediaAudioStream | null
}

export interface QualityPolicy {
  id: string
  requireVideoStream: boolean
  requireContainer: boolean
  minWidth: number
  minHeight: number
  minDurationSec: number | null
  maxDurationSec: number | null
  requireAudioStream: boolean
  requireNonSilent: boolean
  minMeanVolumeDb: number
  minBytes: number
}

export interface QualityFailure {
  code: string
  detail: string
}

export interface QualityVerdict {
  ok: boolean
  measured: Record<string, number | string | null>
  failures: QualityFailure[]
  policyId: string
}

// ── 政策表（门槛集中一处可调；与站点同名同值） ────────────────────────────────────

export const QUALITY_POLICIES: Readonly<Record<string, QualityPolicy>> = {
  video_default: {
    id: "video_default",
    requireVideoStream: true,
    requireContainer: true,
    minWidth: 320,
    minHeight: 240,
    minDurationSec: 0.2,
    maxDurationSec: 600,
    requireAudioStream: false,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 1024,
  },
  video_with_audio: {
    id: "video_with_audio",
    requireVideoStream: true,
    requireContainer: true,
    minWidth: 320,
    minHeight: 240,
    minDurationSec: 0.2,
    maxDurationSec: 600,
    requireAudioStream: true,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 1024,
  },
  image_default: {
    id: "image_default",
    requireVideoStream: true,
    requireContainer: false,
    minWidth: 256,
    minHeight: 256,
    minDurationSec: null,
    maxDurationSec: null,
    requireAudioStream: false,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 64,
  },
  audio_default: {
    id: "audio_default",
    requireVideoStream: false,
    requireContainer: false,
    minWidth: 0,
    minHeight: 0,
    minDurationSec: 0.1,
    maxDurationSec: 1800,
    requireAudioStream: true,
    requireNonSilent: true,
    minMeanVolumeDb: -60,
    minBytes: 256,
  },
}

// ── 纯函式层（无 I/O） ───────────────────────────────────────────────────────

function measuredFrom(probe: MediaProbe): Record<string, number | string | null> {
  return {
    status: probe.status,
    container: probe.container,
    codec: probe.video?.codec ?? null,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    duration_sec: probe.durationSec,
    byte_size: probe.sizeBytes,
    has_audio: probe.audio !== null ? 1 : 0,
    audio_codec: probe.audio?.codec ?? null,
    mean_volume_db: probe.audio?.meanVolumeDb ?? null,
    max_volume_db: probe.audio?.maxVolumeDb ?? null,
  }
}

/**
 * 对一次实测结果套政策（确定性：同输入必同输出，无时间/随机/模型依赖）。
 * 未知量永不当 pass：probe 失败、或政策要求但量不到的栏位，一律进 failures。
 */
export function evaluateMediaQuality(probe: MediaProbe, policy: QualityPolicy): QualityVerdict {
  const measured = measuredFrom(probe)
  const failures: QualityFailure[] = []
  const verdict = (): QualityVerdict => ({ ok: failures.length === 0, measured, failures, policyId: policy.id })

  if (probe.status === "probe_unavailable") {
    failures.push({ code: "probe_unavailable", detail: probe.error ?? "媒体探测不可用（ffprobe 未安装／逾时／无法读取）" })
    return verdict()
  }
  if (probe.status === "unparsable") {
    failures.push({ code: "unparsable", detail: probe.error ?? "媒体探测输出无法解析" })
    return verdict()
  }

  if (probe.sizeBytes === null) {
    failures.push({ code: "empty_file", detail: "档案大小量不到" })
  } else if (probe.sizeBytes < policy.minBytes) {
    failures.push({ code: "empty_file", detail: `档案 ${probe.sizeBytes} bytes < 下限 ${policy.minBytes}` })
  }

  if (policy.requireContainer && !probe.container) {
    failures.push({ code: "container_missing", detail: "容器名解析不出" })
  }

  if (policy.requireVideoStream && !probe.video) {
    failures.push({ code: "video_stream_missing", detail: "无可解码的视觉流" })
  }
  if (probe.video) {
    const { width, height } = probe.video
    if (policy.minWidth > 0 || policy.minHeight > 0) {
      if (width === null || height === null) {
        failures.push({ code: "dimensions_unparsable", detail: "视觉流宽高解析不出" })
      } else {
        if (width < policy.minWidth) failures.push({ code: "width_below_min", detail: `宽 ${width} < 下限 ${policy.minWidth}` })
        if (height < policy.minHeight) failures.push({ code: "height_below_min", detail: `高 ${height} < 下限 ${policy.minHeight}` })
      }
    }
  }

  if (policy.minDurationSec !== null || policy.maxDurationSec !== null) {
    if (probe.durationSec === null) {
      failures.push({ code: "duration_unparsable", detail: "时长解析不出" })
    } else {
      if (policy.minDurationSec !== null && probe.durationSec < policy.minDurationSec) {
        failures.push({ code: "duration_below_min", detail: `时长 ${probe.durationSec}s < 下限 ${policy.minDurationSec}s` })
      }
      if (policy.maxDurationSec !== null && probe.durationSec > policy.maxDurationSec) {
        failures.push({ code: "duration_above_max", detail: `时长 ${probe.durationSec}s > 上限 ${policy.maxDurationSec}s` })
      }
    }
  }

  if (policy.requireAudioStream && !probe.audio) {
    failures.push({ code: "audio_stream_missing", detail: "政策要求音轨但档案无音轨" })
  }

  if (policy.requireNonSilent && probe.audio) {
    const mv = probe.audio.meanVolumeDb
    if (mv === null) {
      failures.push({ code: "volume_unparsable", detail: "平均音量量不到" })
    } else if (mv <= policy.minMeanVolumeDb) {
      failures.push({ code: "silent_audio", detail: `平均音量 ${mv} dB <= 门槛 ${policy.minMeanVolumeDb} dB` })
    }
  }

  return verdict()
}

// ── 技术分（0–10，非审美） ───────────────────────────────────────────────────

/** 满分；每个 failure code 扣固定分（确定性、可审计）。 */
export const TECHNICAL_SCORE_BASE = 10

/**
 * failure code → 扣分。值只反映「技术可用性受损程度」，与美感/意图无关。
 * `probe_unavailable`/`unparsable` 在此表中不参与——它们让 `scoreFromVerdict` 直接回 null。
 */
const FAILURE_PENALTY: Record<string, number> = {
  empty_file: 10,
  container_missing: 4,
  video_stream_missing: 10,
  dimensions_unparsable: 5,
  width_below_min: 3,
  height_below_min: 3,
  duration_unparsable: 4,
  duration_below_min: 3,
  duration_above_max: 3,
  audio_stream_missing: 5,
  volume_unparsable: 4,
  silent_audio: 6,
}

/**
 * 单一产物的技术分。**量测失败（probe_unavailable/unparsable）回 null，不回 0**
 * ——未知不是 0 分，是「没有分数」，呼叫端必须维持 null 的诚实状态。
 */
export function scoreFromVerdict(v: QualityVerdict): number | null {
  if (v.measured.status !== "ok") return null
  let score = TECHNICAL_SCORE_BASE
  for (const f of v.failures) score -= FAILURE_PENALTY[f.code] ?? 3
  return Math.max(0, Math.round(score * 10) / 10)
}

/**
 * 多件产物取**最低技术分**（保守：任一交付物技术上坏掉就该被看见）。
 * 全部量测失败 → null（不冒充）。无 verdict → null。
 */
export function measuredScoreFromVerdicts(verdicts: QualityVerdict[]): number | null {
  const scores = verdicts.map(scoreFromVerdict).filter((s): s is number => s !== null)
  if (scores.length === 0) return null
  return Math.min(...scores)
}

// ── 文字抽媒体目标（与 events-translate.ts collectToolOutputMediaUrls 同副档名口径） ──

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i
const AUDIO_EXT_RE = /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)(\?|$)/i
const URL_RE = /https?:\/\/[^\s"'<>)\]，。、;；]+/gi

export const MEDIA_QUALITY_MAX_ARTIFACTS = 4

/** 政策选择：依 URL 路径副档名。未知型别回 null（不量测，不猜政策）。 */
export function policyForUrl(url: string): QualityPolicy | null {
  if (VIDEO_EXT_RE.test(url)) return QUALITY_POLICIES.video_default
  if (AUDIO_EXT_RE.test(url)) return QUALITY_POLICIES.audio_default
  if (IMAGE_EXT_RE.test(url)) return QUALITY_POLICIES.image_default
  return null
}

/** 纯函式：从交付正文抽出可量测的媒体 URL（去重、保序、封顶）。 */
export function extractMediaTargets(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return []
  const found: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0]
    if (!VIDEO_EXT_RE.test(raw) && !AUDIO_EXT_RE.test(raw) && !IMAGE_EXT_RE.test(raw)) continue
    const url = raw.replace(/[.,;:!?]+$/, "")
    if (seen.has(url)) continue
    seen.add(url)
    found.push(url)
    if (found.length >= MEDIA_QUALITY_MAX_ARTIFACTS) break
  }
  return found
}

// ── I/O 层（spawn 骨架照 src/lib/music-tools.ts:187-216 移植） ─────────────────────

type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; timedOut: boolean }

function runBinary(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e), timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.code === "ENOENT" ? `${bin} 不存在（系统未安装）` : e.message, timedOut: false })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ ok: false, error: `${bin} 超时（${timeoutMs} ms）`, timedOut: true })
        return
      }
      if (code === 0) resolve({ ok: true, stdout, stderr })
      else resolve({ ok: false, error: `${bin} 退出码 ${code ?? "null"}，stderr：${stderr.trim().slice(0, 200)}`, timedOut: false })
    })
  })
}

function unavailable(error: string): MediaProbe {
  return { status: "probe_unavailable", error, container: null, durationSec: null, sizeBytes: null, video: null, audio: null }
}

function unparsable(error: string): MediaProbe {
  return { status: "unparsable", error, container: null, durationSec: null, sizeBytes: null, video: null, audio: null }
}

function parseDb(raw: string | undefined): number | null {
  if (!raw) return null
  const t = raw.trim().toLowerCase()
  if (t === "-inf") return Number.NEGATIVE_INFINITY
  if (t === "inf") return Number.POSITIVE_INFINITY
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

async function measureVolume(localPath: string, timeoutMs: number): Promise<{ mean: number | null; max: number | null }> {
  const r = await runBinary(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", localPath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    timeoutMs,
  )
  if (!r.ok) return { mean: null, max: null }
  const text = `${r.stdout}\n${r.stderr}`
  const mean = /mean_volume:\s*(-?[\d.]+|-inf|inf)\s*dB/i.exec(text)
  const max = /max_volume:\s*(-?[\d.]+|-inf|inf)\s*dB/i.exec(text)
  return { mean: parseDb(mean?.[1]), max: parseDb(max?.[1]) }
}

async function resolveLocal(target: string, timeoutMs: number): Promise<{ path: string; tmp: string | null }> {
  if (!/^https?:\/\//i.test(target)) {
    return { path: target, tmp: null }
  }
  const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`素材下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > 200 * 1024 * 1024) throw new Error("素材下载超过 200MB 上限")
  const ext = (path.extname(new URL(target).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "") || ".bin"
  const local = path.join(os.tmpdir(), `mq-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  await writeFile(local, buf)
  return { path: local, tmp: local }
}

export type MediaProber = (target: string, timeoutMs: number) => Promise<MediaProbe>

/**
 * 实测一个媒体档案（本地路径或 http(s) URL）。任何失败回带分类的 MediaProbe
 * （status!=="ok"），**不 throw、不冒充**。
 */
export async function probeMedia(target: string, timeoutMs = 15_000): Promise<MediaProbe> {
  let local: { path: string; tmp: string | null }
  try {
    local = await resolveLocal(target, timeoutMs)
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : String(e))
  }

  try {
    const probe = await runBinary(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=format_name,duration,size:stream=codec_type,codec_name,width,height", "-of", "json", local.path],
      timeoutMs,
    )
    if (!probe.ok) {
      // 显式取值（部分 tsconfig 下对 `{ok:true}|{ok:false}` 的窄化不生效，避免依赖窄化）。
      const why = (probe as { error?: string }).error ?? "ffprobe 执行失败"
      return unavailable(why)
    }

    let json: {
      format?: { format_name?: string; duration?: string; size?: string }
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
    }
    try {
      json = JSON.parse(probe.stdout) as typeof json
    } catch {
      return unparsable(`ffprobe 输出不是有效 JSON：${probe.stdout.trim().slice(0, 200)}`)
    }

    const streams = Array.isArray(json.streams) ? json.streams : []
    if (!json.format && streams.length === 0) {
      return unparsable("ffprobe 输出无 format 也无 streams")
    }

    const v = streams.find((s) => s?.codec_type === "video")
    const a = streams.find((s) => s?.codec_type === "audio")

    const durationRaw = json.format?.duration
    const durationNum = durationRaw != null ? Number(durationRaw) : NaN
    let sizeNum = json.format?.size != null ? Number(json.format.size) : NaN
    if (!Number.isFinite(sizeNum)) {
      sizeNum = await stat(local.path).then((s) => s.size).catch(() => NaN)
    }

    const video: MediaVideoStream | null = v
      ? {
          codec: typeof v.codec_name === "string" ? v.codec_name : "unknown",
          width: typeof v.width === "number" && Number.isFinite(v.width) ? v.width : null,
          height: typeof v.height === "number" && Number.isFinite(v.height) ? v.height : null,
        }
      : null

    let audio: MediaAudioStream | null = null
    if (a) {
      const vol = await measureVolume(local.path, timeoutMs)
      audio = { codec: typeof a.codec_name === "string" ? a.codec_name : "unknown", meanVolumeDb: vol.mean, maxVolumeDb: vol.max }
    }

    return {
      status: "ok",
      error: null,
      container: typeof json.format?.format_name === "string" ? json.format.format_name : null,
      durationSec: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : null,
      sizeBytes: Number.isFinite(sizeNum) ? sizeNum : null,
      video,
      audio,
    }
  } catch (e) {
    return unparsable(e instanceof Error ? e.message : String(e))
  } finally {
    if (local.tmp) await rm(local.tmp, { force: true }).catch(() => {})
  }
}

// ── 开关 / binary 侦测 / 观测标记 ─────────────────────────────────────────────

/**
 * 开关（环境变数）：`MEDIA_QUALITY_GATE`。真值＝"1"|"true"|"on"|"yes"（不分大小写）。
 * **预设 OFF**：gateway 是独立部署单元，量测会引入 spawn 子程序＋下载媒体的新 I/O 面；
 * 未经刻意启用前，行为与接线前逐位元等价（零回归）。启用后仍要过 ffprobe 侦测这第二道闸。
 */
export function mediaQualityGateEnabled(): boolean {
  const v = (process.env.MEDIA_QUALITY_GATE ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "on" || v === "yes"
}

/** 可观测标记：量测被跳过／失败（console.warn，journald 可见；不阻断交付）。 */
export const MEDIA_QUALITY_UNAVAILABLE_MARK = "【媒体硬检·未量测】"
export const MEDIA_QUALITY_MEASURED_MARK = "【技术硬检·measured】"

let ffprobeOk: boolean | null = null
/** ffprobe 是否可用（快取）。缺 binary → 降级为「不量测」，绝不让 gateway 起不来或交付失败。 */
export async function ffprobeAvailable(): Promise<boolean> {
  if (ffprobeOk !== null) return ffprobeOk
  try {
    const r = await runBinary("ffprobe", ["-version"], 3_000)
    ffprobeOk = r.ok
  } catch {
    ffprobeOk = false
  }
  if (!ffprobeOk) {
    console.warn(`${MEDIA_QUALITY_UNAVAILABLE_MARK} ffprobe 不可用，事后产物硬检降级为「不量测」（交付不受影响）。`)
  }
  return ffprobeOk
}

// ── 编排层（I/O；可注入 prober 便于测试） ──────────────────────────────────────

export interface MeasuredMediaResult {
  /** 0–10 技术分（非审美）。 */
  score: number
  /** 人话细节（可审计；写进 verdict_text）。 */
  detail: string
  /** 实际量测到的产物件数。 */
  artifacts: number
}

export interface MeasureOptions {
  /** 注入 prober（测试用）；缺省走真实 probeMedia。 */
  probe?: MediaProber
  /** 覆写开关（测试用）；缺省读 env。 */
  enabled?: boolean
  /** 单件逾时（下载与每个子程序共用）。 */
  timeoutMs?: number
}

/**
 * 从交付正文抽出媒体 → 逐件硬检 → 回传技术分。
 * 回 null ＝「没有可写的 measured 分数」，**不得**由呼叫端改填 0：
 *   · 开关 OFF；· ffprobe 不可用；· 正文无媒体 URL；· 全部量测失败（下载/逾时/解析）。
 * 全函式 try/catch 包死，**永不 throw**（交付主流程不得被子程序 I/O 拖垮）。
 */
export async function measureMediaScore(texts: string[], opts: MeasureOptions = {}): Promise<MeasuredMediaResult | null> {
  const enabled = opts.enabled ?? mediaQualityGateEnabled()
  if (!enabled) return null
  const prober: MediaProber = opts.probe ?? probeMedia
  const timeoutMs = opts.timeoutMs ?? 15_000
  try {
    if (!opts.probe && !(await ffprobeAvailable())) return null

    const joined = Array.isArray(texts) ? texts.filter((t) => typeof t === "string").join("\n") : ""
    const targets = extractMediaTargets(joined)
    if (targets.length === 0) return null

    const verdicts: QualityVerdict[] = []
    for (const url of targets) {
      const policy = policyForUrl(url)
      if (!policy) continue
      const probe = await prober(url, timeoutMs)
      verdicts.push(evaluateMediaQuality(probe, policy))
    }
    const score = measuredScoreFromVerdicts(verdicts)
    if (score === null) {
      console.warn(`${MEDIA_QUALITY_UNAVAILABLE_MARK} 产物量测全部失败（不可用/逾时/下载失败），本次不写分数（维持 null）。`)
      return null
    }
    const detail = verdicts
      .map((v) => `${v.policyId}=${v.measured.status === "ok" ? (v.ok ? "ok" : v.failures.map((f) => f.code).join("+")) : v.measured.status}`)
      .join(" | ")
    return { score, detail: `技术分 ${score}/10（仅技术正确性，非审美）· 量测 ${verdicts.length} 件 · ${detail}`, artifacts: verdicts.length }
  } catch (e) {
    console.warn(`${MEDIA_QUALITY_UNAVAILABLE_MARK} 量测异常已忽略（交付不受影响）：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
