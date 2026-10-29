// S9 工程图 HTTP 面（设计文档 §10 S9、§3.4、§3.7）。
//
// 三类入口：
//   1) opencode 工具（loopback + X-Internal-Token）：POST /internal/project/{context,get,patch,run}
//      — context 给 eimu-guard 的 transform 用（1.5s 预算，只读图、绝不跑执行器）；
//      — get/patch 的 Actor 由网关按 sessionID 解析（主席位=agent，子代理席位=subagent+lane），
//        工具不得自带 actor（§10 S9 做法）。
//   2) 会话主人（Bearer sk-biz-* + getOwnedSession）：/agent/v1/sessions/:id/project{,/patch,/run}
//      — S10b 画布人手回写走这里，Actor 强制 user（§3.4「人手改动回写」）。
//   3) 网关启动：initProjectSubsystem() → 注册默认执行器 + 扫 projects/* 接续在途任务（§3.4 崩溃恢复）。
//      恢复只按 scanRecovery 的 action 分流，绝不换 key 盲重投（recovery.ts 强制同 idemKey）。
//
// 回执上限：patch/run ≤1024B、get digest ≤6144B、node ≤4096B、events ≤2048B（LIMITS）。
// wait_sec 上限 90 且事件到达即返回：轮询 events.jsonl 的 seq 游标，不空转式长挂。
import path from "node:path"
import { createHash } from "node:crypto"
import { projectBriefResponse } from "./brief.ts"
import { productionJournalOperation, productionGenerationOperation, loadGenerationJournal } from "./generation-journal.ts"
import { stableGenerationOwnerScope } from "../job-delivery.ts"
import { sharedGenerationScope } from "../generation-scope.ts"
import { CONFIRM_TIMEOUT_MS } from "../constants-gateway.ts"
import { jsonError } from "../gw-lib.ts"
import { getOwnedSession, resolveSession } from "../sessions-core.ts"
import { subagentParentState } from "../subagent.ts"
import { byChildOc } from "../subagent-runs.ts"
import { generationParent, generationReceipt, saveDurableSubagentRun } from "../job-store.ts"
import { internalTokenRejection } from "../task-board-http.ts"
import { settleConfirm, readSpendConfirmation } from "../media-internal-routes.ts"
import { emitToSession } from "../sse-core.ts"
import { billingAutoApprovalEnabled } from "../charge-approval-policy.ts"
import { admit, buildPlan, sessionConfirmPort, type ConfirmPort, type Quote } from "./admission.ts"
import { ProjectCanvasBridge } from "./bridge-canvas.ts"
import { CacheIndex } from "./cache-index.ts"
import { LIMITS } from "./constants.ts"
import { onProjectEvents } from "./events.ts"
import { projectContextResponse, projectFactsResponse, type AgentMessage, type AgentPart } from "./context.ts"
import { renderDigest, type DigestInputs } from "./digest.ts"
import { createExecBridgeClient } from "./exec-bridge-client.ts"
import { accumulatedSpendCoins, bindSessionBudget, createLedgerWriter, createProjectBudget, gatewayProjectCapOf, graphCapCoins, type ProjectBudgetPort } from "./ledger.ts"
import { emitDeliveryCards } from "./delivery.ts"
import { getRecipe } from "./recipes/index.ts"
import { recoverProject } from "./recovery.ts"
import { cancelProjectRun, runProject, type RunResult } from "./run.ts"
import { projectDirFor, resetSharedProjectStores, scanProjectRecoveries, setDefaultRecipes, sharedProjectStore, workspaceDir, ProjectNotFoundError, ProjectStore, ackProjectArtifacts } from "./store.ts"
import { createSubmitGeneration } from "./submit-generation.ts"
import type { RunDeps } from "./scheduler.ts"
import { acknowledgeBridgeOutputs } from "./scheduler.ts"
import type { RecoveryDeps } from "./recovery.ts"
import type {
  Actor, NodeId, NodeView, PatchReceipt, ProjectEvent, ProjectGetArgs, ProjectGetReceipt, ProjectGraph,
  ProjectNode, ProjectPatchArgs, ProjectRunArgs, ProjectRunReceipt,
} from "./types.ts"
import type { SessionState } from "../types-gateway.ts"

const WAIT_SEC_MAX = LIMITS.WAIT_SEC_MAX
const EVENT_POLL_MS = 150
/** 后台 run 的总时长上限（HTTP 不挂住执行链；receipt 立刻回 started/running）。 */
const RUN_BACKGROUND_MS = 30 * 60_000

function bytesOf(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
}

function clampWaitSec(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(WAIT_SEC_MAX, Math.floor(raw))
}

/** 测试用：wait_sec 的钳制规则（契约上限 90，超出不拒绝请求、只缩短等待）。 */
export { clampWaitSec }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!isRecord(body)) return jsonError(400, "body must be a JSON object", "bad_request", "bad_request")
  return body
}

function clipChars(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
}

// ───────────────────────── 接线点（生产默认；测试可整体替换） ─────────────────────────

/**
 * routes.ts 与网关既有机制的接线面。默认实现：
 *   owned     = getOwnedSession（Bearer key 的会话归属校验，与 /agent/v1 家族同款）
 *   state     = resolveSession ?? subagentParentState（opencode 子会话归一到父会话）
 *   actor     = 主席位 agent；子代理席位 subagent{lane:[]}（lane 由 S16 收紧，默认空=只读）
 *   deps      = 生产 RunDeps（submitGeneration/execBridge/ledger/budget/cache）
 *   confirm   = sessionConfirmPort 适配到 media-internal-routes 的 settleConfirm/pendingConfirms
 *   authorized= billingAutoApprovalEnabled（auto/full 持续授权）
 */
export interface ProjectRouteHost {
  owned(key: string, sessionId: string): SessionState | undefined
  state(sessionId: string): SessionState | undefined
  actor(sessionId: string, state: SessionState | undefined): Actor
  deps(state: SessionState, store: ProjectStore): RunDeps & RecoveryDeps
  confirm(state: SessionState): ConfirmPort | undefined
  authorized(state: SessionState): Promise<boolean>
  wakeContinuation?(state: SessionState, note: { id: string; label: string; kind: string; text: string; signal?: AbortSignal }): Promise<"delivered" | "deferred" | "unknown">
}

function canonicalSessionId(state: SessionState | undefined, fallback: string): string {
  const id = (state as { sessionId?: unknown } | undefined)?.sessionId
  return typeof id === "string" && id ? id : fallback
}

/**
 * Actor 只由网关按 sessionID 解析（§3.8、§10 S9「工具不得自带 actor」）：
 *   1. 命中 subagent-runs 的 byChildOc（subagentParentState 用的同一张表）→ Actor{subagent, runId, lane}，
 *      lane 来自 S16 派工时写入的 run.lane（缺省=只读）。
 *   2. 未命中但仍是「已知子会话」（收尾后 byChildOc 已删）→ Actor{subagent, lane:[]}：一律只读，
 *      绝不因 run 收尾升格成主席位（否则迟到的工具调用可绕过 lane 全写）。
 *   3. 都不是 → Actor{agent}。
 * 请求体里的 actor/lane 一律不读——身份不从网络输入来。
 */
function defaultActor(sessionId: string, _state: SessionState | undefined): Actor {
  const run = byChildOc.get(sessionId)
  if (run) {
    const runId = typeof run.id === "string" && run.id ? run.id : sessionId
    const lane = Array.isArray(run.lane) ? run.lane : []
    return { kind: "subagent", runId, lane }
  }
  if (isKnownChildSession(sessionId)) return { kind: "subagent", runId: sessionId, lane: [] }
  return { kind: "agent" }
}

/**
 * 「这个 sessionID 是子会话」的两条独立证据：
 *   - subagentParentState：byChildOc 已删时走 recentChildParent（TTL 2h）→ durable 绑定；
 *     但它要网关 deps 已接线且父会话可解析，父会话被逐出就 miss。
 *   - generationParent：generation_consumers 耐久行，不需要 deps、不过期。
 * 任一命中即按子会话处理（fail-closed）。DB 不可读时与网关其余部分同级降级为「不是子会话」，
 * 不因此让所有补丁 500。
 */
