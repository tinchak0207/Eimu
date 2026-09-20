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
import { resolveSession } from "./sessions-core.ts"
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
const CANVAS_OPS_MAX = 100
const CANVAS_OP_TYPES = new Set([
  "add_node",
  "update_node",
  "delete_nodes",
  "connect_nodes",
  "delete_connections",
  "select_nodes",
  "set_viewport",
  "run_generation",
  "set_project_meta",
])

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

// ---- 畫布事件持久化（2026-08-27 修復）----
// 斷鏈根因：autoCreateCanvasUnit / emitCanvasResult 只對 SSE 發 canvas.node.* 事件，
// 從不寫 canvasStates，導致 GET /internal/canvas/snapshot 永遠 has_state:false，
// 前端刷新後畫布全丟。修復：事件發生的同一瞬間，把它套用到該 session 的快照
// state（節點 upsert / 連線 upsert），並隨 session 防抖落盤（canvasSnapshot
// 欄位），gateway 重啟後懶加載時回灌 canvasStates。
// 前端若已上行過自己的完整 state（storeCanvasState），之後的事件疊加其上——
// 同一 data 語義，不衝突。

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

export function validateCanvasOps(ops: unknown): { ok: true; ops: unknown[] } | { ok: false; message: string } {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, message: "ops must be a non-empty array" }
  if (ops.length > CANVAS_OPS_MAX) return { ok: false, message: `too many ops (max ${CANVAS_OPS_MAX})` }
  for (const op of ops) {
    const type = op && typeof op === "object" ? (op as { type?: unknown }).type : undefined
    if (typeof type !== "string" || !CANVAS_OP_TYPES.has(type)) {
      return { ok: false, message: `invalid op type: ${String(type)}` }
    }
  }
  return { ok: true, ops }
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
