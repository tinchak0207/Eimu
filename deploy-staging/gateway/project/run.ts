// S6 一轮 run 的编排（设计文档 §3.4 / §10 S6）：准入 → beginRun → 执行 → finishRun。
//
// 顺序不是随便排的：准入在 beginRun 之前——预算不足/价目缺失/待确认的轮次根本不碰图里的 activeRun，
// 也不会给节点写 running；用户看到的只是一个回执，不是一条半死的执行链。
// 确认与预算拒绝都只回执（status=needs_user/rejected），本函数全程只 await 自己的执行器，不 await 用户。
import { createHash, randomUUID } from "node:crypto"
import { admit, buildPlan, type AdmissionInput, type ConfirmPort, type Quote } from "./admission.ts"
import { CacheIndex } from "./cache-index.ts"
import { effectiveGoalRevision } from "./digest.ts"
import { upgradeLegacyVideoCandidate } from "./legacy-import.ts"
import { recoverProject, type PlatformTaskQuery, type RecoveryDeps, type RecoveryOutcome } from "./recovery.ts"
import { executePlan, type RunDeps, type RunExecution } from "./scheduler.ts"
import { workspaceDir, type ProjectStore } from "./store.ts"
import type { NodeId, ProjectContinuation, ProjectContinuationTask, ProjectGraph } from "./types.ts"

