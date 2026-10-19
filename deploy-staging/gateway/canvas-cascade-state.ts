// 从 index.ts 无损抽取（2026-09-19 第一阶段）：Canvas 状态持久化区段（原 index.ts 7397–7689 行，
// 「Wave C」banner 起、handleCanvasSnapshotRead 止）。
// 依赖说明：
//  - jsonError：import 自 ./gw-lib.ts
//  - SessionState：TODO types-gateway.ts 未建（B 路任务），整合时补
//    `import type { SessionState } from "./types-gateway.ts"`（bun build 只转译不查型别，建得过）
//  - resolveSession / emitToSession：仍定义在 index.ts（≈1412/1957 行），以 setCanvasDeps 注入
//    （本档唯一语义改写：原直接呼叫改为呼叫注入变量；未注入时 resolveSession 回 undefined、
//    canvasKeyFor 回退原 id——与「session 不可解析」语义一致）。
//  - 区内无 markDirty 实际呼叫（仅 7432–7433 注释提及；呼叫点 3745/5464 等在区外），故未做 markDirty 注入。
import { jsonError } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { resolveSession, markDirty } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import { emitToSession } from "./sse-core.ts"

// ─────────────────────────── Wave C：Agent 操作画布（canvas.ops 下发/回执）
//
// 两条通道，核心共用：
//  1) 快照上行：前端（经站点代理）POST /agent/v1/sessions/:id/canvas/state 存压缩
//     快照；loopback 等价端点 POST /internal/canvas/state（body 带 session_id）。
//     opencode 的 canvas_get_state 工具经 GET /internal/canvas/snapshot 读取。
//     注意：既有 GET /internal/canvas/state（读随讯息上送的 canvasSummary）语义不动。
//  2) ops 下发：工具 POST /internal/canvas/dispatch-ops → 经该 session 的 SSE 发
//     canvas.ops 事件 { request_id, ops, label? }，挂起等前端回执；前端执行后
//     POST /agent/v1/sessions/:id/canvas/ops-result（loopback 等价 /internal/canvas/ops-result）
//     resolve 对应 pending。逾时（预设 30s）回 OPS_TIMEOUT。

const CANVAS_STATE_MAX_BYTES = 512 * 1024
const CANVAS_STATE_TTL_MS = 24 * 60 * 60 * 1000 // 2026-08-29：30min → 24h（保存线对齐「至少 24h」；重启另有 DB 镜像回灌）
export const CANVAS_OPS_TIMEOUT_MS = Number.parseInt(process.env.CANVAS_OPS_TIMEOUT_MS || "30000", 10) || 30_000
// op 型别白名单抽到零依赖模组（2026-10-03）：本档 import 链会拉起 sessions-core，
// 白名单自身要能独立跑真行为断言。此处 re-export 保持既有呼叫端不变。
export { CANVAS_OP_TYPES, validateCanvasOps } from "./canvas-op-types.ts"

export interface CanvasSnapshotEntry {
  state: unknown
  updatedAt: number
}

// 画布快照存放。key 统一收敛到 gateway sessionId（session 可解析时），
// 让 opencode session id / gateway session id 两种呼叫方命中同一份。
// 前置声明：markDirty（早于本行定义）引用 canvasStates，const 提升安全
// （markDirty 只在请求处理时执行，远晚于模组顶层求值）。
export const canvasStates = new Map<string, CanvasSnapshotEntry>()

function canvasKeyFor(sessionId: string): string {
  // 0920：子代理（Expert）的画布工具带自己的 opencode session id——旧版 fallback
  // 直接回原文 id，Expert 的节点会写进一个用户看不见的「子会话画布桶」（静默分裂，
  // 比 404 更阴）。兜底回父会话＝模板节点（角色卡/美术卡）落在用户画布上。
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return state ? state.sessionId : sessionId
}

// 惰性 TTL 清理：每次读写顺手扫（条目数 = 活跃画布数，量级小）。
function sweepCanvasStates(): void {
  const now = Date.now()
  for (const [k, v] of canvasStates) {
    if (now - v.updatedAt > CANVAS_STATE_TTL_MS) canvasStates.delete(k)
  }
}

// 服务端单调版本号：每个画布 key 一份，第一次接受写入为 1，之后只增不减。
// 与快照分开存放：applyCanvasNode* 等既有写穿路径整份替换快照时不携带版本，
// 不能因此把版本打回原点。
const canvasStateRevs = new Map<string, number>()

// 形状校验：拒绝脏快照（数组/null/基本类型、非数组 steps、非对象/数组的
// nodes/connections、__proto__ 键）。只校验确实出现的栏位——前端真实上行形状
// 只有 nodes/connections，不得强制要求 steps。
function canvasStateShapeError(state: unknown): string | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return "state 必须是普通对象（数组/null/基本类型不接受）"
  }
  const obj = state as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, "__proto__")) {
    return "state 不得包含 __proto__ 键"
  }
  if (obj.steps !== undefined && !Array.isArray(obj.steps)) {
    return "state.steps 必须是数组"
  }
  for (const field of ["nodes", "connections"] as const) {
    const value = obj[field]
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      return `state.${field} 必须是对象或数组`
    }
  }
  return null
}

