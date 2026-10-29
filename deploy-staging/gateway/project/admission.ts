// S6 准入（设计文档 §3.9 闸 / §10 S6「报价→确认→预算」）。
//
// 四道判断，顺序固定（先便宜后昂贵、先安全后花钱）：
//   1) 可运行性：toRun 节点缺必需参数 → 直接拒绝（宁可不动手，不为缺 prompt 的节点预留预算）。
//   2) 报价：逐节点 executor.estimate()；报不出价（null / 没注册执行器）= 未知价，真实运行一律拒绝。
//      takes 节点按候选数 n 计价（n 个候选都要提交）。
//   3) 预算：min(工程 budget.capCoins, 本次 budget_coins) 与 已花 + S5 在途预留 + 本次报价 比较。
//   4) 确认：报价 ≥ CONFIRM_THRESHOLD_COINS 且会话不是 auto/full 授权 → 开一张确认卡。
//      **确认必须非阻塞**：本档只登记请求并立即返回 "needs_user"，绝不在 run 里 await 用户
//      （记忆 workflow-template-abandon-incident-fix：内联等确认 15 分钟把工具超时打死的结构性死结）。
//      auto/full（billingAutoApprovalEnabled）→ 直接放行。
// dry_run 只走 1)+2) 并回执报价，不执行、不弹卡、不预留。
import { createHash } from "node:crypto"
import { CONFIRM_THRESHOLD_COINS, CONFIRM_TIMEOUT_MS } from "../constants-gateway.ts"
import { getExecutor } from "./executor-registry.ts"
import type { ProjectBudgetPort } from "./ledger.ts"
import { planRun } from "./signature.ts"
import { NODE_SPECS_LITE } from "./specs.ts"
import { checkRunnable } from "./validate.ts"
import type { NodeId, ProjectGraph, RunPlan } from "./types.ts"
import type { ProjectStore } from "./store.ts"
import { researchGate } from "./research.ts"
import type { RunDeps } from "./scheduler.ts"

export interface Quote {
  coins: number | null
  /** 含重生的最坏报价。确认阈值仍比 coins（不含重生的本轮底价），不比这个。 */
  coinsHigh?: number | null
  /** 本轮节点里 onFail.regenerate 的最大次数。 */
  regenMax?: number
  /** 确认卡文案：预计 x–y 币（含最多 k 次重生）。 */
  rangeLabel?: string
  run: number
  reuse: number
  pinned: number
  unknownPrice: NodeId[]
}

/**
 * 确认端口：登记一张非阻塞确认卡并立即返回；`status` 供用户答复后重入时查结果。
 * 生产接线走 handleConfirmRequest/settleConfirm 语义（pendingConfirms + emit confirm.request），
 * 本片只定义接口，不 import media-internal-routes（避免把路由层拖进引擎）。
 */
export interface ConfirmPort {
  request(a: { sessionId: string; requestId: string; amountCoins: number; description: string }): Promise<"pending" | "approved" | "denied" | "unavailable">
  status?(requestId: string): Promise<"pending" | "approved" | "denied" | "unknown">
}

/**
 * 会话确认端口：把「登记 pendingConfirms + emit confirm.request + 立即返回 pending」这一套
 * （handleConfirmRequest 的非阻塞语义）做成可注入适配器。
 * settle / statusOf 由接线方传 media-internal-routes 的 settleConfirm 与 pendingConfirms/resolvedConfirms 读取——
 * 本档不 import 路由层，也不自己发明第二套确认状态。
 */
export function sessionConfirmPort<P extends { timer: unknown }>(host: {
  state: { sessionId: string; pendingConfirms: Map<string, P> }
  createEntry: (a: { requestId: string; amountCoins: number; description: string }) => P
  emit: (name: string, data: unknown) => void
  settle: (requestId: string, outcome: "approved" | "denied" | "expired") => boolean
  statusOf: (requestId: string) => "pending" | "approved" | "denied" | "unknown"
  timeoutMs?: number
}): ConfirmPort {
  return {
    async request(a) {
      if (host.state.pendingConfirms.has(a.requestId)) return "pending"
      const entry = host.createEntry({ requestId: a.requestId, amountCoins: a.amountCoins, description: a.description })
      host.state.pendingConfirms.set(a.requestId, entry)
      const timer = setTimeout(() => { host.settle(a.requestId, "expired") }, host.timeoutMs ?? CONFIRM_TIMEOUT_MS)
      ;(entry as { timer: unknown }).timer = timer
      host.emit("confirm.request", { request_id: a.requestId, amount_coins: a.amountCoins, description: a.description })
      return "pending" // 绝不 await 用户
    },
    async status(requestId) {
      return host.statusOf(requestId)
    },
  }
}