function isKnownChildSession(sessionId: string): boolean {
  try {
    if (subagentParentState(sessionId)) return true
  } catch {
    // 父会话解析不可用：继续看耐久绑定。
  }
  try {
    return generationParent(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * takes select:"qc" 的评分端口。执行器注册表在 initProjectSubsystem 里才装载（避免路由模块
 * 拖入全部执行器），所以这里只保存启动时拿到的端口；未装载时调度器退回读候选 meta.qcScore。
 */
let defaultScoreTakeRef: RunDeps["scoreTake"] | undefined

function productionDeps(state: SessionState, store?: ProjectStore): RunDeps & RecoveryDeps {
  let hold: Promise<void> = Promise.resolve()
  const budget = createProjectBudget({
    capOf: gatewayProjectCapOf(state.sessionId),
    beforeReserve: () => hold,
  })
  bindSessionBudget(state.sessionId, budget)
  if (store) {
    hold = (async () => {
      try {
        const g = await store.read()
        budget.noteCarry?.({ spentCoins: accumulatedSpendCoins(g), capCoins: graphCapCoins(g) })
      } catch {
        // 图读失败时预留仍走 gateway capOf：读不到就 fail-closed，不放行未知预算。
      }
    })()
  }
  const ledger = createLedgerWriter(state)
  const execBridge = createExecBridgeClient()
  return {
    session: state,
    ledger,
    submitGeneration: createSubmitGeneration({ session: state, ledger, budget, ...(store ? { journalOperation: productionJournalOperation(state.sessionId, store) } : {}) }),
    execBridge,
    ...(store ? {generationOperation:productionGenerationOperation(state.sessionId,store,execBridge)} : {}),
    authorizedRecovery: async () => billingAutoApprovalEnabled(state),
    budget,
    ...(defaultScoreTakeRef ? { scoreTake: defaultScoreTakeRef } : {}),
    cache: CacheIndex.forProject(workspaceDir(), state.sessionId),
    signal: AbortSignal.timeout(RUN_BACKGROUND_MS),
  }
}

const productionHost: ProjectRouteHost = {
  owned: (key, sessionId) => getOwnedSession(key, sessionId),
  state: (sessionId) => resolveSession(sessionId) ?? subagentParentState(sessionId),
  actor: defaultActor,
  deps: (state, store) => productionDeps(state, store),
  confirm: (state) => projectConfirmPort(state),
  authorized: (state) => billingAutoApprovalEnabled(state),
}

let host: ProjectRouteHost = productionHost

/** 组合根接回既有父席位唤醒；不另建席位或制作执行器。 */
export function setProjectContinuationWake(wake: NonNullable<ProjectRouteHost["wakeContinuation"]>): void {
  productionHost.wakeContinuation = wake
  host.wakeContinuation = wake
}

const CONTINUATION_DRAINS = new Map<string, Promise<void>>()
const CONTINUATION_AGAIN = new Set<string>()
const CONTINUATION_SIGNALS = new Map<string, AbortController>()

export async function cancelSessionProject(sessionId: string): Promise<void> {
  CONTINUATION_SIGNALS.get(sessionId)?.abort()
  try { await cancelProjectRun(await openStore(sessionId)) } catch (e) {
    if (!(e instanceof ProjectNotFoundError)) throw e
  }
}

/** 只消费已提交的状态变化。投递前耐久占位；unknown 只能对账，重启不盲重投。 */
export async function drainProjectContinuations(sessionId: string): Promise<void> {
  const active = CONTINUATION_DRAINS.get(sessionId)
  if (active) { CONTINUATION_AGAIN.add(sessionId); return active }
  const promise = consumeProjectContinuation(sessionId).finally(() => {
    if (CONTINUATION_DRAINS.get(sessionId) === promise) CONTINUATION_DRAINS.delete(sessionId)
    if (CONTINUATION_AGAIN.delete(sessionId)) void drainProjectContinuations(sessionId).catch((e) => console.error("[gateway] project continuation:", (e as Error).message))
  })
  CONTINUATION_DRAINS.set(sessionId, promise)
  return promise
}

async function consumeProjectContinuation(sessionId: string): Promise<void> {
  const state = host.state(sessionId)
  if (!state || !host.wakeContinuation) return
  const store = await openStore(canonicalSessionId(state, sessionId))
  await store.update((g) => {
    const c = g.continuation
    if (!c || c.cancelled || g.activeRun) return
    for (const author of c.tasks.filter((t) => (t.kind === "author" || t.kind === "provider_unknown") && t.delivery !== "completed" && t.delivery !== "cancelled")) {
    if (author.nodes.every((id) => {
      const n = g.nodes[id]
      return !!n && n.status === "done" && n.outputs.length > 0
    })) {
      author.delivery = "completed"
      const id = `${author.id}:ready`
      if (!c.tasks.some((t) => t.id === id)) c.tasks.push({
        id, kind: "continue", owner: "orchestrator", nodes: author.nodes,
        reason: "等待的产物已真正写入工程。按原 targets 增量运行；先核对真实授权，禁止重复生成已成功素材。", delivery: "pending",
      })
    }
    }
  })
  const graph = await store.read()
  const continuation = graph.continuation
  if (!continuation || continuation.cancelled || graph.activeRun) return
  for (const snapshot of continuation.tasks) {
    if (snapshot.owner !== "orchestrator" || snapshot.delivery !== "pending") continue
    // 父回合在途时不占位；由已有 idle flusher 继续，不轮询。
    if (state.ackTimer != null) return
    let claimed = false
    await store.update((g) => {
      const c = g.continuation
      const task = c?.tasks.find((t) => t.id === snapshot.id)
      if (c?.runId !== continuation.runId || c.cancelled || g.activeRun || task?.delivery !== "pending") return
      task.delivery = "delivering"
      claimed = true
    })
    if (!claimed) continue
    let outcome: "delivered" | "deferred" | "unknown" = "unknown"
    const controller = new AbortController()
    CONTINUATION_SIGNALS.set(sessionId, controller)
    try {
      const fresh = await store.read()
      if (fresh.continuation?.cancelled || fresh.continuation?.runId !== continuation.runId) continue
      outcome = await host.wakeContinuation(state, {
        id: snapshot.id, label: "工程接续", kind: snapshot.kind,
        signal: controller.signal,
        text: `工程 ${sessionId}，执行 ${continuation.runId}。责任：${snapshot.kind}；节点：${snapshot.nodes.join(", ") || "整单交付"}。\n${snapshot.reason}\n原 targets：${JSON.stringify(continuation.targets ?? null)}。读取当前工程与用户有效目标后通过既有研究、派工、定向返工、project_run 继续。此通知不是用户授权或完成证明，不得降低内容要求、重复自审同一素材、轮询平台故障或未知订单。`,
      })
    } catch (e) {
      console.error(`[gateway] project continuation dispatch unknown (${sessionId}):`, (e as Error).message)
    } finally {
      if (CONTINUATION_SIGNALS.get(sessionId) === controller) CONTINUATION_SIGNALS.delete(sessionId)
      await store.update((g) => {
        if (g.continuation?.runId !== continuation.runId || g.continuation.cancelled) return
        const task = g.continuation.tasks.find((t) => t.id === snapshot.id)
        if (task?.delivery === "delivering") task.delivery = outcome === "deferred" ? "pending" : outcome
      })
    }
  }
}

/** 测试注入；返回 restore。未覆盖的字段继续走生产实现。 */
export function configureProjectRoutes(overrides: Partial<ProjectRouteHost>): () => void {
  const prev = host
  host = { ...productionHost, ...overrides }
  return () => { host = prev }
}

// ───────────────────────── 确认卡（S6 留的缺口） ─────────────────────────
// 接到 media-internal-routes 的同一套状态：pendingConfirms + resolvedConfirms + settleConfirm。
// request() 只登记并立即返回 "pending"（绝不 await 用户）；auto/full 由 admission 的 authorized 直放，
// 因此这里只在「未授权且金额过阈值」时才会被调用。
export function projectConfirmPort(state: SessionState): ConfirmPort {
  const base = sessionConfirmPort<{ timer: ReturnType<typeof setTimeout>; ledger?: { amount_coins: number } }>({
    state: state as unknown as {
      sessionId: string
      pendingConfirms: Map<string, { timer: ReturnType<typeof setTimeout>; ledger?: { amount_coins: number } }>
    },
    createEntry: ({ amountCoins }) => ({ timer: setTimeout(() => {}, 0), ledger: { amount_coins: amountCoins } }),
    emit: (name, data) => emitToSession(state, name, data),
    settle: (requestId, outcome) => settleConfirm(state, requestId, outcome),
    statusOf: (requestId) => confirmStatusOf(state, requestId),
    timeoutMs: CONFIRM_TIMEOUT_MS,
  })
  return {
    async request(a) {
      // 同一 requestId 重入（agent 再次 project_run）：上次答复直接复用，不重弹卡。
      const settled = await base.status?.(a.requestId)
      if (settled === "approved" || settled === "denied") return settled
      return base.request(a)
    },
    status: (requestId) => Promise.resolve(confirmStatusOf(state, requestId)),
  }
}

function confirmStatusOf(state: SessionState, requestId: string): "pending" | "approved" | "denied" | "unknown" {
  const resolved = state.resolvedConfirms.get(requestId)
  if (resolved) return resolved.outcome === "approved" ? "approved" : "denied"
  return state.pendingConfirms.has(requestId) ? "pending" : "unknown"
}

// 配方注册表在组合根注入一次：首句 ingress 的 apply_recipe 与工具路由用同一张表（缺了会回 UNKNOWN_RECIPE、首屏空图）。
setDefaultRecipes(getRecipe)

// ───────────────────────── 工程 store 注册表（进程内单例，写串行） ─────────────────────────
const STORES = new Map<string, ProjectStore>()

/** 打开已有工程（不创建）；不存在抛 ProjectNotFoundError。同一目录在整个进程里只有一个 store（共享 promise 链）。 */
async function openStore(sessionId: string, opts: { create?: boolean } = {}): Promise<ProjectStore> {
  const dir = projectDirFor(sessionId)
  const cached = STORES.get(dir)
  if (cached) return cached
  const store = sharedProjectStore(sessionId)
  // 工程模式会话的图在首条用户消息 ingress 才建；工具/画布先到时不能回 404 断点，就地建空图（幂等）。
  if (opts.create) await store.ensure()
  await store.read()
  STORES.set(dir, store)
  return store
}

/** 仅测试：丢掉缓存的 store 实例与在跑表。 */
export function resetProjectStores(): void {
  STORES.clear()
  resetSharedProjectStores()
  RUNNING.clear()
  CANVAS_BRIDGES.clear()
  DELIVERY_SEEN.clear()
}

// ─────────────────────── S20 画布桥与交付卡接线（§3.4 画布呈现 / §3.9 交付只认 export 产物） ───────────────────────
// 画布：事件 → canvas.node.*（S10a 的桥），按 store 目录缓存；首次创建时 syncGraph 补齐首屏。
// 交付卡：只从 export 产物出卡（S17 的 deliverablesFromExport），按 nodeId:sha256 进程内去重。
const CANVAS_BRIDGES = new Map<string, ProjectCanvasBridge>()
const DELIVERY_SEEN = new Set<string>()

/** 取（或首次创建）该工程的画布桥。首次创建时整图对账一次（不重复发已发过的节点）。 */
async function bridgeFor(
  store: ProjectStore,
  state: SessionState,
): Promise<{ bridge: ProjectCanvasBridge; createdSync: number }> {
  const cached = CANVAS_BRIDGES.get(store.paths.dir)
  if (cached) return { bridge: cached, createdSync: 0 }
  const canonical = canonicalSessionId(state, store.sessionId)
  const bridge = new ProjectCanvasBridge({
    projectId: canonical,
    sessionId: canonical,
    emit: (name, data) => emitToSession(state, name, data),
  })
  CANVAS_BRIDGES.set(store.paths.dir, bridge)
  const createdSync = bridge.syncGraph(await store.read()).frames
  return { bridge, createdSync }
}

/**
 * 从 events.jsonl 追平画布（幂等、可重复调用）。失败只记日志：
 * 画布是呈现面，绝不让 GET/run 因推送失败而失败。
 */
export async function pumpCanvas(
  store: ProjectStore,
  state: SessionState,
): Promise<{ cursor: number; events: number; frames: number }> {
  try {
    const { bridge, createdSync } = await bridgeFor(store, state)
    const pumped = await bridge.pump(store.log, () => store.read())
    // 首次创建时 syncGraph 的帧也算本次追平的产出（首屏补齐）；缓存命中时为 0。
    return { ...pumped, frames: pumped.frames + createdSync }
  } catch (e) {
    console.error(`[gateway] project canvas pump failed (${store.sessionId}):`, (e as Error)?.message ?? e)
    return { cursor: 0, events: 0, frames: 0 }
  }
}

// ─────────────────────── 对话投影：工程事件 → 画布与对话卡 ───────────────────────
// 工程图是真源，画布和对话都是它的投影。任何写入方（ingress 配方、模型补丁、子代理、执行器、恢复）
// 追加事件后都在这里统一推送：画布即时追平；新产出的图／片／音直接进对话，不必等到 export。
// 只投影本批事件里新出的 node_output，进程重启不会把旧产物重刷一遍。
const PROJECTION_DEBOUNCE_MS = 150
const PROGRESS_CARD_TYPES = new Set(["keyframe", "clip", "music", "voice", "mix", "render3d"])
const PENDING_PROJECTION = new Map<string, { timer: ReturnType<typeof setTimeout>; outputs: Set<string> }>()

onProjectEvents((file, events) => {
  if (events.some((e) => e.kind === "run_started")) CONTINUATION_SIGNALS.get(path.basename(path.dirname(file)))?.abort()
  if (events.some((e) => e.kind === "run_finished" || e.kind === "node_output")) {
    void drainProjectContinuations(path.basename(path.dirname(file))).catch((e) => console.error("[gateway] project continuation:", (e as Error).message))
  }
  const dir = path.dirname(file)
  let pending = PENDING_PROJECTION.get(dir)
  if (!pending) {
    pending = {
      outputs: new Set(),
      timer: setTimeout(() => {
        const batch = PENDING_PROJECTION.get(dir)
        PENDING_PROJECTION.delete(dir)
        void projectToSession(path.basename(dir), [...(batch?.outputs ?? [])])
      }, PROJECTION_DEBOUNCE_MS),
    }
    PENDING_PROJECTION.set(dir, pending)
  }
  for (const e of events) if (e.kind === "node_output" && e.node) pending.outputs.add(e.node)
})

async function projectToSession(sessionId: string, outputNodes: string[]): Promise<void> {
  try {
    const state = host.state(sessionId)
    if (!state || state.projectMode !== true) return
    const store = await openStore(canonicalSessionId(state, sessionId))
    await pumpCanvas(store, state)
    if (outputNodes.length) emitProgressCards(state, await store.read(), outputNodes)
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return
    console.error(`[gateway] project projection failed (${sessionId}):`, (e as Error)?.message ?? e)
  }
}

/** 节点新产物 → 对话里的图／片／音卡（与 export 交付卡共用去重表；只发有公网 url 的真实产物）。 */
export function emitProgressCards(
  state: SessionState,
  graph: Readonly<ProjectGraph>,
  nodeIds: readonly string[],
  emit: (name: string, data: unknown) => void = (name, data) => emitToSession(state, name, data),
): number {
  let emitted = 0
  for (const id of nodeIds) {
    const node = graph.nodes[id]
    if (!node || node.status !== "done" || !PROGRESS_CARD_TYPES.has(node.type)) continue
    for (const out of node.outputs ?? []) {
      const url = typeof out.url === "string" ? out.url.trim() : ""
      if (!url) continue
      const key = `${id}:${out.sha256}`
      if (DELIVERY_SEEN.has(key)) continue
      const mime = String(out.mime ?? "").toLowerCase()
      const event = mime.startsWith("image/") ? "image.done" : mime.startsWith("video/") ? "video.done" : mime.startsWith("audio/") ? "audio.done" : null
      if (!event) continue
      DELIVERY_SEEN.add(key)
      const mediaKind = event === "image.done" ? "image" : event === "video.done" ? "video" : "audio"
      emit(event, {
        url,
        cost_coins: node.lastRun?.costCoins ?? 0,
        task_id: id,
        media_kind: mediaKind,
        ...(node.intent ? { title: clipChars(node.intent, 60) } : {}),
      })
      emitted += 1
    }
  }
  return emitted
}

/** run 收尾：先追平画布，再从 export 产物发交付卡（全程不抛）。 */
async function settleDelivery(store: ProjectStore, state: SessionState): Promise<void> {
  await pumpCanvas(store, state)
  try {
    const graph = await store.read()
    emitDeliveryCards(state, graph, (name, data) => emitToSession(state, name, data), DELIVERY_SEEN)
  } catch (e) {
    console.error(`[gateway] project delivery cards failed (${state.sessionId}):`, (e as Error)?.message ?? e)
  }
}

// ───────────────────────── 内部入口（loopback + X-Internal-Token） ─────────────────────────
export async function handleProjectInternal(req: Request, pathname: string): Promise<Response> {
  try {
    return await handleProjectInternalInner(req, pathname)
  } catch (e) {
    // 机器调用方收 HTML 500 会直接解析失败（G2 教训）：任何未预期抛错一律回 JSON。
    console.error(`[gateway] project internal ${pathname} failed:`, (e as Error)?.stack ?? e)
    return jsonError(500, "project internal error", "internal_error", "internal_error")
  }
}

async function handleProjectInternalInner(req: Request, pathname: string): Promise<Response> {
  const tokenError = internalTokenRejection(req)
  if (tokenError) return tokenError
  const m = /^\/internal\/project\/(context|get|patch|run|generate)$/.exec(pathname)
  if (!m) return jsonError(404, "not found", "not_found", "not_found")
  if (req.method !== "POST") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
  const op = m[1]

  const body = await readJson(req)
  if (body instanceof Response) return body
  const sessionId = typeof body.session_id === "string" ? body.session_id : ""
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")

  const state = host.state(sessionId)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const canonical = canonicalSessionId(state, sessionId)

  if (op === "context") return handleContext(canonical, state, body)

  let store: ProjectStore
  try {
    store = await openStore(canonical, { create: op === "generate" || (state.projectMode === true && body.create !== false) })
  } catch (e) {
    if (e instanceof ProjectNotFoundError && op === "get" && body.view === "nodes" && body.create === false) return Response.json({ ok: true, project_mode: state.projectMode === true, project_state: "absent", version: 0, nodes: [] })
    if (e instanceof ProjectNotFoundError) return jsonError(404, "project not found", "not_found", "project_not_found")
    throw e
  }

  if (op === "get") return handleInternalGet(store, body, state)
  if (op === "patch") return handlePatchOp(store, body, host.actor(sessionId, state))
  if (op === "generate") return handleGenerateOp(store, state, body, host.actor(sessionId, state))
  return handleRunOp(store, state, body)
}

// ───────────────────────── 公开入口（会话主人） ─────────────────────────
export async function handleProjectSessionRoute(key: string, sessionId: string, req: Request, pathname: string): Promise<Response> {
  try {
    return await handleProjectSessionRouteInner(key, sessionId, req, pathname)
  } catch (e) {
    console.error(`[gateway] project route ${pathname} failed:`, (e as Error)?.stack ?? e)
    return jsonError(500, "project route error", "internal_error", "internal_error")
  }
}

async function handleProjectSessionRouteInner(key: string, sessionId: string, req: Request, pathname: string): Promise<Response> {
  const m = /^\/agent\/v1\/sessions\/([^/]+)\/project(?:\/(patch|run))?$/.exec(pathname)
  if (!m) return jsonError(404, "not found", "not_found", "not_found")
  const state = host.owned(key, sessionId)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const canonical = canonicalSessionId(state, sessionId)

  let store: ProjectStore
  try {
    store = await openStore(canonical, { create: state.projectMode === true })
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return jsonError(404, "project not found", "not_found", "project_not_found")
    throw e
  }

  if (!m[2]) {
    if (req.method !== "GET") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
    // 公开读面按契约走 query（view/node/since/wait_sec/detail）；工具走内部 POST。
    const q = new URL(req.url).searchParams
    const args: Record<string, unknown> = {}
    if (q.has("view")) args.view = q.get("view")
    if (q.has("node")) args.node = q.get("node")
    if (q.has("detail")) args.detail = q.get("detail")
    if (q.has("since")) args.since = Number(q.get("since"))
    if (q.has("wait_sec")) args.wait_sec = Number(q.get("wait_sec"))
    // S20：先追平画布（模型轮询与用户读面都走这里），再读回执。
    await pumpCanvas(store, state)
    return Response.json(await buildGetReceipt(store, state, args))
  }
  if (req.method !== "POST") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
  const body = await readJson(req)
  if (body instanceof Response) return body
  if (m[2] === "patch") {
    // 画布人手回写：Actor 强制 user（§3.4）。模型永远不通过画布写工程图。
    return handlePatchOp(store, body, { kind: "user" })
  }
  return handleRunOp(store, state, body)
}

// ───────────────────────── 上下文装配 ─────────────────────────
/**
 * POST /internal/project/context — 每轮上下文装配（§3.7 第 5 点）。
 * 请求 `{session_id, messages:[{id,role,summary?,parts:[...]}]}`；非工程会话/工程不存在 → 404，
 * 插件据此逐字节回旧路径。只读 project.json，不跑执行器（插件超时 1.5s）。
 */
async function handleContext(canonical: string, state: SessionState, body: Record<string, unknown>): Promise<Response> {
  // 旧席位只增补工程事实，历史仍由 opencode 管；历史 lean 席位沿用既有窗口。
  if (state.projectMode !== true) {
    return jsonError(404, "project mode not enabled for this session", "not_found", "not_project_session")
  }
  const raw = body.messages
  if (!Array.isArray(raw)) return jsonError(400, "messages must be an array", "bad_request", "bad_request")
  let graph: ProjectGraph
  let store: ProjectStore
  try {
    store = await openStore(canonical)
    graph = await store.read()
  } catch (e) {
    if (e instanceof ProjectNotFoundError) return Response.json({ project_mode: false, project_state: "absent" })
    throw e
  }
  // S14 停掉工程模式的尾部注入后，「授权模式 / 环境可用性 / 最近事件」只能靠摘要承接：
  // 与 project_get 的 digest 视图共用 digestInputs（一次 authorized 判定 + 读最近 10 行事件）。
  if (state.seat !== "creator") return Response.json(projectFactsResponse(graph, await digestInputs(store, graph, state)))
  return Response.json(
    projectContextResponse(graph, toAgentMessages(raw), { digestInputs: await digestInputs(store, graph, state) }),
  )
}

/** 请求体的扁平消息形状 → context.ts 的 AgentMessage（也接受已嵌套的 info）。 */
function toAgentMessages(raw: unknown[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const infoRaw = isRecord(item.info) ? item.info : item
    const id = typeof infoRaw.id === "string" ? infoRaw.id : ""
    const role = typeof infoRaw.role === "string" ? infoRaw.role : ""
    if (!id || !role) continue
    const parts: AgentPart[] = Array.isArray(item.parts) ? (item.parts.filter(isRecord) as AgentPart[]) : []
    const info: AgentMessage["info"] = { id, role }
    if (typeof infoRaw.sessionID === "string") info.sessionID = infoRaw.sessionID
    if (infoRaw.summary === true) info.summary = true
    out.push({ info, parts })
  }
  return out
}

// ───────────────────────── GET ─────────────────────────
/** 内部 get（工具用）：额外支持 view:"nodes"（工具端展开 {op:"dsl"} 时取当前图摘要）。 */
async function handleInternalGet(store: ProjectStore, body: Record<string, unknown>, state: SessionState | undefined): Promise<Response> {
  if (body.view === "brief") return Response.json(projectBriefResponse(await store.read(), body))
  // S20：模型轮询是最重要的画布追平点（GET 先 pump 再读回执）。
  if (state) await pumpCanvas(store, state)
  if (body.view === "nodes") {
    const graph = await store.read()
    const nodes: Record<string, unknown>[] = []
    for (const id of graph.order) {
      const node = graph.nodes[id]
      if (node) nodes.push(compactNode(node))
    }
    return Response.json({ ok: true, project_mode: state?.projectMode === true, version: graph.version, cursor: graph.seq, nodes })
  }
  return Response.json(await buildGetReceipt(store, state, body))
}

/** 工具端展开 DSL 用的节点摘要（只带编译器关心的字段，去掉产物/账本噪音）。 */
function compactNode(node: ProjectNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id, type: node.type, intent: node.intent, params: node.params, inputs: node.inputs, refs: node.refs, rev: node.rev,
    pinned: node.pinned ? { take: node.pinned.take, reason: node.pinned.reason } : null,
  }
  if (node.forEach) out.forEach = node.forEach
  if (node.takes) out.takes = node.takes
  if (node.onFail) out.onFail = node.onFail
  if (node.locked) out.locked = node.locked
  if (node.derivedFrom) out.derivedFrom = node.derivedFrom
  if (node.scratch) out.scratch = node.scratch
  return out
}

async function buildGetReceipt(store: ProjectStore, state: SessionState | undefined, rawArgs: Record<string, unknown> = {}): Promise<ProjectGetReceipt> {
  const args = rawArgs as ProjectGetArgs
  // 给了 node 就是看节点（模型常漏写 view 或写错成 view:"full"，此前静默退回 digest，它以为没读到又接着猜）。
  const hasNode = typeof args.node === "string" && args.node.trim() !== ""
  const view = args.view === "events" ? "events" : args.view === "node" || (hasNode && args.view !== "digest") ? "node" : "digest"
  let graph = await store.read()
  const explicitSince = typeof args.since === "number" && Number.isFinite(args.since) ? Math.max(0, Math.floor(args.since)) : null
  const since = view === "events" ? (explicitSince ?? Math.max(0, graph.seq - 20)) : graph.seq
  const waitMs = clampWaitSec(args.wait_sec) * 1000

  if (waitMs > 0 && view !== "node") {
    await waitForEvents(store, since, waitMs)
    graph = await store.read()
  }

  if (view === "digest") {
    const digest = renderDigest(graph, await digestInputs(store, graph, state), LIMITS.DIGEST_BYTES - 96, { nodeMap: true })
    return fitGetReceipt({ ok: true, version: graph.version, cursor: graph.seq, digest })
  }

  if (view === "node") {
    const nodeId = typeof args.node === "string" ? args.node : ""
    const node = nodeId ? graph.nodes[nodeId] : undefined
    if (!node) return { ok: false, version: graph.version, cursor: graph.seq, known: knownNodeIds(graph) }
    return fitGetReceipt({ ok: true, version: graph.version, cursor: graph.seq, node: nodeView(node, args.detail) })
  }

  // events：seq > since，最多 20 行、总 ≤2048B；新事件到达即返回（上面的 wait 已经等到）。
  const all = await store.log.read(since)
  const lines: string[] = []
  let used = 0
  let truncated = all.length > 20
  for (const e of all.slice(0, 20)) {
    const line = eventLine(e)
    const cost = bytesOf(line) + 4
    if (used + cost > LIMITS.EVENTS_BYTES - 96) { truncated = true; break }
    lines.push(line)
    used += cost
  }
  if (all.length > lines.length) truncated = true
  const cursor = lines.length ? all[lines.length - 1].seq : since
  const receipt: ProjectGetReceipt = { ok: true, version: graph.version, cursor, events: lines }
  if (truncated) receipt.truncated = true
  return fitGetReceipt(receipt)
}

/** 节点不存在时回给代理的现有 id（按类型分组），让它一次改对，不再逐个猜。 */
function knownNodeIds(graph: ProjectGraph): string {
  const byType = new Map<string, string[]>()
  for (const id of graph.order?.length ? graph.order : Object.keys(graph.nodes)) {
    const n = graph.nodes[id]
    if (!n || id.includes("#")) continue
    byType.set(n.type, [...(byType.get(n.type) ?? []), id])
  }
  return [...byType].map(([t, ids]) => `${t}: ${ids.join(",")}`).join("; ").slice(0, 1500)
}

async function digestInputs(store: ProjectStore, graph: ProjectGraph, state: SessionState | undefined): Promise<DigestInputs> {
  const authorized = state ? await host.authorized(state).catch(() => false) : false
  let recent: ProjectEvent[] = []
  try {
    recent = await store.log.read(Math.max(0, graph.seq - 10))
  } catch {
    recent = [] // 事件文件不可读时摘要照出，只是少一段
  }
  return {
    authorization: authorized ? "auto/full：持续授权，不必逐次确认" : "逐次确认：超过阈值需用户同意",
    environment: `exec-bridge ${process.env.EXEC_BRIDGE_URL ? "已配置" : "http://127.0.0.1:8767（默认）"}`,
    recentEvents: recent.slice(-10),
  }
}

/** 轮询 events.jsonl 的 seq 游标；有新行立即返回，不空转式长挂。 */
async function waitForEvents(store: ProjectStore, since: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if ((await store.log.count()) > since) return
    const left = deadline - Date.now()
    if (left <= 0) return
    await sleep(Math.min(EVENT_POLL_MS, left))
  }
}

function eventLine(e: ProjectEvent): string {
  const d = isRecord(e.data) ? e.data : {}
  const parts = [`#${e.seq}`, e.kind]
  if (e.node) parts.push(e.node)
  if (typeof d.status === "string") parts.push(`status=${d.status}`)
  if (typeof d.via === "string") parts.push(`via=${d.via}`)
  if (typeof d.coins === "number") parts.push(`cost=${d.coins}`)
  if (typeof d.saved_coins === "number") parts.push(`saved=${d.saved_coins}`)
  if (typeof d.signature === "string") parts.push(`sig=${d.signature.slice(0, 8)}`)
  if (Array.isArray(d.artifact_ids) && typeof d.artifact_ids[0] === "string") parts.push(`out=${(d.artifact_ids[0] as string).slice(0, 16)}`)
  if (Array.isArray(d.ports) && typeof d.ports[0] === "string") parts.push(`ports=${d.ports.join(",")}`)
  if (typeof d.reason === "string" && d.reason) parts.push(`reason=${d.reason.slice(0, 80)}`)
  if (d.submit_unknown === true) parts.push("submit_unknown")
  if (typeof d.attempt === "number" && d.attempt > 0) parts.push(`a=${d.attempt}`)
  return parts.join(" ")
}

function nodeView(node: ProjectNode, detail: ProjectGetArgs["detail"]): NodeView {
  const full = detail === "full"
  const view: NodeView = {
    id: node.id, type: node.type, status: node.status, intent: node.intent, params: node.params, inputs: node.inputs,
    outputs: node.outputs.map((o) => {
      const out: NodeView["outputs"][number] = { port: o.port, artifactId: o.artifactId, sha256: o.sha256, mime: o.mime, bytes: o.bytes }
      if (typeof o.durationSec === "number") out.durationSec = o.durationSec
      if (o.url) out.url = o.url
      return out
    }),
  }
  if (node.pinned) view.pinned = true
  if (node.pinned && node.signature && node.pinned.signatureAtPin !== node.signature) view.drift = true
  if (node.locked) view.locked = node.locked.fields
  if (node.lastRun) view.lastRun = { via: node.lastRun.via, costCoins: node.lastRun.costCoins, attempt: node.lastRun.attempt, at: node.lastRun.at }
  if (node.error) view.error = `${node.error.code}: ${node.error.message}`.slice(0, full ? 400 : 160)
  if (!full) {
    view.intent = clipChars(view.intent, 200)
    view.params = capParams(view.params, 240)
    if (view.outputs.length > 2) view.outputs = view.outputs.slice(0, 2)
  }
  return view
}

function capParams<T extends Record<string, unknown>>(params: T, maxStr: number): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params ?? {})) out[k] = typeof v === "string" ? clipChars(v, maxStr) : v
  return out as T
}

