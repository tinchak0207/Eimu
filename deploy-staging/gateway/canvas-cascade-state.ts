// 從 index.ts 無損抽取（2026-09-19 第一階段）：Canvas 狀態持久化區段（原 index.ts 7397–7689 行，
// 「Wave C」banner 起、handleCanvasSnapshotRead 止）。
// 依賴說明：
//  - jsonError：import 自 ./gw-lib.ts
//  - SessionState：TODO types-gateway.ts 未建（B 路任務），整合時補
//    `import type { SessionState } from "./types-gateway.ts"`（bun build 只轉譯不查型別，建得過）
//  - resolveSession / emitToSession：仍定義在 index.ts（≈1412/1957 行），以 setCanvasDeps 注入
//    （本檔唯一語義改寫：原直接呼叫改為呼叫注入變量；未注入時 resolveSession 回 undefined、
//    canvasKeyFor 回退原 id——與「session 不可解析」語義一致）。
//  - 區內無 markDirty 實際呼叫（僅 7432–7433 註釋提及；呼叫點 3745/5464 等在區外），故未做 markDirty 注入。
import { jsonError } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { resolveSession, markDirty } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import { emitToSession } from "./sse-core.ts"

// ─────────────────────────── Wave C：Agent 操作畫布（canvas.ops 下發/回執）
//
// 兩條通道，核心共用：
//  1) 快照上行：前端（經站點代理）POST /agent/v1/sessions/:id/canvas/state 存壓縮
//     快照；loopback 等價端點 POST /internal/canvas/state（body 帶 session_id）。
//     opencode 的 canvas_get_state 工具經 GET /internal/canvas/snapshot 讀取。
//     注意：既有 GET /internal/canvas/state（讀隨訊息上送的 canvasSummary）語義不動。
//  2) ops 下發：工具 POST /internal/canvas/dispatch-ops → 經該 session 的 SSE 發
//     canvas.ops 事件 { request_id, ops, label? }，掛起等前端回執；前端執行後
//     POST /agent/v1/sessions/:id/canvas/ops-result（loopback 等價 /internal/canvas/ops-result）
//     resolve 對應 pending。逾時（預設 30s）回 OPS_TIMEOUT。

const CANVAS_STATE_MAX_BYTES = 512 * 1024
const CANVAS_STATE_TTL_MS = 24 * 60 * 60 * 1000 // 2026-08-29：30min → 24h（保存線對齊「至少 24h」；重啟另有 DB 鏡像回灌）
export const CANVAS_OPS_TIMEOUT_MS = Number.parseInt(process.env.CANVAS_OPS_TIMEOUT_MS || "30000", 10) || 30_000
// op 型別白名單抽到零依賴模組（2026-10-03）：本檔 import 鏈會拉起 sessions-core，
// 白名單自身要能獨立跑真行為斷言。此處 re-export 保持既有呼叫端不變。
export { CANVAS_OP_TYPES, validateCanvasOps } from "./canvas-op-types.ts"

export interface CanvasSnapshotEntry {
  state: unknown
  updatedAt: number
}

// 畫布快照存放。key 統一收斂到 gateway sessionId（session 可解析時），
// 讓 opencode session id / gateway session id 兩種呼叫方命中同一份。
// 前置聲明：markDirty（早於本行定義）引用 canvasStates，const 提升安全
// （markDirty 只在請求處理時執行，遠晚於模組頂層求值）。
export const canvasStates = new Map<string, CanvasSnapshotEntry>()

function canvasKeyFor(sessionId: string): string {
  // 0920：子代理（Expert）的畫布工具帶自己的 opencode session id——舊版 fallback
  // 直接回原文 id，Expert 的節點會寫進一個用戶看不見的「子會話畫布桶」（靜默分裂，
  // 比 404 更陰）。兜底回父會話＝模板節點（角色卡/美術卡）落在用戶畫布上。
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return state ? state.sessionId : sessionId
}

