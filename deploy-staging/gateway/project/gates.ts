// S17：工程模式的交付前置检查（设计文档 §3.9「闸：删闸不加闸」）。
//
// 只有两种入口，且都只查产物：
//   - checkExportArtifacts：export 节点前置检查（文件在且 sha256 对、ffprobe 可解码、时长合规、有音轨）。
//   - checkQcMedia：qc 节点前置检查（响度、黑帧、冻结帧、评分阈值）。
//
// 工程模式下模型的自然语言「已完成」不触发本档任何函数，也不产生交付卡：
// deliverablesFromExport 只读 type==="export" 的节点产物，文本节点写得再像交付也不算。
//
// 复用量测轮子：ffprobe/analyzeFilm 走 executors/qc.ts 的 measureMedia / inspectMedia（同一份口径），
// 阈值来自 rubrics.ts；本档不新增检查项，也不改旧席位任何路径（旧席位的 delivery-gate 等闸不受影响）。
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { inspectMedia, measureMedia, type MediaMeasurement } from "./executors/qc.ts"
import { rubricOf } from "./rubrics.ts"
import type { Json, NodeId, Output, ProjectGraph, Sha256, Targets } from "./types.ts"

/** 设计文档 §3.9：targets.durationSec ±10%。 */
export const GATE_DURATION_TOLERANCE = 0.1

/** 无 targets 时的配方时长上限范围（秒）：§3.9「非零且 ≤ 配方上限 8–90 秒」。 */
export const GATE_RECIPE_MIN_MAX_SEC = 8
export const GATE_RECIPE_MAX_MAX_SEC = 90

/** 配方没声明上限时的缺省值（取范围上界，宁松不卡）。 */
export const GATE_DEFAULT_MAX_DURATION_SEC = GATE_RECIPE_MAX_MAX_SEC

export type GateCheckId =
  | "file_exists"
  | "sha256"
  | "decodable"
  | "duration"
  | "audio"
  | "loudness"
  | "black"
  | "freeze"
  | "qc_score"

export interface GateCheck {
  id: GateCheckId
  ok: boolean
  detail: string
}

export interface GateResult {
  ok: boolean
  checks: GateCheck[]
  /** 失败项的 detail（人话），顺序与 checks 一致。 */
  deficiencies: string[]
}

export interface ExportGateOptions {
  ffmpeg?: string
  /** 工程目标；null/缺省时只检查「非零且 ≤ 配方上限」。 */
  targets?: Targets | null
  /** 配方声明的成片上限（秒）；按 §3.9 钳在 8–90，缺省 90。 */
  maxDurationSec?: number
  /** 测试/审计可注入的 sha256；缺省流式读文件现算。 */
  sha256Of?: (file: string) => Promise<string>
}

export interface QcGateOptions {
  ffmpeg?: string
  project?: Readonly<ProjectGraph>
  rubricId?: string
  thresholds?: Json
}

/** 把配方上限钳进 §3.9 的 8–90 秒；没给或非正数用 90。 */
export function clampRecipeMaxDuration(v?: number | null): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return GATE_DEFAULT_MAX_DURATION_SEC
  return Math.min(GATE_RECIPE_MAX_MAX_SEC, Math.max(GATE_RECIPE_MIN_MAX_SEC, v))
}

/** 文件内容 sha256（64 位小写 hex）。与 artifact-store 的 hashFile 同一算法/同一流式读法。 */
export async function sha256File(file: string): Promise<Sha256> {
  const h = createHash("sha256")
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest("hex")
}

const failed = (checks: GateCheck[]): GateResult => {
  const bad = checks.filter((c) => !c.ok)
  return { ok: bad.length === 0, checks, deficiencies: bad.map((c) => c.detail) }
}

const fmtSec = (v: number) => `${v.toFixed(2)}s`

function targetDurationOf(targets: Targets | null | undefined): number | null {
  const d = targets && typeof targets.durationSec === "number" ? targets.durationSec : null
  return d !== null && Number.isFinite(d) && d > 0 ? d : null
}

/** targets.audio≠"none" 时必须有音轨；无 targets 不要求（§3.9 字面）。 */
function audioRequiredBy(targets: Targets | null | undefined): boolean {
  return Boolean(targets) && targets!.audio !== "none"
}

function durationCheck(m: MediaMeasurement, opts: ExportGateOptions): GateCheck {
  const measured = m.durationSec
  if (measured === null || !(measured > 0)) {
    return { id: "duration", ok: false, detail: "时长为 0：ffprobe 读不出有效时长" }
  }
  const target = targetDurationOf(opts.targets)
  if (target !== null) {
    const deviation = Math.abs(measured - target) / target
    const ok = deviation <= GATE_DURATION_TOLERANCE
    return {
      id: "duration",
      ok,
      detail: ok
        ? `时长 ${fmtSec(measured)}（目标 ${target}s，偏差 ${(deviation * 100).toFixed(1)}% ≤ 10%）`
        : `时长 ${fmtSec(measured)} 偏离目标 ${target}s 达 ${(deviation * 100).toFixed(1)}%（容差 10%）`,
    }
  }
  const max = clampRecipeMaxDuration(opts.maxDurationSec)
  const ok = measured <= max
  return {
    id: "duration",
    ok,
    detail: ok
      ? `时长 ${fmtSec(measured)}（无时长目标；上限 ${max}s）`
      : `时长 ${fmtSec(measured)} 超过配方上限 ${max}s`,
  }
}

