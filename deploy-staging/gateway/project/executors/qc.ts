// S8c：qc 执行器（machine / critic）与 takes 选优评分。
// machine：视频/图片走 film-qc.ts 的 analyzeFilm + ffprobe；纯音频交付（mp3 等）不跑读图滤镜，改走可量测代理
//          （文件存在、ffprobe 可解码、时长对、有音频流、响度在阈内）。
// critic：执行器不派发评审子代理（S16 接线）；判决由子代理经 applyCriticVerdict → patch 的 write_result 语义落盘。
// 评分表与扣分权重在 rubrics.ts；takes 的 select:"qc" 由 takes.ts 读取 Output.meta.qcScore。
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { analyzeFilm, parseEbur128, type FilmQcReport } from "../../film-qc.ts"
import type { ArtifactStore } from "../artifacts.ts"
import { applyPatch } from "../patch.ts"
import { checkWriteValue } from "../patch-validate.ts"
import {
  QC_DEFAULT_THRESHOLDS, QUIET_LUFS, rubricOf, RUBRICS, scoreQc, scoredOutput,
  type MediaKind, type QcMetrics, type QcVerdict, type Rubric,
} from "../rubrics.ts"
import { NODE_SPECS } from "../specs.ts"
import type { Actor, ExecContext, ExecResult, Json, NodeExecutor, NodeId, Output, PatchReceipt, ProjectGraph } from "../types.ts"

// ---------------------------------------------------------------- 进程封装（与 film-qc.ts 的 run 同形；那边未导出）
function run(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const ffprobeOf = (ffmpeg: string) => (ffmpeg.endsWith("ffmpeg") ? ffmpeg.replace(/ffmpeg$/, "ffprobe") : "ffprobe")

// ---------------------------------------------------------------- 媒体类型
const EXT_KIND: Readonly<Record<string, MediaKind>> = {
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
  ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".ogg": "audio", ".flac": "audio", ".aac": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
}

function kindFromMime(mime: string): MediaKind | null {
  const m = (mime || "").toLowerCase()
  if (m.startsWith("video/")) return "video"
  if (m.startsWith("image/")) return "image"
  if (m.startsWith("audio/")) return "audio"
  return null
}

export function mediaKindOf(output: Pick<Output, "mime" | "path">): MediaKind | null {
  return kindFromMime(output.mime) ?? EXT_KIND[path.extname(output.path).toLowerCase()] ?? null
}

/** 选 QC 的主输入：视频优先，其次图片，最后音频（同名端口内按到达顺序）。 */
export function pickMediaInput(inputs: Readonly<Record<string, Output[]>>): Output | null {
  const rank = (k: MediaKind | null) => (k === "video" ? 0 : k === "image" ? 1 : k === "audio" ? 2 : 9)
  let best: { o: Output; r: number } | null = null
  for (const outs of Object.values(inputs)) {
    for (const o of outs) {
      const r = rank(mediaKindOf(o))
      if (r === 9) continue
      if (!best || r < best.r) best = { o, r }
    }
  }
  return best?.o ?? null
}

// ---------------------------------------------------------------- 量测
export interface MediaMeasurement {
  kind: MediaKind
  filePath: string
  exists: boolean
  decodable: boolean
  probeError: string | null
  hasAudio: boolean
  durationSec: number | null
  lufs: number | null
  truePeakDb: number | null
  black: boolean
  blackDetail: string | null
  freeze: boolean
  freezeDetail: string | null
}

interface ProbeResult {
  ok: boolean
  durationSec: number | null
  streams: string[]
  error: string | null
}

async function probeMedia(ffprobe: string, file: string): Promise<ProbeResult> {
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], 30_000)
  if (r.code !== 0) {
    const first = r.stderr.trim().split("\n").find((l) => l.trim()) ?? "ffprobe 失败"
    return { ok: false, durationSec: null, streams: [], error: first.slice(0, 160) }
  }
  try {
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }
    const streams = (j.streams ?? []).map((s) => String(s.codec_type ?? "")).filter(Boolean)
    if (streams.length === 0) return { ok: false, durationSec: null, streams, error: "ffprobe 读不到任何流" }
    const d = Number(j.format?.duration)
    return { ok: true, durationSec: Number.isFinite(d) && d > 0 ? d : null, streams, error: null }
  } catch {
    return { ok: false, durationSec: null, streams: [], error: "ffprobe 输出无法解析" }
  }
}

