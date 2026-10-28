// S6 一轮 run 的编排（设计文档 §3.4 / §10 S6）：准入 → beginRun → 执行 → finishRun。
//
// 顺序不是随便排的：准入在 beginRun 之前——预算不足/价目缺失/待确认的轮次根本不碰图里的 activeRun，
// 也不会给节点写 running；用户看到的只是一个回执，不是一条半死的执行链。
// 确认与预算拒绝都只回执（status=needs_user/rejected），本函数全程只 await 自己的执行器，不 await 用户。
import { randomUUID } from "node:crypto"
import { admit, buildPlan, type AdmissionInput, type ConfirmPort, type Quote } from "./admission.ts"
import { CacheIndex } from "./cache-index.ts"
import { recoverProject, type PlatformTaskQuery, type RecoveryDeps, type RecoveryOutcome } from "./recovery.ts"
import { executePlan, type RunDeps, type RunExecution } from "./scheduler.ts"
import { workspaceDir, type ProjectStore } from "./store.ts"
import type { NodeId } from "./types.ts"

export interface RunRequest {
  targets?: NodeId[]
  mode?: "incremental" | "force"
  dry_run?: boolean
  /** 本次运行的钱上限（与工程 budget.capCoins 取小）。 */
  budget_coins?: number
  /** 上一次 needs_user 回执里的确认请求 id（用户答复后重入）。 */
  confirm_request_id?: string
  /** 先做崩溃恢复：接续在途任务、把 lost 节点按签名重跑。 */
  resume?: boolean
  /** 测试/接线覆盖（缺省 CONFIRM_THRESHOLD_COINS）。 */
  confirmThreshold?: number
  confirm?: ConfirmPort
  authorized?: () => Promise<boolean>
  /** 平台任务只读查询（恢复用）。 */
  queryTask?: PlatformTaskQuery
}

export type RunStatus = "quoted" | "started" | "running" | "done" | "partial" | "failed" | "needs_user" | "rejected"

export interface RunResult {
  ok: boolean
  runId?: string
  status: RunStatus
  quote: Quote
  done?: number
  failed?: NodeId[]
  stale?: NodeId[]
  blocked?: { node: NodeId; reason: string }[]
  needsUser?: NodeId[]
  awaitingAuthor?: NodeId[]
  /** submit_unknown 的在途节点：结果未定，恢复流程用同 key 核对。 */
  inFlightUnknown?: NodeId[]
  reason?: string
  requestId?: string
  cursor: number
  recovery?: RecoveryOutcome
}

const EMPTY_QUOTE: Quote = { coins: null, run: 0, reuse: 0, pinned: 0, unknownPrice: [] }

// 网关单进程：同一工程同时只允许一轮 run（两个入口并发会双跑双扣费）。
// 图里的 activeRun 只管跨重启的遗留标记，管不住同一进程内的竞态，所以这里再加一道进程内互斥。
const ACTIVE_RUNS = new Set<string>()

/** 一轮 run。deps 里带 session/ledger/submitGeneration/execBridge；cache 缺省用 projects/<sid>/cache.json。 */
export async function runProject(store: ProjectStore, inputDeps: RunDeps & RecoveryDeps, req: RunRequest = {}): Promise<RunResult> {
  const key = store.paths.dir
  if (ACTIVE_RUNS.has(key)) {
    const g = await store.read()
    return { ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: g.seq, reason: "这一轮已经在跑，拒绝并发双跑（防双扣费）。" }
  }
  ACTIVE_RUNS.add(key)
  try {
    return await runProjectInner(store, inputDeps, req)
  } finally {
    ACTIVE_RUNS.delete(key)
  }
}

async function runProjectInner(store: ProjectStore, inputDeps: RunDeps & RecoveryDeps, req: RunRequest): Promise<RunResult> {
  // 缓存索引默认落在 projects/<sid>/cache.json（§3.2 第 6 条）；测试/接线可注入。
  const deps: RunDeps & RecoveryDeps = { ...inputDeps, cache: inputDeps.cache ?? CacheIndex.forProject(workspaceDir(), store.sessionId) }
  let recovery: RecoveryOutcome | undefined
  if (req.resume) {
    // 崩溃遗留的 activeRun 先收尾（它不是「正在跑」，是没人管的死标记）。
    const pre = await store.read()
    if (pre.activeRun) await store.finishRun(pre.activeRun)
    recovery = await recoverProject(store, { ...deps, ...(req.queryTask ? { queryTask: req.queryTask } : {}) })
  }

  const graph = await store.read()
  if (graph.activeRun) {
    return {
      ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: graph.seq,
      reason: `已有 run 在进行（${graph.activeRun}）；等它结束或恢复后再开。`,
    }
  }

  // plan 用「现在」的图算；执行时每个节点再取最新图与自己启动时的签名（用户中途改参数 → stale）。
  const built = await buildPlan({ store, deps, targets: req.targets, mode: req.mode })
  const plan = built.plan

  const admissionInput: AdmissionInput = {
    store,
    deps,
    plan,
    ...(deps.budget ? { budget: deps.budget } : {}),
    ...(req.dry_run !== undefined ? { dry_run: req.dry_run } : {}),
    ...(req.budget_coins !== undefined ? { budget_coins: req.budget_coins } : {}),
    ...(req.confirm_request_id !== undefined ? { confirm_request_id: req.confirm_request_id } : {}),
    ...(req.confirmThreshold !== undefined ? { confirmThreshold: req.confirmThreshold } : {}),
    ...(req.confirm ? { confirm: req.confirm } : {}),
    ...(req.authorized ? { authorized: req.authorized } : {}),
  }
  const verdict = await admit(admissionInput)
  // strictNullChecks=false 下联合类型不按 boolean 字面量收窄：显式分成两支。
  const approvedQuote = (verdict as Extract<typeof verdict, { ok: true }>).quote

  if (verdict.ok === true) {
    if ((verdict as Extract<typeof verdict, { ok: true }>).mode === "quote") {
      return { ok: true, status: "quoted", quote: approvedQuote, cursor: graph.seq, ...(recovery ? { recovery } : {}) }
    }
  } else {
    const fail = verdict as Extract<typeof verdict, { ok: false }>
    return {
      ok: false, status: fail.status, quote: fail.quote, reason: fail.reason,
      ...(fail.status === "needs_user" && fail.requestId ? { requestId: fail.requestId } : {}),
      cursor: graph.seq,
      ...(recovery ? { recovery } : {}),
    }
  }

  const runId = `pg_${randomUUID().replace(/-/g, "").slice(0, 16)}`
  await store.beginRun(runId)
  let execution: RunExecution
  try {
    execution = await executePlan(store, deps, runId, plan)
  } finally {
    await store.finishRun(runId)
  }

  const status: RunStatus =
    execution.status === "done" ? "done"
      : execution.status === "failed" ? "failed"
        : execution.status === "needs_user" ? "needs_user"
          : "partial"

  return {
    ok: status !== "failed",
    runId,
    status,
    quote: approvedQuote,
    done: execution.done.length + execution.reused.length,
    failed: execution.failed,
    stale: execution.stale,
    blocked: execution.blocked,
    needsUser: execution.needsUser,
    awaitingAuthor: execution.awaitingAuthor,
    ...(execution.inFlightUnknown.length ? { inFlightUnknown: execution.inFlightUnknown } : {}),
    cursor: execution.cursor,
    ...(recovery ? { recovery } : {}),
  }
}