// 上行版本：优先 rev，其次 version；两者都不是有限数字时回 null（按旧行为接受）。
function incomingCanvasRev(state: unknown): number | null {
  const obj = state as Record<string, unknown>
  for (const field of ["rev", "version"] as const) {
    const value = obj[field]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

export function storeCanvasState(
  sessionId: string,
  stateValue: unknown,
): { ok: true; bytes: number; updatedAt: number; rev: number } | { ok: false; status: number; message: string } {
  const shapeError = canvasStateShapeError(stateValue)
  if (shapeError) {
    return { ok: false, status: 400, message: shapeError }
  }
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(stateValue), "utf-8")
  } catch {
    return { ok: false, status: 400, message: "state is not serializable" }
  }
  if (bytes > CANVAS_STATE_MAX_BYTES) {
    return { ok: false, status: 413, message: `state exceeds ${CANVAS_STATE_MAX_BYTES} bytes` }
  }
  const key = canvasKeyFor(sessionId)
  const currentRev = canvasStateRevs.get(key) ?? 0
  const incomingRev = incomingCanvasRev(stateValue)
  // 乐观并发：带版本且落后于服务端当前版本 = 旧标签页的迟到保存，整份拒绝，
  // 已存快照（含 agent 刚写入的节点/连线）一律不动。
  if (incomingRev !== null && incomingRev < currentRev) {
    return { ok: false, status: 409, message: `stale snapshot (rev=${incomingRev} < current=${currentRev})` }
  }
  const nextRev = Math.max(currentRev + 1, incomingRev !== null ? incomingRev + 1 : 0)
  sweepCanvasStates()
  const updatedAt = Date.now()
  canvasStates.set(key, { state: stateValue, updatedAt })
  canvasStateRevs.set(key, nextRev)
  return { ok: true, bytes, updatedAt, rev: nextRev }
}

// 工具/内部读取最新快照；无快照回 null。
export function getCanvasState(sessionId: string): CanvasSnapshotEntry | null {
  sweepCanvasStates()
  return canvasStates.get(canvasKeyFor(sessionId)) ?? null
}

// ---- 画布事件持久化（2026-08-27 修复；2026-09-20 写穿收口）----
// 断链根因：autoCreateCanvasUnit / emitCanvasResult 只对 SSE 发 canvas.node.* 事件，
// 从不写 canvasStates，导致 GET /internal/canvas/snapshot 永远 has_state:false，
// 前端刷新后画布全丢。修复：事件发生的同一瞬间，把它套用到该 session 的快照
// state（节点 upsert / 连线 upsert），并随 session 防抖落盘（canvasSnapshot
// 栏位），gateway 重启后懒加载时回灌 canvasStates。
// 前端若已上行过自己的完整 state（storeCanvasState），之后的事件叠加其上——
// 同一 data 语义，不冲突。
// 2026-09-20 写穿：上述「懒加载回灌」与「SSE 事件流」双轨收口为「SSE 事件即写穿」
// ——workflow 出口（workflow-gw.ts 的 workflowService emit hook 与两处直发
// emitToSession）在每个 canvas.node.created/updated/connected/disconnected/generating
// 发出的同一瞬间呼叫本档的 applyCanvasNode*（created/connected upsert、updated/generating
// metadata 浅合并、disconnected 移除连线），幂等（按 id upsert、last-write-wins）。
// 写穿只合并进既有快照：updated/generating 在快照不存在或节点不在时静默跳过
// （不强造空壳，留给懒加载回灌兜底）；created/connected 沿用 mutableCanvasStateOf
// 既有语义建快照。prompt-time skeleton 推送路径（同样落到 applyCanvasNodeCreated）
// 不动。

export interface PersistableCanvasState {
  nodes?: Record<string, unknown> | Record<string, unknown>[]
  connections?: Record<string, unknown> | Record<string, unknown>[]
  [k: string]: unknown
}

// 读（无则建）该 session 的可变快照形状；尽量沿用前端上行 state 的既有栏位
// （如 nodes/connections 阵列），缺什么补什么，不覆盖前端已有资料。
function mutableCanvasStateOf(sessionId: string): PersistableCanvasState {
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (snap && snap.state && typeof snap.state === "object") {
    return snap.state as PersistableCanvasState
  }
  const fresh: PersistableCanvasState = { nodes: {}, connections: {} }
  canvasStates.set(key, { state: fresh, updatedAt: Date.now() })
  return fresh
}

function nodesArray(cs: PersistableCanvasState): Record<string, unknown>[] {
  if (!Array.isArray(cs.nodes)) cs.nodes = []
  return cs.nodes as Record<string, unknown>[]
}

function connectionsArray(cs: PersistableCanvasState): Record<string, unknown>[] {
  if (!Array.isArray(cs.connections)) cs.connections = []
  return cs.connections as Record<string, unknown>[]
}

function touchCanvasSnapshot(sessionId: string, cs: PersistableCanvasState): void {
  canvasStates.set(canvasKeyFor(sessionId), { state: cs, updatedAt: Date.now() })
}