function blackOf(report: FilmQcReport): { black: boolean; detail: string | null } {
  if (report.tailBlackStart !== null) {
    const s = report.tailBlackStart
    return { black: true, detail: s <= 0.05 ? `全黑：整段画面为黑（${s.toFixed(1)}s 起）` : `尾部黑帧：${s.toFixed(1)}s 起至片尾为黑` }
  }
  const mid = report.midIssues.find((m) => m.includes("黑帧"))
  return mid ? { black: true, detail: mid } : { black: false, detail: null }
}

function freezeOf(report: FilmQcReport): { freeze: boolean; detail: string | null } {
  if (report.tailFreezeStart !== null) return { freeze: true, detail: `冻结：${report.tailFreezeStart.toFixed(1)}s 起画面静止至片尾` }
  const mid = report.midIssues.find((m) => m.includes("冻结"))
  return mid ? { freeze: true, detail: mid } : { freeze: false, detail: null }
}

/** 测一个产物文件：存在性 → ffprobe 可解码 → 按类型取响度/黑帧/冻结。不抛错（错误写进 probeError）。 */
export async function measureMedia(ffmpeg: string, output: Output): Promise<MediaMeasurement> {
  const base: MediaMeasurement = {
    kind: mediaKindOf(output) ?? "video", filePath: output.path, exists: false, decodable: false, probeError: null,
    hasAudio: false, durationSec: null, lufs: null, truePeakDb: null, black: false, blackDetail: null, freeze: false, freezeDetail: null,
  }
  try {
    const st = await stat(output.path)
    if (!st.isFile()) return { ...base, probeError: "不是常规文件" }
  } catch {
    return { ...base, probeError: "文件不存在或不可读" }
  }
  const probe = await probeMedia(ffprobeOf(ffmpeg), output.path)
  if (!probe.ok) return { ...base, exists: true, probeError: probe.error }

  const hasVideo = probe.streams.includes("video")
  const hasAudio = probe.streams.includes("audio")
  // mime/扩展名说 video 但只有音频流：按音频代理处理，避免拿读图滤镜去测 mp3。
  const kind: MediaKind = base.kind === "video" && !hasVideo && hasAudio ? "audio" : base.kind
  const measured: MediaMeasurement = { ...base, kind, exists: true, decodable: true, hasAudio, durationSec: probe.durationSec }

  if (kind === "audio") {
    // 纯音频：不跑 freezedetect/blackdetect（对音频无意义且会失败），只测响度。
    const a = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", output.path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], 60_000)
    if (a.code === 0) {
      const e = parseEbur128(a.stderr)
      return { ...measured, lufs: e.lufs, truePeakDb: e.truePeakDb }
    }
    return { ...measured, probeError: `ebur128 失败：${a.stderr.trim().split("\n").pop()?.slice(0, 120) ?? ""}` }
  }

  const report = await analyzeFilm(ffmpeg, output.path)
  const b = blackOf(report)
  const f = freezeOf(report)
  return {
    ...measured,
    hasAudio: report.hasAudio || hasAudio,
    durationSec: report.durationSec > 0 ? report.durationSec : measured.durationSec,
    lufs: report.lufs,
    truePeakDb: report.truePeakDb,
    black: b.black,
    blackDetail: b.detail,
    freeze: f.freeze,
    freezeDetail: f.detail,
  }
}

// ---------------------------------------------------------------- 阈值
export interface QcThresholds {
  durationSec: number | null
  durationTolerance: number
  maxDurationSec: number | null
  minScore: number
  lufsTolerance: number
  truePeakDb: number
  requireAudio: boolean
}

const asObject = (v: Json | undefined): Record<string, Json> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : {}