/** 回执字节上限（digest 6144 / node 4096 / events 2048）：逐级降级，绝不上交超限体。 */
function fitGetReceipt(receipt: ProjectGetReceipt): ProjectGetReceipt {
  const limit = receipt.digest !== undefined ? LIMITS.DIGEST_BYTES : receipt.node !== undefined ? LIMITS.NODE_VIEW_BYTES : LIMITS.EVENTS_BYTES
  if (bytesOf(receipt) <= limit) return receipt
  let r = receipt
  if (r.digest !== undefined) {
    let digest = r.digest
    while (bytesOf(r) > limit && digest.length > 0) {
      const drop = Math.max(1, Math.ceil((bytesOf(r) - limit) / 2))
      digest = digest.slice(0, Math.max(0, digest.length - drop))
      r = { ...r, digest, truncated: true }
    }
    return r
  }
  if (r.node) {
    let node = r.node
    const steps: ((n: NodeView) => NodeView)[] = [
      (n) => ({ ...n, intent: clipChars(n.intent, 80), params: capParams(n.params, 80) }),
      (n) => ({ ...n, outputs: n.outputs.slice(0, 1).map((o) => ({ port: o.port, artifactId: o.artifactId, sha256: o.sha256, mime: o.mime, bytes: o.bytes })) }),
      (n) => ({ ...n, params: {} }),
      (n) => ({ ...n, inputs: {}, outputs: [] }),
    ]
    for (const step of steps) {
      node = step(node)
      r = { ...r, node, truncated: true }
      if (bytesOf(r) <= limit) return r
    }
    return r
  }
  if (r.events) {
    let events = r.events
    while (bytesOf(r) > limit && events.length > 0) {
      events = events.slice(1)
      r = { ...r, events, truncated: true }
    }
  }
  return r
}

