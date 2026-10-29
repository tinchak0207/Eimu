// S8c：qc 执行器（machine / critic）与 takes 选优评分。
// machine：视频/图片走 film-qc.ts 的 analyzeFilm + ffprobe；纯音频交付（mp3 等）不跑读图滤镜，改走可量测代理
//          （文件存在、ffprobe 可解码、时长对、有音频流、响度在阈内）。
// critic：经 lanes.dispatchCriticRun 派独立 critic 席位；回执用 delivery-gate-critic.checkCriticReceipt 校验后签名落盘。
// 评分表与扣分权重在 rubrics.ts；takes 的 select:"qc" 由 takes.ts 读取 Output.meta.qcScore。
import { execFile } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import { rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkCriticReceipt } from "../../delivery-gate-critic.ts"
import type { CriticPassTarget } from "../../delivery-gate-types.ts"
import { analyzeFilm, parseEbur128, type FilmQcReport } from "../../film-qc.ts"
import type { ArtifactStore } from "../artifacts.ts"
import { CRITIC_EXPERT, dispatchCriticRun, projectSeatOf, type CriticDispatchFn } from "../lanes.ts"
import { applyPatch } from "../patch.ts"
import { checkWriteValue } from "../patch-validate.ts"
import {
  QC_DEFAULT_THRESHOLDS, QUIET_LUFS, rubricOf, RUBRICS, scoreQc, scoredOutput,
  type MediaKind, type QcMetrics, type QcVerdict, type Rubric,
} from "../rubrics.ts"
import { NODE_SPECS } from "../specs.ts"
import { effectiveGoalRevision, briefLedgerRevision } from "../digest.ts"
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

/** 失败指向需修改的作品，不让调度器把重审同一素材当作返工。 */
async function qualityRework(ctx: ExecContext, picked: Output, deficiencies: string[], items?: Map<string, CriticItemResult>, scoring?: { score: number; minScore: number }): Promise<ExecResult> {
  const report: Json = {
    kind: "quality_rework",
    ...(scoring ? { score: scoring.score, minScore: scoring.minScore } : {}),
    qcNodeId: ctx.node.id,
    artifactSha256: picked.sha256,
    goalRevision: effectiveGoalRevision(ctx.project),
    sourceNodes: Object.values(ctx.node.inputs).map((ref) => ref.from),
    defects: deficiencies.map((description) => {
      const observed = items ? [...items.values()].find((item) => description.startsWith(`${item.id} `)) : undefined
      return { nodeId: observed?.nodeId ?? "unknown", timecode: observed?.timecode ?? "unknown",
        sourceRequirement: observed?.sourceRequirement ?? (typeof ctx.params.rubric === "string" ? `rubric:${ctx.params.rubric}` : "unknown"), description }
    }),
    ...(items ? { observedItems: [...items.values()].map((item) => ({ id: item.id, pass: item.pass, evidence: item.evidence })) } : {}),
  }
  let reportArtifactId: string | null = null
  try { reportArtifactId = (await persistVerdict(ctx, picked.path, report)).artifactId } catch { /* retain inline defects even if report persistence fails */ }
  return { ok: false, code: "qc_failed", retryable: false, costCoins: 0, message: JSON.stringify({ ...report as Record<string, Json>, reportArtifactId }) }
}

