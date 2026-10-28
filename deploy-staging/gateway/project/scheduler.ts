// S6 调度器：按签名增量执行（设计文档 §3.4 并发/崩溃恢复、§3.3 takes/onFail、§3.2 复用）。
//
// 职责边界：
//   - planRun（S1）决定 toRun/reuse/pinned/blocked；本档只执行，不重算复用策略。
//   - 每个节点完成后在 store.update() 的锁内落 node.status/outputs/lastRun/signature/error/inflight，
//     再 appendEvents（node_status/node_output/node_reused/cost）。图写全走 S2 的锁。
//   - 执行器通过 executor-registry 注入（fake 可测）；本档不 import project/executors/*。
//   - 复用节点不入队、不调执行器，但必发 node_reused 事件 + reused 账本行（cost_coins=0）。
//   - 结果落盘前比较「启动时签名」与「当前签名」：不同 → 结果照存（钱已花）、节点置 stale。
//     自产物引起的签名变化（reference 的内容指纹 / takes 被选产物）不算漂移：用「把本节点产物回退成
//     启动时样子」的探针签名对照，只有探针 ≠ 启动签名才算用户改了参数/上游变了。
//   - 失败：本节点 failed（或用尽后 skip/ask_user）、下游 blocked 且不调下游执行器。
//   - 作者节点（script/shotlist）无内容（执行器回 bad_input "awaiting authored content"）不是执行失败：
//     节点保持 pending、下游 blocked(reason="awaiting author")、整轮不算失败。
//   - submit_unknown：冻结为 running + inflight.submitUnknown，不重试、不换 key，交 recovery.ts 核对。
import { readFile } from "node:fs/promises"
import { idempotencyKeyOf } from "./submit-generation.ts"
import { NODE_SPECS_LITE, materializeDefaults, specOf } from "./specs.ts"
import { computeSignature, findReusable, nodeDependencies, type CacheLookup } from "./signature.ts"
import { decideOnFail, effectiveSeed, selectTake, type FailureKind } from "./takes.ts"
import { getExecutor } from "./executor-registry.ts"
import type { ProjectBudgetPort } from "./ledger.ts"
import type {
  ExecBridgeClient, ExecContext, ExecResult, Inflight, Iso, Json, NodeId, NodeStatus, Output, ProjectGraph, ProjectNode,
  RunId, RunPlan, SubmitGenerationFn, LedgerWriter,
} from "./types.ts"
import type { ProjectStore } from "./store.ts"

const MAIN_PORT = "out"
const AUTHOR_AWAITING = /awaiting authored content/i

