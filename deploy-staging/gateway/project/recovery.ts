// S6 崩溃恢复（设计文档 §3.4 崩溃恢复段）。
//
// 判据只有一个：**既有订单的真相没查清之前，不重投、不换 key、不假宣判失败**（记忆
// 2026-08-31-provider-reconciliation-architecture）。因此按 scanRecovery() 的 action 分流：
//   poll_task       有平台任务 → 查平台任务（只读），succeeded/failed 才落终态；
//   confirm_unknown 提交结果未知 → 先查 exec-bridge result(idemKey)，其次平台任务；查不清就保持 running；
//   resubmit        只有 idemKey → 用**同一个** Idempotency-Key 重提交（上游去重，不重复扣费）。
//                   重提交前先核对：由当前图算出的 key 必须与 inflight 里的 key 逐字相等——
//                   用户改过参数时 key 会变，此时绝不重投，转人工确认。
//   lost            queued/running 但没有 inflight（进程死在落盘之前）：状态不可信 → 置回 pending，
//                   交给调用方按签名重跑（run.ts 的 resume 路径）；这里不自己猜。
import { PLATFORM_BASE } from "../constants-gateway.ts"
import { idempotencyKeyOf } from "./submit-generation.ts"
import { computeSignature } from "./signature.ts"
import { NODE_SPECS, NODE_SPECS_LITE } from "./specs.ts"
import { openProject, scanProjectRecoveries, type ProjectRecoveryItem, type ProjectStore } from "./store.ts"
import { executeNode, type RunDeps } from "./scheduler.ts"
import type { NodeId, Output } from "./types.ts"

export interface PlatformTaskQuery {
  query(a: { kind: "image" | "video"; taskId: string; apiKey: string }): Promise<
    | { state: "running" }
    | { state: "done"; urls: string[]; costCoins?: number }
    | { state: "failed"; message?: string }
    | { state: "unknown" }
  >
}

export interface RecoveryDeps extends RunDeps {
  /** 平台任务只读查询（poll_task / confirm_unknown 用）；缺省走 PLATFORM_BASE 的 GET。 */
  queryTask?: PlatformTaskQuery
}

export interface RecoveryOutcome {
  sessionId: string
  resumed: { node: NodeId; action: ProjectRecoveryItem["action"]; result: "done" | "failed" | "running" | "manual"; reason?: string }[]
  /** lost 节点：已置回 pending，按签名重跑（交给 run.ts）。
   */
  rerun: NodeId[]
  manual: NodeId[]
  cursor: number
}