// ───────────────────────── PATCH ─────────────────────────
async function handlePatchOp(store: ProjectStore, body: Record<string, unknown>, actor: Actor): Promise<Response> {
  const args = body as unknown as ProjectPatchArgs
  if (!Array.isArray(args.ops)) return jsonError(400, "ops must be an array", "bad_request", "bad_request")
  const ops = args.ops.filter((op) => isRecord(op) && typeof (op as { op?: unknown }).op === "string")
  // 网关只收强类型 PatchOp："dsl" 必须由工具端经站点 compile(target:"project") 展开（§3.4）。
  const typed = ops.filter((op) => (op as { op: string }).op !== "dsl")
  const dslDropped = ops.length - typed.length
  const outcome = await store.applyPatches(
    {
      ops: typed as never[],
      ...(typeof args.baseVersion === "number" ? { baseVersion: args.baseVersion } : {}),
      ...(typeof args.atomic === "boolean" ? { atomic: args.atomic } : {}),
    },
    actor,
  )
  let receipt: PatchReceipt = outcome.receipt
  if (dslDropped > 0) {
    receipt = {
      ...receipt,
      warnings: [...receipt.warnings, `丢弃 ${dslDropped} 个未展开的 dsl op（须先经站点 compile target:"project"）`].slice(0, 3),
    }
  }
  return Response.json(fitPatchReceipt(receipt))
}

