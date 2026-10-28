// S5：工程图的账本写入器与项目预算。
// LedgerWriter 把 ProjectGraph 的执行事件落到现有 quota-ledger（同一份 ledger.jsonl），行里带 project_id/node_id/signature 等。
// 项目预算镜像 image_generate 的 authorizedProjectBudget + prepareSubmission：先预留、成功转实扣、明确失败才释放，
// 提交结果未知（submit_unknown）绝不释放。预留表在进程内；崩溃后由调度器用同一 Idempotency-Key 重走 reserve（幂等）。
import { readFileSync } from "node:fs"
import type { SessionState } from "../types-gateway.ts"
import type { LedgerEntry } from "../quota-ledger.ts"
import { LEDGER_PATH } from "../constants-gateway.ts"
import { appendLedgerFor } from "../quota-ledger.ts"
import type { LedgerWriter } from "./types.ts"

export type LedgerSessionLike = Pick<SessionState, "apiKey" | "sessionId" | "opencodeSessionId">
export type LedgerAppend = (state: SessionState, overrides: Partial<LedgerEntry>) => Promise<void>

export function createLedgerWriter(session: LedgerSessionLike, append: LedgerAppend = appendLedgerFor): LedgerWriter {
  return {
    async write(e) {
      const { event, ...rest } = e
      // reused 行永远是 0 币：复用不花钱，账本不得出现“复用但有成本”的行。
      const cost = event === "reused" ? 0 : rest.cost_coins
      await append(session as SessionState, { ...rest, ...(cost !== undefined ? { cost_coins: cost } : {}), kind: "generation", event, ...(event === "reused" ? { reused: true } : {}) })
    },
  }
}

export type BudgetReserveResult =
  | { ok: true; version?: string; source?: string }
  | { ok: false; code: "budget_exceeded" | "budget_unavailable"; message: string }

export interface ProjectBudgetPort {
  /** 幂等：同一 idemKey 重复预留不叠加。 */
  reserve(a: { projectId: string; idemKey: string; coins: number }): Promise<BudgetReserveResult>
  /** 成功：预留转为实扣。 */
  settle(idemKey: string, actualCoins: number): void
  /** 明确失败/已退款：释放预留。submit_unknown 不得调用。 */
  release(idemKey: string): void
  snapshot(projectId: string): { reserved: number; spent: number }
  /** 跨轮基线：图上已花费 + 账本未决预留，以及图上的硬上限。 */
  noteCarry?(carry: { spentCoins: number; capCoins: number | null }): void
}

const EPS = 1e-8
export function createProjectBudget(opts: {
  /** 返回该项目的硬预算（币）；null = 没有额外上限；抛错 = 预算不可读，fail-closed 拒绝提交。 */
  capOf: (projectId: string) => Promise<number | null>
  /** 本进程之外已经实扣的币（例如工程图 budget.spentCoins）。与 noteCarry 叠加，两边不要填同一笔。 */
  spentOf?: (projectId: string) => number
  /** 每次预留前等待（路由把跨轮基线放进 noteCarry 之后再放行 POST）。 */
  beforeReserve?: () => Promise<void>
}): ProjectBudgetPort {
  const reservations = new Map<string, { projectId: string; coins: number }>()
  const spent = new Map<string, number>()
  let carrySpent = 0
  let graphCap: number | null | undefined
  const totals = (projectId: string) => {
    let reserved = 0
    for (const r of reservations.values()) if (r.projectId === projectId) reserved += r.coins
    return { reserved, spent: (opts.spentOf?.(projectId) ?? 0) + carrySpent + (spent.get(projectId) ?? 0) }
  }
  return {
    noteCarry(carry) {
      carrySpent = Number.isFinite(carry.spentCoins) && carry.spentCoins > 0 ? carry.spentCoins : 0
      graphCap = carry.capCoins
    },
    async reserve({ projectId, idemKey, coins }) {
      if (opts.beforeReserve) await opts.beforeReserve()
      if (!Number.isFinite(coins) || coins < 0) return { ok: false, code: "budget_unavailable", message: "invalid_budget: 预留币值必须为非负有限数；未提交。" }
      if (reservations.has(idemKey)) return { ok: true }
      let configured: number | null
      try { configured = await opts.capOf(projectId) }
      catch (e) { return { ok: false, code: "budget_unavailable", message: `project_budget_unavailable: 项目预算暂不可读取，未提交（${(e as Error).message}）。` } }
      const caps = [configured, graphCap].filter((c): c is number => typeof c === "number" && Number.isFinite(c))
      const cap = caps.length ? Math.min(...caps) : null
      const t = totals(projectId)
      if (cap != null && t.reserved + t.spent + coins > cap + EPS)
        return { ok: false, code: "budget_exceeded", message: `task_budget_exceeded: 已保留 ${t.reserved} 币、已实扣 ${t.spent} 币，本次 ${coins} 币，硬预算 ${cap} 币；未提交。` }
      reservations.set(idemKey, { projectId, coins })
      return { ok: true, version: cap == null ? "no_extra_cap" : undefined, source: cap == null ? "no_extra_cap" : "human_config" }
    },
    settle(idemKey, actualCoins) {
      const r = reservations.get(idemKey)
      if (!r) return
      reservations.delete(idemKey)
      spent.set(r.projectId, (spent.get(r.projectId) ?? 0) + (Number.isFinite(actualCoins) ? actualCoins : r.coins))
    },
    release(idemKey) { reservations.delete(idemKey) },
    snapshot: totals,
  }
}

