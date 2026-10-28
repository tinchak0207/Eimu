// S8c：QC 评分表（纯函数）。machine QC 执行器与 takes 选优共用同一份评分。
// 期望值来源：设计文档 §3.9（时长 ±10%、有音轨、analyzeFilm 的响度/黑帧/冻结帧过阈值）与
// film-qc.ts 的 QC_TARGET_LUFS / QC_TARGET_TP；扣分权重是本片默认评分表 film_default（不含美学项，
// 美学评分按 S8c「禁止打磨」不在此片）。takes 的 select:"qc" 读取 Output.meta.qcScore（takes.ts 的键名）。
import { QC_TARGET_LUFS, QC_TARGET_TP } from "../film-qc.ts"
import type { Output, RubricId } from "./types.ts"

export type MediaKind = "video" | "image" | "audio"

/** 一次机器质检的全部可量测事实；缺陷文字也在这里成形（评分函数只负责扣分）。 */
export interface QcMetrics {
  kind: MediaKind
  filePath: string
  exists: boolean
  decodable: boolean
  probeError: string | null
  hasAudio: boolean
  audioRequired: boolean
  durationSec: number | null
  targetDurationSec: number | null
  durationTolerance: number
  maxDurationSec: number | null
  black: boolean
  blackDetail: string | null
  freeze: boolean
  freezeDetail: string | null
  lufs: number | null
  lufsTarget: number
  lufsTolerance: number
  truePeakDb: number | null
  truePeakMax: number
}

export interface RubricWeights {
  noAudio: number
  duration: number
  black: number
  freeze: number
  loudness: number
  truePeak: number
}

export interface Rubric {
  id: RubricId
  title: string
  /** 低于此分判不过（设计文档 §3.9「qc 评分≥阈值」；阈值为本片默认，可由 params.thresholds.minScore 覆盖）。 */
  minScore: number
  weights: RubricWeights
}

/** 默认及格线：任一单条硬缺陷（权重 45–50）都会把 100 拉到 55 以下。 */
export const QC_MIN_SCORE = 60

/** 可测响度下限：低于此值视为近乎静音（与 film-qc.ts qcAndFixFilm 的 -70 判定同一口径）。 */
export const QUIET_LUFS = -70

export const RUBRICS: Readonly<Record<string, Rubric>> = {
  film_default: {
    id: "film_default",
    title: "影音交付默认",
    minScore: QC_MIN_SCORE,
    weights: { noAudio: 45, duration: 45, black: 50, freeze: 45, loudness: 45, truePeak: 45 },
  },
}

export const DEFAULT_RUBRIC_ID = "film_default"

/** 未知 id 返回 null（执行器据此报 bad_input，而不是静默套默认表）。缺省=film_default。 */
export function rubricOf(id?: string | null): Rubric | null {
  if (!id) return RUBRICS[DEFAULT_RUBRIC_ID]
  return Object.prototype.hasOwnProperty.call(RUBRICS, id) ? RUBRICS[id] : null
}

export interface QcVerdict {
  score: number
  pass: boolean
  deficiencies: string[]
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`

/**
 * 评分：100 起扣，每类缺陷扣 rubric.weights 里声明的分。
 * 文件不存在/无法解码是硬失败（0 分，不看及格线）；其余按 minScore 判过。
 */
export function scoreQc(m: QcMetrics, rubric: Rubric = RUBRICS[DEFAULT_RUBRIC_ID]): QcVerdict {
  if (!m.exists) return { score: 0, pass: false, deficiencies: [`文件不存在：${m.filePath}`] }
  if (!m.decodable) return { score: 0, pass: false, deficiencies: [`无法解码：${m.probeError ?? "ffprobe 读不出任何流"}`] }

  const w = rubric.weights
  const deficiencies: string[] = []
  let score = 100

  if (m.audioRequired && !m.hasAudio) {
    score -= w.noAudio
    deficiencies.push(m.kind === "audio" ? "无音轨：音频交付里没有音频流" : "无音轨：交付要求有声音，但文件没有音频流")
  }

  if (m.kind !== "image") {
    if (m.durationSec === null || !(m.durationSec > 0)) {
      score -= w.duration
      deficiencies.push("时长为 0：ffprobe 读不出有效时长")
    } else if (m.targetDurationSec !== null) {
      const deviation = Math.abs(m.durationSec - m.targetDurationSec) / m.targetDurationSec
      if (deviation > m.durationTolerance) {
        score -= w.duration
        deficiencies.push(
          `时长 ${m.durationSec.toFixed(2)}s 偏离目标 ${m.targetDurationSec}s 达 ${pct(deviation)}（容差 ${pct(m.durationTolerance)}）`,
        )
      }
    } else if (m.maxDurationSec !== null && m.durationSec > m.maxDurationSec) {
      score -= w.duration
      deficiencies.push(`时长 ${m.durationSec.toFixed(2)}s 超过上限 ${m.maxDurationSec}s`)
    }
  }

  if (m.black) {
    score -= w.black
    deficiencies.push(m.blackDetail ?? "全黑：画面为黑")
  }
  if (m.freeze) {
    score -= w.freeze
    deficiencies.push(m.freezeDetail ?? "冻结：画面静止")
  }

  if (m.hasAudio) {
    if (m.lufs === null) {
      if (m.audioRequired) {
        score -= w.loudness
        deficiencies.push("响度无法测量（ebur128 无结果）")
      }
    } else if (m.lufs <= QUIET_LUFS) {
      if (m.audioRequired) {
        score -= w.loudness
        deficiencies.push(`音轨近乎静音（${m.lufs.toFixed(1)} LUFS），响度不可用`)
      }
    } else {
      if (Math.abs(m.lufs - m.lufsTarget) > m.lufsTolerance) {
        score -= w.loudness
        deficiencies.push(`响度 ${m.lufs.toFixed(1)} LUFS 超出 ${m.lufsTarget}±${m.lufsTolerance} LUFS`)
      }
      if (m.truePeakDb !== null && m.truePeakDb > m.truePeakMax) {
        score -= w.truePeak
        deficiencies.push(`真峰值 ${m.truePeakDb.toFixed(1)} dBFS 超过上限 ${m.truePeakMax} dBFS`)
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, pass: score >= rubric.minScore, deficiencies }
}

/** 把 QC 分数写进候选产物的 meta.qcScore（S4：takes select:"qc" 按它取最高分）。返回浅拷贝，不改原产物。 */
export function scoredOutput(o: Output, verdict: Pick<QcVerdict, "score" | "pass"> & { deficiencies?: string[] }): Output {
  return {
    ...o,
    meta: {
      ...(o.meta ?? {}),
      qcScore: verdict.score,
      qcPass: verdict.pass,
      ...(verdict.deficiencies ? { qcDeficiencies: verdict.deficiencies } : {}),
    },
  }
}

/** 默认阈值（qc 节点 params.thresholds 的同名键可覆盖）。 */
export const QC_DEFAULT_THRESHOLDS = {
  durationTolerance: 0.1, // 设计文档 §3.9：targets.durationSec ±10%
  lufsTolerance: 1.5, // 与 film-qc.ts 的 LOUD_TOLERANCE_LU 同一口径
  lufsTarget: QC_TARGET_LUFS,
  truePeakDb: QC_TARGET_TP,
} as const