/** params.thresholds 覆盖默认；未给时用工程 targets（durationSec/audio）与设计文档 §3.9 的 ±10%。 */
export function parseQcThresholds(raw: Json | undefined, opts: { project?: Readonly<ProjectGraph>; rubric: Rubric; kind: MediaKind }): QcThresholds {
  const obj = asObject(raw)
  const num = (k: string): number | null => (typeof obj[k] === "number" && Number.isFinite(obj[k] as number) ? (obj[k] as number) : null)
  const bool = (k: string): boolean | null => (typeof obj[k] === "boolean" ? (obj[k] as boolean) : null)
  const targets = opts.project?.targets ?? null
  const explicitDur = num("durationSec")
  const targetDur = explicitDur !== null && explicitDur > 0
    ? explicitDur
    : typeof targets?.durationSec === "number" && targets.durationSec > 0 ? targets.durationSec : null
  const tolerance = num("durationTolerance")
  const maxDur = num("maxDurationSec")
  const minScore = num("minScore")
  const lufsTol = num("lufsTolerance")
  const tp = num("truePeakDb")
  const requireAudio = bool("requireAudio") ?? (opts.kind === "image" ? false : opts.kind === "audio" ? true : targets ? targets.audio !== "none" : true)
  return {
    durationSec: targetDur,
    durationTolerance: tolerance !== null && tolerance >= 0 ? tolerance : QC_DEFAULT_THRESHOLDS.durationTolerance,
    maxDurationSec: maxDur !== null && maxDur > 0 ? maxDur : null,
    minScore: minScore !== null && minScore >= 0 ? minScore : opts.rubric.minScore,
    lufsTolerance: lufsTol !== null && lufsTol >= 0 ? lufsTol : QC_DEFAULT_THRESHOLDS.lufsTolerance,
    truePeakDb: tp !== null ? tp : QC_DEFAULT_THRESHOLDS.truePeakDb,
    requireAudio,
  }
}

function metricsOf(m: MediaMeasurement, t: QcThresholds): QcMetrics {
  return {
    kind: m.kind,
    filePath: m.filePath,
    exists: m.exists,
    decodable: m.decodable,
    probeError: m.probeError,
    hasAudio: m.hasAudio,
    audioRequired: t.requireAudio,
    durationSec: m.durationSec,
    targetDurationSec: t.durationSec,
    durationTolerance: t.durationTolerance,
    maxDurationSec: t.maxDurationSec,
    black: m.black,
    blackDetail: m.blackDetail,
    freeze: m.freeze,
    freezeDetail: m.freezeDetail,
    lufs: m.lufs,
    lufsTarget: QC_DEFAULT_THRESHOLDS.lufsTarget,
    lufsTolerance: t.lufsTolerance,
    truePeakDb: m.truePeakDb,
    truePeakMax: t.truePeakDb,
  }
}

const metricsJson = (m: QcMetrics): Record<string, Json> => ({
  kind: m.kind, filePath: m.filePath, exists: m.exists, decodable: m.decodable, probeError: m.probeError,
  hasAudio: m.hasAudio, audioRequired: m.audioRequired, durationSec: m.durationSec,
  targetDurationSec: m.targetDurationSec, durationTolerance: m.durationTolerance, maxDurationSec: m.maxDurationSec,
  black: m.black, blackDetail: m.blackDetail, freeze: m.freeze, freezeDetail: m.freezeDetail,
  lufs: m.lufs, lufsTarget: m.lufsTarget, lufsTolerance: m.lufsTolerance,
  truePeakDb: m.truePeakDb, truePeakMax: m.truePeakMax, quietLufs: QUIET_LUFS,
})

// ---------------------------------------------------------------- 检视/评分（qc 节点与 takes 选优共用）
export interface InspectOptions {
  ffmpeg?: string
  project?: Readonly<ProjectGraph>
  rubricId?: string
  thresholds?: Json
}

export interface QcInspection {
  kind: MediaKind
  score: number
  pass: boolean
  deficiencies: string[]
  rubric: string
  minScore: number
  measurement: MediaMeasurement
  metrics: Record<string, Json>
}