/** 层内并发上限。0=不限（与网关现有「同层 Promise.all」行为一致）；env PROJECT_RUN_CONCURRENCY 可收紧，不是必需 env。 */
export function concurrencyLimit(override?: number): number {
  if (override !== undefined && Number.isFinite(override)) return Math.max(0, Math.floor(override))
  const raw = (process.env.PROJECT_RUN_CONCURRENCY ?? "").trim()
  if (raw === "") return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export interface RunDeps {
  /** 网关 SessionState（执行器只取 apiKey/用户设置，Deps 原样透传）。 */
  session: unknown
  ledger: LedgerWriter
  submitGeneration: SubmitGenerationFn
  execBridge: ExecBridgeClient
  /** 签名缓存索引（可选；不传则只认节点自己的上次产物）。put 存在时执行成功会写入缓存，供后续/同签名节点复用。 */
  cache?: CacheLookup & { put?(signature: string, outputs: Output[], costCoins: number): Promise<void> }
  /** S5 的项目预算预留（只读快照）：准入把在途预留算进「已花 + 预留 + 本次报价」。 */
  budget?: Pick<ProjectBudgetPort, "snapshot">
  /** 层内并发上限；缺省读 env / 不限。 */
  concurrency?: number
  signal?: AbortSignal
  now?: () => Date
  /** takes select:"qc" 的评分端口（S11z 接 scoreTakeOutput）；缺省只读候选 meta.qcScore。 */
  scoreTake?: (output: Output, node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>) => Promise<Output>
}

export interface NodeRunReport {
  node: NodeId
  status: NodeStatus
  costCoins: number
  reason?: string
  error?: { code: string; message: string; retryable: boolean }
  awaitingAuthor?: boolean
  needsUser?: boolean
  needsRecovery?: boolean
  outputs?: Output[]
  take?: number
}

export interface RunExecution {
  runId: RunId
  status: "done" | "partial" | "failed" | "needs_user"
  done: NodeId[]
  failed: NodeId[]
  skipped: NodeId[]
  stale: NodeId[]
  reused: NodeId[]
  pinned: NodeId[]
  blocked: { node: NodeId; reason: string }[]
  needsUser: NodeId[]
  awaitingAuthor: NodeId[]
  /** submit_unknown：任务仍在上游、结果未定（不算 done，也不宣判失败）。 */
  inFlightUnknown: NodeId[]
  costCoins: number
  cursor: number
}

export interface ExecuteNodeOptions {
  /** 启动时签名（恢复/调度已算过时传入）；缺省现算。 */
  signature?: string | null
  attempt?: number
  /** 只跑指定 take（恢复单候选用）。 */
  take?: number
  /** 恢复路径：不跑 onFail 的 regenerate（禁止盲重试）。 */
  noRegenerate?: boolean
}

// ---------------------------------------------------------------- 小工具
function toDate(deps: RunDeps): Date {
  return deps.now?.() ?? new Date()
}
function iso(deps: RunDeps): Iso {
  return toDate(deps).toISOString()
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
function failureOf(e: unknown): ExecResult {
  return { ok: false, code: "provider_error", message: e instanceof Error ? e.message : String(e), retryable: true }
}
function primaryPortOf(graph: Readonly<ProjectGraph>, node: Readonly<ProjectNode>): string {
  return specOf(node.type)?.primaryPort ?? MAIN_PORT
}

async function signatureOf(store: ProjectStore, graph: Readonly<ProjectGraph>, nodeId: NodeId): Promise<string | null> {
  const r = await computeSignature(graph, nodeId, store.artifacts, NODE_SPECS_LITE)
  return r.ok ? r.signature : null
}

/** 上游产物：显式 inputs 口 → 该口产物；口名缺省=上游主输出口。空则回退到 out/全部（兼容执行器只写 out 的实现）。 */
function outputsAt(graph: Readonly<ProjectGraph>, node: Readonly<ProjectNode>, port?: string): Output[] {
  const p = port ?? primaryPortOf(graph, node)
  let outs = node.outputs.filter((o) => o.port === p)
  if (!outs.length && port === undefined) outs = node.outputs.filter((o) => o.port === MAIN_PORT)
  if (!outs.length && port === undefined) outs = node.outputs
  return outs
}

function collectInputs(graph: Readonly<ProjectGraph>, node: Readonly<ProjectNode>): Record<string, Output[]> {
  const out: Record<string, Output[]> = {}
  for (const name of Object.keys(node.inputs ?? {}).sort()) {
    const ref = node.inputs[name]
    const up = graph.nodes[ref.from]
    if (!up) continue
    const outs = outputsAt(graph, up, ref.port)
    if (outs.length) out[name] = outs
  }
  return out
}

/** 引用常量素材（refs[]）→ Output；找不到抛错（宁可失败，不静默丢参考条件）。 */
async function collectRefs(store: ProjectStore, node: Readonly<ProjectNode>): Promise<{ role: string; output: Output }[]> {
  const refs: { role: string; output: Output }[] = []
  for (const r of node.refs ?? []) {
    const out = await store.artifacts.get(r.artifactId)
    if (!out) throw new Error(`refs.${r.role} 的产物 ${r.artifactId} 不在 artifact-store`)
    refs.push({ role: r.role, output: out })
  }
  return refs
}

// ---------------------------------------------------------------- ${} 运行期解析（ctx.params 的契约：已解析）
interface RefValue { text: string; isJson: boolean }

async function referencedValue(graph: Readonly<ProjectGraph>, head: string, port?: string): Promise<RefValue | null> {
  const up = graph.nodes[head]
  if (!up) return null
  const outs = outputsAt(graph, up, port)
  const o = outs[0]
  if (!o) return null
  const textual = /^text\//i.test(o.mime) || /json/i.test(o.mime)
  if (textual) {
    try {
      return { text: await readFile(o.path, "utf-8"), isJson: /json/i.test(o.mime) }
    } catch {
      return { text: o.url ?? o.path, isJson: false }
    }
  }
  return { text: o.url ?? o.path, isJson: false }
}

const REF_RE = /\$\{([^{}]*)\}/g
const WHOLE_REF = /^\$\{([^{}]+)\}$/

async function resolveParamString(text: string, graph: Readonly<ProjectGraph>): Promise<Json> {
  if (!text.includes("${")) return text
  const whole = WHOLE_REF.exec(text)
  if (whole) {
    const segs = whole[1].trim().split(".")
    const v = await referencedValue(graph, segs[0], segs[1])
    if (!v) return text
    if (v.isJson) {
      try {
        return JSON.parse(v.text) as Json
      } catch {
        return v.text
      }
    }
    return v.text
  }
  let out = ""
  let cursor = 0
  REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REF_RE.exec(text)) !== null) {
    out += text.slice(cursor, m.index)
    cursor = m.index + m[0].length
    const segs = m[1].trim().split(".")
    const v = await referencedValue(graph, segs[0], segs[1])
    out += v ? v.text : m[0] // 取不到就保留原样：执行器会以「未解析 ${}」拒绝提交，不静默丢条件
  }
  out += text.slice(cursor)
  return out
}