// ---------------------------------------------------------------- critic 派发（复用 dispatchCriticRun + checkCriticReceipt）
// 测试钥匙只在非生产使用。生产只认 EIMU_CRITIC_VERDICT_KEY；缺省或与测试钥匙相同则拒绝，不退回测试钥匙。
export const CRITIC_VERDICT_TEST_KEY = "eimu-critic-verdict-test-key-v1"
const MEDIA_LOCATOR_EXT = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv)(?:[?#].*)?$/i
const criticRounds = new Set<string>()
let criticDispatchForTest: CriticDispatchFn | null = null

export function setQcCriticDispatchForTest(fn: CriticDispatchFn | null): void {
  criticDispatchForTest = fn
  criticRounds.clear()
}

export function criticSeat(): string {
  return projectSeatOf(CRITIC_EXPERT, true)
}

export interface CriticItemResult {
  id: string
  pass: boolean
  evidence: string
  nodeId?: string
  timecode?: string
  sourceRequirement?: string
}

export interface SignedCriticVerdict {
  schema: 1
  mode: "critic"
  rubric: string
  score: number
  pass: true
  items: CriticItemResult[]
  deficiencies: string[]
  evidence: string[]
  actor: { kind: "subagent"; seat: string; runId: string; lane: string[]; sessionId: string }
  parentSessionId: string
  artifactSha256: string
  goalRevision?: string
  briefLedgerRevision?: string
  receiptCallIds: string[]
  sig: string
}

function verdictCanonical(body: Omit<SignedCriticVerdict, "sig">): string {
  return JSON.stringify({
    schema: body.schema,
    mode: body.mode,
    rubric: body.rubric,
    score: body.score,
    pass: body.pass,
    items: body.items,
    deficiencies: body.deficiencies,
    evidence: body.evidence,
    actor: body.actor,
    parentSessionId: body.parentSessionId,
    artifactSha256: body.artifactSha256,
    ...(body.goalRevision ? { goalRevision: body.goalRevision } : {}),
    ...(body.briefLedgerRevision ? { briefLedgerRevision: body.briefLedgerRevision } : {}),
    receiptCallIds: body.receiptCallIds,
  })
}

function productionVerdictEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.EIMU_ENV === "production"
}

function verdictKey(): { ok: true; key: string } | { ok: false; reason: string } {
  if (productionVerdictEnv()) {
    const raw = process.env.EIMU_CRITIC_VERDICT_KEY
    if (!raw || raw === CRITIC_VERDICT_TEST_KEY) return { ok: false, reason: "生产钥匙不可用" }
    return { ok: true, key: raw }
  }
  return { ok: true, key: CRITIC_VERDICT_TEST_KEY }
}

function signVerdict(body: Omit<SignedCriticVerdict, "sig">): string | null {
  const key = verdictKey()
  if (!key.ok) return null
  return createHmac("sha256", key.key).update(verdictCanonical(body)).digest("hex")
}

function rubricForVerdict(id: string): Rubric | null {
  if (!id || !Object.prototype.hasOwnProperty.call(RUBRICS, id)) return null
  return RUBRICS[id]
}

export function verifySignedCriticVerdict(
  raw: unknown,
  parentSessionId: string,
  mediaKind: "image" | "video",
  expected?: { artifactSha256: string; goalRevision: string; briefLedgerRevision?: string },
): { ok: true; verdict: SignedCriticVerdict } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "verdict 不是对象（只读 pass 不够）" }
  const v = raw as Partial<SignedCriticVerdict>
  if (v.schema !== 1 || v.mode !== "critic" || typeof v.sig !== "string" || !v.sig) {
    return { ok: false, reason: "verdict 缺少 critic 签名" }
  }
  if (v.pass !== true) return { ok: false, reason: "verdict 未判过" }
  if (typeof v.score !== "number" || !Number.isFinite(v.score) || v.score < 0 || v.score > 100) {
    return { ok: false, reason: "verdict.score 必须是 0–100" }
  }
  if (!Array.isArray(v.items) || v.items.length === 0) return { ok: false, reason: "verdict 没有逐项 pass" }
  for (const item of v.items) {
    if (!item || typeof item.id !== "string" || item.pass !== true || typeof item.evidence !== "string" || !item.evidence) {
      return { ok: false, reason: "verdict 有条目未过或没有证据" }
    }
  }
  const actor = v.actor
  if (!actor || actor.kind !== "subagent" || actor.seat !== criticSeat() || typeof actor.sessionId !== "string" || !actor.sessionId) {
    return { ok: false, reason: "verdict 不是 critic lane 写入" }
  }
  if (actor.sessionId === parentSessionId) return { ok: false, reason: "critic 与父会话是同一个" }
  if (!Array.isArray(actor.lane) || actor.lane.length === 0) return { ok: false, reason: "verdict 没有 critic lane" }
  if (typeof v.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.artifactSha256)) {
    return { ok: false, reason: "verdict 没有被评产物指纹" }
  }
  if (expected && (v.artifactSha256 !== expected.artifactSha256 || v.goalRevision !== expected.goalRevision)) {
    return { ok: false, reason: "verdict 与本次候选文件或有效目标版本不一致" }
  }
  if (expected?.briefLedgerRevision && v.briefLedgerRevision !== expected.briefLedgerRevision) return { ok: false, reason: "review_required: 原话账本有新增消息，需要独立核对修订；媒体候选保留，不重渲" }
  if (!Array.isArray(v.receiptCallIds) || v.receiptCallIds.length === 0) return { ok: false, reason: "verdict 没有感知回执" }
  const body: Omit<SignedCriticVerdict, "sig"> = {
    schema: 1,
    mode: "critic",
    rubric: String(v.rubric ?? ""),
    score: v.score,
    pass: true,
    items: v.items.map((item) => ({ id: item.id, pass: true, evidence: item.evidence })),
    deficiencies: Array.isArray(v.deficiencies) ? v.deficiencies.map((d) => String(d)) : [],
    evidence: Array.isArray(v.evidence) ? v.evidence.map((d) => String(d)) : [],
    actor: { kind: "subagent", seat: actor.seat, runId: String(actor.runId ?? ""), lane: actor.lane.map((id) => String(id)), sessionId: actor.sessionId },
    parentSessionId: String(v.parentSessionId ?? ""),
    artifactSha256: v.artifactSha256,
    ...(typeof v.goalRevision === "string" ? { goalRevision: v.goalRevision } : {}),
    ...(typeof v.briefLedgerRevision === "string" ? { briefLedgerRevision: v.briefLedgerRevision } : {}),
    receiptCallIds: v.receiptCallIds.map((id) => String(id)),
  }
  if (body.parentSessionId !== parentSessionId) return { ok: false, reason: "verdict 不属于本会话" }
  if (mediaKind !== "image" && mediaKind !== "video") return { ok: false, reason: "交付媒体类型必须是 image 或 video" }
  const key = verdictKey()
  if (key.ok === false) return { ok: false, reason: key.reason }
  const expect = createHmac("sha256", key.key).update(verdictCanonical(body)).digest("hex")
  const hmacOk = expect === v.sig
  const runFixture = body.actor.runId === "critic:fixture" || body.actor.runId.includes(":fixture")
  const receiptFixture = body.receiptCallIds.some((id) => id.includes("call_fixture"))
  if (runFixture || receiptFixture) {
    const marks = [
      runFixture ? "runId critic:fixture / :fixture" : "",
      receiptFixture ? "receiptCallIds call_fixture" : "",
    ].filter(Boolean)
    return { ok: false, reason: `拒收夹具签名，HMAC ${hmacOk ? "正确" : "不正确"}：${marks.join("，")}` }
  }
  const rubric = rubricForVerdict(body.rubric)
  if (!rubric) return { ok: false, reason: `未知评分表 ${body.rubric}` }
  if (rubric.media !== mediaKind) {
    return { ok: false, reason: `评分表 ${rubric.id} 媒体类型 ${rubric.media} 与交付媒体类型 ${mediaKind} 不一致` }
  }
  if (!hmacOk) return { ok: false, reason: "verdict 签名对不上 critic lane" }
  return { ok: true, verdict: { ...body, sig: v.sig } }
}