export interface RunRequest {
  /** 仅内部已报价/确认入口：把独立prepared节点接入现有工作代。 */
  joinPreparedNode?: NodeId
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
const RUN_SIGNALS = new Map<string, AbortController>()
interface ActiveAdmission {
  ready: Promise<void>; publish: () => void; accepting: boolean
  runId?: string; signal: AbortSignal; nodes: Set<NodeId>
  operations: Map<string, NodeId>
  joins: Map<NodeId, Promise<{ result: RunResult; execution?: RunExecution }>>
}
const ACTIVE_ADMISSIONS = new Map<string, ActiveAdmission>()

function executionResult(execution: RunExecution, quote: Quote): RunResult {
  return { ok: execution.status !== "failed", runId: execution.runId, status: execution.status, quote,
    done: execution.done.length + execution.reused.length, failed: execution.failed, stale: execution.stale,
    blocked: execution.blocked, needsUser: execution.needsUser, awaitingAuthor: execution.awaitingAuthor,
    inFlightUnknown: execution.inFlightUnknown, cursor: execution.cursor }
}

/** 复用同一executePlan；不会新开执行代，不能把普通依赖节点塞进并发旁路。 */
export async function joinPreparedRun(store: ProjectStore, inputDeps: RunDeps & RecoveryDeps, nodeId: NodeId, authorized?: () => Promise<boolean>): Promise<RunResult | null> {
  const active = ACTIVE_ADMISSIONS.get(store.paths.dir)
  if (!active) return null
  await active.ready
  const rejected = async (reason: string): Promise<RunResult> => ({ ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: (await store.read()).seq, reason })
  const prior = active.joins.get(nodeId)
  if (prior) return (await prior).result
  if (!active.accepting || !active.runId || active.signal.aborted) return rejected("project_run_closing: 本工作代已关闭接入或已取消；节点保留，未提交")
  if (active.nodes.has(nodeId)) return rejected("join_target_overlap: 节点已经属于原计划，不从新入口重做")
  active.nodes.add(nodeId)
  const joined = Promise.resolve().then(async () => {
    const runId = active.runId!
    const graph = await store.read()
    const node = graph.nodes[nodeId]
    const prepared = node?.params.toolSubmission as { payload?: unknown; identity?: { request_id?: unknown } } | undefined
    if (graph.activeRun !== runId || graph.continuation?.cancelled && graph.continuation.runId === runId || active.signal.aborted) return { result: await rejected("join_cancelled: 原工作代已撤销，未提交") }
    if (!node || !["keyframe", "clip"].includes(node.type) || Object.keys(node.inputs).length || !prepared?.payload || typeof prepared.identity?.request_id !== "string" || node.pinned || node.locked || node.lastRun || node.outputs.length) return { result: await rejected("join_unsupported: 只接收服务端持久登记、无依赖、未运行且未锁定的prepared生成节点") }
    const operationNode = active.operations.get(prepared.identity.request_id)
    if (operationNode && operationNode !== nodeId) return { result: await rejected(`join_operation_overlap: 原operation已属于${operationNode}，未提交第二节点`) }
    active.operations.set(prepared.identity.request_id, nodeId)
    if (!authorized || !await authorized()) return { result: await rejected("join_needs_authorization: 缺少实际操作批准") }
    await store.update(g => {
      if (g.activeRun !== runId || active.signal.aborted) throw new Error("join_cancelled")
      g.activeRunAdmission ??= { runId, accepting: active.accepting, joinedNodes: [] }
      g.activeRunAdmission.joinedNodes.push(nodeId)
      g.nodes[nodeId].status = "queued"
    })
    const signal = inputDeps.signal ? AbortSignal.any([active.signal, inputDeps.signal]) : active.signal
    const deps = { ...inputDeps, signal, cache: inputDeps.cache ?? CacheIndex.forProject(workspaceDir(), store.sessionId) }
    const { plan } = await buildPlan({ store, deps, targets: [nodeId], mode: "incremental" })
    const admission = await admit({ store, deps, plan, authorized })
    if (admission.ok === false) {
      const failure = admission as Extract<typeof admission, { ok: false }>
      return { result: { ok: false, status: failure.status, reason: failure.reason, quote: failure.quote, cursor: (await store.read()).seq } as RunResult }
    }
    const execution = await executePlan(store, deps, runId, plan)
    return { execution, result: executionResult(execution, admission.quote) }
  }).catch(async error => ({ result: await rejected(`join_failed: ${error instanceof Error ? error.message : String(error)}`) }))
  active.joins.set(nodeId, joined)
  return (await joined).result
}

async function closeJoinedRuns(store: ProjectStore, execution: RunExecution): Promise<RunExecution> {
  const active = ACTIVE_ADMISSIONS.get(store.paths.dir)
  if (!active || active.runId !== execution.runId) return execution
  // 同一JS边界先关接收，再等已登记promise。finish不能越过在途join。
  active.accepting = false
  await store.update(g => { if (g.activeRunAdmission?.runId === execution.runId) g.activeRunAdmission.accepting = false })
  for (const [nodeId, joinedPromise] of active.joins) {
    const joined = await joinedPromise
    const other = joined.execution
    if (!other) {
      if (!(await store.read()).activeRunAdmission?.joinedNodes.includes(nodeId)) continue
      const reason = joined.result.reason ?? "joined operation did not execute"
      execution.blocked.push({ node: nodeId, reason })
      await store.update(g => {
        if (g.activeRun !== execution.runId || active.signal.aborted || !g.activeRunAdmission?.joinedNodes.includes(nodeId)) return
        g.nodes[nodeId].status = "blocked"
        g.nodes[nodeId].error = { code: "blocked", message: reason, retryable: false, at: new Date().toISOString() }
      })
      continue
    }
    for (const key of ["done", "failed", "skipped", "stale", "reused", "pinned", "needsUser", "awaitingAuthor", "inFlightUnknown"] as const) execution[key] = [...new Set([...execution[key], ...other[key]])]
    execution.blocked.push(...other.blocked)
    execution.costCoins += other.costCoins
    execution.cursor = Math.max(execution.cursor, other.cursor)
  }
  execution.status = execution.failed.length ? "failed" : execution.needsUser.length ? "needs_user" : execution.blocked.length || execution.awaitingAuthor.length || execution.inFlightUnknown.length ? "partial" : "done"
  return execution
}

/** 执行轮次不是新工作的证明：同待办、同输入代沿用同一投递身份。 */
function responsibilityId(graph: Readonly<ProjectGraph>, kind: ProjectContinuationTask["kind"], nodes: NodeId[], targets?: NodeId[]): string {
  const facts = [...nodes].sort().map((id) => {
    const n = graph.nodes[id]
    return n ? { id, rev: n.rev, params: n.params, inputs: n.inputs, refs: n.refs, signature: n.signature,
      outputs: n.outputs.map((o) => o.sha256), inflight: n.inflight?.idemKey,
      error: n.error ? { code: n.error.code, message: n.error.message } : undefined } : { id, missing: true }
  })
  return `pc_${createHash("sha256").update(JSON.stringify({ kind, facts, targets: targets ? [...targets].sort() : null, goal: effectiveGoalRevision(graph) })).digest("hex").slice(0, 32)}`
}

/** 用户 stop 同时中止真正的节点执行，并耐久撤销接续。已提交上游不虚称取消。 */
export async function cancelProjectRun(store: ProjectStore): Promise<void> {
  RUN_SIGNALS.get(store.paths.dir)?.abort(new Error("用户停止当前工程"))
  await store.update((g) => {
    if (!g.continuation || (g.activeRun && g.continuation.runId !== g.activeRun)) {
      g.continuation = { runId: g.activeRun ?? "cancelled", cancelled: true, tasks: [] }
    }
    g.continuation.cancelled = true
    for (const task of g.continuation.tasks) if (task.delivery !== "completed") task.delivery = "cancelled"
  })
}

/** 一轮 run。deps 里带 session/ledger/submitGeneration/execBridge；cache 缺省用 projects/<sid>/cache.json。 */
export async function runProject(store: ProjectStore, inputDeps: RunDeps & RecoveryDeps, req: RunRequest = {}): Promise<RunResult> {
  const key = store.paths.dir
  if (ACTIVE_RUNS.has(key)) {
    if (req.joinPreparedNode) return await joinPreparedRun(store, inputDeps, req.joinPreparedNode, req.authorized) ?? { ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: (await store.read()).seq, reason: "project_run_closing: 原工作代已关闭接入，节点保留未提交" }
    const g = await store.read()
    return { ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: g.seq, reason: "这一轮已经在跑，拒绝并发双跑（防双扣费）。" }
  }
  ACTIVE_RUNS.add(key)
  const controller = new AbortController()
  RUN_SIGNALS.set(key, controller)
  const signal = inputDeps.signal ? AbortSignal.any([inputDeps.signal, controller.signal]) : controller.signal
  let publish!: () => void
  const ready = new Promise<void>(resolve => { publish = resolve })
  const admission: ActiveAdmission = { ready, publish, accepting: false, signal, nodes: new Set(), operations: new Map(), joins: new Map() }
  ACTIVE_ADMISSIONS.set(key, admission)
  try {
    return await runProjectInner(store, { ...inputDeps, signal }, req)
  } finally {
    admission.accepting = false
    admission.publish()
    if (ACTIVE_ADMISSIONS.get(key) === admission) ACTIVE_ADMISSIONS.delete(key)
    ACTIVE_RUNS.delete(key)
    if (RUN_SIGNALS.get(key) === controller) RUN_SIGNALS.delete(key)
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
    recovery = await recoverProject(store, { ...deps, authorizedRecovery: req.authorized ?? deps.authorizedRecovery, ...(req.queryTask ? { queryTask: req.queryTask } : {}) })
  }

  const graph = await store.read()
  if (graph.activeRun) {
    return {
      ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: graph.seq,
      reason: `已有 run 在进行（${graph.activeRun}）；等它结束或恢复后再开。`,
    }
  }

  // plan 用「现在」的图算；执行时每个节点再取最新图与自己启动时的签名（用户中途改参数 → stale）。
  const legacy = await upgradeLegacyVideoCandidate(store)
  if (legacy.blocked) return { ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: (await store.read()).seq, reason: legacy.blocked }
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
  if (deps.signal?.aborted) return { ok: false, status: "rejected", quote: approvedQuote, cursor: (await store.read()).seq, reason: "用户已撤销当前执行，未提交新工作。" }
  await store.beginRun(runId)
  const activeAdmission = ACTIVE_ADMISSIONS.get(store.paths.dir)
  if (activeAdmission) {
    activeAdmission.runId = runId
    activeAdmission.nodes = new Set([...plan.toRun, ...plan.unknown, ...plan.reuse, ...plan.pinned, ...plan.blocked])
    for (const id of activeAdmission.nodes) {
      const request = (built.graph.nodes[id]?.params.toolSubmission as { identity?: { request_id?: string } } | undefined)?.identity?.request_id
      if (request) activeAdmission.operations.set(request, id)
    }
    activeAdmission.accepting = true
    await store.update(g => { g.activeRunAdmission = { runId, accepting: true, joinedNodes: [] } })
    activeAdmission.publish()
  }
  let execution: RunExecution
  try {
    execution = await closeJoinedRuns(store, await executePlan(store, deps, runId, plan))
  } catch (error) {
    if (activeAdmission) {
      activeAdmission.accepting = false
      RUN_SIGNALS.get(store.paths.dir)?.abort(error)
      await Promise.all(activeAdmission.joins.values())
    }
    const reason = error instanceof Error ? error.message : String(error)
    await store.finishRun(runId, {
      runId, targets: req.targets, cancelled: deps.signal?.aborted ?? false,
      tasks: [{ id: `${runId}:fault`, kind: "platform_fault", owner: "operator", nodes: [], reason, delivery: "pending" }],
    })
    throw error
  }
  {
    const after = await store.read()
    const continuationTargets = req.targets ? [...new Set([...req.targets, ...(after.activeRunAdmission?.runId === runId ? after.activeRunAdmission.joinedNodes : [])])] : undefined
    const tasks: ProjectContinuationTask[] = []
    const add = (kind: ProjectContinuationTask["kind"], owner: ProjectContinuationTask["owner"], nodes: NodeId[], reason: string) => {
      if (!nodes.length) return
      const id = responsibilityId(after, kind, nodes, continuationTargets)
      const previous = !after.continuation?.cancelled ? after.continuation?.tasks.find((task) => task.id === id) : undefined
      tasks.push({ id, kind, owner, nodes, reason, delivery: deps.signal?.aborted ? "cancelled" : previous?.delivery ?? "pending" })
    }
    add("author", "orchestrator", execution.awaitingAuthor, "作者内容尚未写入。按现有研究、派工与节点 lane 完成内容，保留用户目标；不得只解释等待。")
    add("provider_unknown", "reconciler", execution.inFlightUnknown.filter((id) => after.nodes[id]?.error?.code !== "platform_fault"), "上游提交结果未知；只按原 operation 对账，不得换键重投或让模型轮询。")
    add("user", "user", execution.needsUser, "等待必要用户选择或真实授权，不能自动批准。")
    const qc = execution.failed.filter((id) => after.nodes[id]?.error?.code === "qc_failed")
    add("qc_rework", "orchestrator", qc, qc.map((id) => `${id}: ${after.nodes[id]?.error?.message ?? "审片不通过"}`).join("\n"))
    const faults = [...execution.failed.filter((id) => !qc.includes(id)), ...execution.inFlightUnknown.filter((id) => after.nodes[id]?.error?.code === "platform_fault")]
    add("platform_fault", "operator", faults, faults.map((id) => `${id}: ${after.nodes[id]?.error?.message ?? "执行失败，原因未知"}`).join("\n"))
    if (!tasks.length && execution.blocked.length) add("platform_fault", "operator", execution.blocked.map((b) => b.node), execution.blocked.map((b) => `${b.node}: ${b.reason}`).join("\n"))
    if (execution.status === "done") add("continue", "orchestrator", [...new Set([...execution.done, ...execution.reused, ...execution.pinned])], "本轮节点执行结束。核对实际成片、独立评审与可编辑工程交付；节点完成不等于整单完成。")
    const continuation: ProjectContinuation = { runId, targets: continuationTargets, tasks, ...(deps.signal?.aborted ? { cancelled: true } : {}) }
    await store.finishRun(runId, continuation)
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