async function resolveParams(value: Json, graph: Readonly<ProjectGraph>): Promise<Json> {
  if (typeof value === "string") return resolveParamString(value, graph)
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (const v of value) out.push(await resolveParams(v, graph))
    return out
  }
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {}
    for (const k of Object.keys(value)) out[k] = await resolveParams(value[k], graph)
    return out
  }
  return value
}

// ---------------------------------------------------------------- 执行上下文
interface ContextOptions { runId: RunId; signature: string; attempt: number; take: number }

async function buildContext(
  store: ProjectStore, deps: RunDeps, graph: Readonly<ProjectGraph>, nodeId: NodeId, o: ContextOptions,
): Promise<ExecContext> {
  const node = graph.nodes[nodeId]
  if (!node) throw new Error(`节点 ${nodeId} 不存在`)
  const eff = materializeDefaults(node.type, node.id, node.params ?? {}, graph.defaults ?? {})
  const params = (await resolveParams(eff, graph)) as Record<string, Json>
  const baseSeed = eff.seed
  if (typeof baseSeed === "number" && Number.isInteger(baseSeed)) params.seed = effectiveSeed(baseSeed, o.attempt, o.take)
  // ctx.node 也带解析后的 params + 本轮有效种子：S7 执行器自己会 materializeDefaults(ctx.node.params)，
  // 只改 ctx.params 的话「重生成 seed+1」到不了提交载荷（Idempotency-Key 变了、种子没变 = 白花钱重试同一张图）。
  const nodeForCtx: Readonly<ProjectNode> = { ...node, params }
  const signal = deps.signal ?? new AbortController().signal
  return {
    project: graph,
    node: nodeForCtx,
    signature: o.signature,
    runId: o.runId,
    attempt: o.attempt,
    take: o.take,
    sessionId: store.sessionId,
    session: deps.session,
    params,
    inputs: collectInputs(graph, nodeForCtx),
    refs: await collectRefs(store, node),
    signal,
    ingest: (src, hint) => store.putArtifact(src, { ...hint, signal }),
    ledger: deps.ledger,
    submitGeneration: deps.submitGeneration,
    execBridge: deps.execBridge,
  }
}

// ---------------------------------------------------------------- 单轮（takes 并发）
interface RoundOutcome {
  pool: Output[]
  failure?: { code: string; message: string; retryable: boolean; submitUnknown?: boolean }
  cost: number
}

async function runRound(
  store: ProjectStore, deps: RunDeps, graph: Readonly<ProjectGraph>, nodeId: NodeId, executor: { run(ctx: ExecContext): Promise<ExecResult> },
  o: { runId: RunId; signature: string; attempt: number; takes: number[] },
): Promise<RoundOutcome> {
  const node = graph.nodes[nodeId]
  const multi = (node.takes?.n ?? 1) > 1
  const results = await Promise.all(o.takes.map(async (take) => {
    let res: ExecResult
    try {
      res = await executor.run(await buildContext(store, deps, graph, nodeId, { runId: o.runId, signature: o.signature, attempt: o.attempt, take }))
    } catch (e) {
      res = failureOf(e)
    }
    return { take, res }
  }))
  const pool: Output[] = []
  let cost = 0
  let failure: RoundOutcome["failure"]
  for (const { take, res } of results) {
    cost += typeof res.costCoins === "number" ? res.costCoins : 0
    if (res.ok) {
      for (const out of res.outputs ?? []) pool.push({ ...out, port: out.port || MAIN_PORT, ...(multi ? { take } : {}) })
      if (res.pool) for (const out of res.pool) pool.push({ ...out, port: out.port || MAIN_PORT, ...(multi ? { take } : {}) })
    } else if (!failure) {
      // strictNullChecks=false 下联合类型不按 boolean 字面量收窄：显式取失败分支（类型与 ExecResult 的失败臂逐字段一致）。
      const bad = res as Extract<ExecResult, { ok: false }>
      failure = { code: bad.code, message: bad.message, retryable: bad.retryable, ...(bad.submitUnknown ? { submitUnknown: true } : {}) }
    }
  }
  return { pool, ...(failure ? { failure } : {}), cost }
}