/** 网关生产接线：项目硬预算取自 generation_project_authorizations（只有人手确认的配置写入口能填），与 /internal/project-budget 同源。 */
export function gatewayProjectCapOf(sessionId: string): (projectId: string) => Promise<number | null> {
  return async (project) => {
    const { stableGenerationOwnerScope } = await import("../job-delivery.ts")
    const { generationProjectAuthorization } = await import("../job-store.ts")
    const ownerScope = await stableGenerationOwnerScope(sessionId)
    if (!ownerScope) throw new Error("trusted stable owner identity unavailable")
    const authorization = generationProjectAuthorization(ownerScope, project)
    if (!authorization) return null
    const cap = Number(authorization.cap_coins)
    if (!Number.isFinite(cap) || cap < 0) throw new Error("project budget record invalid")
    return cap
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/**
 * 跨轮已占用币：max(图上 spentCoins, 账本已完成) + 账本里尚未终态的 submitted（submit_unknown 未决预留）。
 * ledgerText 仅测试注入；缺省读 LEDGER_PATH，读不到就只认图上已花费。
 */
export function accumulatedSpendCoins(
  graph: { id: string; budget?: { spentCoins?: number } },
  ledgerText?: string,
): number {
  const graphSpent = typeof graph.budget?.spentCoins === "number" && Number.isFinite(graph.budget.spentCoins) ? graph.budget.spentCoins : 0
  let text = ledgerText
  if (text === undefined) {
    try { text = readFileSync(LEDGER_PATH, "utf8") } catch { text = "" }
  }
  const open = new Map<string, number>()
  const settledByKey = new Map<string, number>()
  let settledNoKey = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let row: { project_id?: unknown; event?: unknown; cost_coins?: unknown; idem_key?: unknown }
    try { row = JSON.parse(line) as typeof row } catch { continue }
    if (row.project_id !== graph.id) continue
    const event = typeof row.event === "string" ? row.event : ""
    const cost = typeof row.cost_coins === "number" && Number.isFinite(row.cost_coins) ? row.cost_coins : 0
    const key = typeof row.idem_key === "string" ? row.idem_key : ""
    if (!key) {
      if (event === "completed") settledNoKey += cost
      continue
    }
    if (event === "submitted") {
      if (!open.has(key) && !settledByKey.has(key)) open.set(key, cost)
    } else if (event === "completed") {
      open.delete(key)
      settledByKey.set(key, cost)
    } else if (event === "failed" || event === "refunded") {
      open.delete(key)
      if (!settledByKey.has(key)) settledByKey.set(key, 0)
    }
  }
  let ledgerSettled = settledNoKey
  for (const v of settledByKey.values()) ledgerSettled += v
  let ledgerOpen = 0
  for (const v of open.values()) ledgerOpen += v
  return round6(Math.max(graphSpent, ledgerSettled) + ledgerOpen)
}

export function graphCapCoins(graph: { budget?: { capCoins?: number | null } }): number | null {
  const cap = graph.budget?.capCoins
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : null
}

const sessionBudgets = new Map<string, ProjectBudgetPort>()

/** 生产 RunDeps 把本轮预算挂到会话上，music/voice 与图片视频走同一只预留桶。 */
export function bindSessionBudget(sessionId: string, budget: ProjectBudgetPort | undefined): void {
  if (!budget) sessionBudgets.delete(sessionId)
  else sessionBudgets.set(sessionId, budget)
}

export function sessionBudgetOf(sessionId: string): ProjectBudgetPort | undefined {
  return sessionBudgets.get(sessionId)
}

export async function reserveGenerationCharge(
  sessionId: string,
  a: { projectId: string; idemKey: string; coins: number },
): Promise<{ ok: true; bound: boolean } | { ok: false; code: "bad_input" | "provider_error"; message: string; retryable: boolean }> {
  const budget = sessionBudgets.get(sessionId)
  if (!budget) return { ok: true, bound: false }
  const reserved = await budget.reserve(a)
  if (reserved.ok) return { ok: true, bound: true }
  return {
    ok: false,
    code: reserved.code === "budget_exceeded" ? "bad_input" : "provider_error",
    message: reserved.message,
    retryable: reserved.code === "budget_unavailable",
  }
}

export function settleGenerationCharge(sessionId: string, idemKey: string, actualCoins: number): void {
  sessionBudgets.get(sessionId)?.settle(idemKey, actualCoins)
}

export function releaseGenerationCharge(sessionId: string, idemKey: string): void {
  sessionBudgets.get(sessionId)?.release(idemKey)
}