function isoNow(deps: RecoveryDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function apiKeyOf(session: unknown): string {
  const k = (session as { apiKey?: unknown } | null)?.apiKey
  return typeof k === "string" ? k : ""
}

function kindOf(nodeType: string): "image" | "video" {
  return nodeType === "clip" ? "video" : "image"
}

/** 缺省平台查询：GET /v1/{images|videos}/:id（与 S5 轮询同一对端点，只读、不改单）。 */
export function createPlatformTaskQuery(fetchImpl: typeof fetch = fetch): PlatformTaskQuery {
  return {
    async query({ kind, taskId, apiKey }) {
      const base = kind === "video" ? `/v1/videos/${taskId}` : `/v1/images/${taskId}`
      let res: Response
      try {
        res = await fetchImpl(`${PLATFORM_BASE}${base}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
      } catch {
        return { state: "unknown" }
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok) return res.status === 404 ? { state: "unknown" } : { state: "unknown" }
      if (data?.status === "succeeded") {
        const raw: unknown[] = Array.isArray(data?.data) ? data.data.map((d: any) => d?.url) : [data?.result_url ?? data?.url]
        const urls = raw.filter((u): u is string => typeof u === "string" && u.length > 0)
          .map((u) => (/^https?:\/\//.test(u) ? u : `${PLATFORM_BASE}${u.startsWith("/") ? "" : "/"}${u}`))
        return urls.length ? { state: "done", urls, ...(Number.isFinite(Number(data?.cost_coins)) ? { costCoins: Number(data.cost_coins) } : {}) } : { state: "unknown" }
      }
      if (data?.status === "failed") return { state: "failed", message: String(data?.error?.message ?? "generation failed") }
      if (data?.status === "queued" || data?.status === "running") return { state: "running" }
      return { state: "unknown" } // 查无此单/读不出：保守按 running，宁冻结不假宣判
    },
  }
}

async function ingestUrls(store: ProjectStore, urls: string[], deps: RecoveryDeps): Promise<Output[]> {
  const outs: Output[] = []
  for (const url of urls) {
    const out = await store.putArtifact({ url }, { port: "out", origin: "generated", url, signal: deps.signal })
    outs.push({ ...out, port: "out", url })
  }
  return outs
}

async function ingestFiles(
  store: ProjectStore,
  files: { path: string; mime: string; bytes: number; durationSec?: number }[],
  deps: RecoveryDeps,
): Promise<Output[]> {
  const outs: Output[] = []
  for (const f of files) {
    const out = await store.putArtifact({ path: f.path }, { port: "out", mime: f.mime, origin: "generated", signal: deps.signal })
    outs.push({ ...out, port: "out", ...(typeof f.durationSec === "number" ? { durationSec: f.durationSec } : {}) })
  }
  return outs
}

async function finishNode(
  store: ProjectStore, deps: RecoveryDeps, runId: string, nodeId: NodeId,
  status: "done" | "failed", extra: { outputs?: Output[]; costCoins?: number; error?: { code: string; message: string; retryable: boolean } },
): Promise<void> {
  const at = (deps.now?.() ?? new Date()).toISOString()
  await store.update(async (g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.status = status
    n.inflight = undefined
    n.error = extra.error ? { ...extra.error, at } : undefined
    if (status === "done") {
      n.outputs = extra.outputs ?? []
      g.budget.spentCoins = Math.round(((g.budget.spentCoins ?? 0) + (extra.costCoins ?? 0)) * 1e6) / 1e6
      const sig = await computeSignature(g, nodeId, store.artifacts, NODE_SPECS_LITE)
      n.signature = sig.ok ? sig.signature : null
      n.lastRun = { runId, at, via: "executed", signature: sig.ok ? sig.signature : "", costCoins: extra.costCoins ?? 0, attempt: 0 }
    }
  })
  await store.appendEvents([{
    kind: "node_status", node: nodeId, run: runId,
    data: { status, recovered: true, ...(extra.error ? { error: extra.error.message } : {}) },
  }])
}

async function leaveRunning(store: ProjectStore, deps: RecoveryDeps, runId: string, nodeId: NodeId, reason: string): Promise<void> {
  await store.update((g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.error = { code: "recovery_pending", message: reason, retryable: true, at: isoNow(deps) }
  })
  await store.appendEvents([{ kind: "node_status", node: nodeId, run: runId, data: { status: "running", recovered: true, reason } }])
}

async function markManual(store: ProjectStore, deps: RecoveryDeps, runId: string, nodeId: NodeId, reason: string): Promise<void> {
  await store.update((g) => {
    const n = g.nodes[nodeId]
    if (!n) return
    n.error = { code: "recovery_manual", message: reason, retryable: false, at: isoNow(deps) }
  })
  await store.appendEvents([{ kind: "node_status", node: nodeId, run: runId, data: { status: "running", manual: true, reason } }])
}

function parseKey(key: string): { take: number; attempt: number } | null {
  const m = /:t(\d+):a(\d+)$/.exec(key)
  if (!m) return null
  return { take: Number(m[1]), attempt: Number(m[2]) }
}

export async function recoverProject(store: ProjectStore, deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const scan = await store.scanRecovery()
  const graph = await store.read()
  const runId = graph.activeRun ?? "recovery"
  const query = deps.queryTask ?? createPlatformTaskQuery()
  const resumed: RecoveryOutcome["resumed"] = []
  const manual: NodeId[] = []
  const rerun: NodeId[] = []

  for (const item of scan.resumable) {
    const node = graph.nodes[item.node]
    if (!node) {
      manual.push(item.node)
      continue
    }
    if (item.action === "poll_task") {
      const q = await query.query({ kind: kindOf(node.type), taskId: item.taskId!, apiKey: apiKeyOf(deps.session) })
      if (q.state === "done") {
        const outs = await ingestUrls(store, q.urls, deps)
        await finishNode(store, deps, runId, item.node, "done", { outputs: outs, costCoins: q.costCoins ?? 0 })
        resumed.push({ node: item.node, action: item.action, result: "done" })
      } else if (q.state === "failed") {
        await finishNode(store, deps, runId, item.node, "failed", { error: { code: "provider_error", message: q.message ?? "平台任务失败", retryable: true } })
        resumed.push({ node: item.node, action: item.action, result: "failed" })
      } else {
        await leaveRunning(store, deps, runId, item.node, "平台任务仍在跑/查不清，保持 running")
        resumed.push({ node: item.node, action: item.action, result: "running" })
      }
      continue
    }

    if (item.action === "confirm_unknown") {
      if (NODE_SPECS[node.type]?.executor === "exec-bridge") {
        const r = await deps.execBridge.result(item.idemKey)
        if (r.state === "done") {
          const outs = await ingestFiles(store, r.files ?? [], deps)
          if (!outs.length) {
            await markManual(store, deps, runId, item.node, "exec-bridge 报 done 但没有文件；需人工确认")
            manual.push(item.node)
          } else {
            await finishNode(store, deps, runId, item.node, "done", { outputs: outs, costCoins: r.costCoins ?? 0 })
            resumed.push({ node: item.node, action: item.action, result: "done" })
          }
        } else if (r.state === "failed") {
          await finishNode(store, deps, runId, item.node, "failed", { error: { code: "bridge_unavailable", message: "exec-bridge 确认失败", retryable: true } })
          resumed.push({ node: item.node, action: item.action, result: "failed" })
        } else {
          await leaveRunning(store, deps, runId, item.node, "exec-bridge 结果未定（unknown/running），保持 running")
          resumed.push({ node: item.node, action: item.action, result: "running" })
        }
        continue
      }
      if (item.taskId) {
        const q = await query.query({ kind: kindOf(node.type), taskId: item.taskId, apiKey: apiKeyOf(deps.session) })
        if (q.state === "done") {
          const outs = await ingestUrls(store, q.urls, deps)
          await finishNode(store, deps, runId, item.node, "done", { outputs: outs, costCoins: q.costCoins ?? 0 })
          resumed.push({ node: item.node, action: item.action, result: "done" })
          continue
        }
        if (q.state === "failed") {
          await finishNode(store, deps, runId, item.node, "failed", { error: { code: "provider_error", message: q.message ?? "平台任务失败", retryable: true } })
          resumed.push({ node: item.node, action: item.action, result: "failed" })
          continue
        }
      }
      await markManual(store, deps, runId, item.node, "提交结果未知且无法确认（无 task_id / 桥无结果）；保留 key，等人工核对")
      manual.push(item.node)
      resumed.push({ node: item.node, action: item.action, result: "manual" })
      continue
    }

    // resubmit：只有 idemKey。先核对当前签名是否还能生成同一个 key —— 不同就绝不重投。
    const parsed = parseKey(item.idemKey)
    const sig = await computeSignature(graph, item.node, store.artifacts, NODE_SPECS_LITE)
    if (!parsed || !sig.ok) {
      await markManual(store, deps, runId, item.node, "inflight key 无法解析或当前签名不可算；不重投，等人工确认")
      manual.push(item.node)
      resumed.push({ node: item.node, action: item.action, result: "manual" })
      continue
    }
    const expected = idempotencyKeyOf({ projectId: graph.id, signature: sig.signature, take: parsed.take, attempt: parsed.attempt })
    if (expected !== item.idemKey) {
      await markManual(store, deps, runId, item.node, "图已变（当前签名生成的 key 与在途 key 不同）；不换 key 重投，等人工确认")
      manual.push(item.node)
      resumed.push({ node: item.node, action: item.action, result: "manual" })
      continue
    }
    const r = await executeNode(store, deps, runId, item.node, {
      signature: sig.signature, attempt: parsed.attempt, take: parsed.take, noRegenerate: true,
    })
    if (r.status === "done" || r.status === "stale") resumed.push({ node: item.node, action: item.action, result: "done" })
    else if (r.status === "failed" || r.status === "skipped") resumed.push({ node: item.node, action: item.action, result: "failed" })
    else if (r.needsRecovery) resumed.push({ node: item.node, action: item.action, result: "running" })
    else if (r.error?.code === "recovery_manual") resumed.push({ node: item.node, action: item.action, result: "manual" })
    else resumed.push({ node: item.node, action: item.action, result: "running", reason: r.reason })
  }

  for (const id of scan.lost) {
    await store.update((g) => {
      const n = g.nodes[id]
      if (!n) return
      n.status = "pending"
      n.inflight = undefined
      n.error = { code: "recovery_lost", message: "进程中断时没有在途记录；按签名重跑", retryable: true, at: isoNow(deps) }
    })
    await store.appendEvents([{ kind: "node_status", node: id, run: runId, data: { status: "pending", recovered: true, reason: "lost" } }])
    rerun.push(id)
  }

  return { sessionId: store.sessionId, resumed, rerun, manual, cursor: (await store.read()).seq }
}

/** 网关启动扫描：projects/* 逐个接续（坏档跳过，不阻塞其它工程）。 */
export async function recoverProjectsAt(
  rootDir: string,
  depsFor: (sessionId: string) => RecoveryDeps,
): Promise<{ sessionId: string; outcome?: RecoveryOutcome; error?: string }[]> {
  const entries = await scanProjectRecoveries(rootDir)
  const out: { sessionId: string; outcome?: RecoveryOutcome; error?: string }[] = []
  for (const e of entries) {
    if (e.error) {
      out.push({ sessionId: e.sessionId, error: e.error })
      continue
    }
    if (!e.resumable.length && !e.lost.length) continue
    try {
      const store = await openProject(e.sessionId)
      out.push({ sessionId: e.sessionId, outcome: await recoverProject(store, depsFor(e.sessionId)) })
    } catch (err) {
      out.push({ sessionId: e.sessionId, error: (err as Error).message })
    }
  }
  return out
}