// canvas.node.created → 节点 upsert（以 node.id 为键，重放安全）。
export function applyCanvasNodeCreated(sessionId: string, payload: unknown): void {
  const node = (payload as { node?: unknown })?.node
  if (!node || typeof node !== "object") return
  const id = (node as { id?: unknown }).id
  if (typeof id !== "string" || !id) return
  const cs = mutableCanvasStateOf(sessionId)
  const arr = nodesArray(cs)
  const idx = arr.findIndex((n) => n && n.id === id)
  if (idx >= 0) arr[idx] = node as Record<string, unknown>
  else arr.push(node as Record<string, unknown>)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.connected → 连线 upsert（以 connection.id 为键，重放安全）。
export function applyCanvasNodeConnected(sessionId: string, payload: unknown): void {
  const conn = (payload as { connection?: unknown })?.connection
  if (!conn || typeof conn !== "object") return
  const id = (conn as { id?: unknown }).id
  if (typeof id !== "string" || !id) return
  const cs = mutableCanvasStateOf(sessionId)
  const arr = connectionsArray(cs)
  const idx = arr.findIndex((c) => c && c.id === id)
  if (idx >= 0) arr[idx] = conn as Record<string, unknown>
  else arr.push(conn as Record<string, unknown>)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.updated → 对目标节点做 metadata 浅合并（patch 套用到 metadata）。
// 浅合并即可：现有 patch 栏位（status/content/cost_coins/progress）皆为纯量或
// 独立小物件，覆写语义正确。
export function applyCanvasNodeUpdated(sessionId: string, payload: unknown): void {
  const p = (payload ?? {}) as { node_id?: unknown; patch?: unknown }
  if (typeof p.node_id !== "string" || !p.node_id) return
  if (!p.patch || typeof p.patch !== "object") return
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (!snap || !snap.state || typeof snap.state !== "object") return
  const cs = snap.state as PersistableCanvasState
  const arr = Array.isArray(cs.nodes) ? (cs.nodes as Record<string, unknown>[]) : []
  const node = arr.find((n) => n && n.id === p.node_id)
  if (!node) return
  const md = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : (node.metadata = {})
  Object.assign(md, p.patch)
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.deleted → 从快照移除节点（若有）。
export function applyCanvasNodeDeleted(sessionId: string, payload: unknown): void {
  const p = (payload ?? {}) as { node_id?: unknown; node_ids?: unknown }
  const ids = new Set<string>()
  if (typeof p.node_id === "string") ids.add(p.node_id)
  if (Array.isArray(p.node_ids)) for (const x of p.node_ids) if (typeof x === "string") ids.add(x)
  if (ids.size === 0) return
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (!snap || !snap.state || typeof snap.state !== "object") return
  const cs = snap.state as PersistableCanvasState
  if (Array.isArray(cs.nodes)) {
    cs.nodes = (cs.nodes as Record<string, unknown>[]).filter((n) => !(n && typeof n.id === "string" && ids.has(n.id)))
  }
  if (Array.isArray(cs.connections)) {
    cs.connections = (cs.connections as Record<string, unknown>[]).filter(
      (c) => !(c && ((typeof c.fromNodeId === "string" && ids.has(c.fromNodeId)) || (typeof c.toNodeId === "string" && ids.has(c.toNodeId)))),
    )
  }
  touchCanvasSnapshot(sessionId, cs)
}

// canvas.node.disconnected → 从快照移除对应连线（wire 载荷只有 from/to，无 id；
// 对照 canvas.node.connected 的 connection 形状 fromNodeId/toNodeId 过滤）。幂等：
// 连线不在快照时 no-op。快照不存在时同样 no-op（不强造空壳）。
export function applyCanvasNodeDisconnected(sessionId: string, payload: unknown): void {
  const p = (payload ?? {}) as { from?: unknown; to?: unknown }
  if (typeof p.from !== "string" || !p.from) return
  if (typeof p.to !== "string" || !p.to) return
  const key = canvasKeyFor(sessionId)
  const snap = canvasStates.get(key)
  if (!snap || !snap.state || typeof snap.state !== "object") return
  const cs = snap.state as PersistableCanvasState
  if (Array.isArray(cs.connections)) {
    cs.connections = (cs.connections as Record<string, unknown>[]).filter(
      (c) => !(c && c.fromNodeId === p.from && c.toNodeId === p.to),
    )
  }
  touchCanvasSnapshot(sessionId, cs)
}

export interface CanvasOpsResult {
  ok: boolean
  error?: string
  created_node_ids?: string[]
  /** F1：前端未回执／无 SSE 客户端时，结构 ops 已写穿 canvasStates，可稍后 hydrate。 */
  queued?: boolean
  /** 2026-10-11：queued 的原因——no_client＝无 SSE 客户端（稍后 hydrate）；ack_timeout＝有客户端但逾时未回执（前端很可能没渲染）。 */
  queued_reason?: "no_client" | "ack_timeout"
}

interface PendingCanvasOps {
  sessionKey: string
  settle: (result: CanvasOpsResult) => void
}

const pendingCanvasOps = new Map<string, PendingCanvasOps>()

// ---- 用户批准凭据＋偏离模板 token（2026-10-02）----
// 模型自宣告 deviate_from_template=true 等于没守；改成网关签发 token：只有「本 session 内
// 用户真的回应过 question」（走既有 question/confirm 机制）才发；模型必须把 token 原样带回，
// 自带 deviate_from_template=true 不再放行。
// 2026-10-02：token 本体移住 session 状态（persistence 白名单栏位 tplDeviateToken）＝
// 跨 agent-gateway 重启存活（过往行程内 Map，重启即失＝用户批准过的偏离出口被关上）。
// userAnsweredQuestions 仍在行程内：它只决定「签不签」，token 本体在 session 状态，单一真源。
const userAnsweredQuestions = new Map<string, number>()
const USER_ANSWERED_MAX = 2000
const TPL_DEVIATE_TTL_MS = 15 * 60 * 1000
// session 解析惯例同 canvasKeyFor：网关 id 优先，子代理（Expert）带自己的 opencode id 时
// 兜底回父会话（token 必须落在用户会话上，落在子会话桶里等于没签）。
function sessionForToken(sessionId: string): SessionState | undefined {
  return resolveSession(sessionId) ?? subagentParentState(sessionId)
}
export function markUserAnsweredQuestion(sessionId: string): void {
  if (!sessionId) return
  // 先删再插：Map 迭代序即插入序，淘汰时删最旧（队首）。
  userAnsweredQuestions.delete(sessionId)
  userAnsweredQuestions.set(sessionId, Date.now())
  while (userAnsweredQuestions.size > USER_ANSWERED_MAX) {
    const oldest = userAnsweredQuestions.keys().next().value
    if (oldest === undefined) break
    userAnsweredQuestions.delete(oldest)
  }
  // 用户真实批准 → 网关签发偏离 token（模型下一回合才能拿到），写进 session 状态（落盘）。
  const token = `tpl-dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const st = sessionForToken(sessionId)
  if (st) {
    st.tplDeviateToken = { token, at: Date.now() }
    markDirty(st)
    console.log(`[gateway] template_guard: user answered question → deviate token issued session=${sessionId}`)
  } else {
    // 解析不到 session：只留 answered 标记，无行程内 token 后备（避免双真源）。
    console.warn(`[gateway] template_guard: cannot resolve session for deviate token session=${sessionId}`)
  }
}
export function hasUserAnsweredQuestion(sessionId: string): boolean {
  return userAnsweredQuestions.has(sessionId)
}
// 取本 session 当前有效的偏离 token（无/过期回 null）——注入模型上下文用。
export function getTemplateDeviateToken(sessionId: string): string | null {
  const st = sessionForToken(sessionId)
  const rec = st?.tplDeviateToken
  if (!st || !rec) return null
  if (Date.now() - rec.at > TPL_DEVIATE_TTL_MS) {
    st.tplDeviateToken = null
    markDirty(st)
    return null
  }
  return rec.token
}
// 单次核销：token 相符即消耗（一批 ops 一次授权），否则 false。
export function consumeTemplateDeviateToken(sessionId: string, token: string): boolean {
  const cur = getTemplateDeviateToken(sessionId)
  if (cur && token && cur === token) {
    const st = sessionForToken(sessionId)
    if (st) {
      st.tplDeviateToken = null
      markDirty(st)
    }
    return true
  }
  return false
}

// ---- 模板节点守卫（2026-10-02 v2：守「接线契约」，不禁止建节点）----
// v1 病灶：用「type 黑名单 + 任一空位未填＝全锁」拦 add_node，把模板灵活性一起杀掉——
// 模板步骤头卡本身就是 config 型 ⇒ 加一步＝加 config＝一律 409；character_card/scene_card 同病；
// 反而 text 型不在名单 ⇒ 未接线的漂浮节点照样放行（守错方向）。
// v2 只守两个结果面不变量（守卫要教不要禁，见 feedback-guard-teaches-not-bans）：
//   I1 模板产出必须落在模板槽位（防平行重复生成＝防重复扣费）：新增生成类节点若与某未填空位
//      同 (type, role)，或未宣告 role 而对同型别空位直接 run_generation ⇒ 拦。
//   I2 新增节点必须是图上的一环：同批 connect_nodes 至少有一条 inbound 来自既有节点（整批锚定），
//      且不得有漂浮新节点（每颗新节点至少一条 inbound，来自既有或同批新节点）。
// 409 文案一律附精确接线修法（哪个 id 连哪个 id）＋模板拓扑，不是「不要建」。
const TPL_GEN_NODE_TYPES = new Set(["image", "video", "audio", "director", "character_card", "scene_card", "config"])

export interface TemplateOpenSlot {
  id: string
  title: string
  type: string
  /** 槽位语义角色（role/slot_hint/stepName/deliverable），供 (type, role) 重复判定。 */
  role: string
  stepIndex: number | null
  stepName: string
  /** 模板拓扑中这颗生成卡的前驱节点 id（无则 null）。 */
  prevId: string | null
}

function isTplGenNode(n: Record<string, unknown>): boolean {
  const id = typeof n.id === "string" ? n.id : ""
  return /^tpl-/.test(id) && /-gen$/.test(id)
}

function readCanvas(sessionId: string): { nodes: Record<string, unknown>[]; connections: Record<string, unknown>[] } {
  const state = getCanvasState(sessionId)?.state as { nodes?: unknown; connections?: unknown } | null | undefined
  const nodes = Array.isArray(state?.nodes) ? (state!.nodes as Record<string, unknown>[]) : []
  const connections = Array.isArray(state?.connections) ? (state!.connections as Record<string, unknown>[]) : []
  return { nodes, connections }
}

function normalizeRole(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, "")
}

function slotRoleFromMeta(meta: Record<string, unknown>, fallback = ""): string {
  for (const key of ["role", "slot_hint", "slotRole", "stepName", "deliverable"]) {
    const v = meta[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return fallback.trim()
}

// 所有模板生成卡（含已填/在途），带拓扑（stepIndex/stepName/前驱 id）。
export function listTemplateGenNodes(sessionId: string): TemplateOpenSlot[] {
  const { nodes, connections } = readCanvas(sessionId)
  const out: TemplateOpenSlot[] = []
  for (const n of nodes) {
    if (!isTplGenNode(n)) continue
    const meta = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>
    const id = String(n.id)
    const prev = connections.find((c) => c?.toNodeId === id && typeof c?.fromNodeId === "string")
    const title = typeof n.title === "string" ? n.title : ""
    out.push({
      id,
      title,
      type: typeof n.type === "string" ? n.type : "",
      role: slotRoleFromMeta(meta, title),
      stepIndex: typeof meta.stepIndex === "number" ? meta.stepIndex : null,
      stepName: typeof meta.stepName === "string" ? meta.stepName : "",
      prevId: prev ? String(prev.fromNodeId) : null,
    })
  }
  return out
}

// 模板生成卡中尚未回填结果（metadata.content 为空）的空位。
export function listTemplateOpenSlots(sessionId: string, excludeLoading = false): TemplateOpenSlot[] {
  const { nodes } = readCanvas(sessionId)
  const out: TemplateOpenSlot[] = []
  for (const slot of listTemplateGenNodes(sessionId)) {
    const raw = nodes.find((n) => String(n.id) === slot.id)
    const meta = (raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>
    const content = typeof meta.content === "string" ? meta.content.trim() : ""
    if (content) continue
    if (excludeLoading && meta.status === "loading") continue
    out.push(slot)
  }
  return out
}

function templateNodeStatus(sessionId: string, slot: TemplateOpenSlot): "open" | "loading" | "filled" {
  const { nodes } = readCanvas(sessionId)
  const raw = nodes.find((n) => String(n.id) === slot.id)
  const meta = (raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>
  if (typeof meta.content === "string" && meta.content.trim()) return "filled"
  if (meta.status === "loading") return "loading"
  return "open"
}

// 模板拓扑（每步 stepIndex/stepName/前驱 id/下游 id/生成卡 id/落位状态）——注入模型＋附在 409 文案。
export function renderTemplateTopology(sessionId: string): string | null {
  const slots = listTemplateGenNodes(sessionId)
  if (slots.length === 0) return null
  const { connections } = readCanvas(sessionId)
  return slots
    .slice(0, 16)
    .map((s) => {
      const step = s.stepIndex !== null ? `第${s.stepIndex + 1}步 ` : ""
      const name = s.stepName || s.title || s.id
      const next = connections.find((c) => c?.fromNodeId === s.id && typeof c?.toNodeId === "string")
      return `- ${step}${name} | 前驱=${s.prevId ?? "(无)"} | 下游=${next ? String(next.toNodeId) : "(无)"} | 生成卡=${s.id}(${s.type}) | ${templateNodeStatus(sessionId, s)}`
    })
    .join("\n")
}

// 生成工具（image_generate 等）出图时网关会自动铺一组 cu_* 节点（autoCreateCanvasUnit），
// 与用户的模板节点完全无关 → 模板被架空。模板有同类型空位时，改为把这次生成「绑定」到空位：
// 不新建 unit，结果事件改写在模板节点上（unit_id → 模板节点 id 的映射）。
const tplBoundUnits = new Map<string, string>() // `${sessionId}|${unitId}` → 模板节点 id
// 落位回灌：最近一次生成被网关改写落在哪个 tpl 节点（下一回合注入模型上下文，见 templateLandingFact）。
const tplLastLandings = new Map<string, { slotId: string; at: number }>()
export function claimTemplateSlot(sessionId: string, unitId: string, kind: "image" | "video"): TemplateOpenSlot | null {
  // 选位：同 kind、未 loading、未被其他 unit 占用 的空位中，取 metadata.stepIndex 最小者
  // （缺省视为很大）；同 stepIndex 依快照顺序。多步模板不再错位到第一步。
  const { nodes } = readCanvas(sessionId)
  const claimed = new Set<string>()
  const prefix = `${sessionId}|`
  for (const [k, v] of tplBoundUnits) if (k.startsWith(prefix)) claimed.add(v)
  let best: TemplateOpenSlot | null = null
  let bestStep = Number.POSITIVE_INFINITY
  for (const slot of listTemplateGenNodes(sessionId)) {
    if (slot.type !== kind) continue
    if (claimed.has(slot.id)) continue
    const raw = nodes.find((n) => String(n.id) === slot.id)
    const meta = (raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>
    if (typeof meta.content === "string" && meta.content.trim()) continue
    if (meta.status === "loading") continue
    const si = slot.stepIndex !== null && Number.isFinite(slot.stepIndex) ? slot.stepIndex : Number.POSITIVE_INFINITY
    if (best === null || si < bestStep) {
      best = slot
      bestStep = si
    }
  }
  if (best === null) return null
  tplBoundUnits.set(`${sessionId}|${unitId}`, best.id)
  if (tplBoundUnits.size > 2000) tplBoundUnits.delete(tplBoundUnits.keys().next().value as string)
  tplLastLandings.set(sessionId, { slotId: best.id, at: Date.now() })
  if (tplLastLandings.size > 2000) tplLastLandings.delete(tplLastLandings.keys().next().value as string)
  return best
}
// 结果节点 id：绑定了模板空位 → 模板节点；否则沿用自动 unit 的 `${unitId}-image`。
export function canvasResultNodeId(sessionId: string, unitId: string): string {
  return tplBoundUnits.get(`${sessionId}|${unitId}`) ?? `${unitId}-image`
}
// 落位回灌事实：模型不知道网关把落点改写到哪颗 tpl 节点（v1 病灶④）。下一回合明说。
export function templateLandingFact(sessionId: string): string | null {
  const last = tplLastLandings.get(sessionId)
  if (!last) return null
  if (Date.now() - last.at > 30 * 60 * 1000) return null
  return `你上一笔生成已被网关落位到模板节点「${last.slotId}」（结果会回填在该节点，不要为同一交付物再重复生成／不要另建平行节点）。`
}

// 画布快照里是否已有用户配上的模板节点（任一 tpl-* 节点即算）。
export function hasTemplateNodes(sessionId: string): boolean {
  const nodes = (getCanvasState(sessionId)?.state as { nodes?: unknown } | null | undefined)?.nodes
  return Array.isArray(nodes) && nodes.some((n) => typeof (n as { id?: unknown })?.id === "string" && /^tpl-/.test((n as { id: string }).id))
}

// 每回合注入模型上下文的事实：模板拓扑＋空位＋插入配方＋（若已批准）偏离 token。
export function buildTemplateSlotsFact(sessionId: string, deviateToken?: string): string | null {
  const topology = renderTemplateTopology(sessionId)
  if (!topology) return null
  const open = listTemplateOpenSlots(sessionId)
  const loadingIds = listTemplateGenNodes(sessionId)
    .filter((s) => templateNodeStatus(sessionId, s) === "loading")
    .map((s) => s.id)
  const lines: string[] = [
    "画布上已配好用户选定的模板（生成卡＝交付落地位）。拓扑：",
    topology,
  ]
  if (loadingIds.length > 0) lines.push(`已在跑（勿重复提交）：${loadingIds.join("、")}`)
  lines.push(
    open.length > 0
      ? `未填空位 ${open.length} 个。生成既有交付物 → 落在 open 生成卡：canvas_apply_ops update_node {id:"<gen-id>", patch:{metadata:{prompt,model,size}}} 后 run_generation {node_id:"<gen-id>"}。`
      : "模板生成卡已全部落位。",
    "要新增步骤/角色/节点 → 必须同批带 connect_nodes 接进图（至少一条 inbound 来自既有节点），例：{\"type\":\"connect_nodes\",\"connections\":[{\"fromNodeId\":\"<既有 id>\",\"toNodeId\":\"<新 id>\"}]}；跨栏扇入是合法的。新节点若与某空位同 (type, role) ＝平行重复生成，会被拦；额外一步/额外角色请宣告不同 role（metadata.role 或 slot_hint）。",
  )
  if (deviateToken) lines.push(`已获用户批准偏离模板：重试时带 deviate_token=${deviateToken}（自带 deviate_from_template=true 无效）。`)
  else lines.push("确需偏离模板 → 先用 question 向用户说明并取得真实同意；网关批准后才签发 token，自带 deviate_from_template=true 无效。")
  let out = lines.join("\n")
  if (out.length > 1400) out = out.slice(0, 1399) + "…"
  return out
}

export interface TemplateDeviation {
  declared: boolean
  reason: string
  /** 模型带回的偏离 token。 */
  token?: string
}

// 返回拦截讯息（人话）；null = 放行。
export function checkTemplateGuard(sessionId: string, ops: unknown[], deviation: TemplateDeviation): string | null {
  if (!hasTemplateNodes(sessionId)) return null
  const adds = ops.filter((o) => (o as { type?: unknown })?.type === "add_node") as Array<{
    type: "add_node"
    node: Record<string, unknown>
  }>
  if (adds.length === 0) return null

  // 偏离：只认网关签发 token（模型自宣告无效）。
  if (consumeTemplateDeviateToken(sessionId, deviation.token ?? "")) {
    console.log(`[gateway] template_guard: deviation token accepted session=${sessionId} ops=${ops.length}`)
    return null
  }
  if (deviation.declared) {
    console.log(`[gateway] template_guard: declared deviation REJECTED (no gateway token) session=${sessionId}`)
  }

  const { nodes: existingNodes } = readCanvas(sessionId)
  const existingIds = new Set(existingNodes.map((n) => String(n.id)))
  const newIds = new Set(adds.map((a) => String(a.node?.id ?? "")))
  const batchEdges: Array<{ from: string; to: string }> = []
  for (const op of ops) {
    const o = op as { type?: unknown; connections?: unknown }
    if (o?.type !== "connect_nodes") continue
    for (const c of Array.isArray(o.connections) ? o.connections : []) {
      const cc = c as { fromNodeId?: unknown; toNodeId?: unknown }
      if (typeof cc.fromNodeId === "string" && typeof cc.toNodeId === "string") batchEdges.push({ from: cc.fromNodeId, to: cc.toNodeId })
    }
  }

  const openSlots = listTemplateOpenSlots(sessionId)
  // 模板已全部落位（无空位）＝无保护标的 → 维持旧行为放行（不做图完整性守卫）。
  if (openSlots.length === 0) return null

  // I2a 漂浮节点：新节点没有任何 inbound（来自既有或同批新节点）。
  const floating = adds.filter((a) => {
    const id = String(a.node?.id ?? "")
    return !batchEdges.some((e) => e.to === id && e.from !== id && (existingIds.has(e.from) || newIds.has(e.from)))
  })
  // I2b 整批锚定：至少一条边「既有 → 新」。
  const anchored = batchEdges.some((e) => existingIds.has(e.from) && newIds.has(e.to))

  // I1 平行重复生成：同 type 且（未宣告 role＝无法证明是额外物，或宣告的 role 与空位相同）。
  const dupes = adds.filter((a) => {
    const node = a.node ?? {}
    const type = typeof node.type === "string" ? node.type : ""
    const meta = (node.metadata && typeof node.metadata === "object" ? node.metadata : {}) as Record<string, unknown>
    const role = slotRoleFromMeta(meta)
    return openSlots.some(
      (s) => s.type === type && (!role || (!!s.role && normalizeRole(s.role) === normalizeRole(role))),
    )
  })

  const problems: string[] = []
  if (dupes.length) problems.push(`平行重复生成 x${dupes.length}`)
  if (floating.length) problems.push(`漂浮节点 x${floating.length}`)
  if (!anchored) problems.push("未接入既有图")
  if (problems.length === 0) return null

  const anchor =
    openSlots[0]?.prevId ?? openSlots[0]?.id ?? listTemplateGenNodes(sessionId)[0]?.id ?? [...existingIds][0] ?? ""

  const msg: string[] = [`模板守卫：这批 ops 的接线不合法（新节点必须是模板图的一环），已拦下（未落位、未扣费）。问题：${problems.join("、")}。`]
  if (dupes.length) {
    const d = dupes[0]
    const type = typeof d.node?.type === "string" ? d.node.type : ""
    const meta = (d.node?.metadata && typeof d.node.metadata === "object" ? d.node.metadata : {}) as Record<string, unknown>
    const role = slotRoleFromMeta(meta)
    const slot = openSlots.find((s) => s.type === type && (!role || (!!s.role && normalizeRole(s.role) === normalizeRole(role))))
    msg.push(
      slot
        ? `• 新增节点「${String(d.node?.id)}」与未填空位「${slot.id}」同型别(${type})同角色(${role || slot.role})＝平行重复生成。修法二选一：` +
            `(a) 直接填既有空位：{"type":"update_node","id":"${slot.id}","patch":{"metadata":{"prompt":"…","model":"…","size":"…"}}} 再 {"type":"run_generation","node_id":"${slot.id}"}；` +
            `(b) 若确实是「额外一步/额外角色」，在 add_node 的 node.metadata.role 写明不同角色（例 "额外角色：反派"），并用 connect_nodes 把新节点接进图。`
        : `• 新增节点「${String(d.node?.id)}」与模板未填空位同型别且直接 run_generation＝平行重复生成。请改填既有空位，或宣告不同 role（metadata.role）后再 connect_nodes 接线。`,
    )
  }
  if (floating.length) {
    const f = String(floating[0].node?.id)
    msg.push(`• 漂浮节点 ${floating.map((a) => String(a.node?.id)).join("、")} 没有任何 inbound（未接线）。修法：同批补 connect_nodes，例：{"type":"connect_nodes","connections":[{"fromNodeId":"${anchor}","toNodeId":"${f}"}]}。`)
  }
  if (!anchored) {
    const first = String(adds[0].node?.id)
    msg.push(`• 这批新节点没有任何一条 inbound 来自既有节点（整批未锚定＝未接线到模板图）。修法：从最接近的前驱接出，例：{"type":"connect_nodes","connections":[{"fromNodeId":"${anchor}","toNodeId":"${first}"}]}。跨栏扇入（多上游汇入同一节点）是合法的。`)
  }
  const topology = renderTemplateTopology(sessionId)
  if (topology) msg.push(`模板拓扑（前驱/生成卡/落位状态）：\n${topology}`)
  msg.push("确需偏离模板 → 先用 question 向用户说明并取得真实同意；网关批准后签发 deviate_token，重试时带上（自带 deviate_from_template=true 无效）。")
  console.log(`[gateway] template_guard: BLOCKED session=${sessionId} adds=${adds.length} problems=${problems.join("|")}`)
  return msg.join("\n")
}

/**
 * F1 闭画布可落工作流：把结构 ops（add/update/delete/connect）写穿进 canvasStates。
 * 前端未开／未回执时节点仍进可 hydrate 持久快照（markDirty → canvasSnapshot）；
 * 用户稍后打开画布走 fetchAgentCanvasSnapshot 回填。跳过 select/viewport/run_generation。
 */
export function applyCanvasOpsToSnapshot(sessionId: string, ops: unknown[]): { created_node_ids: string[] } {
  const created_node_ids: string[] = []
  for (const raw of ops) {
    if (!raw || typeof raw !== "object") continue
    const op = raw as Record<string, unknown>
    const type = op.type
    if (type === "add_node") {
      const node = op.node
      if (!node || typeof node !== "object") continue
      const id = (node as { id?: unknown }).id
      applyCanvasNodeCreated(sessionId, { node })
      if (typeof id === "string" && id) created_node_ids.push(id)
    } else if (type === "update_node") {
      const id = op.id
      if (typeof id !== "string" || !id) continue
      const patch = op.patch && typeof op.patch === "object" ? (op.patch as Record<string, unknown>) : {}
      const key = canvasKeyFor(sessionId)
      const snap = canvasStates.get(key)
      if (!snap || !snap.state || typeof snap.state !== "object") continue
      const cs = snap.state as PersistableCanvasState
      const arr = nodesArray(cs)
      const node = arr.find((n) => n && n.id === id)
      if (!node) continue
      if (typeof patch.title === "string") node.title = patch.title
      if (patch.metadata && typeof patch.metadata === "object") {
        const md =
          node.metadata && typeof node.metadata === "object"
            ? (node.metadata as Record<string, unknown>)
            : (node.metadata = {})
        Object.assign(md, patch.metadata as Record<string, unknown>)
      }
      if (patch.position !== undefined) node.position = patch.position
      if (typeof patch.width === "number") node.width = patch.width
      if (typeof patch.height === "number") node.height = patch.height
      touchCanvasSnapshot(sessionId, cs)
    } else if (type === "delete_nodes") {
      applyCanvasNodeDeleted(sessionId, { node_ids: op.ids })
    } else if (type === "connect_nodes") {
      const conns = Array.isArray(op.connections) ? op.connections : []
      for (const c of conns) {
        if (!c || typeof c !== "object") continue
        const from = (c as { fromNodeId?: unknown }).fromNodeId
        const to = (c as { toNodeId?: unknown }).toNodeId
        if (typeof from !== "string" || typeof to !== "string") continue
        applyCanvasNodeConnected(sessionId, {
          connection: { id: `conn-${from}-${to}`, fromNodeId: from, toNodeId: to },
        })
      }
    } else if (type === "delete_connections") {
      const ids = Array.isArray(op.ids)
        ? (op.ids as unknown[]).filter((x): x is string => typeof x === "string")
        : []
      if (ids.length === 0) continue
      const key = canvasKeyFor(sessionId)
      const snap = canvasStates.get(key)
      if (!snap || !snap.state || typeof snap.state !== "object") continue
      const cs = snap.state as PersistableCanvasState
      if (Array.isArray(cs.connections)) {
        const idSet = new Set(ids)
        cs.connections = (cs.connections as Record<string, unknown>[]).filter(
          (c) => !(c && typeof c.id === "string" && idSet.has(c.id)),
        )
        touchCanvasSnapshot(sessionId, cs)
      }
    }
  }
  const st = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (st) markDirty(st)
  return { created_node_ids }
}

// 下发一批画布操作：经 SSE 对该 session 发 canvas.ops，挂起等前端回执。
// 前端暂时断线也照发（事件进 replay buffer，重连即补）。
// F1：结构 ops 先写穿 canvasStates；无 SSE 客户端立即 queued 成功；逾时亦 queued 成功（不再 OPS_TIMEOUT 甩锅）。
export function dispatchCanvasOps(
  state: SessionState,
  ops: unknown[],
  label?: string,
  timeoutMs: number = CANVAS_OPS_TIMEOUT_MS,
): Promise<{ request_id: string; result: CanvasOpsResult }> {
  const request_id = `cop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const offline = applyCanvasOpsToSnapshot(state.sessionId, ops)
  const queuedResult: CanvasOpsResult = {
    ok: true,
    queued: true,
    ...(offline.created_node_ids.length > 0 ? { created_node_ids: offline.created_node_ids } : {}),
  }
  // 无活 SSE 客户端：前端此刻接不到 canvas.ops，直接以写穿快照为准返回（可 hydrate）。
  if (state.clients.size === 0) {
    emitToSession(state, "canvas.ops", { request_id, ops, ...(label ? { label } : {}) })
    return Promise.resolve({ request_id, result: { ...queuedResult, queued_reason: "no_client" } })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCanvasOps.delete(request_id)
      // 逾时：快照已写穿，agent 视为成功（queued）；前端稍后打开可 hydrate／apply 队列。
      console.warn(`[gateway] canvas.ops ack timeout — session=${state.sessionId} request=${request_id} clients=${state.clients.size} ops=${ops.length}`)
      resolve({ request_id, result: { ...queuedResult, queued_reason: "ack_timeout" } })
    }, timeoutMs)
    pendingCanvasOps.set(request_id, {
      sessionKey: state.sessionId,
      settle: (result) => {
        clearTimeout(timer)
        pendingCanvasOps.delete(request_id)
        // 前端真回执优先；若缺 created_node_ids 则用写穿侧的补上。
        const merged: CanvasOpsResult = {
          ...result,
          created_node_ids: result.created_node_ids?.length
            ? result.created_node_ids
            : offline.created_node_ids.length > 0
              ? offline.created_node_ids
              : result.created_node_ids,
        }
        resolve({ request_id, result: merged })
      },
    })
    emitToSession(state, "canvas.ops", { request_id, ops, ...(label ? { label } : {}) })
  })
}