export function evaluateMedia(m: MediaMeasurement, opts: InspectOptions = {}): QcInspection {
  const rubric = rubricOf(opts.rubricId)
  if (!rubric) throw new Error(`未知评分表 ${String(opts.rubricId)}（可用：${Object.keys(RUBRICS).join(", ")}）`)
  const t = parseQcThresholds(opts.thresholds, { project: opts.project, rubric, kind: m.kind })
  const metrics = metricsOf(m, t)
  const verdict = scoreQc(metrics, rubric)
  return {
    kind: m.kind,
    score: verdict.score,
    pass: verdict.score > 0 && verdict.score >= t.minScore,
    deficiencies: verdict.deficiencies,
    rubric: rubric.id,
    minScore: t.minScore,
    measurement: m,
    metrics: metricsJson(metrics),
  }
}

/** 量测 + 评分；takes 选优（S6）与 qc 节点共用这一条。 */
export async function inspectMedia(output: Output, opts: InspectOptions = {}): Promise<QcInspection> {
  const m = await measureMedia(opts.ffmpeg ?? "ffmpeg", output)
  return evaluateMedia(m, opts)
}

/** takes 评分入口：返回带 meta.qcScore 的候选副本（S4 约定）。 */
export async function scoreTakeOutput(output: Output, opts: InspectOptions = {}): Promise<Output> {
  const r = await inspectMedia(output, opts)
  return scoredOutput(output, r)
}

// ---------------------------------------------------------------- machine QC
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200)

async function persistVerdict(ctx: ExecContext, mediaPath: string, content: Json): Promise<Output> {
  // ingest 只收工程目录内文件；判决写在媒体产物同目录，入库后立刻删临时文件。
  const dir = path.dirname(mediaPath)
  const tmp = path.join(dir, `.qc-${ctx.runId.replace(/[^A-Za-z0-9_-]/g, "_")}-t${ctx.take}-${randomBytes(4).toString("hex")}.json`)
  await writeFile(tmp, JSON.stringify(content), "utf-8")
  try {
    return await ctx.ingest({ path: tmp }, { port: "out", mime: "application/json", origin: "derived" })
  } finally {
    await rm(tmp, { force: true })
  }
}

const failureMessage = (r: QcInspection) =>
  `qc 未通过（${r.score}/${r.minScore}）：${r.deficiencies.join("；") || "未给出缺陷说明"}`

export async function runQc(ctx: ExecContext): Promise<ExecResult> {
  const mode = typeof ctx.params.mode === "string" ? ctx.params.mode : ""
  if (mode === "critic") {
    return {
      ok: false,
      code: "bad_input",
      message: "critic_dispatch_unwired: qc(mode=\"critic\") 的判决必须由评审子代理经 write_result 落盘（S16 接线，入口 applyCriticVerdict）；执行器不派发、不自判。",
      retryable: false,
    }
  }
  if (mode !== "machine") {
    return { ok: false, code: "bad_input", message: `qc.mode 必须是 "machine" | "critic"（收到 ${JSON.stringify(ctx.params.mode)}）。`, retryable: false }
  }
  if (ctx.signal.aborted) return { ok: false, code: "cancelled", message: "qc 已取消", retryable: true }

  const picked = pickMediaInput(ctx.inputs)
  if (!picked) return { ok: false, code: "bad_input", message: "qc 需要影音产物输入（video/audio/image），当前没有可检查的产物。", retryable: false }

  let inspection: QcInspection
  try {
    inspection = await inspectMedia(picked, { project: ctx.project, rubricId: typeof ctx.params.rubric === "string" ? ctx.params.rubric : undefined, thresholds: ctx.params.thresholds })
  } catch (e) {
    return { ok: false, code: "bad_input", message: `qc 未能执行：${errMsg(e)}`, retryable: true }
  }

  if (!inspection.pass) return { ok: false, code: "qc_failed", message: failureMessage(inspection), retryable: false, costCoins: 0 }

  const verdict: Json = {
    mode: "machine",
    rubric: inspection.rubric,
    score: inspection.score,
    pass: true,
    deficiencies: [],
    metrics: inspection.metrics,
  }
  try {
    const out = await persistVerdict(ctx, picked.path, verdict)
    return {
      ok: true,
      outputs: [{ ...out, meta: { qcScore: inspection.score, qcPass: true, qcRubric: inspection.rubric } }],
      costCoins: 0,
    }
  } catch (e) {
    return { ok: false, code: "bad_input", message: `qc 判过但判决写入失败：${errMsg(e)}`, retryable: true }
  }
}