async function checksForOutput(o: Output, opts: ExportGateOptions): Promise<GateCheck[]> {
  const checks: GateCheck[] = []
  let exists = false
  try {
    exists = (await stat(o.path)).isFile()
  } catch {
    exists = false
  }
  if (!exists) {
    checks.push({ id: "file_exists", ok: false, detail: `文件不存在：${o.path}` })
    checks.push({ id: "sha256", ok: false, detail: "文件不存在，无法核对 sha256" })
    checks.push({ id: "decodable", ok: false, detail: "文件不存在，无法解码" })
    if (o.mime?.startsWith("image/")) return checks
    checks.push({ id: "duration", ok: false, detail: "文件不存在，读不出时长" })
    if (audioRequiredBy(opts.targets)) checks.push({ id: "audio", ok: false, detail: "文件不存在，读不出音轨" })
    return checks
  }
  checks.push({ id: "file_exists", ok: true, detail: `文件存在：${o.path}` })

  const hash = await (opts.sha256Of ?? sha256File)(o.path).catch(() => null)
  const shaOk = typeof o.sha256 === "string" && o.sha256.length === 64 && hash === o.sha256
  checks.push({
    id: "sha256",
    ok: shaOk,
    detail: shaOk ? `sha256 一致（${o.sha256.slice(0, 12)}…）` : `sha256 不符：产物登记 ${String(o.sha256).slice(0, 64)}，文件实算 ${String(hash).slice(0, 64)}`,
  })

  const m = await measureMedia(opts.ffmpeg ?? "ffmpeg", o)
  checks.push({
    id: "decodable",
    ok: m.decodable,
    detail: m.decodable ? "ffprobe 可解码" : `无法解码：${m.probeError ?? "ffprobe 读不出任何流"}`,
  })
  if (!m.decodable || m.kind === "image") return checks

  checks.push(durationCheck(m, opts))
  if (audioRequiredBy(opts.targets)) {
    const ok = m.hasAudio
    checks.push({
      id: "audio",
      ok,
      detail: ok ? "有音轨" : "无音轨：工程目标要求有声音（targets.audio≠\"none\"）",
    })
  }
  return checks
}

/** export 节点前置检查：逐产物查存在/sha256/可解码/时长/音轨。空产物=没有交付。 */
export async function checkExportArtifacts(outputs: readonly Output[], opts: ExportGateOptions = {}): Promise<GateResult> {
  if (outputs.length === 0) {
    return failed([{ id: "file_exists", ok: false, detail: "export 没有产物：没有可交付的文件" }])
  }
  const checks: GateCheck[] = []
  for (const o of outputs) checks.push(...(await checksForOutput(o, opts)))
  return failed(checks)
}

const loudnessDeficiency = (deficiencies: readonly string[]): string | undefined =>
  deficiencies.find((d) => d.startsWith("响度") || d.startsWith("音轨近乎静音") || d.startsWith("真峰值"))

/**
 * qc 节点前置检查：响度/黑帧/冻结帧/评分阈值。
 * 量测与扣分全部复用 executors/qc.ts:inspectMedia → rubrics.ts:scoreQc，本档只把结果拆成逐项检查。
 */
export async function checkQcMedia(output: Output, opts: QcGateOptions = {}): Promise<GateResult> {
  if (!rubricOf(opts.rubricId)) throw new Error(`未知评分表 ${String(opts.rubricId)}`)
  const r = await inspectMedia(output, {
    ffmpeg: opts.ffmpeg ?? "ffmpeg",
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.rubricId ? { rubricId: opts.rubricId } : {}),
    ...(opts.thresholds !== undefined ? { thresholds: opts.thresholds } : {}),
  })
  const m = r.measurement
  const loud = loudnessDeficiency(r.deficiencies)
  const checks: GateCheck[] = [
    { id: "file_exists", ok: m.exists, detail: m.exists ? `文件存在：${m.filePath}` : `文件不存在：${m.filePath}` },
    { id: "decodable", ok: m.decodable, detail: m.decodable ? "ffprobe 可解码" : `无法解码：${m.probeError ?? "ffprobe 读不出任何流"}` },
    {
      id: "loudness",
      ok: !loud,
      detail: loud ?? (m.hasAudio ? `响度在阈内${m.lufs !== null ? `（${m.lufs.toFixed(1)} LUFS）` : ""}` : "无音轨：响度不适用"),
    },
    { id: "black", ok: !m.black, detail: m.black ? m.blackDetail ?? "全黑：画面为黑" : "无黑帧" },
    { id: "freeze", ok: !m.freeze, detail: m.freeze ? m.freezeDetail ?? "冻结：画面静止" : "无冻结帧" },
    {
      id: "qc_score",
      ok: r.pass,
      detail: `qc 分数 ${r.score}/${r.minScore}${r.pass ? "（过阈）" : `（低于阈值：${r.deficiencies.join("；") || "未给出缺陷说明"}）`}`,
    },
  ]
  return failed(checks)
}

export interface Deliverable {
  nodeId: NodeId
  output: Output
}

/**
 * 交付卡的唯一渲染源：export 节点的已落盘产物。
 * 文本/意图/模型自述一律不算交付；没有 export 节点或它没有产物 → 空数组。
 */
export function deliverablesFromExport(graph: Readonly<ProjectGraph>): Deliverable[] {
  const out: Deliverable[] = []
  const seen = new Set<NodeId>()
  for (const id of [...graph.order, ...Object.keys(graph.nodes)]) {
    if (seen.has(id)) continue
    seen.add(id)
    const node = graph.nodes[id]
    if (!node || node.type !== "export") continue
    if (node.params.stage === "candidate") continue
    if (node.status !== "done" || node.scratch) continue
    for (const output of node.outputs ?? []) {
      if (output.meta?.stage === "candidate") continue
      out.push({ nodeId: node.id, output })
    }
  }
  return out
}