export function resolveCanvasOps(sessionId: string, requestId: string, result: CanvasOpsResult): boolean {
  const pending = pendingCanvasOps.get(requestId)
  if (!pending) return false
  if (pending.sessionKey !== canvasKeyFor(sessionId)) return false
  pending.settle(result)
  return true
}

export function sanitizeOpsResult(body: Record<string, unknown>): CanvasOpsResult {
  const created = Array.isArray(body.created_node_ids)
    ? (body.created_node_ids.filter((v) => typeof v === "string") as string[]).slice(0, 100)
    : undefined
  return {
    ok: body.ok === true,
    ...(typeof body.error === "string" && body.error ? { error: body.error.slice(0, 400) } : {}),
    ...(created && created.length > 0 ? { created_node_ids: created } : {}),
  }
}

// POST /internal/canvas/state — loopback 快照写入（body 带 session_id）。
export async function handleCanvasStateWrite(req: Request): Promise<Response> {
  let body: { session_id?: unknown; state?: unknown }
  try {
    body = (await req.json()) as { session_id?: unknown; state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  if (body.state === null || body.state === undefined || typeof body.state !== "object") {
    return jsonError(400, "state (object) is required", "bad_request", "bad_request")
  }
  const stored = storeCanvasState(body.session_id, body.state)
  if ("status" in stored) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt, rev: stored.rev })
}

// GET /internal/canvas/snapshot — 工具读最新快照（与既有 GET /internal/canvas/state 分开）。
export async function handleCanvasSnapshotRead(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const snap = getCanvasState(sessionId)
  return Response.json({
    ok: true,
    has_state: snap !== null,
    state: snap?.state ?? null,
    updated_at: snap?.updatedAt ?? null,
  })
}