function reviewLocator(output: Output): string | null {
  const url = output.url
  if (typeof url === "string" && /^https?:\/\//i.test(url) && MEDIA_LOCATOR_EXT.test(url)) return url
  const ext = path.extname(output.path || "").toLowerCase()
  if (!MEDIA_LOCATOR_EXT.test(ext) || !/^[0-9a-f]{64}$/.test(output.sha256)) return null
  return `http://project-artifact.local/${output.sha256}${ext}`
}

function asItemList(raw: unknown): CriticItemResult[] | null {
  if (!Array.isArray(raw)) return null
  const items: CriticItemResult[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") return null
    const r = row as { id?: unknown; pass?: unknown; evidence?: unknown; nodeId?: unknown; timecode?: unknown; sourceRequirement?: unknown }
    if (typeof r.id !== "string" || !r.id || typeof r.pass !== "boolean") return null
    items.push({ id: r.id, pass: r.pass, evidence: typeof r.evidence === "string" ? r.evidence : "",
      ...(typeof r.nodeId === "string" ? { nodeId: r.nodeId } : {}), ...(typeof r.timecode === "string" ? { timecode: r.timecode } : {}),
      ...(typeof r.sourceRequirement === "string" ? { sourceRequirement: r.sourceRequirement } : {}) })
  }
  return items
}

async function runCritic(ctx: ExecContext): Promise<ExecResult> {
  const key = `${ctx.node.id}:${ctx.runId}:${ctx.attempt}:${ctx.take}`
  if (criticRounds.has(key)) {
    return { ok: false, code: "bad_input", message: "critic_call_cap: 本节点本轮已经派发过一次 critic", retryable: false }
  }
  criticRounds.add(key)

  const picked = pickMediaInput(ctx.inputs)
  if (!picked) return { ok: false, code: "bad_input", message: "critic 没有可评的图或视频产物", retryable: false }
  const goalRevision = effectiveGoalRevision(ctx.project)
  if (picked.meta?.stage === "candidate" && picked.meta.goalRevision !== goalRevision) return { ok: false, code: "qc_failed", message: "候选目标版本已过期，先更新候选再审", retryable: false }
  const locator = reviewLocator(picked)
  if (!locator) return { ok: false, code: "bad_input", message: "critic 读不到被评产物的媒体地址", retryable: false }
  const rubricId = typeof ctx.params.rubric === "string" ? ctx.params.rubric : ""
  const rubric = rubricOf(rubricId)
  if (!rubric) return { ok: false, code: "bad_input", message: `未知评分表 ${rubricId}`, retryable: false }
  const required = rubric.items ?? []
  if (required.length === 0) return { ok: false, code: "bad_input", message: `评分表 ${rubric.id} 没有可判定条目`, retryable: false }

  const prompt = [
    "你是独立 critic。只审不产。不得与生成方同一会话。",
    `parentSession: ${ctx.sessionId}`,
    `qcNode: ${ctx.node.id}`,
    `rubric: ${rubric.id}`,
    `minScore: ${rubric.minScore}`,
    `artifact: ${locator}`,
    `sha256: ${picked.sha256}`,
    `localPath: ${picked.path}`,
    `goalRevision: ${goalRevision}`,
    `用户原话（保留来源）: ${JSON.stringify(ctx.project.brief.map((b) => ({ messageId: b.messageId, text: b.text })))}`,
    ...required.map((item) => `item ${item.id}: ${item.rule}`),
    "用 read_image 或 vision_analyze 读取 artifact。视频先抽帧再感知。回执必须指向上面的 artifact。",
    "视频必须检查实际动态、声音、字幕及开头/中段/结尾；静帧证据不代表动作与节奏通过。缺少感知能力就明确未覆盖，不得判过。",
    "失败条目必须写 nodeId（可定位时）、timecode（实际观测时）、sourceRequirement（用户消息或评分表条目）与具体反例；未知位置写 unknown，不猜时间码。",
  ].join("\n")

  const dispatched = await dispatchCriticRun(
    { sessionId: ctx.sessionId, qcNodeId: ctx.node.id, prompt, label: `评审 ${ctx.node.id}`, async: false },
    criticDispatchForTest ?? undefined,
  )
  if (!dispatched.ok) {
    return { ok: false, code: "bad_input", message: dispatched.error ?? "critic 派发失败", retryable: false }
  }
  if (dispatched.seat !== criticSeat()) {
    return { ok: false, code: "bad_input", message: "critic 席位不是 critic", retryable: false }
  }
  const childSession = dispatched.sessionId ?? ""
  if (!childSession || childSession === ctx.sessionId) {
    return { ok: false, code: "bad_input", message: "critic 与生成方是同一会话", retryable: false }
  }
  if (dispatched.agent && dispatched.agent !== "critic" && dispatched.agent !== criticSeat()) {
    return { ok: false, code: "bad_input", message: "派发回执的 agent 不是 critic", retryable: false }
  }

  const target: CriticPassTarget = {
    agent: "author",
    label: ctx.node.id,
    runId: dispatched.subagentId ?? childSession,
    text: locator,
    artifacts: [locator],
  }
  const receipt = checkCriticReceipt([target], dispatched.messages)
  if (!receipt.ok) {
    return { ok: false, code: "qc_failed", message: `critic 没有读到被评产物：${receipt.missing.join("；") || "无感知回执"}`, retryable: false }
  }

  const rawVerdict = dispatched.verdict
  if (!rawVerdict || typeof rawVerdict !== "object") {
    return { ok: false, code: "bad_input", message: "critic_verdict_missing: 派发回执里没有 verdict", retryable: false }
  }
  const bag = rawVerdict as { score?: unknown; items?: unknown; deficiencies?: unknown; evidence?: unknown }
  const items = asItemList(bag.items)
  if (!items) return { ok: false, code: "bad_input", message: "critic verdict.items 不是逐项清单", retryable: false }
  if (typeof bag.score !== "number" || !Number.isFinite(bag.score)) {
    return { ok: false, code: "bad_input", message: "critic verdict.score 不是数字", retryable: false }
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  const deficiencies: string[] = []
  for (const item of required) {
    const got = byId.get(item.id)
    if (!got) deficiencies.push(`${item.id} 缺判定`)
    else if (!got.pass) deficiencies.push(`${item.id} 不过：${got.evidence || item.rule}`)
    else if (!got.evidence) deficiencies.push(`${item.id} 没有证据`)
  }
  const score = Math.max(0, Math.min(100, Math.round(bag.score)))
  if (score < rubric.minScore) deficiencies.push(`分数 ${score} 低于 ${rubric.minScore}`)
  if (deficiencies.length > 0) {
    return qualityRework(ctx, picked, deficiencies, byId, { score, minScore: rubric.minScore })
  }

  const body: Omit<SignedCriticVerdict, "sig"> = {
    schema: 1,
    mode: "critic",
    rubric: rubric.id,
    score,
    pass: true,
    items: required.map((item) => ({ id: item.id, pass: true, evidence: byId.get(item.id)!.evidence })),
    deficiencies: [],
    evidence: Array.isArray(bag.evidence) ? bag.evidence.map((e) => String(e)) : [picked.sha256],
    actor: {
      kind: "subagent",
      seat: dispatched.seat,
      runId: dispatched.subagentId ?? "critic",
      lane: dispatched.lane,
      sessionId: childSession,
    },
    parentSessionId: ctx.sessionId,
    artifactSha256: picked.sha256,
    goalRevision,
    briefLedgerRevision: briefLedgerRevision(ctx.project),
    receiptCallIds: receipt.checked.map((row) => row.callId),
  }
  const sig = signVerdict(body)
  if (!sig) return { ok: false, code: "bad_input", message: "critic 判过但生产钥匙不可用，拒绝签发", retryable: false }
  const signed: SignedCriticVerdict = { ...body, sig }
  try {
    const out = await persistVerdict(ctx, picked.path, signed as unknown as Json)
    return {
      ok: true,
      outputs: [{ ...out, meta: { qcScore: score, qcPass: true, qcRubric: rubric.id, criticSeat: dispatched.seat, artifactSha256: picked.sha256 } }],
      costCoins: 0,
    }
  } catch (e) {
    return { ok: false, code: "bad_input", message: `critic 判过但判决写入失败：${errMsg(e)}`, retryable: true }
  }
}

export async function runQc(ctx: ExecContext): Promise<ExecResult> {
  const mode = typeof ctx.params.mode === "string" ? ctx.params.mode : ""
  if (mode === "critic") return runCritic(ctx)
  if (mode !== "machine") {
    return { ok: false, code: "bad_input", message: `qc.mode 必须是 "machine" | "critic"（收到 ${JSON.stringify(ctx.params.mode)}）。`, retryable: false }
  }
  if (ctx.signal.aborted) return { ok: false, code: "cancelled", message: "qc 已取消", retryable: true }

  const picked = pickMediaInput(ctx.inputs)
  if (!picked) return { ok: false, code: "bad_input", message: "qc 需要影音产物输入（video/audio/image），当前没有可检查的产物。", retryable: false }
  if (picked.meta?.stage === "candidate" && picked.meta.goalRevision !== effectiveGoalRevision(ctx.project)) return { ok: false, code: "qc_failed", message: "候选目标版本已过期，先更新候选再审", retryable: false }

  let inspection: QcInspection
  try {
    inspection = await inspectMedia(picked, { project: ctx.project, rubricId: typeof ctx.params.rubric === "string" ? ctx.params.rubric : undefined, thresholds: ctx.params.thresholds })
  } catch (e) {
    return { ok: false, code: "bad_input", message: `qc 未能执行：${errMsg(e)}`, retryable: true }
  }

  if (!inspection.pass) return qualityRework(ctx, picked, inspection.deficiencies, undefined, inspection)

  const verdict: Json = {
    mode: "machine",
    rubric: inspection.rubric,
    score: inspection.score,
    pass: true,
    deficiencies: [],
    metrics: inspection.metrics,
    artifactSha256: picked.sha256,
    goalRevision: effectiveGoalRevision(ctx.project),
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