// ---------------------------------------------------------------- critic 回执（S16 经 write_result 接线）
export type CriticVerdict = { score: number; pass: boolean; deficiencies: string[] }

/** 校验子代理回执；校验规则直接复用 patch 的 checkWriteValue("qc")，与 write_result 同一真源。 */
export function normalizeCriticVerdict(value: unknown): { ok: true; verdict: CriticVerdict } | { ok: false; message: string } {
  const v = checkWriteValue("qc", value)
  // 本仓 tsconfig 关闭 strictNullChecks，布尔判别式收窄失效；用 in 判别成员。
  if ("msg" in v) return { ok: false, message: v.msg }
  const def = v.value.deficiencies
  return {
    ok: true,
    verdict: {
      score: v.value.score as number,
      pass: v.value.pass as boolean,
      deficiencies: Array.isArray(def) ? def.map((d) => String(d)) : [],
    },
  }
}

export interface CriticWriteOptions {
  artifacts: Pick<ArtifactStore, "putBytes" | "get">
  /** 缺省 = 评审子代理在本节点 lane 内写入。 */
  actor?: Actor
  runId?: string
  now?: () => Date
}

export type CriticWriteOutcome =
  | { ok: true; graph: ProjectGraph; receipt: PatchReceipt; output: Output; verdict: CriticVerdict }
  | { ok: false; message: string; graph: ProjectGraph; receipt: PatchReceipt | null }

/**
 * 接收 critic 的 {score,pass,deficiencies[]} 并写成 QC 节点产物。
 * 落盘走 patch 引擎的 write_result（产物入库、状态 done、lastRun、事件与补丁回执都与其他写入路径一致）。
 */
export async function applyCriticVerdict(
  graph: Readonly<ProjectGraph>,
  nodeId: NodeId,
  value: unknown,
  opts: CriticWriteOptions,
): Promise<CriticWriteOutcome> {
  const norm = normalizeCriticVerdict(value)
  if ("message" in norm) return { ok: false, message: norm.message, graph: graph as ProjectGraph, receipt: null }
  const actor: Actor = opts.actor ?? { kind: "subagent", runId: opts.runId ?? "critic", lane: [nodeId] }
  const outcome = await applyPatch(
    graph,
    { ops: [{ op: "write_result", node: nodeId, value: norm.verdict }] },
    actor,
    { artifacts: opts.artifacts, ...(opts.now ? { now: opts.now } : {}) },
  )
  if (!outcome.committed || !outcome.receipt.ok) {
    const r = outcome.receipt.rejected[0]
    return { ok: false, message: r ? `${r.code}: ${r.msg}` : "write_result 被拒绝", graph: outcome.graph, receipt: outcome.receipt }
  }
  const output = outcome.graph.nodes[nodeId]?.outputs?.[0]
  if (!output) return { ok: false, message: `节点 ${nodeId} 写入后没有产物`, graph: outcome.graph, receipt: outcome.receipt }
  return { ok: true, graph: outcome.graph, receipt: outcome.receipt, output, verdict: norm.verdict }
}

// ---------------------------------------------------------------- NodeExecutor
export const qcExecutor: NodeExecutor = {
  type: "qc",
  specVersion: NODE_SPECS.qc.specVersion,
  async estimate() {
    // machine QC 只花本机 CPU；critic 的子代理成本走子代理账（设计文档 §3.5）。
    return 0
  },
  async run(ctx: ExecContext): Promise<ExecResult> {
    return runQc(ctx)
  },
}

export type { QcVerdict }