// 惰性 TTL 清理：每次讀寫順手掃（條目數 = 活躍畫布數，量級小）。
function sweepCanvasStates(): void {
  const now = Date.now()
  for (const [k, v] of canvasStates) {
    if (now - v.updatedAt > CANVAS_STATE_TTL_MS) canvasStates.delete(k)
  }
}

export function storeCanvasState(
  sessionId: string,
  stateValue: unknown,
): { ok: true; bytes: number; updatedAt: number } | { ok: false; status: number; message: string } {
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(stateValue), "utf-8")
  } catch {
    return { ok: false, status: 400, message: "state is not serializable" }
  }
  if (bytes > CANVAS_STATE_MAX_BYTES) {
    return { ok: false, status: 413, message: `state exceeds ${CANVAS_STATE_MAX_BYTES} bytes` }
  }
  sweepCanvasStates()
  const updatedAt = Date.now()
  canvasStates.set(canvasKeyFor(sessionId), { state: stateValue, updatedAt })
  return { ok: true, bytes, updatedAt }
}

// 工具/內部讀取最新快照；無快照回 null。
export function getCanvasState(sessionId: string): CanvasSnapshotEntry | null {
  sweepCanvasStates()
  return canvasStates.get(canvasKeyFor(sessionId)) ?? null
}

// ---- 畫布事件持久化（2026-08-27 修復；2026-09-20 寫穿收口）----
// 斷鏈根因：autoCreateCanvasUnit / emitCanvasResult 只對 SSE 發 canvas.node.* 事件，
// 從不寫 canvasStates，導致 GET /internal/canvas/snapshot 永遠 has_state:false，
// 前端刷新後畫布全丟。修復：事件發生的同一瞬間，把它套用到該 session 的快照
// state（節點 upsert / 連線 upsert），並隨 session 防抖落盤（canvasSnapshot
// 欄位），gateway 重啟後懶加載時回灌 canvasStates。
// 前端若已上行過自己的完整 state（storeCanvasState），之後的事件疊加其上——
// 同一 data 語義，不衝突。
// 2026-09-20 寫穿：上述「懶加載回灌」與「SSE 事件流」雙軌收口為「SSE 事件即寫穿」
// ——workflow 出口（workflow-gw.ts 的 workflowService emit hook 與兩處直發
// emitToSession）在每個 canvas.node.created/updated/connected/disconnected/generating
// 發出的同一瞬間呼叫本檔的 applyCanvasNode*（created/connected upsert、updated/generating
// metadata 淺合併、disconnected 移除連線），冪等（按 id upsert、last-write-wins）。
// 寫穿只合併進既有快照：updated/generating 在快照不存在或節點不在時靜默跳過
// （不強造空殼，留給懶加載回灌兜底）；created/connected 沿用 mutableCanvasStateOf
// 既有語義建快照。prompt-time skeleton 推送路徑（同樣落到 applyCanvasNodeCreated）
// 不動。

export interface PersistableCanvasState {
  nodes?: Record<string, unknown> | Record<string, unknown>[]
  connections?: Record<string, unknown> | Record<string, unknown>[]
  [k: string]: unknown
}

// 讀（無則建）該 session 的可變快照形狀；盡量沿用前端上行 state 的既有欄位
// （如 nodes/connections 陣列），缺什麼補什麼，不覆蓋前端已有資料。
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

// canvas.node.created → 節點 upsert（以 node.id 為鍵，重放安全）。
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

// canvas.node.connected → 連線 upsert（以 connection.id 為鍵，重放安全）。
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

// canvas.node.updated → 對目標節點做 metadata 淺合併（patch 套用到 metadata）。
// 淺合併即可：現有 patch 欄位（status/content/cost_coins/progress）皆為純量或
// 獨立小物件，覆寫語義正確。
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

// canvas.node.deleted → 從快照移除節點（若有）。
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