function fitPatchReceipt(receipt: PatchReceipt): PatchReceipt {
  if (bytesOf(receipt) <= LIMITS.PATCH_RECEIPT_BYTES) return receipt
  let r = receipt
  const steps: ((x: PatchReceipt) => PatchReceipt)[] = [
    (x) => ({ ...x, changed: [], more: { ...(x.more ?? {}), changed: x.changed.length } }),
    (x) => ({ ...x, stale: [], more: { ...(x.more ?? {}), stale: x.stale.length } }),
    (x) => ({ ...x, drift: [], more: { ...(x.more ?? {}), drift: x.drift.length } }),
    (x) => ({ ...x, warnings: [] }),
    (x) => ({ ...x, rejected: x.rejected.slice(0, 1).map((e) => ({ ...e, msg: e.msg.slice(0, 40) })), more: { ...(x.more ?? {}), rejected: x.rejected.length } }),
  ]
  for (const step of steps) {
    if (bytesOf(r) <= LIMITS.PATCH_RECEIPT_BYTES) return r
    r = step(r)
  }
  return r
}

// ───────────────────────── RUN ─────────────────────────
const RUNNING = new Map<string, Promise<RunResult>>()
const EMPTY_QUOTE: Quote = { coins: null, run: 0, reuse: 0, pinned: 0, unknownPrice: [] }