export interface AdmissionInput {
  store: ProjectStore
  /** RunDeps 里的会话/缓存/预算只读口；不跑执行，所以不需要 ledger/submit。 */
  deps: Pick<RunDeps, "session" | "cache"> & { concurrency?: number }
  plan?: RunPlan
  targets?: NodeId[]
  mode?: "incremental" | "force"
  dry_run?: boolean
  budget_coins?: number
  /** 上一次 needs_user 回执里带回来的确认请求 id（用户答复后重入）。 */
  confirm_request_id?: string
  /** 测试/接线覆盖确认阈值（缺省 constants-gateway 的 CONFIRM_THRESHOLD_COINS）。 */
  confirmThreshold?: number
  confirm?: ConfirmPort
  /** S5 的项目预算预留（只读快照）；不传则只按图里的 spentCoins 算。 */
  budget?: Pick<ProjectBudgetPort, "snapshot">
  /** 授权查询；缺省按 billingAutoApprovalEnabled（auto 互动模式或 full 权限）。 */
  authorized?: () => Promise<boolean>
}

export type AdmissionResult =
  | { ok: true; quote: Quote; mode: "run" | "quote" }
  | { ok: false; status: "rejected"; reason: string; quote: Quote }
  | { ok: false; status: "needs_user"; reason: string; quote: Quote; requestId?: string }

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export async function buildPlan(input: Pick<AdmissionInput, "store" | "deps" | "targets" | "mode">): Promise<{ graph: ProjectGraph; plan: RunPlan }> {
  const graph = await input.store.read()
  const plan = await planRun(graph, input.targets, input.mode ?? "incremental", input.store.artifacts, NODE_SPECS_LITE, input.deps.cache)
  return { graph, plan }
}

/** 逐节点报价；null=报不出价。takes 按候选数计。 */
export async function computeQuote(
  store: ProjectStore, graph: Readonly<ProjectGraph>, plan: RunPlan, deps: Pick<RunDeps, "session">,
): Promise<Quote> {
  const unknownPrice: NodeId[] = []
  // unknown 节点也要跑（§3.2.5「保守视为要跑」），所以一并报价。
  const planned = [...new Set([...plan.toRun, ...plan.unknown])]
  let coins = 0
  let coinsHigh = 0
  let regenMax = 0
  for (const id of planned) {
    const node = graph.nodes[id]
    if (!node) {
      unknownPrice.push(id)
      continue
    }
    const executor = getExecutor(node.type)
    if (!executor) {
      unknownPrice.push(id)
      continue
    }
    // select:"user" 的候选池已经产出过（等选 / 已选）：本轮不会再花钱，不报价。
    if (node.takes?.select === "user" && (node.takesPool?.length ?? 0) > 0) continue
    let unit: number | null
    try {
      unit = await executor.estimate(node, graph, deps.session)
    } catch {
      unit = null
    }
    if (unit === null || !Number.isFinite(unit) || unit < 0) {
      unknownPrice.push(id)
      continue
    }
    const takesN = node.takes?.n ?? 1
    const onFail = node.onFail as { action?: string; max?: number } | undefined
    const regen = onFail?.action === "regenerate" && typeof onFail.max === "number" && onFail.max > 0 ? onFail.max : 0
    const base = unit * takesN
    coins += base
    // 最坏：每个候选都按 onFail.max 重生，(1+max) 次提交。
    coinsHigh += base * (1 + regen)
    if (regen > regenMax) regenMax = regen
  }
  const low = round6(coins)
  const high = round6(coinsHigh)
  return {
    coins: unknownPrice.length ? null : low,
    coinsHigh: unknownPrice.length ? null : high,
    regenMax,
    ...(unknownPrice.length ? {} : { rangeLabel: `预计 ${low}–${high} 币（含最多 ${regenMax} 次重生）` }),
    run: planned.length,
    reuse: plan.reuse.length,
    pinned: plan.pinned.length,
    unknownPrice,
  }
}

async function defaultAuthorized(session: unknown): Promise<boolean> {
  const { billingAutoApprovalEnabled } = await import("../charge-approval-policy.ts")
  return billingAutoApprovalEnabled(session as Parameters<typeof billingAutoApprovalEnabled>[0])
}

function requestIdOf(sessionId: string, quote: Quote): string {
  const h = createHash("sha256").update(`${sessionId}|${quote.coins}|${quote.run}`).digest("hex").slice(0, 12)
  return `pgrun_${h}`
}