// ---------------------------------------------------------------- 状态落盘
interface CommitArgs {
  startSig: string
  startOutputs: Output[]
  status: NodeStatus
  outputs: Output[]
  takesPool?: Output[]
  costCoins: number
  attempt: number
  durationMs: number
  take?: number
  error?: { code: string; message: string; retryable: boolean }
  inflight?: Inflight
  /** 已经存在（例如用户拿 select_take 选过）——不要用空 outputs 覆盖 */
  keepOutputs?: boolean
}

async function commitNode(
  store: ProjectStore, deps: RunDeps, runId: RunId, nodeId: NodeId, args: CommitArgs,
): Promise<NodeRunReport> {
  const nowIso = iso(deps)
  // 一次锁内完成：状态/产物/预算 + 当前签名 + 漂移探针（避免中间态被并发 planRun 看到）。
  const committed = await store.update(async (g) => {
    const n = g.nodes[nodeId]
    if (!n) return { missing: true as const }
    n.status = args.status
    if (!args.keepOutputs) n.outputs = args.outputs
    if (args.takesPool !== undefined) n.takesPool = args.takesPool
    n.error = args.error ? { ...args.error, at: nowIso } : undefined
    n.inflight = args.inflight
    g.budget.spentCoins = round6((g.budget.spentCoins ?? 0) + args.costCoins)

    const post = await computeSignature(g, nodeId, store.artifacts, NODE_SPECS_LITE)
    const postSig = post.ok ? post.signature : null
    let stale = false
    if (postSig !== args.startSig) {
      // 探针：把本节点产物回退成启动时的样子，看是不是「用户改了参数/上游变了」引起的漂移。
      // 这样 reference 的内容指纹、takes 被选产物这类「自己刚写进去」的签名变化不会被误判成 stale。
      const probe = structuredClone(g) as ProjectGraph
      probe.nodes[nodeId].outputs = args.startOutputs
      const eq = await computeSignature(probe, nodeId, store.artifacts, NODE_SPECS_LITE)
      stale = !eq.ok || eq.signature !== args.startSig
    }
    const finalStatus: NodeStatus = stale && args.status === "done" ? "stale" : args.status
    n.status = finalStatus
    n.signature = postSig
    if (finalStatus === "done" || finalStatus === "stale") {
      n.lastRun = {
        runId, at: nowIso, via: "executed", signature: postSig ?? args.startSig,
        costCoins: args.costCoins, attempt: args.attempt, durationMs: args.durationMs,
      }
    }
    return { missing: false as const, finalStatus, postSig, outputs: n.outputs }
  })
  if (committed.missing) return { node: nodeId, status: "blocked", costCoins: 0, reason: "node not found" }
  const finalStatus = committed.finalStatus!
  const n = { outputs: committed.outputs! }

  // 缓存索引（§3.2 第 6 条）：产出成功（done/stale）按「产出这些 outputs 的签名」记一条，供同签名节点跨节点复用。
  // 写失败不阻断（缓存丢了只会多重跑，不会错用旧产物）。
  if ((finalStatus === "done" || finalStatus === "stale") && deps.cache?.put && args.outputs.length) {
    try { await deps.cache.put(committed.postSig ?? args.startSig, args.outputs, args.costCoins) } catch { /* 见上 */ }
  }

  const events: { kind: "node_status" | "node_output" | "cost"; node: NodeId; run: RunId; data: Record<string, Json> }[] = [
    { kind: "node_status", node: nodeId, run: runId, data: { status: finalStatus, attempt: args.attempt } },
  ]
  if (args.outputs.length && !args.keepOutputs) {
    events.push({
      kind: "node_output", node: nodeId, run: runId,
      data: {
        ports: [...new Set(args.outputs.map((o) => o.port))].sort(),
        artifact_ids: args.outputs.map((o) => o.artifactId),
        ...(args.take !== undefined ? { take: args.take } : {}),
      },
    })
  }
  if (args.costCoins > 0) events.push({ kind: "cost", node: nodeId, run: runId, data: { coins: round6(args.costCoins) } })
  await store.appendEvents(events)

  return {
    node: nodeId, status: finalStatus, costCoins: args.costCoins,
    ...(args.error ? { error: args.error } : {}),
    ...(args.take !== undefined ? { take: args.take } : {}),
    outputs: args.keepOutputs ? n.outputs : args.outputs,
  }
}