/** Original media-tool preprocessing enters the same signed node and runner as DSL. */
async function handleGenerateOp(store: ProjectStore, state: SessionState, body: Record<string, unknown>, actor: Actor): Promise<Response> {
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")
  const reject = (code: string, message: string, nodeId?: string) => Response.json({ ok: false, code, message, request_id: requestId, ...(nodeId ? { node_id: nodeId } : {}), recoverable: true, new_generation: false })
  if (!requestId || requestId.length > 200) return reject("bad_input", "需要原始稳定request_id")
  if (actor.kind === "subagent") {
    const live = typeof body.session_id === "string" ? byChildOc.get(body.session_id) : undefined
    if (!live || live.status !== "running" || live.stoppedAt || live.parentGatewaySessionId !== state.sessionId) return reject("lane_denied", "子代理委派已结束或归属未知；保留旧任务但不接受迟到生成")
  }
  if (body.legacy_ref) {
    const ref = body.legacy_ref as any
    const g = await store.read()
    const receipt = typeof ref.task_id === "string" ? generationReceipt(ref.task_id) : undefined
    const originalRequestId = ref.source === "retry_task_id" && receipt ? receipt.tool_request_id ?? receipt.request_id : ref.request_id
    const recoveredRequestId = typeof originalRequestId === "string" && originalRequestId ? originalRequestId : requestId
    const node = Object.values(g.nodes).find(n => (n.params.toolSubmission as any)?.identity?.request_id === originalRequestId)
    if (node && receipt?.parent_gw === state.sessionId && receipt.node_id === node.id && receipt.tool_request_id === originalRequestId) {
      if (actor.kind === "subagent" && !actor.lane.includes(node.id)) return reject("lane_denied", "旧任务不属于当前子代理节点", node.id)
      return Response.json({ ok: true, task_id: ref.task_id, request_id: recoveredRequestId, node_id: node.id, status: receipt.status === "succeeded" ? "succeeded" : "accepted", new_generation: false })
    }
    let evidence = "unknown"
    if (receipt?.parent_gw === state.sessionId && (receipt.tool_request_id ?? receipt.request_id) === originalRequestId && receipt.kind === ref.kind && (actor.kind !== "subagent" || receipt.producer_oc === body.session_id)) {
      const owner = await stableGenerationOwnerScope(state.sessionId)
      if (owner) {
        const journal = await loadGenerationJournal()
        const originalProject = receipt.tool_request_id ? receipt.tool_project : receipt.project
        const row = journal.getSubmission(sharedGenerationScope(owner, typeof originalProject === "string" ? originalProject : undefined), originalRequestId)
        if (row?.task_id === ref.task_id && [state.sessionId, receipt.producer_oc].includes(row.session_id) && row.state !== "rejected") evidence = "journal_and_receipt"
      }
    }
    const recoveredNodes: string[] = []
    await store.update(current => {
      const refs = current.legacyGenerationRefs ??= []
      if (!refs.some(r => r.taskId === ref.task_id && r.requestId === recoveredRequestId)) refs.push({taskId:String(ref.task_id),requestId:recoveredRequestId,kind:ref.kind,evidence,at:new Date().toISOString()})
    })
    try {
    if (evidence === "journal_and_receipt" && receipt?.status === "succeeded" && receipt.artifacts.length) {
      for (let i = 0; i < receipt.artifacts.length; i++) {
        const artifact = receipt.artifacts[i]
        const id = `legacy_${hash([ref.task_id, i]).slice(0,24)}`
        if (!(await store.read()).nodes[id]) {
          const out = await store.artifacts.ingest({ url: artifact.url }, { port: "out", origin: "generated" }, {signal: AbortSignal.timeout(30_000)})
          const snapshot = await store.read()
          const imported = await store.applyPatches({baseVersion:snapshot.version,atomic:true,ops:[{op:"add_node",node:{id,type:"reference",params:{artifactId:out.artifactId}}}]},{kind:"engine"})
          if (!imported.committed) return reject("legacy_artifact_link_failed", "旧产物已保全，工程引用登记失败；未新生成")
          await store.update(current => { const n=current.nodes[id]; n.outputs=[{...out,url:artifact.url,meta:{task_id:ref.task_id,legacy_read_only:true}}]; n.status="done" })
        }
        recoveredNodes.push(id)
      }
      const restored = await store.read()
      try { ackProjectArtifacts(ref.task_id, recoveredNodes.flatMap(id => restored.nodes[id].outputs)) }
      catch { console.error("[project] legacy artifact downloaded ACK pending; durable outputs retained") }
    }
    } catch (error) {
      return Response.json({ok:false,code:"legacy_artifact_recovery_unknown",message:`旧任务已核对，下载/入库尚未完成：${String(error)}；原订单保留，不新生成`,task_id:ref.task_id,request_id:requestId,recoverable:true,new_generation:false})
    }
    await store.update(current => {
      const refs = current.legacyGenerationRefs ??= []
      const record = { taskId: String(ref.task_id), requestId: recoveredRequestId, kind: ref.kind, evidence, nodes:recoveredNodes, at: new Date().toISOString() }
      const index = refs.findIndex(r => r.taskId === ref.task_id && r.requestId === recoveredRequestId)
      if (index < 0) refs.push(record); else if(evidence!=="unknown") refs[index]=record
    })
    if (evidence !== "unknown") return Response.json({ ok: true, task_id: ref.task_id, request_id: recoveredRequestId, node_id:recoveredNodes[0], nodes:recoveredNodes, original_cost_coins:receipt!.cost_coins,new_cost_coins:0,status: receipt!.status === "succeeded" ? "succeeded" : "accepted", legacy_read_only: true, new_generation: false })
    return Response.json({ ok: false, code: "legacy_reconciliation_required", message: "旧任务证据尚未闭合；只读保全原task_id，未新提交", task_id: ref.task_id, request_id: requestId, recoverable: true, new_generation: false })
  }
  const payload = body.payload as Record<string, any>, identity = body.identity as Record<string, any>
  if (!payload || !identity || identity.request_id !== requestId || !["image", "video"].includes(String(body.kind))) return reject("bad_input", "生成载荷或操作身份无效")
  const payloadSignature = hash(Object.fromEntries(Object.entries(payload).filter(([key]) => !["workflow", "cap_coins"].includes(key))))
  if (identity.payload_signature !== payloadSignature) return reject("payload_conflict", "生成载荷指纹不一致")
  let graph = await store.read()
  const type = body.kind === "video" ? "clip" : "keyframe"
  const childRun = typeof body.session_id === "string" ? byChildOc.get(body.session_id) : undefined
  const liveLegacyDelegation = actor.kind === "subagent" && childRun?.status === "running" && !childRun.stoppedAt && childRun.parentGatewaySessionId === state.sessionId && childRun.projectMode !== true && (childRun.lane === undefined || childRun.toolLaneSource === "legacy_generation")
  const laneCandidates = actor.kind === "subagent" ? actor.lane.filter(id => graph.nodes[id]?.type === type) : []
  const generatedId = `tool_${hash([state.sessionId, body.session_id, requestId]).slice(0, 24)}`
  const nodeId = typeof body.node_id === "string" ? body.node_id : !liveLegacyDelegation && actor.kind === "subagent" && laneCandidates.length === 1 ? laneCandidates[0] : generatedId
  if (liveLegacyDelegation && nodeId === generatedId) {
    // 领取新独立节点的能力来自仍存活的旧委派；不把工具请求体变成任意lane权限。
    childRun!.toolLaneSource = "legacy_generation"
    childRun!.lane = [...new Set([...(childRun!.lane ?? []), nodeId])]
    saveDurableSubagentRun(childRun!)
    actor = { kind: "subagent", runId: childRun!.id, lane: childRun!.lane }
  } else if (actor.kind === "subagent" && (!actor.lane.includes(nodeId) || !graph.nodes[nodeId] || childRun?.status !== "running" || childRun.stoppedAt)) return reject("lane_denied", "子代理只能提交仍存活委派的真实节点", nodeId)
  const prepared = { payload, identity: { ...identity, ...(typeof body.project_budget_coins === "number" ? { project_budget_coins: body.project_budget_coins } : {}) }, lock: body.lock ?? {} }
  const prior = graph.nodes[nodeId]
  if (prior?.params.toolSubmission && JSON.stringify(prior.params.toolSubmission) !== "{}") {
    if (hash(prior.params.toolSubmission) !== hash(prepared)) return reject("operation_conflict", "原节点操作载荷不同；新拍请使用新request_id", nodeId)
    const taskId = prior.inflight?.taskId ?? prior.outputs.map(o => o.meta?.task_id).find(t => typeof t === "string")
    if (taskId) return Response.json({ ok: true, task_id: taskId, request_id: requestId, node_id: nodeId, status: prior.status === "done" ? "succeeded" : "accepted", new_generation: false })
  }
  if (!prior?.params.toolSubmission || JSON.stringify(prior.params.toolSubmission) === "{}") {
    const params: Record<string, any> = { prompt: payload.prompt, model: payload.model, size: payload.size, n: payload.n ?? 1, toolSubmission: prepared }
    if (body.kind === "video") Object.assign(params, { seconds: payload.duration_seconds, resolution: payload.resolution, generateAudio: payload.generate_audio })
    else if (payload.quality !== undefined) params.quality = payload.quality
    for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key]
    const ops = prior ? Object.entries(params).map(([key, value]) => ({ op: "set" as const, node: nodeId, path: `params.${key}`, value })) : [{ op: "add_node" as const, node: { id: nodeId, type: type as "clip" | "keyframe", params } }]
    const patched = await store.applyPatches({ baseVersion: graph.version, atomic: true, ops }, actor)
    if (!patched.committed) return reject("node_rejected", JSON.stringify(patched), nodeId)
  }
  const deps = host.deps(state, store)
  const plan = (await buildPlan({ store, deps, targets: [nodeId], mode: "incremental" })).plan
  const quoted = await admit({ store, deps, plan, dry_run: true, authorized: async () => true })
  const amount = quoted.quote?.coins
  let approved = await host.authorized(state)
  if (!approved && amount !== null && amount !== undefined && amount <= 0.1) approved = true
  if (!approved) {
    let receipt
    try { receipt = readSpendConfirmation(state, requestId) } catch (e) { return reject("confirmation_conflict", String(e), nodeId) }
    approved = !!receipt && receipt.outcome === "approved" && receipt.model === payload.model && receipt.input_signature === payloadSignature && receipt.amount_coins === amount
  }
  if (!approved) return reject("needs_user", "本操作缺少匹配实际参数、模型与报价的真实批准回执", nodeId)
  let accepted!: (notice: any) => void
  const notice = new Promise<any>(resolve => { accepted = resolve })
  const submit = deps.submitGeneration
  deps.submitGeneration = async req => submit({ ...req, onAccepted: async n => {
    await store.update(g => { const node = g.nodes[req.nodeId]; if (!node?.inflight) throw new Error("operation_not_durable"); node.inflight.taskId = n.taskId })
    if (req.nodeId === nodeId) accepted(n)
  } })
  const joining = RUNNING.has(store.paths.dir)
  const promise = runProject(store, deps, { targets: [nodeId], mode: "incremental", resume: !joining, ...(joining ? { joinPreparedNode: nodeId } : {}), authorized: async () => approved }).catch(e => ({ ok: false, status: "failed", reason: String(e), quote: EMPTY_QUOTE, cursor: graph.seq } as RunResult))
  if (!joining) {
    RUNNING.set(store.paths.dir, promise)
    void promise.finally(() => { if (RUNNING.get(store.paths.dir) === promise) RUNNING.delete(store.paths.dir) })
  }
  const result = await raceWithTimeout(Promise.race([notice.then(n => ({ accepted: n })), promise.then(done => ({ done }))]), 40_000)
  if (result && "accepted" in result) return Response.json({ ok: true, task_id: result.accepted.taskId, request_id: requestId, node_id: nodeId, status: "accepted", new_generation: true })
  graph = await store.read()
  const node = graph.nodes[nodeId]
  const taskId = node?.inflight?.taskId ?? node?.outputs.map(o => o.meta?.task_id).find(t => typeof t === "string")
  if (taskId) return Response.json({ ok: true, task_id: taskId, request_id: requestId, node_id: nodeId, status: "succeeded", new_generation: false })
  return reject(node?.inflight?.submitUnknown ? "submission_unknown" : "generation_blocked", result && "done" in result ? JSON.stringify(result.done) : "受理状态未知；保持原request_id接续", nodeId)
}

