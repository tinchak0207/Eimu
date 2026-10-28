// S5：工程图的账本写入器与项目预算。
// LedgerWriter 把 ProjectGraph 的执行事件落到现有 quota-ledger（同一份 ledger.jsonl），行里带 project_id/node_id/signature 等。
// 项目预算镜像 image_generate 的 authorizedProjectBudget + prepareSubmission：先预留、成功转实扣、明确失败才释放，
// 提交结果未知（submit_unknown）绝不释放。预留表在进程内；崩溃后由调度器用同一 Idempotency-Key 重走 reserve（幂等）。
import type { SessionState } from "../types-gateway.ts"
import type { LedgerEntry } from "../quota-ledger.ts"
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
}

const EPS = 1e-8
export function createProjectBudget(opts: {
  /** 返回该项目的硬预算（币）；null = 没有额外上限；抛错 = 预算不可读，fail-closed 拒绝提交。 */
  capOf: (projectId: string) => Promise<number | null>
  /** 本进程之外已经实扣的币（例如工程图 budget.spentCoins）。 */
  spentOf?: (projectId: string) => number
}): ProjectBudgetPort {
  const reservations = new Map<string, { projectId: string; coins: number }>()
  const spent = new Map<string, number>()
  const totals = (projectId: string) => {
    let reserved = 0
    for (const r of reservations.values()) if (r.projectId === projectId) reserved += r.coins
    return { reserved, spent: (opts.spentOf?.(projectId) ?? 0) + (spent.get(projectId) ?? 0) }
  }
  return {
    async reserve({ projectId, idemKey, coins }) {
      if (!Number.isFinite(coins) || coins < 0) return { ok: false, code: "budget_unavailable", message: "invalid_budget: 预留币值必须为非负有限数；未提交。" }
      if (reservations.has(idemKey)) return { ok: true }
      let cap: number | null
      try { cap = await opts.capOf(projectId) }
      catch (e) { return { ok: false, code: "budget_unavailable", message: `project_budget_unavailable: 项目预算暂不可读取，未提交（${(e as Error).message}）。` } }
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