// ---------------------------------------------------------------- executeNode（单节点一圈：takes + regenerate + onFail）
export async function executeNode(
  store: ProjectStore, deps: RunDeps, runId: RunId, nodeId: NodeId, opts: ExecuteNodeOptions = {},
): Promise<NodeRunReport> {
  const startedMs = Date.now()
  const graph0 = await store.read()
  const node = graph0.nodes[nodeId]
  if (!node) return { node: nodeId, status: "blocked", costCoins: 0, reason: "node not found" }
  if (node.pinned) return { node: nodeId, status: "done", costCoins: 0, reason: "pinned", outputs: node.outputs }

  const startOutputs = node.outputs ?? []
  const startSig = opts.signature !== undefined ? opts.signature : await signatureOf(store, graph0, nodeId)
  if (!startSig) {
    const err = { code: "bad_input", message: `节点 ${nodeId} 的签名不稳定（上游内容缺失/指纹不可读），不能带不明确的幂等键提交。`, retryable: false }
    return commitNode(store, deps, runId, nodeId, {
      startSig: "", startOutputs, status: "failed", outputs: [], costCoins: 0, attempt: opts.attempt ?? 0,
      durationMs: Date.now() - startedMs, error: err,
    })
  }

  const executor = getExecutor(node.type)
  if (!executor) {
    const err = { code: "bridge_unavailable", message: `没有为节点类型 ${node.type} 注册执行器（接线归 S11z），未运行 ${nodeId}。`, retryable: false }
    return commitNode(store, deps, runId, nodeId, {
      startSig, startOutputs, status: "failed", outputs: [], costCoins: 0, attempt: opts.attempt ?? 0,
      durationMs: Date.now() - startedMs, error: err,
    })
  }

  const takesSpec = node.takes
  const nTakes = takesSpec ? takesSpec.n : 1

  // select:"user"：候选已经花钱产出过，就绝不重新生成。
  //   有候选池没选中 → 交等待状态（不阻塞整轮，不重复花钱）；
  //   已经被用户 select_take 选中（status=done 且 outputs 非空）→ 直接把选中的产物交给下游，并补一条 reused 记账带。
  if (takesSpec?.select === "user" && (node.takesPool?.length ?? 0) > 0) {
    if (node.status === "done" && startOutputs.length > 0) {
      await markReused(store, deps, runId, nodeId, startSig, startOutputs, await savedCostOf(store, deps, node, startSig))
      return { node: nodeId, status: "done", costCoins: 0, outputs: startOutputs }
    }
    return { node: nodeId, status: "pending", costCoins: 0, needsUser: true, reason: "awaiting take select", outputs: [] }
  }

  const attempts = opts.take !== undefined ? [opts.take] : Array.from({ length: nTakes }, (_, i) => i)
  const firstKey = idempotencyKeyOf({ projectId: graph0.id, signature: startSig, take: attempts[0], attempt: opts.attempt ?? 0 })

  // 开跑：running + inflight（崩溃后 recovery 靠它接续，不盲重投）
  await store.update((g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.status = "running"
    n.inflight = { idemKey: firstKey, since: iso(deps) }
    n.error = undefined
  })
  await store.appendEvents([{ kind: "node_status", node: nodeId, run: runId, data: { status: "running", attempt: opts.attempt ?? 0 } }])

  let attempt = opts.attempt ?? 0
  let retriesUsed = attempt
  let totalCost = 0
  const signal = deps.signal

  for (;;) {
    if (signal?.aborted) {
      return commitNode(store, deps, runId, nodeId, {
        startSig, startOutputs, status: "pending", outputs: [], costCoins: totalCost, attempt,
        durationMs: Date.now() - startedMs, error: { code: "cancelled", message: "run 已取消，节点停在中途", retryable: true },
      })
    }
    const round = await runRound(store, deps, graph0, nodeId, executor, { runId, signature: startSig, attempt, takes: attempts })
    totalCost = round6(totalCost + round.cost)

    // 提交结果未知：冻结，不重试、不换 key；recovery 用同 key 核对。
    if (round.failure?.submitUnknown) {
      const err = { code: "submit_unknown", message: round.failure.message, retryable: false }
      await store.update((g) => {
        const n = g.nodes[nodeId]
        if (!n) return
        n.status = "running"
        n.inflight = { idemKey: firstKey, since: iso(deps), submitUnknown: true }
        n.error = { ...err, at: iso(deps) }
        g.budget.spentCoins = round6((g.budget.spentCoins ?? 0) + totalCost)
      })
      await store.appendEvents([
        { kind: "node_status", node: nodeId, run: runId, data: { status: "running", submit_unknown: true } },
        { kind: "cost", node: nodeId, run: runId, data: { coins: totalCost } },
      ])
      return { node: nodeId, status: "running", costCoins: totalCost, error: err, needsRecovery: true, reason: "submit unknown" }
    }

    if (round.pool.length) {
      let pool = round.pool
      if (takesSpec?.select === "qc" && deps.scoreTake) {
        const scored: Output[] = []
        for (const o of pool) {
          try { scored.push(await deps.scoreTake(o, node, graph0)) } catch { scored.push(o) }
        }
        pool = scored
      }
      if (!takesSpec) {
        return commitNode(store, deps, runId, nodeId, {
          startSig, startOutputs, status: "done", outputs: pool, costCoins: totalCost, attempt,
          durationMs: Date.now() - startedMs,
        })
      }
      const selection = selectTake(takesSpec, pool)
      if (selection.kind === "selected") {
        return commitNode(store, deps, runId, nodeId, {
          startSig, startOutputs, status: "done", outputs: selection.outputs, takesPool: pool, costCoins: totalCost,
          attempt, durationMs: Date.now() - startedMs, take: selection.take,
        })
      }
      if (selection.kind === "pending_user") {
        return commitNode(store, deps, runId, nodeId, {
          startSig, startOutputs, status: "pending", outputs: [], takesPool: pool, costCoins: totalCost, attempt,
          durationMs: Date.now() - startedMs, keepOutputs: false,
          error: { code: "awaiting_take", message: `节点 ${nodeId} 有 ${pool.length} 个候选，等待用户 select_take。`, retryable: false },
        }).then((r) => ({ ...r, needsUser: true, reason: "awaiting take select" }))
      }
      // qc 选优但没有分数：按 qc_fail 处理（不静默挑一个）
      round.failure = { code: "qc_failed", message: `takes 选优失败：${selection.reason}`, retryable: false }
    }

    const failure = round.failure ?? { code: "provider_error", message: "没有产物且没有错误详情", retryable: true }
    if (failure.code === "bad_input" && AUTHOR_AWAITING.test(failure.message)) {
      const err = { code: "awaiting_author", message: failure.message, retryable: true }
      const rep = await commitNode(store, deps, runId, nodeId, {
        startSig, startOutputs, status: "pending", outputs: [], costCoins: totalCost, attempt,
        durationMs: Date.now() - startedMs, error: err, keepOutputs: true,
      })
      return { ...rep, awaitingAuthor: true, reason: "awaiting author" }
    }

    const kind: FailureKind = failure.code === "qc_failed" ? "qc_fail" : "error"
    const decision = opts.noRegenerate ? { do: "fail" as const } : decideOnFail(node.onFail, kind, retriesUsed)
    if (decision.do === "regenerate") {
      attempt = decision.retryNo
      retriesUsed = decision.retryNo
      await store.update((g) => {
        const n = g.nodes[nodeId]
        if (!n) return
        n.inflight = { idemKey: idempotencyKeyOf({ projectId: g.id, signature: startSig, take: attempts[0], attempt }), since: iso(deps) }
      })
      continue
    }
    if (decision.do === "skip") {
      return commitNode(store, deps, runId, nodeId, {
        startSig, startOutputs, status: "skipped", outputs: [], costCoins: totalCost, attempt,
        durationMs: Date.now() - startedMs,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      })
    }
    if (decision.do === "ask_user") {
      const err = { code: "ask_user", message: `${failure.message}（已按 onFail=ask_user 停下，等你决定）`, retryable: false }
      const rep = await commitNode(store, deps, runId, nodeId, {
        startSig, startOutputs, status: "pending", outputs: [], costCoins: totalCost, attempt,
        durationMs: Date.now() - startedMs, error: err, keepOutputs: true,
      })
      return { ...rep, needsUser: true, reason: "awaiting user decision" }
    }
    return commitNode(store, deps, runId, nodeId, {
      startSig, startOutputs, status: "failed", outputs: [], costCoins: totalCost, attempt,
      durationMs: Date.now() - startedMs,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    })
  }
}