async function handleRunOp(store: ProjectStore, state: SessionState | undefined, body: Record<string, unknown>): Promise<Response> {
  const args = body as ProjectRunArgs
  const targets = Array.isArray(args.targets) ? args.targets.filter((t): t is NodeId => typeof t === "string") : undefined
  const mode = args.mode === "force" ? "force" : "incremental"
  const dryRun = args.dry_run === true
  const budgetCoins = typeof args.budget_coins === "number" && Number.isFinite(args.budget_coins) && args.budget_coins >= 0 ? args.budget_coins : undefined
  const waitMs = clampWaitSec(args.wait_sec) * 1000

  let graph = await store.read()
  if (!state) {
    return Response.json(fitRunReceipt({ ok: false, status: "rejected", quote: EMPTY_QUOTE, cursor: graph.seq, reason: "会话状态不可读，未开跑。" }))
  }
  const sessionState = state

  // 进程内并发双跑：已有在跑的一轮时直接回 running，不排队、不双扣费。
  const active = RUNNING.get(store.paths.dir)
  if (active) {
    const settled = waitMs > 0 ? await raceWithTimeout(active, waitMs) : null
    return Response.json(fitRunReceipt(settled ? resultToReceipt(settled) : { ok: true, status: "running", quote: EMPTY_QUOTE, cursor: graph.seq }))
  }
  if (graph.activeRun) {
    // 进程内没有对应的 run（RUNNING 已判空）：这是崩溃遗留的死标记，不是「正在跑」。
    // 照 run.ts 的 resume 语义先收尾，否则该工程此后每次 project_run 都会被它挡死。
    await store.finishRun(graph.activeRun)
    graph = await store.read()
  }

  const deps = host.deps(state, store)
  const budgetPort = deps.budget as ProjectBudgetPort | undefined
  budgetPort?.noteCarry?.({ spentCoins: accumulatedSpendCoins(graph), capCoins: graphCapCoins(graph) })
  const confirm = host.confirm(state)
  const authorized = () => host.authorized(state)
  const plan = (await buildPlan({ store, deps, targets, mode })).plan

  const verdict = await admit({
    store, deps, plan,
    ...(deps.budget ? { budget: deps.budget } : {}),
    ...(dryRun ? { dry_run: true } : {}),
    ...(budgetCoins !== undefined ? { budget_coins: budgetCoins } : {}),
    ...(confirm ? { confirm } : {}),
    authorized,
  })
  const quote = verdict.quote ?? EMPTY_QUOTE
  graph = await store.read()

  if (verdict.ok !== true) {
    const fail = verdict as Extract<typeof verdict, { ok: false }>
    const requestId = "requestId" in fail ? fail.requestId : undefined
    return Response.json(fitRunReceipt({
      ok: false,
      status: fail.status === "needs_user" ? "needs_user" : "rejected",
      quote: fail.quote,
      cursor: graph.seq,
      reason: requestId ? `${fail.reason} request_id=${requestId}` : fail.reason,
    }))
  }
  if ((verdict as Extract<typeof verdict, { ok: true }>).mode === "quote") {
    return Response.json(fitRunReceipt({ ok: true, status: "quoted", quote, cursor: graph.seq }))
  }

  // 准入通过：执行链放后台（HTTP 不挂住），回执立刻给 started；带 wait_sec 时等它返回。
  const promise = runProject(store, deps, {
    targets, mode,
    // 每次运行前先接续崩溃遗留的在途节点（同 idemKey，不盲重投）；健康图里这是空操作。
    resume: true,
    ...(budgetCoins !== undefined ? { budget_coins: budgetCoins } : {}),
    ...(confirm ? { confirm } : {}),
    authorized,
  }).catch((e: unknown): RunResult => ({
    ok: false, status: "failed", quote: EMPTY_QUOTE, cursor: graph.seq,
    reason: `run 异常：${(e as Error)?.message ?? String(e)}`,
  }))
  RUNNING.set(store.paths.dir, promise)
  void promise.finally(() => {
    if (RUNNING.get(store.paths.dir) === promise) RUNNING.delete(store.paths.dir)
    // S20：run 收尾后追平画布并出交付卡（幂等；内部已吞错，不污染回执）。
    void settleDelivery(store, sessionState)
  })

  if (waitMs > 0) {
    const settled = await raceWithTimeout(promise, waitMs)
    if (settled) return Response.json(fitRunReceipt(resultToReceipt(settled)))
  }
  return Response.json(fitRunReceipt({ ok: true, status: "started", quote, cursor: graph.seq }))
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    const finish = (v: T | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    p.then((v) => finish(v), () => finish(null))
  })
}