export async function admit(input: AdmissionInput): Promise<AdmissionResult> {
  const { store, deps } = input
  const { graph, plan } = input.plan ? { graph: await store.read(), plan: input.plan } : await buildPlan(input)
  const quote = await computeQuote(store, graph, plan, deps)

  // 1) 可运行性（缺必需参数 → 现在是 error）
  const notRunnable: string[] = []
  for (const id of [...new Set([...plan.toRun, ...plan.unknown])]) {
    for (const issue of checkRunnable(graph, id)) {
      if (issue.severity !== "error") continue
      notRunnable.push(issue.message)
      if (notRunnable.length >= 5) break
    }
    if (notRunnable.length >= 5) break
  }

  if (input.dry_run) return { ok: true, mode: "quote", quote }

  // R-20 研究闸：研究没写满，要花钱的节点一律不开跑（作者节点 0 成本照常跑，研究本身就是作者节点）。
  const gate = researchGate(graph)
  if (gate && (quote.coins === null || quote.coins > 0)) {
    return { ok: false, status: "rejected", reason: gate, quote }
  }

  if (notRunnable.length) {
    return { ok: false, status: "rejected", reason: `节点还不能运行：${notRunnable.join("；")}`, quote }
  }

  // 2) 价目缺失 → 拒绝（不以未知价格开跑）
  if (quote.coins === null) {
    return {
      ok: false,
      status: "rejected",
      reason: `报不出价：${quote.unknownPrice.slice(0, 6).join(", ")}${quote.unknownPrice.length > 6 ? " …" : ""}；没有权威报价不提交。`,
      quote,
    }
  }

  // 3) 预算上限（工程预算与本次上限取小）
  const caps = [graph.budget?.capCoins, input.budget_coins].filter((c): c is number => typeof c === "number" && Number.isFinite(c))
  const cap = caps.length ? Math.min(...caps) : null
  if (cap !== null) {
    const graphSpent = Number.isFinite(graph.budget?.spentCoins) ? graph.budget.spentCoins : 0
    let spent = graphSpent
    let reserved = 0
    if (input.budget) {
      try {
        const snap = input.budget.snapshot(graph.id)
        reserved = snap.reserved
        // snap.spent 含跨轮基线（图上已花 + submit_unknown 未决预留）。模拟口只填 reserved 时 spent 为 0，不能把图上已花抹掉。
        if (Number.isFinite(snap.spent)) spent = Math.max(graphSpent, snap.spent)
      } catch {
        return { ok: false, status: "rejected", reason: "工程预算预留状态不可读，未开跑。", quote }
      }
    }
    if (spent + reserved + quote.coins > cap + 1e-6) {
      return {
        ok: false,
        status: "rejected",
        reason: `预算不足：已花 ${round6(spent)} 币、在途预留 ${round6(reserved)} 币，本次报价 ${quote.coins} 币，上限 ${round6(cap)} 币；未开跑。`,
        quote,
      }
    }
  }

  // 阈值保持现状：比的是不含重生的本轮底价 quote.coins，不是最坏价。数字来自 CONFIRM_THRESHOLD_COINS。
  const threshold = input.confirmThreshold ?? CONFIRM_THRESHOLD_COINS
  if (quote.coins > 0 && quote.coins >= threshold) {
    const authorized = input.authorized ? await input.authorized() : await defaultAuthorized(deps.session)
    if (!authorized) {
      const requestId = input.confirm_request_id ?? requestIdOf(store.sessionId, quote)
      if (input.confirm_request_id && input.confirm?.status) {
        const st = await input.confirm.status(input.confirm_request_id)
        if (st === "approved") return { ok: true, mode: "run", quote }
        if (st === "denied") return { ok: false, status: "rejected", reason: "用户驳回了这笔花费，未开跑。", quote }
        return { ok: false, status: "needs_user", reason: "等待用户确认这笔花费（未阻塞 run）。", quote, requestId }
      }
      if (!input.confirm) {
        // 端口未接线：诚实地停在 needs_user，不假装在等、也不擅自放行。
        return { ok: false, status: "needs_user", reason: "估算金额超过确认阈值，但确认端口未接线；未开跑。", quote }
      }
      const st = await input.confirm.request({
        sessionId: store.sessionId,
        requestId,
        amountCoins: quote.coins,
        description: `工程 ${graph.id} 本轮${quote.rangeLabel ?? `预计 ${quote.coins}–${quote.coinsHigh ?? quote.coins} 币（含最多 ${quote.regenMax ?? 0} 次重生）`}（${quote.run} 个节点待跑）`,
      })
      if (st === "approved") return { ok: true, mode: "run", quote }
      if (st === "denied") return { ok: false, status: "rejected", reason: "用户驳回了这笔花费，未开跑。", quote }
      return {
        ok: false,
        status: "needs_user",
        reason: st === "unavailable" ? "确认卡未能登记（端口不可用）；未开跑。" : "等待用户确认这笔花费（未阻塞 run）。",
        quote,
        requestId,
      }
    }
  }

  return { ok: true, mode: "run", quote }
}