// canvas.node.disconnected → 從快照移除對應連線（wire 載荷只有 from/to，無 id；
// 對照 canvas.node.connected 的 connection 形狀 fromNodeId/toNodeId 過濾）。冪等：
// 連線不在快照時 no-op。快照不存在時同樣 no-op（不強造空殼）。
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
}

interface PendingCanvasOps {
  sessionKey: string
  settle: (result: CanvasOpsResult) => void
}

const pendingCanvasOps = new Map<string, PendingCanvasOps>()

// ---- 用戶批准憑據＋偏離模板 token（2026-10-02）----
// 模型自宣告 deviate_from_template=true 等於沒守；改成網關簽發 token：只有「本 session 內
// 用戶真的回應過 question」（走既有 question/confirm 機制）才發；模型必須把 token 原樣帶回，
// 自帶 deviate_from_template=true 不再放行。
// 2026-10-02：token 本體移住 session 狀態（persistence 白名單欄位 tplDeviateToken）＝
// 跨 agent-gateway 重啟存活（過往行程內 Map，重啟即失＝用戶批准過的偏離出口被關上）。
// userAnsweredQuestions 仍在行程內：它只決定「簽不簽」，token 本體在 session 狀態，單一真源。
const userAnsweredQuestions = new Map<string, number>()
const USER_ANSWERED_MAX = 2000
const TPL_DEVIATE_TTL_MS = 15 * 60 * 1000
// session 解析慣例同 canvasKeyFor：網關 id 優先，子代理（Expert）帶自己的 opencode id 時
// 兜底回父會話（token 必須落在用戶會話上，落在子會話桶裡等於沒簽）。
function sessionForToken(sessionId: string): SessionState | undefined {
  return resolveSession(sessionId) ?? subagentParentState(sessionId)
}
export function markUserAnsweredQuestion(sessionId: string): void {
  if (!sessionId) return
  // 先刪再插：Map 迭代序即插入序，淘汰時刪最舊（隊首）。
  userAnsweredQuestions.delete(sessionId)
  userAnsweredQuestions.set(sessionId, Date.now())
  while (userAnsweredQuestions.size > USER_ANSWERED_MAX) {
    const oldest = userAnsweredQuestions.keys().next().value
    if (oldest === undefined) break
    userAnsweredQuestions.delete(oldest)
  }
  // 用戶真實批准 → 網關簽發偏離 token（模型下一回合才能拿到），寫進 session 狀態（落盤）。
  const token = `tpl-dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const st = sessionForToken(sessionId)
  if (st) {
    st.tplDeviateToken = { token, at: Date.now() }
    markDirty(st)
    console.log(`[gateway] template_guard: user answered question → deviate token issued session=${sessionId}`)
  } else {
    // 解析不到 session：只留 answered 標記，無行程內 token 後備（避免雙真源）。
    console.warn(`[gateway] template_guard: cannot resolve session for deviate token session=${sessionId}`)
  }
}
export function hasUserAnsweredQuestion(sessionId: string): boolean {
  return userAnsweredQuestions.has(sessionId)
}
// 取本 session 當前有效的偏離 token（無/過期回 null）——注入模型上下文用。
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
// 單次核銷：token 相符即消耗（一批 ops 一次授權），否則 false。
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

// ---- 模板節點守衛（2026-10-02 v2：守「接線契約」，不禁止建節點）----
// v1 病灶：用「type 黑名單 + 任一空位未填＝全鎖」攔 add_node，把模板靈活性一起殺掉——
// 模板步驟頭卡本身就是 config 型 ⇒ 加一步＝加 config＝一律 409；character_card/scene_card 同病；
// 反而 text 型不在名單 ⇒ 未接線的漂浮節點照樣放行（守錯方向）。
// v2 只守兩個結果面不變量（守衛要教不要禁，見 feedback-guard-teaches-not-bans）：
//   I1 模板產出必須落在模板槽位（防平行重複生成＝防重複扣費）：新增生成類節點若與某未填空位
//      同 (type, role)，或未宣告 role 而對同型別空位直接 run_generation ⇒ 攔。
//   I2 新增節點必須是圖上的一環：同批 connect_nodes 至少有一條 inbound 來自既有節點（整批錨定），
//      且不得有漂浮新節點（每顆新節點至少一條 inbound，來自既有或同批新節點）。
// 409 文案一律附精確接線修法（哪個 id 連哪個 id）＋模板拓撲，不是「不要建」。
const TPL_GEN_NODE_TYPES = new Set(["image", "video", "audio", "director", "character_card", "scene_card", "config"])

export interface TemplateOpenSlot {
  id: string
  title: string
  type: string
  /** 槽位語義角色（role/slot_hint/stepName/deliverable），供 (type, role) 重複判定。 */
  role: string
  stepIndex: number | null
  stepName: string
  /** 模板拓撲中這顆生成卡的前驅節點 id（無則 null）。 */
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

// 所有模板生成卡（含已填/在途），帶拓撲（stepIndex/stepName/前驅 id）。
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

// 模板生成卡中尚未回填結果（metadata.content 為空）的空位。
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

// 模板拓撲（每步 stepIndex/stepName/前驅 id/下游 id/生成卡 id/落位狀態）——注入模型＋附在 409 文案。
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
      return `- ${step}${name} | 前驅=${s.prevId ?? "(無)"} | 下游=${next ? String(next.toNodeId) : "(無)"} | 生成卡=${s.id}(${s.type}) | ${templateNodeStatus(sessionId, s)}`
    })
    .join("\n")
}

// 生成工具（image_generate 等）出圖時網關會自動鋪一組 cu_* 節點（autoCreateCanvasUnit），
// 與用戶的模板節點完全無關 → 模板被架空。模板有同類型空位時，改為把這次生成「綁定」到空位：
// 不新建 unit，結果事件改寫在模板節點上（unit_id → 模板節點 id 的映射）。
const tplBoundUnits = new Map<string, string>() // `${sessionId}|${unitId}` → 模板節點 id
// 落位回灌：最近一次生成被網關改寫落在哪個 tpl 節點（下一回合注入模型上下文，見 templateLandingFact）。
const tplLastLandings = new Map<string, { slotId: string; at: number }>()
export function claimTemplateSlot(sessionId: string, unitId: string, kind: "image" | "video"): TemplateOpenSlot | null {
  // 選位：同 kind、未 loading、未被其他 unit 佔用 的空位中，取 metadata.stepIndex 最小者
  // （缺省視為很大）；同 stepIndex 依快照順序。多步模板不再錯位到第一步。
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
// 結果節點 id：綁定了模板空位 → 模板節點；否則沿用自動 unit 的 `${unitId}-image`。
export function canvasResultNodeId(sessionId: string, unitId: string): string {
  return tplBoundUnits.get(`${sessionId}|${unitId}`) ?? `${unitId}-image`
}
// 落位回灌事實：模型不知道網關把落點改寫到哪顆 tpl 節點（v1 病灶④）。下一回合明說。
export function templateLandingFact(sessionId: string): string | null {
  const last = tplLastLandings.get(sessionId)
  if (!last) return null
  if (Date.now() - last.at > 30 * 60 * 1000) return null
  return `你上一筆生成已被網關落位到模板節點「${last.slotId}」（結果會回填在該節點，不要為同一交付物再重複生成／不要另建平行節點）。`
}

// 畫布快照裡是否已有用戶配上的模板節點（任一 tpl-* 節點即算）。
export function hasTemplateNodes(sessionId: string): boolean {
  const nodes = (getCanvasState(sessionId)?.state as { nodes?: unknown } | null | undefined)?.nodes
  return Array.isArray(nodes) && nodes.some((n) => typeof (n as { id?: unknown })?.id === "string" && /^tpl-/.test((n as { id: string }).id))
}

// 每回合注入模型上下文的事實：模板拓撲＋空位＋插入配方＋（若已批准）偏離 token。
export function buildTemplateSlotsFact(sessionId: string, deviateToken?: string): string | null {
  const topology = renderTemplateTopology(sessionId)
  if (!topology) return null
  const open = listTemplateOpenSlots(sessionId)
  const loadingIds = listTemplateGenNodes(sessionId)
    .filter((s) => templateNodeStatus(sessionId, s) === "loading")
    .map((s) => s.id)
  const lines: string[] = [
    "畫布上已配好用戶選定的模板（生成卡＝交付落地位）。拓撲：",
    topology,
  ]
  if (loadingIds.length > 0) lines.push(`已在跑（勿重複提交）：${loadingIds.join("、")}`)
  lines.push(
    open.length > 0
      ? `未填空位 ${open.length} 個。生成既有交付物 → 落在 open 生成卡：canvas_apply_ops update_node {id:"<gen-id>", patch:{metadata:{prompt,model,size}}} 後 run_generation {node_id:"<gen-id>"}。`
      : "模板生成卡已全部落位。",
    "要新增步驟/角色/節點 → 必須同批帶 connect_nodes 接進圖（至少一條 inbound 來自既有節點），例：{\"type\":\"connect_nodes\",\"connections\":[{\"fromNodeId\":\"<既有 id>\",\"toNodeId\":\"<新 id>\"}]}；跨欄扇入是合法的。新節點若與某空位同 (type, role) ＝平行重複生成，會被攔；額外一步/額外角色請宣告不同 role（metadata.role 或 slot_hint）。",
  )
  if (deviateToken) lines.push(`已獲用戶批准偏離模板：重試時帶 deviate_token=${deviateToken}（自帶 deviate_from_template=true 無效）。`)
  else lines.push("確需偏離模板 → 先用 question 向用戶說明並取得真實同意；網關批准後才簽發 token，自帶 deviate_from_template=true 無效。")
  let out = lines.join("\n")
  if (out.length > 1400) out = out.slice(0, 1399) + "…"
  return out
}

export interface TemplateDeviation {
  declared: boolean
  reason: string
  /** 模型帶回的偏離 token。 */
  token?: string
}

// 返回攔截訊息（人話）；null = 放行。
export function checkTemplateGuard(sessionId: string, ops: unknown[], deviation: TemplateDeviation): string | null {
  if (!hasTemplateNodes(sessionId)) return null
  const adds = ops.filter((o) => (o as { type?: unknown })?.type === "add_node") as Array<{
    type: "add_node"
    node: Record<string, unknown>
  }>
  if (adds.length === 0) return null

  // 偏離：只認網關簽發 token（模型自宣告無效）。
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
  // 模板已全部落位（無空位）＝無保護標的 → 維持舊行為放行（不做圖完整性守衛）。
  if (openSlots.length === 0) return null

  // I2a 漂浮節點：新節點沒有任何 inbound（來自既有或同批新節點）。
  const floating = adds.filter((a) => {
    const id = String(a.node?.id ?? "")
    return !batchEdges.some((e) => e.to === id && e.from !== id && (existingIds.has(e.from) || newIds.has(e.from)))
  })
  // I2b 整批錨定：至少一條邊「既有 → 新」。
  const anchored = batchEdges.some((e) => existingIds.has(e.from) && newIds.has(e.to))

  // I1 平行重複生成：同 type 且（未宣告 role＝無法證明是額外物，或宣告的 role 與空位相同）。
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
  if (dupes.length) problems.push(`平行重複生成 x${dupes.length}`)
  if (floating.length) problems.push(`漂浮節點 x${floating.length}`)
  if (!anchored) problems.push("未接入既有圖")
  if (problems.length === 0) return null

  const anchor =
    openSlots[0]?.prevId ?? openSlots[0]?.id ?? listTemplateGenNodes(sessionId)[0]?.id ?? [...existingIds][0] ?? ""

  const msg: string[] = [`模板守衛：這批 ops 的接線不合法（新節點必須是模板圖的一環），已攔下（未落位、未扣費）。問題：${problems.join("、")}。`]
  if (dupes.length) {
    const d = dupes[0]
    const type = typeof d.node?.type === "string" ? d.node.type : ""
    const meta = (d.node?.metadata && typeof d.node.metadata === "object" ? d.node.metadata : {}) as Record<string, unknown>
    const role = slotRoleFromMeta(meta)
    const slot = openSlots.find((s) => s.type === type && (!role || (!!s.role && normalizeRole(s.role) === normalizeRole(role))))
    msg.push(
      slot
        ? `• 新增節點「${String(d.node?.id)}」與未填空位「${slot.id}」同型別(${type})同角色(${role || slot.role})＝平行重複生成。修法二選一：` +
            `(a) 直接填既有空位：{"type":"update_node","id":"${slot.id}","patch":{"metadata":{"prompt":"…","model":"…","size":"…"}}} 再 {"type":"run_generation","node_id":"${slot.id}"}；` +
            `(b) 若確實是「額外一步/額外角色」，在 add_node 的 node.metadata.role 寫明不同角色（例 "額外角色：反派"），並用 connect_nodes 把新節點接進圖。`
        : `• 新增節點「${String(d.node?.id)}」與模板未填空位同型別且直接 run_generation＝平行重複生成。請改填既有空位，或宣告不同 role（metadata.role）後再 connect_nodes 接線。`,
    )
  }
  if (floating.length) {
    const f = String(floating[0].node?.id)
    msg.push(`• 漂浮節點 ${floating.map((a) => String(a.node?.id)).join("、")} 沒有任何 inbound（未接線）。修法：同批補 connect_nodes，例：{"type":"connect_nodes","connections":[{"fromNodeId":"${anchor}","toNodeId":"${f}"}]}。`)
  }
  if (!anchored) {
    const first = String(adds[0].node?.id)
    msg.push(`• 這批新節點沒有任何一條 inbound 來自既有節點（整批未錨定＝未接線到模板圖）。修法：從最接近的前驅接出，例：{"type":"connect_nodes","connections":[{"fromNodeId":"${anchor}","toNodeId":"${first}"}]}。跨欄扇入（多上游匯入同一節點）是合法的。`)
  }
  const topology = renderTemplateTopology(sessionId)
  if (topology) msg.push(`模板拓撲（前驅/生成卡/落位狀態）：\n${topology}`)
  msg.push("確需偏離模板 → 先用 question 向用戶說明並取得真實同意；網關批准後簽發 deviate_token，重試時帶上（自帶 deviate_from_template=true 無效）。")
  console.log(`[gateway] template_guard: BLOCKED session=${sessionId} adds=${adds.length} problems=${problems.join("|")}`)
  return msg.join("\n")
}

// 下發一批畫布操作：經 SSE 對該 session 發 canvas.ops，掛起等前端回執。
// 前端暫時斷線也照發（事件進 replay buffer，重連即補），靠逾時兜底。
export function dispatchCanvasOps(
  state: SessionState,
  ops: unknown[],
  label?: string,
  timeoutMs: number = CANVAS_OPS_TIMEOUT_MS,
): Promise<{ request_id: string; result: CanvasOpsResult }> {
  const request_id = `cop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCanvasOps.delete(request_id)
      reject(Object.assign(new Error("canvas ops timeout"), { code: "OPS_TIMEOUT", request_id }))
    }, timeoutMs)
    pendingCanvasOps.set(request_id, {
      sessionKey: state.sessionId,
      settle: (result) => {
        clearTimeout(timer)
        pendingCanvasOps.delete(request_id)
        resolve({ request_id, result })
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

// POST /internal/canvas/state — loopback 快照寫入（body 帶 session_id）。
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
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// GET /internal/canvas/snapshot — 工具讀最新快照（與既有 GET /internal/canvas/state 分開）。
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