function resultToReceipt(r: RunResult): ProjectRunReceipt {
  const receipt: ProjectRunReceipt = { ok: r.ok, status: r.status, quote: r.quote ?? EMPTY_QUOTE, cursor: r.cursor }
  if (r.runId) receipt.runId = r.runId
  if (typeof r.done === "number") receipt.done = r.done
  if (r.failed?.length) receipt.failed = r.failed
  if (r.reason) receipt.reason = r.reason
  return receipt
}

function fitRunReceipt(receipt: ProjectRunReceipt): ProjectRunReceipt {
  const limit = LIMITS.RUN_RECEIPT_BYTES
  if (bytesOf(receipt) <= limit) return receipt
  let r = receipt
  const steps: ((x: ProjectRunReceipt) => ProjectRunReceipt)[] = [
    (x) => ({ ...x, quote: { ...x.quote, unknownPrice: x.quote.unknownPrice.slice(0, 8) }, failed: x.failed?.slice(0, 24) }),
    (x) => ({ ...x, failed: x.failed?.slice(0, 8), reason: x.reason ? clipChars(x.reason, 200) : x.reason }),
    (x) => ({ ...x, failed: x.failed?.slice(0, 3), reason: x.reason ? clipChars(x.reason, 120) : x.reason, quote: { ...x.quote, unknownPrice: [] } }),
    (x) => ({ ...x, failed: x.failed?.slice(0, 1), reason: undefined }),
  ]
  for (const step of steps) {
    if (bytesOf(r) <= limit) return r
    r = step(r)
  }
  return r
}

// ───────────────────────── 启动恢复（S6 留的缺口） ─────────────────────────
export interface ProjectStartupOutcome {
  sessionId: string
  outcome?: { resumed: { node: NodeId; action: string; result: string }[]; rerun: NodeId[]; manual: NodeId[] }
  skipped?: "no_session"
  error?: string
}

/**
 * 网关启动一次：注册默认执行器（S11z）→ 扫 projects/* 按 action 接续。
 * 不盲重投：resubmit 只在「当前签名生成的 key 与 inflight key 逐字相等」时执行（recovery.ts）。
 * 会话不可恢复（无 apiKey/凭证）时整档跳过，保持 inflight 原样交下一次 project_run(resume)。
 */
export async function initProjectSubsystem(depsFor?: (sessionId: string) => (RunDeps & RecoveryDeps) | null): Promise<ProjectStartupOutcome[]> {
  try {
    const mod = await import("./executors/index.ts")
    const installed = mod.installDefaultExecutors()
    defaultScoreTakeRef = installed.scoreTake
  } catch (e) {
    console.error("[gateway] project executors not installed:", (e as Error)?.message ?? e)
  }
  return recoverAllProjects(depsFor)
}

export async function recoverAllProjects(depsFor?: (sessionId: string) => (RunDeps & RecoveryDeps) | null): Promise<ProjectStartupOutcome[]> {
  const entries = await scanProjectRecoveries()
  const out: ProjectStartupOutcome[] = []
  for (const e of entries) {
    if (e.error) { out.push({ sessionId: e.sessionId, error: e.error }); continue }
    try {
      const pendingStore = await openStore(e.sessionId)
      await pendingStore.update((g) => {
        // 崩溃时请求可能已被接受，不能把 delivering 当作未投递。
        for (const task of g.continuation?.tasks ?? []) if (task.delivery === "delivering") task.delivery = "unknown"
      })
      await drainProjectContinuations(e.sessionId)
      const state = host.state(e.sessionId)
      const deps = depsFor ? depsFor(e.sessionId) : state ? host.deps(state, await openStore(e.sessionId)) : null
      if (!deps) {
        out.push({ sessionId: e.sessionId, skipped: "no_session" })
        continue
      }
      const store = await openStore(e.sessionId)
      const saved = await store.read()
      for (const node of Object.values(saved.nodes)) await acknowledgeBridgeOutputs(store, deps, saved.activeRun ?? saved.continuation?.runId ?? node.lastRun?.runId ?? "recovery", node.id)
      if (!e.resumable.length && !e.lost.length) continue
      const outcome = await recoverProject(store, deps)
      out.push({
        sessionId: e.sessionId,
        outcome: {
          resumed: outcome.resumed.map((r) => ({ node: r.node, action: r.action, result: r.result })),
          rerun: outcome.rerun,
          manual: outcome.manual,
        },
      })
      if (outcome.resumed.length || outcome.rerun.length) {
        console.log(`[gateway] project recovery ${e.sessionId}: resumed=${outcome.resumed.length} rerun=${outcome.rerun.length} manual=${outcome.manual.length}`)
      }
    } catch (err) {
      out.push({ sessionId: e.sessionId, error: (err as Error).message })
    }
  }
  return out
}