// ---------------------------------------------------------------- 复用 / blocked 落盘
async function savedCostOf(store: ProjectStore, deps: RunDeps, node: Readonly<ProjectNode>, signature: string): Promise<number> {
  if (node.lastRun?.signature === signature && typeof node.lastRun.costCoins === "number") return node.lastRun.costCoins
  if (deps.cache) {
    try {
      const hit = await deps.cache.lookup(signature, store.artifacts)
      if (hit) return hit.costCoins
    } catch {
      // 缓存索引坏了不阻断复用（产物 sha 已复核）
    }
  }
  return 0
}

export async function markReused(
  store: ProjectStore, deps: RunDeps, runId: RunId, nodeId: NodeId, signature: string, outputs: Output[], savedCoins: number,
): Promise<void> {
  const nowIso = iso(deps)
  await store.update((g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.status = "done"
    n.outputs = outputs
    n.signature = signature
    n.lastRun = { runId, at: nowIso, via: "reused", signature, costCoins: 0, attempt: 0 }
    n.error = undefined
    n.inflight = undefined
    g.budget.savedCoins = round6((g.budget.savedCoins ?? 0) + savedCoins)
  })
  await store.appendEvents([{
    kind: "node_reused", node: nodeId, run: runId,
    data: { signature, saved_coins: round6(savedCoins), artifact_ids: outputs.map((o) => o.artifactId) },
  }])
  // reused 账本行：复用不花钱，cost_coins 永远 0（S5 的 ledger.ts 同样强制）。
  await deps.ledger.write({
    event: "reused",
    cost_coins: 0,
    project_id: store.sessionId,
    node_id: nodeId,
    signature,
    run_id: runId,
    attempt: 0,
    reused: true,
    ...(outputs[0] ? { artifact_sha256: outputs[0].sha256 } : {}),
  })
}

