// ===== project/takes.ts — takes / onFail 的数据处理（设计文档 §3.3，S4；不含执行）=====
// 纯函数：校验、失败后的决策、候选选择、种子推导。调度器（S6）和 QC 执行器（S8c）调用。
import { LIMITS } from "./constants"
import type { OnFail, Output, TakesSpec } from "./types"

/** takesPool 里每个候选的 QC 评分写在 Output.meta[QC_SCORE_META_KEY]（数字）。 */
export const QC_SCORE_META_KEY = "qcScore"

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v)

/** 返回错误列表（空=合法）。 */
export function validateTakes(t: unknown): string[] {
  if (t === undefined) return []
  if (!isObj(t)) return [`takes 必须是对象，例如 {"n":3,"select":"qc","rubric":"kf_basic"}。`]
  const errs: string[] = []
  if (!isInt(t.n) || t.n < 2 || t.n > LIMITS.TAKES_MAX) errs.push(`takes.n 必须是 2..${LIMITS.TAKES_MAX} 的整数（收到 ${JSON.stringify(t.n)}）。只要 1 个结果就不要设 takes。`)
  if (t.select !== "qc" && t.select !== "first" && t.select !== "user") errs.push(`takes.select 必须是 "qc" | "first" | "user"（收到 ${JSON.stringify(t.select)}）。`)
  if (t.rubric !== undefined && (typeof t.rubric !== "string" || t.rubric === "")) errs.push(`takes.rubric 必须是非空字符串（评分表 id）。`)
  return errs
}

export function validateOnFail(o: unknown): string[] {
  if (o === undefined) return []
  if (!isObj(o)) return [`onFail 必须是对象，例如 {"action":"regenerate","max":2,"then":"ask_user"}。`]
  const a = o.action
  if (a === "fail" || a === "skip" || a === "ask_user") return []
  if (a !== "regenerate") return [`onFail.action 必须是 "regenerate" | "fail" | "skip" | "ask_user"（收到 ${JSON.stringify(a)}）。`]
  const errs: string[] = []
  if (!isInt(o.max) || o.max < 1 || o.max > LIMITS.REGENERATE_MAX) errs.push(`onFail.max 必须是 1..${LIMITS.REGENERATE_MAX} 的整数（收到 ${JSON.stringify(o.max)}）。`)
  if (o.on !== undefined && o.on !== "error" && o.on !== "qc_fail" && o.on !== "any") errs.push(`onFail.on 必须是 "error" | "qc_fail" | "any"。`)
  if (o.then !== undefined && o.then !== "fail" && o.then !== "skip" && o.then !== "ask_user") errs.push(`onFail.then 必须是 "fail" | "skip" | "ask_user"。`)
  return errs
}

export type FailureKind = "error" | "qc_fail"
export type FailDecision =
  | { do: "regenerate"; retryNo: number }   // retryNo=这是第几次重生成（1 起）
  | { do: "fail" } | { do: "skip" } | { do: "ask_user" }

/** 失败后怎么办。retriesUsed=已经做过的重生成次数。未配置 onFail=失败即失败。 */
export function decideOnFail(onFail: OnFail | undefined, failure: FailureKind, retriesUsed: number): FailDecision {
  if (!onFail) return { do: "fail" }
  if (onFail.action !== "regenerate") return { do: onFail.action }
  const on = onFail.on ?? "any"
  const matches = on === "any" || on === failure
  if (matches && retriesUsed < onFail.max) return { do: "regenerate", retryNo: retriesUsed + 1 }
  return { do: onFail.then ?? "fail" }
}

/**
 * 提交载荷用的有效种子（不改 params.seed）。take 步长 = REGENERATE_MAX+1，保证 takes×重试 的网格内种子互不相同；
 * take=0 时恰为设计文档的“重生成 seed+1”。
 */
export function effectiveSeed(baseSeed: number, retriesUsed: number, take = 0): number {
  return baseSeed + take * (LIMITS.REGENERATE_MAX + 1) + retriesUsed
}

/** take 序号从 0 起（无 takes 的节点 take=0）。 */
export function takeInRange(takes: TakesSpec | undefined, take: number): boolean {
  if (!isInt(take) || take < 0) return false
  return take < (takes ? takes.n : 1)
}

export type TakeSelection =
  | { kind: "selected"; take: number; outputs: Output[]; score?: number }
  | { kind: "pending_user" }
  | { kind: "none"; reason: string }

/** 按 take 分组，保持候选到达顺序。 */
export function groupByTake(pool: readonly Output[]): Map<number, Output[]> {
  const g = new Map<number, Output[]>()
  for (const o of pool) {
    const t = o.take ?? 0
    const arr = g.get(t)
    if (arr) arr.push(o)
    else g.set(t, [o])
  }
  return g
}

function scoreOf(outs: readonly Output[]): number | undefined {
  for (const o of outs) {
    const s = o.meta?.[QC_SCORE_META_KEY]
    if (typeof s === "number" && Number.isFinite(s)) return s
  }
  return undefined
}

/** 从候选池选一个 take。first=最先到达的；qc=分最高（同分取序号小的，无分的不参选）；user=等 select_take。 */
export function selectTake(takes: TakesSpec, pool: readonly Output[]): TakeSelection {
  const groups = groupByTake(pool)
  if (groups.size === 0) return { kind: "none", reason: "没有任何成功的候选" }
  if (takes.select === "user") return { kind: "pending_user" }
  if (takes.select === "first") {
    const [take, outputs] = groups.entries().next().value as [number, Output[]]
    return { kind: "selected", take, outputs }
  }
  let best: { take: number; outputs: Output[]; score: number } | null = null
  for (const [take, outputs] of groups) {
    const score = scoreOf(outputs)
    if (score === undefined) continue
    if (!best || score > best.score || (score === best.score && take < best.take)) best = { take, outputs, score }
  }
  if (!best) return { kind: "none", reason: "候选都没有 QC 评分" }
  return { kind: "selected", ...best }
}