async function markBlocked(store: ProjectStore, deps: RunDeps, runId: RunId, nodeId: NodeId, reason: string): Promise<void> {
  await store.update((g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.status = "blocked"
    n.error = { code: "blocked", message: reason, retryable: false, at: iso(deps) }
    n.inflight = undefined
  })
  await store.appendEvents([{ kind: "node_status", node: nodeId, run: runId, data: { status: "blocked", reason } }])
}

// ---------------------------------------------------------------- plan 执行（层内并发）
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (limit <= 0 || limit >= items.length) {
    await Promise.all(items.map(fn))
    return
  }
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

export async function executePlan(store: ProjectStore, deps: RunDeps, runId: RunId, plan: RunPlan): Promise<RunExecution> {
  const reused: NodeId[] = []
  const pinned: NodeId[] = [...plan.pinned]
  const failed: NodeId[] = []
  const skipped: NodeId[] = []
  const stale: NodeId[] = []
  const needsUser: NodeId[] = []
  const awaitingAuthor: NodeId[] = []
  const inFlightUnknown: NodeId[] = []
  const blocked: { node: NodeId; reason: string }[] = []
  const reasons = new Map<NodeId, string>()
  const queue = new Set<NodeId>()
  const done: NodeId[] = []
  let totalCost = 0

  // 1) 复用：不入队、不调执行器；必发 node_reused + reused 账本行
  for (const id of plan.reuse) {
    const g = await store.read()
    const sig = await signatureOf(store, g, id)
    const outs = sig ? await findReusable(g, id, sig, store.artifacts, deps.cache) : null
    if (!sig || !outs) {
      queue.add(id) // 计划与现图有出入（产物刚被删）：退回执行
      continue
    }
    await markReused(store, deps, runId, id, sig, outs, await savedCostOf(store, deps, g.nodes[id], sig))
    reused.push(id)
  }

  // 2) plan 判 blocked 的（上游不可用/缺 spec）：落盘为 blocked，不执行
  for (const id of plan.blocked) {
    const reason = "upstream unavailable (plan)"
    await markBlocked(store, deps, runId, id, reason)
    blocked.push({ node: id, reason })
    reasons.set(id, reason)
  }

  for (const id of plan.toRun) queue.add(id)
  // unknown = 签名依赖尚未产出的上游内容（§3.2.5「保守视为要跑」）：入队，执行前上游已落定，
  // executeNode 会用自己的启动签名重算（那时内容已经有了）。
  for (const id of plan.unknown) queue.add(id)
  const limit = concurrencyLimit(deps.concurrency)

  // 3) 波次执行：每波只跑「上游全部落定」的节点，同波并发受上限约束
  while (queue.size) {
    if (deps.signal?.aborted) break
    const g = await store.read()
    const ready: NodeId[] = []
    const nowBlocked: { node: NodeId; reason: string }[] = []
    for (const id of [...queue]) {
      const n = g.nodes[id]
      if (!n) {
        queue.delete(id)
        nowBlocked.push({ node: id, reason: "node not found" })
        continue
      }
      let reason: string | null = null
      for (const d of nodeDependencies(g, n)) {
        const dn = g.nodes[d]
        if (!dn) { reason = `missing upstream ${d}`; break }
        if (reasons.has(d)) { reason = reasons.get(d)!; break }
        if (dn.status === "failed") { reason = `upstream failed: ${d}`; break }
        if (dn.status === "blocked") { reason = `upstream blocked: ${d}`; break }
        if (dn.status === "skipped") { reason = `upstream skipped: ${d}`; break }
      }
      if (reason) {
        queue.delete(id)
        nowBlocked.push({ node: id, reason })
        continue
      }
      const depsIds = nodeDependencies(g, n)
      const waiting = depsIds.some((d) => queue.has(d))
      if (waiting) continue
      // 上游不在本队列里、状态还没落定（例如上一轮 ask_user/等作者内容停在 pending）：别抢跑。
      const stalled = depsIds.find((d) => {
        const dn = g.nodes[d]
        return dn && (dn.status === "pending" || dn.status === "queued" || dn.status === "running") && !queue.has(d)
      })
      if (stalled) {
        queue.delete(id)
        nowBlocked.push({ node: id, reason: `upstream not ready: ${stalled}` })
        continue
      }
      ready.push(id)
    }
    for (const b of nowBlocked) {
      await markBlocked(store, deps, runId, b.node, b.reason)
      blocked.push(b)
      reasons.set(b.node, b.reason)
    }
    if (!ready.length) {
      if (queue.size) {
        for (const id of queue) {
          const reason = "dependency unresolved (cycle or missing upstream)"
          await markBlocked(store, deps, runId, id, reason)
          blocked.push({ node: id, reason })
          reasons.set(id, reason)
        }
        queue.clear()
      }
      break
    }
    await pool(ready, limit, async (id) => {
      const r = await executeNode(store, deps, runId, id)
      queue.delete(id)
      totalCost = round6(totalCost + r.costCoins)
      if (r.awaitingAuthor) {
        awaitingAuthor.push(id)
        reasons.set(id, "awaiting author")
        return
      }
      if (r.needsUser) {
        needsUser.push(id)
        reasons.set(id, r.reason ?? "awaiting user input")
        return
      }
      if (r.status === "failed") { failed.push(id); return }
      if (r.status === "skipped") { skipped.push(id); return }
      if (r.status === "blocked") {
        blocked.push({ node: id, reason: r.reason ?? "blocked" })
        reasons.set(id, r.reason ?? "blocked")
        return
      }
      // submit_unknown：任务仍在上游、钱可能已冻在预留里——不算 done，也不许当失败宣判。
      if (r.needsRecovery || (r.status === "running" && !r.outputs?.length)) {
        inFlightUnknown.push(id)
        reasons.set(id, "submit unknown (待核对)")
        return
      }
      done.push(id)
      if (r.status === "stale") stale.push(id)
    })
  }
  if (deps.signal?.aborted && queue.size) {
    for (const id of queue) {
      await markBlocked(store, deps, runId, id, "run cancelled")
      blocked.push({ node: id, reason: "run cancelled" })
    }
    queue.clear()
  }

  const status: RunExecution["status"] = failed.length
    ? "failed"
    : needsUser.length
      ? "needs_user"
      : blocked.length || awaitingAuthor.length || inFlightUnknown.length
        ? "partial"
        : "done"
  const after = await store.read()
  return {
    runId, status, done, failed, skipped, stale, reused, pinned, blocked, needsUser, awaitingAuthor,
    inFlightUnknown, costCoins: totalCost, cursor: after.seq,
  }
}
