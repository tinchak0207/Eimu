import { appendFile, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { WorkflowService } from "./workflow-service"
import {
  initPersistence,
  saveSession,
  loadSessionById,
  loadSessionByOpencodeId,
  deleteSessionRow,
  hydrateRow,
  sweepStaleRows,
} from "./persistence"

/**
 * agent-gateway — Bun TypeScript gateway between frontend clients and opencode serve.
 *
 * Port 8081. Public API is key-authenticated (Bearer sk-biz-*), validated against
 * the platform's OpenAI-compatible endpoint (cached 5 min). Internal API is
 * loopback-only and drives the billing confirmation flow.
 *
 * Connects once to opencode's global /event SSE stream and fans events out to the
 * matching frontend SSE streams, translating opencode event shapes into
 * frontend-friendly event names.
 */

// OpenCode 1.18.x /event payloads are loosely-typed JSON whose shape varies per
// event type. The old strict OpencodeEvent/OpencodePart interfaces encoded a
// guessed schema (part.toolName, part.state as a string, part.result) that does
// not match the wire format and is now dead. Translation uses `any`-shaped
// objects with safe optional access instead.

interface PendingConfirm {
  timer: ReturnType<typeof setTimeout>
  ledger?: { amount_coins: number; task_id?: string; model?: string }
}

interface PendingQuestion {
  requestId: string
  callId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
  }>
}

// Outcome of a confirm that is no longer pending. Kept around deliberately:
// the tool polls for the answer, so if a resolved request vanished from memory
// the poller's next tick would see "unknown" and read it as a denial —
// silently cancelling work the user had already approved.
type ConfirmOutcome = "approved" | "denied" | "expired"

interface ResolvedConfirm {
  outcome: ConfirmOutcome
  resolvedAt: number
}

interface SSEClient {
  controller: ReadableStreamDefaultController<Uint8Array>
}

interface SessionState {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  clients: Set<SSEClient>
  pendingConfirms: Map<string, PendingConfirm>
  pendingQuestions: Map<string, PendingQuestion>
  resolvedConfirms: Map<string, ResolvedConfirm>
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array }[]
  // Touched by every lookup and every emitted event; drives the idle reaper.
  lastActivityAt: number
  // Per-session translation state for the /event fan-out. All bounded below.
  partTextEmitted: Map<string, { emittedLen: number }>
  announcedUrls: Set<string>
  toolStatusSeen: Set<string>
  toolInvokeSeen: Set<string>
  stepCostLogged: Set<string>
  messageRole: Map<string, string>
  suppressedParts: Set<string>
  // 畫布摘要：前端每次發訊息時上送的最新畫布狀態（節點/連線/預算），
  // 供前端接續畫布/稽核用。deepseek 不讀這個——它完全不知道畫布存在。
  canvasSummary?: unknown
  canvasSummaryAt?: number
  // 自動製畫布：opencode image_* 工具的活躍單元追蹤。
  // deepseek 只提交生圖/改圖請求，gateway 攔截其參數自動建畫布：
  //   工具 callID → 畫布單元 id（running 階段建立）
  //   task_id    → 畫布單元 id（submit 完成後掛取，供完成事件關聯）
  canvasUnitByCall: Map<string, string>
  canvasUnitByTask: Map<string, string>
  // 意圖審查政策只在 session 首次 send 時注入（system 欄位），之後不再重複，
  // 避免每次訊息都帶同一段 system 造成 token 膨脹。
  vettingInjected: boolean
  // L0 账户级记忆：本站会话创建时上送的 user_profile + lessons（已确认的画像
  // 与教训）。首条消息时拼进 system 注入，之后不再重复，避免 token 膨胀。
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  // 记忆注入标记（vettingInjected 同款一次性语义）。
  memoryInjected: boolean
  // 滾動摘要壓縮水位：上次 opencode summarize 後的訊息數與時間（持久化）。
  // 觸發條件 = 訊息數 ≥ SESSION_COMPACT_THRESHOLD 且自上次壓縮新增 ≥ 半個閾值。
  compact?: { lastCount: number; at: number }
}

const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "")
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || ""
const PORT = Number.parseInt(process.env.GATEWAY_PORT || "8081", 10) || 8081
const PLATFORM_BASE = (process.env.PLATFORM_BASE || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
const QUOTA_URL = process.env.QUOTA_URL || `${PLATFORM_BASE}/v1/quota`
// How long a spend confirmation stays answerable. 15 minutes, not 90 seconds:
// the user may be reading the parameter card, checking their balance, or simply
// away from the tab, and a spend prompt that silently expires under them is
// worse than one that waits. This is NO LONGER bounded by the HTTP layer —
// /internal/confirm-request returns immediately and the tool polls, precisely
// because a request cannot block this long (Bun's idleTimeout maxes at 255s
// and the caller aborts at 150s).
const CONFIRM_TIMEOUT_MS = Number.parseInt(process.env.CONFIRM_TIMEOUT_MS || "900000", 10) || 900_000
// Keep answered confirmations addressable well past the poll interval so a
// poller that ticks right after resolution still reads the real outcome.
const CONFIRM_RESOLVED_TTL_MS = 5 * 60 * 1000
const CONFIRM_RESOLVED_CAP = 200
const KEY_CACHE_TTL_MS = 5 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 20_000
const REPLAY_BUFFER_SIZE = 200
const IMAGE_URL_DEDUP_CAP = 100
const PART_TEXT_TRACK_CAP = 200
const TOOL_STATUS_DEDUP_CAP = 500
const STEP_COST_LOG_CAP = 1000
const MESSAGE_ROLE_CAP = 400
const SUPPRESSED_PART_CAP = 500
// Reaper thresholds. A session with no SSE clients and no activity for this
// long is assumed abandoned (closed tab / lost network) and freed.
const SESSION_IDLE_TTL_MS = Number.parseInt(process.env.SESSION_IDLE_TTL_MS || "1800000", 10) || 1_800_000
const SESSION_REAP_INTERVAL_MS = 60_000
const LEDGER_PATH = process.env.LEDGER_PATH || "/opt/agent-harness/ledger.jsonl"
// 畫布事件白名單：opencode canvas_* 工具透過 emitEvent 推送的畫布動作/成果事件。
// 這組事件由前端 reducer 接住，驅動畫布渲染（建節點/連線/顯示圖片/預算）。
const CANVAS_EMIT_ALLOWED = new Set([
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.deleted",
  "canvas.node.generating",
  "canvas.derive.started",
  "canvas.budget.updated",
])

const INTERNAL_EMIT_ALLOWED = new Set(["image.done", "session.error", "quota.changed", "tool.result"])

const WORKSPACE_DIR = "/opt/agent-harness/workspace"
const UPLOADS_DIR = path.join(WORKSPACE_DIR, "uploads")
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 // 4MB per file
const ALLOWED_UPLOAD_EXTS = new Set([
  ".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json",
  ".csv", ".xml", ".yaml", ".yml", ".png", ".jpg", ".jpeg",
  ".webp", ".gif", ".mp4", ".mov", ".zip",
])

function sanitizeUploadName(raw: string): string | null {
  const base = path.basename(raw).normalize("NFC")
  const safe = base.replace(/[^\w.\- ]/g, "_").replace(/_{2,}/g, "_").slice(0, 200)
  const ext = path.extname(safe).toLowerCase()
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) return null
  return safe
}

async function handleAttachmentUpload(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const ct = req.headers.get("content-type") || ""
  if (!ct.includes("multipart/form-data")) {
    return jsonError(400, "multipart/form-data required", "bad_request", "bad_request")
  }
  try {
    const form = await req.formData()
    const files = form.getAll("file") as File[]
    if (files.length === 0) return jsonError(400, "no file field", "bad_request", "bad_request")
    const uploadDir = path.join(UPLOADS_DIR, state.sessionId)
    await mkdir(uploadDir, { recursive: true })
    const results: { name: string; path: string; size: number }[] = []
    for (const file of files) {
      if (file.size > UPLOAD_MAX_BYTES) {
        return jsonError(413, "file exceeds 4MB limit", "payload_too_large", "payload_too_large")
      }
      const safeName = sanitizeUploadName(file.name)
      if (!safeName) {
        return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
      }
      const dest = path.join(uploadDir, safeName)
      if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
        return jsonError(400, "invalid path", "bad_request", "bad_request")
      }
      await Bun.write(dest, await file.arrayBuffer())
      results.push({ name: safeName, path: `uploads/${state.sessionId}/${safeName}`, size: file.size })
    }
    return Response.json({ attachments: results })
  } catch (e) {
    console.error("[gateway] upload error:", e)
    return jsonError(500, "upload failed", "server_error", "server_error")
  }
}

// SSE tickets. The browser EventSource API cannot set an Authorization header
// (its only option is withCredentials), so a page written the way §7 shows it
// cannot authenticate the event stream at all. Rather than accept the sk-biz-*
// key in the query string — where it lands in nginx access logs, Referer
// headers and browser history, and where it would still be a key that can spend
// money — a ticket is minted by an authenticated POST and scoped to exactly one
// session, read-only, with a short TTL.
//
// Deliberately reusable until it expires: EventSource reconnects on its own and
// replays Last-Event-ID, so a one-shot ticket would break §9-5 resume on the
// first network blip.
const SSE_TICKET_TTL_MS = Number.parseInt(process.env.SSE_TICKET_TTL_MS || "600000", 10) || 600_000
const sseTickets = new Map<string, { sessionId: string; apiKey: string; expiresAt: number }>()

// ---- 服務端會話持久化（bun:sqlite，見 persistence.ts）----
// 進程重啟不再丟會話：session row 落在 sessions.db；getOwnedSession 與事件
// fan-out 在內存 miss 時 lazy reload。訊息歷史的權威存儲是 opencode（重啟不丟），
// DB 只保存 gateway 自有的那部分狀態（身分映射 / replayBuffer / 去重集合 / 注入標記）。
initPersistence()
const sessions = new Map<string, SessionState>()

// dirty 標記 + 防抖 flush：emitToSession 等高頻變更只標記，每 3 秒統一落盤；
// 建立/刪除走同步寫。重啟最多丟 3 秒內的 replay 幀，訊息本身永遠安全在 opencode。
const dirtySessions = new Set<string>()
const PERSIST_FLUSH_INTERVAL_MS = 3000

function markDirty(state: SessionState): void {
  dirtySessions.add(state.sessionId)
}

function flushDirtySessions(): void {
  if (dirtySessions.size === 0) return
  const ids = [...dirtySessions]
  dirtySessions.clear()
  for (const id of ids) {
    const st = sessions.get(id)
    if (st) saveSession(st)
  }
}

setInterval(flushDirtySessions, PERSIST_FLUSH_INTERVAL_MS)

// systemd restart（SIGTERM）前補一次 flush，把最後 ≤3s 的 replay 幀也保住。
process.on("SIGTERM", () => {
  try {
    flushDirtySessions()
  } catch {
    // best-effort：flush 失敗不阻止退出
  }
  process.exit(0)
})

const keyCache = new Map<string, { ok: boolean; expiresAt: number }>()
const encoder = new TextEncoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jsonError(status: number, message: string, type: string, code: string): Response {
  return Response.json({ error: { message, type, code } }, { status })
}

function getBearer(req: Request): string | null {
  const auth = req.headers.get("authorization")
  if (!auth) return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

// ---- auth validation (cached 5 minutes) ----

async function validateApiKey(key: string): Promise<boolean> {
  const now = Date.now()
  const cached = keyCache.get(key)
  if (cached && cached.expiresAt > now) return cached.ok
  let ok = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    ok = res.ok
  } catch {
    ok = false
  }
  keyCache.set(key, { ok, expiresAt: now + KEY_CACHE_TTL_MS })
  return ok
}

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---- opencode client helpers ----

function opencodeHeaders(): Record<string, string> {
  return {
    Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
    "Content-Type": "application/json",
  }
}

// 內存 miss 時從 DB lazy reload（進程重啟後的會話恢復路徑）。
// 選 lazy 而非啟動全量載入：冷會話佔多數，lazy 免付啟動成本、不把殭屍
// session 釘在內存，且 reaper 的 idle 規則照常生效。
function hydrateFromDb(id: string): SessionState | null {
  const row = loadSessionById(id)
  if (!row) return null
  const state = hydrateRow(row) as unknown as SessionState
  sessions.set(state.sessionId, state)
  console.log(`[gateway] session restored from db: ${state.sessionId} (opencode ${state.opencodeSessionId})`)
  return state
}

function getOwnedSession(key: string, id: string): SessionState | null {
  const state = sessions.get(id) ?? hydrateFromDb(id)
  if (!state || state.apiKey !== key) return null
  state.lastActivityAt = Date.now()
  return state
}

// Mint an SSE ticket for a session the caller already owns.
function issueSseTicket(key: string, sessionId: string): string {
  const ticket = `st_${crypto.randomUUID().replace(/-/g, "")}`
  sseTickets.set(ticket, { sessionId, apiKey: key, expiresAt: Date.now() + SSE_TICKET_TTL_MS })
  return ticket
}

// Redeem a ticket for its session. Expiry is checked here rather than by a
// sweeper alone so a stale entry can never authenticate a stream.
function redeemSseTicket(ticket: string, sessionId: string): SessionState | null {
  const rec = sseTickets.get(ticket)
  if (!rec) return null
  if (rec.expiresAt <= Date.now()) {
    sseTickets.delete(ticket)
    return null
  }
  // Scoped to one session: a ticket for session A must not open session B.
  if (rec.sessionId !== sessionId) return null
  return getOwnedSession(rec.apiKey, sessionId)
}

function revokeSseTicketsFor(sessionId: string): void {
  for (const [ticket, rec] of sseTickets) {
    if (rec.sessionId === sessionId) sseTickets.delete(ticket)
  }
}

function findSessionByOpenCodeId(opencodeSessionId: string): SessionState | undefined {
  for (const state of sessions.values()) {
    if (state.opencodeSessionId === opencodeSessionId) return state
  }
  // 內存 miss：重啟後 opencode 事件 fan-out 仍能透過 DB 恢復 session 狀態，
  // 在途回合的後續事件照常進 replayBuffer。
  const row = loadSessionByOpencodeId(opencodeSessionId)
  if (!row) return undefined
  const state = hydrateRow(row) as unknown as SessionState
  sessions.set(state.sessionId, state)
  console.log(`[gateway] session restored from db (event fan-out): ${state.sessionId}`)
  return state
}

function resolveSession(id: string): SessionState | undefined {
  const state = sessions.get(id) ?? findSessionByOpenCodeId(id)
  if (state) state.lastActivityAt = Date.now()
  return state
}

function summarizeArgs(args?: unknown): string {
  if (!args) return ""
  if (typeof args !== "object") {
    const t = String(args)
    return t.length > 500 ? t.slice(0, 500) + "…" : t
  }
  if (Object.keys(args as Record<string, unknown>).length === 0) return ""
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    s = String(args)
  }
  return s.length > 500 ? s.slice(0, 500) + "…" : s
}

// ---- SSE helpers (gateway -> frontend) ----

function serializeSse(name: string, data: unknown, eventId: number): string {
  const payload = JSON.stringify({ ...(data as Record<string, unknown>), event_id: eventId })
  return `id: ${eventId}\nevent: ${name}\ndata: ${payload}\n\n`
}

function emitToSession(state: SessionState, name: string, data: unknown): void {
  // Agent-produced output counts as activity: a long generate with no client
  // polling must not look idle to the reaper while it is still working.
  state.lastActivityAt = Date.now()
  state.eventCounter += 1
  const frame = encoder.encode(serializeSse(name, data, state.eventCounter))
  state.replayBuffer.push({ id: state.eventCounter, frame })
  if (state.replayBuffer.length > REPLAY_BUFFER_SIZE) {
    state.replayBuffer.splice(0, state.replayBuffer.length - REPLAY_BUFFER_SIZE)
  }
  markDirty(state) // 防抖落盤：重啟後 replayBuffer 可供前端 Last-Event-ID 續傳
  for (const client of state.clients) {
    try {
      client.controller.enqueue(frame)
    } catch {
      state.clients.delete(client)
    }
  }
}

function closeSessionStreams(state: SessionState): void {
  for (const client of state.clients) {
    try {
      client.controller.close()
    } catch {
      // already closed
    }
  }
  state.clients.clear()
}

// ─────────────────────────── 畫布工作流引擎（暴君策略 v2）
//
// Deepseek 透過 workflow_* 工具填內容（參數/提示詞），本服務展開節點流並執行。
// 執行提交（image/video）由 submitWorkflowNode 完成（帶 session key）。

const workflowService = new WorkflowService({
  emit: (state, name, data) => {
    const target = (state as SessionState | undefined) ?? stateForWorkflow
    if (target) emitToSession(target, name, data)
  },
  runNode: async (node, upstream, graph) => {
    const session = stateForWorkflow
    if (!session) return { nodeId: node.id, ok: false, error: "no active session" }
    return submitWorkflowNode(session, node, upstream, graph)
  },
})

// runNode 需要目前的 session（key）。workflow 端點都是帶 session 呼叫的，執行前設入。
let stateForWorkflow: SessionState | null = null

/**
 * 提交單一節點生成：image → /v1/images/generations；video → /v1/videos/generations。
 * 非同步提交後輪詢（202 → task_id → GET {id} → succeeded → result url）。
 * 回傳 OpenAI 相容結果 {ok, content(url), costCoins?}。
 */
async function submitWorkflowNode(
  session: SessionState,
  node: { kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; error?: string }> {
  const meta = node.metadata
  const nodeId = (node as { id?: string }).id || ""

  // 解析 prompt：優先 node.metadata，其次沿上游連線 BFS 找第一個有內容的 text 節點
  // （大片模板：角色描述 text → 四視圖 config → 各視圖 image；image 的 prompt 繼承自角色描述）
  function collectUpstreamPrompt(startId: string, depth = 0): string {
    if (depth > 4) return ""
    const direct = graph?.connections.filter((c) => c.to === startId).map((c) => graph.nodes.find((n) => n.id === c.from)).filter(Boolean)
    for (const n of direct ?? []) {
      const content = typeof n.metadata.content === "string" ? n.metadata.content : typeof n.metadata.prompt === "string" ? n.metadata.prompt : ""
      if (content.trim()) return content
    }
    for (const n of direct ?? []) {
      const found = collectUpstreamPrompt(n.id, depth + 1)
      if (found) return found
    }
    return ""
  }
  const prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""

  const model = typeof meta.model === "string" ? meta.model : node.kind === "video" ? "seedance-2.0" : "pixai-tsubaki2"
  const size = typeof meta.size === "string" ? meta.size : "1024x1024"

  // 參考圖：上游中已完成且有 content 的 image 節點（角色圖/場景圖 → 影片參考）
  const refImages = graph
    ? graph.connections
        .filter((c) => c.to === nodeId)
        .map((c) => graph.nodes.find((n) => n.id === c.from))
        .filter((n): n is { id: string; kind: string; metadata: Record<string, unknown> } => Boolean(n) && n.kind === "image" && Boolean(upstream.get(n.id)))
        .map((n) => upstream.get(n.id)!)
    : []

  const endpoint = node.kind === "video" ? "/videos/generations" : "/images/generations"
  const payload: Record<string, unknown> = {
    prompt,
    model,
    size,
    n: 1,
    response_format: "url",
  }
  if (node.kind === "video") {
    payload.duration_seconds = typeof meta.duration_seconds === "number" ? meta.duration_seconds : 5
    if (refImages.length) payload.reference = refImages[0]
  } else if (refImages.length) {
    payload.reference = refImages[0]
  }

  if (!prompt) {
    console.error(`[workflow] node ${nodeId} (${node.kind}) has no prompt`)
    return { nodeId: node.id, ok: false, error: "缺少提示词：上游文本节点未填写内容" }
  }

  // 模型可用性強制探測（2026-08-15）：工作流節點提交前確認模型可用，
  // 避免把節點發給不可用渠道。探測失敗（unknown/網絡）不擋提交，
  // 防止探測端本身故障卡死整個工作流；明確 unavailable 才攔截。
  try {
    const msRes = await fetch(`${PLATFORM_BASE}/v1/model-status`, {
      headers: { Authorization: `Bearer ${session.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    const msData = await msRes.json().catch(() => null)
    const msEntry = msData?.models?.find((m: { id?: string }) => m?.id === model)
    if (msEntry && msEntry.availability === "unavailable") {
      const msNote = typeof msEntry.note === "string" ? msEntry.note : "渠道故障"
      console.error(`[workflow] node ${nodeId} model ${model} unavailable: ${msNote}`)
      return { nodeId: node.id, ok: false, error: `模型 ${model} 目前不可用（${msNote}）。请在画布上更换模型后重试该节点` }
    }
  } catch {
    // 探測端不可達時放行（unknown 語義），不阻擋工作流
  }

  let taskSubmitted = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 202 || (res.ok && (data?.task_id || data?.id))) {
      taskSubmitted = true
      const taskId = data?.task_id ?? data?.id
      const pollEndpoint = node.kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
      // 輪詢：間隔 3s；圖最多 120s、影片最多 300s（seedance 5 秒片可能排隊較久）
      // 2026-08-21（PM 要求）：預算按真實耗時放寬——實測 image 60-90s、kling 8s 影片 >300s
      // （Kling 標準模式約 2-6 分鐘）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 進度條：每 15s 推一次 elapsed/ETA（percent 封頂 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch: { status: "running", progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } },
          })
        }
        const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const pd = await poll.json().catch(() => ({}))
        if (pd?.status === "succeeded") {
          const rawUrl = pd?.data?.[0]?.url || pd?.result_url || pd?.url
          // 結果可能是相對 /v1/images/{id}/result，轉成絕對公開 URL（沿用 resolveResultUrl 語義）
          const url = rawUrl
            ? /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
            : ""
          if (url) return { nodeId: node.id, ok: true, content: url, costCoins: pd?.cost_coins }
          break
        }
        if (pd?.status === "failed") {
          console.error(`[workflow] node ${nodeId} generation failed: ${pd?.error?.message}`)
          return { nodeId: node.id, ok: false, error: pd?.error?.message || "generation failed" }
        }
        if (poll.status >= 400 && poll.status !== 404) {
          console.error(`[workflow] node ${nodeId} poll ${poll.status}: ${(pd as { error?: { message?: string } })?.error?.message}`)
          return { nodeId: node.id, ok: false, error: `poll ${poll.status}` }
        }
      }
    }
    // 同步回圖兜底
    const url = data?.data?.[0]?.url || data?.result_url || data?.url
    if (res.ok && url) return { nodeId: node.id, ok: true, content: url, costCoins: data?.cost_coins }
    if (taskSubmitted) {
      console.error(`[workflow] node ${nodeId} poll timeout`)
      return { nodeId: node.id, ok: false, error: "生成超时：平台排队过久，可在画布上稍后重试该节点" }
    }
    console.error(`[workflow] node ${nodeId} submit failed: ${JSON.stringify(data)}`)
    return { nodeId: node.id, ok: false, error: data?.error?.message || `submit ${res.status}` }
  } catch (e) {
    console.error(`[workflow] node ${nodeId} exception: ${(e as Error).message}`)
    return { nodeId: node.id, ok: false, error: (e as Error).message }
  }
}

// workflow 端點（不需 session）：列模板。
function workflowServiceTemplates(): Response {
  return Response.json({ ok: true, templates: workflowService.templates() })
}

// workflow 內部端點（loopback）：Deepseek 的 workflow_* 工具呼叫。
async function handleWorkflowInternal(req: Request, session: SessionState): Promise<Response> {
  const url = new URL(req.url)
  const pathname = url.pathname
  stateForWorkflow = session
  let body: Record<string, unknown> = {}
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return jsonError(400, "invalid json body", "bad_request", "bad_request")
    }
  }

  const wf = (id: unknown) => {
    const s = typeof id === "string" ? workflowService.get(id) : undefined
    return s
  }

  if (pathname.endsWith("/workflow/templates") && req.method === "GET") {
    return Response.json({ ok: true, templates: workflowService.templates() })
  }
  if (pathname.endsWith("/workflow/start") && req.method === "POST") {
    const templateId = typeof body.template_id === "string" ? body.template_id : null
    const content = body.content && typeof body.content === "object" ? (body.content as Record<string, unknown>) : {}
    const r = workflowService.start(templateId, content as never, session)
    return "error" in r ? jsonError(400, r.error, "missing_content", "missing_content") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/node") && req.method === "POST") {
    const r = workflowService.addNode(
      typeof body.workflow_id === "string" ? body.workflow_id : "",
      typeof body.role === "string" ? body.role : "node",
      typeof body.kind === "string" ? body.kind : "image",
      typeof body.title === "string" ? body.title : "节点",
      body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {},
    )
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/connect") && req.method === "POST") {
    const r = workflowService.connect(typeof body.workflow_id === "string" ? body.workflow_id : "", typeof body.from === "string" ? body.from : "", typeof body.to === "string" ? body.to : "")
    return "error" in r ? jsonError(400, r.error, "bad_request", "bad_request") : Response.json({ ok: true, ...r })
  }
  if (pathname.endsWith("/workflow/status") && req.method === "GET") {
    const wfid = url.searchParams.get("workflow_id")
    const st = wf(wfid)
    return st ? Response.json({ ok: true, workflow: workflowService.status(wfid!) }) : jsonError(404, "workflow not found", "not_found", "not_found")
  }
  if (pathname.endsWith("/workflow/generate") && req.method === "POST") {
    const wfid = typeof body.workflow_id === "string" ? body.workflow_id : ""
    if (!workflowService.get(wfid)) return jsonError(404, "workflow not found", "not_found", "not_found")
    // 後台執行：立即回 running，每個節點結果以 canvas.* 事件推送到畫布（agent 不阻塞等待）。
    void workflowService.generate(wfid).then((r) => {
      if (!r.ok) console.error(`[workflow] ${wfid} finished: ${r.status}`)
    })
    return Response.json({ ok: true, status: "running" })
  }
  return jsonError(404, "not found", "not_found", "not_found")
}

function openEventStream(state: SessionState, lastEventId?: number, req?: Request): Response {
  let client: SSEClient | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = { controller }
      state.clients.add(client)
      controller.enqueue(encoder.encode(`event: connected\ndata: {"ok":true}\n\n`))
      if (typeof lastEventId === "number" && !Number.isNaN(lastEventId)) {
        for (const frame of state.replayBuffer) {
          if (frame.id > lastEventId) {
            controller.enqueue(frame.frame.slice())
          }
        }
      }
      void hydratePendingQuestions(state)
    },
    cancel() {
      if (client) state.clients.delete(client)
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
      ...corsHeaders(corsOriginFor(req?.headers.get("origin") ?? null)),
    },
  })
}

// ---- opencode event translation -> frontend events ----

// sessionID lives in different properties depending on event type:
//   session.*            -> properties.sessionID
//   message.updated      -> properties.sessionID AND properties.info.sessionID
//   message.part.updated -> properties.part.sessionID (NO properties.sessionID)
//   message.part.delta   -> properties.sessionID
function eventSessionId(event: any): string | undefined {
  const p = event?.properties
  return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
}

function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

// Text parts carry no role, so the only way to tell the assistant's reply from
// the user's own prompt is the messageID -> role map built from message.updated.
// Unknown messageID => false: message.updated for a message always precedes its
// parts, so an unknown id means something is off and dropping is the safe side.
function isAssistantMessage(state: SessionState, messageID: unknown): boolean {
  if (typeof messageID !== "string" || messageID.length === 0) return false
  return state.messageRole.get(messageID) === "assistant"
}

// tool state.output arrives as a JSON string (e.g. an HTTP 401 with ok:false).
// Parse defensively; malformed/absent output yields null so callers fall back to
// ok:false instead of throwing.
function parseToolOutput(
  output: unknown,
): { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown } | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object") {
        return parsed as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
      }
      return null
    } catch {
      return null
    }
  }
  if (output && typeof output === "object") {
    return output as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
  }
  return null
}

// Shared image.done emission path, deduped per session by url (bounded Set, cap
// 100, evict oldest). Both the opencode tool-result translation and the
// /internal/emit entry point go through here, so the same image can never be
// announced twice to the frontend in one session.
// The platform hands back /v1/images/<id>/result — relative, Bearer-authed, and
// a 302 to a public store.tinchak0207.xyz .webp. An <img src> can send neither a
// host nor an auth header, and the frontend must never hold a backend key, so
// that URL is unrenderable as-is. Resolve the redirect here, server-side, and
// publish the terminal public URL instead.
//
// Verified 2026-08-07: GET the result path with the session key -> 302; Location
// is an unsigned, query-less, publicly readable image/webp (200 without auth).
// Because it carries no signature there is nothing to expire or leak.
async function resolveResultUrl(rawUrl: string, key: string): Promise<string> {
  if (!rawUrl) return rawUrl
  // Already a public asset URL (poller/tool may hand one over directly).
  if (/^https?:\/\//i.test(rawUrl) && !/\/v1\/images\/[^/]+\/result\/?$/.test(rawUrl)) return rawUrl
  const absolute = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
  // 平台 /v1/images/{id}/result 預設回 JSON，帶 ?format=redirect 才 302 到公開 blob URL。
  const target = /\/v1\/images\/[^/]+\/result\/?$/.test(absolute) ? absolute + "?format=redirect" : absolute
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    })
    const loc = res.headers.get("location")
    if (loc && /^https?:\/\//i.test(loc)) return loc
    // Some deployments may serve the bytes directly instead of redirecting; the
    // absolute URL is then still wrong for the frontend, but it is the best we
    // have and at least names the right host.
    return absolute
  } catch {
    return absolute
  }
}

async function emitImageDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
): Promise<void> {
  if (!url) return
  // Dedup on the RAW url: the same task resolved twice yields two different
  // public URLs only if the platform regenerates, but the raw form is stable.
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  const publicUrl = await resolveResultUrl(url, state.apiKey)
  emitToSession(state, "image.done", { url: publicUrl, cost_coins, task_id })
  // 自動製畫布：task 掛過 unit 就更新該 unit 的結果圖片節點。
  if (task_id) {
    emitCanvasResult(state, task_id, publicUrl, cost_coins)
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: "done",
    task_id,
    cost_coins,
    result_url: publicUrl,
  })
  void emitQuotaChanged(state)
}

// ---- 自動製畫布（Auto Canvas Builder） ----
//
// 暴君立場：deepseek 不「思考」畫布的事。它只提交生圖/改圖請求，
// gateway 攔截每個 image_* 工具的參數與結果，自動在畫布上重現：
//   文本節點(prompt) → 配置節點(model/size/n) → [執行] → 圖片節點(結果)
// 每次請求建立一個「畫布單元」(unit)，unit 內節點用相同 unit_id 前綴，
// 前端以 unit_id 關聯成組；task_id 掛在同一 unit 上，完成時更新該組。

function canvasUnitId(): string {
  return `cu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
}

function summarizeCanvasTitle(model: string, prompt: string): string {
  const m = model || "生成"
  const p = prompt.trim().slice(0, 18)
  return p ? `${m} · ${p}${prompt.trim().length > 18 ? "…" : ""}` : m
}

// 從工具 input 抽取生成參數（deepseek 送哪欄就用哪欄，缺失給安全預設）。
function readGenerateInput(input: unknown): {
  prompt: string
  model: string
  size: string
  n: number
  kind: string
  quality?: string
  image?: string // edit/upscale 的來源 mediaId/URL
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const prompt =
    typeof obj.prompt === "string"
      ? obj.prompt
      : typeof obj.content === "string"
        ? obj.content
        : ""
  const model = typeof obj.model === "string" && obj.model ? obj.model : "gpt-image-2"
  const size = typeof obj.size === "string" && obj.size ? obj.size : "1024x1024"
  const nNum = typeof obj.n === "number" ? obj.n : typeof obj.count === "number" ? obj.count : 1
  const n = Number.isFinite(nNum) ? Math.max(1, Math.min(15, Math.floor(nNum))) : 1
  const kind = typeof obj.kind === "string" && obj.kind === "video" ? "video" : "image"
  const quality = typeof obj.quality === "string" ? obj.quality : undefined
  const image = typeof obj.image === "string" && obj.image ? obj.image : undefined
  return { prompt, model, size, n, kind, quality, image }
}

// 建立一個畫布單元並 emit 節點/連線事件。回傳 unit id。
function autoCreateCanvasUnit(
  state: SessionState,
  toolName: string,
  input: unknown,
  callID: string,
): string {
  const cfg = readGenerateInput(input)
  const unitId = canvasUnitId()

  // 計畫卡：一句話讓暴君知道他會被怎麼對待。
  const planLabel =
    toolName === "image_edit"
      ? "改圖（圖生圖）"
      : toolName === "image_upscale"
        ? "放大"
        : toolName === "image_generate"
          ? cfg.kind === "video"
            ? "生影片"
            : "生圖"
          : "生成"
  emitToSession(state, "canvas.plan", {
    unit_id: unitId,
    tool: toolName,
    label: planLabel,
    prompt: cfg.prompt,
    model: cfg.model,
    size: cfg.size,
    count: cfg.n,
    kind: cfg.kind,
    source_image: cfg.image ?? null,
    cost_hint: null,
  })

  // 文本節點：承載 prompt（source_image 存在時併入提示，編輯語義）。
  const textNode = {
    id: `${unitId}-text`,
    type: "text",
    title: summarizeCanvasTitle(cfg.model, cfg.prompt),
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      content: cfg.prompt,
      status: "idle",
      source_image: cfg.image ?? (toolName === "image_edit" || toolName === "image_upscale" ? cfg.image ?? null : null),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: textNode })

  // 配置節點：model/size/n/kind。
  const configNode = {
    id: `${unitId}-config`,
    type: "config",
    title: `${cfg.model} · ${cfg.size}`,
    position: { x: 0, y: 0 },
    width: 440,
    height: 240,
    metadata: {
      content: "",
      status: "idle",
      model: cfg.model,
      size: cfg.size,
      count: cfg.n,
      kind: cfg.kind,
      ...(cfg.quality ? { quality: cfg.quality } : {}),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: configNode })

  // 連線：文本 → 配置。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id },
  })

  // 預留圖片節點（結果落地時更新同一節點）。
  const imageNode = {
    id: `${unitId}-image`,
    type: "image",
    title: "生成中…",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "", status: "loading" },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: imageNode, target_kind: "result" })
  // 連線：配置 → 圖片。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id },
    target_kind: "result",
  })

  state.canvasUnitByCall.set(callID, unitId)
  boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
  return unitId
}

// 為已建立的 unit 掛上 task_id（submit 完成階段），供結果更新。
function attachCanvasTask(state: SessionState, callID: string, taskId: string, unitId?: string): void {
  const target = unitId ?? state.canvasUnitByCall.get(callID)
  if (!target || !taskId) return
  state.canvasUnitByTask.set(taskId, target)
  boundMap(state.canvasUnitByTask, TOOL_STATUS_DEDUP_CAP)
}

// task_id → unit 存在時，emit 完成事件；返回命中與否。
function emitCanvasResult(
  state: SessionState,
  taskId: string,
  url: string,
  cost_coins?: number,
): boolean {
  const unitId = state.canvasUnitByTask.get(taskId)
  if (!unitId) return false
  emitToSession(state, "canvas.node.updated", {
    unit_id: unitId,
    node_id: `${unitId}-image`,
    patch: { status: "success", content: url, ...(typeof cost_coins === "number" ? { cost_coins } : {}) },
    url,
    cost_coins,
  })
  return true
}

function handleToolPartUpdate(state: SessionState, part: any): void {
  const toolName = typeof part?.tool === "string" ? part.tool : ""
  const callId = typeof part?.callID === "string" ? part.callID : ""
  const st = part?.state
  if (!st || typeof st !== "object") return
  const status = typeof st.status === "string" ? st.status : ""
  if (!callId || !status) return

  // Dedup by callID + status so a repeated identical status does not re-emit.
  const dedupKey = `${callId}:${status}`
  if (state.toolStatusSeen.has(dedupKey)) return
  state.toolStatusSeen.add(dedupKey)
  boundSet(state.toolStatusSeen, TOOL_STATUS_DEDUP_CAP)

if (status === "pending" || status === "running") {
    // question is not a generic running tool. The agent is blocked on a
    // que_* request; emit question.request so the frontend can reply.
    if (toolName === "question") {
      void emitQuestionRequest(state, callId, st.input)
      return
    }
    // 只在拿到工具輸入後才發 invoke。opencode 的 pending 狀態常只有
    // {status:"pending"} 而沒有 input；等 running（input 完整）再發，
    // 前端工具卡才顯示得出「在做什麼」，不是黑盒。
    const argsSummary = summarizeArgs(st.input)
    if (state.toolInvokeSeen.has(callId)) return
    if (!argsSummary && status === "pending") return
    state.toolInvokeSeen.add(callId)
    boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
    emitToSession(state, "tool.invoke", {
      tool: toolName,
      args_summary: argsSummary,
    })
    // 自動製畫布：image_* 工具首次建立畫布單元。deepseek 完全不知道——
    // 它只是提交請求，gateway 攔截參數自動建文本/配置/圖片節點。
    if (toolName.startsWith("image_") && !state.canvasUnitByCall.has(callId) && st.input != null) {
      autoCreateCanvasUnit(state, toolName, st.input, callId)
    }
  } else if (status === "completed") {
    // 若 running 階段因 input 缺失沒發過 invoke，這裡補發一次（completed 的
    // input 一定完整），確保前端工具卡必定有說明、不黑盒。
    if (!state.toolInvokeSeen.has(callId) && st.input != null) {
      state.toolInvokeSeen.add(callId)
      boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
      emitToSession(state, "tool.invoke", {
        tool: toolName,
        args_summary: summarizeArgs(st.input),
      })
      // 同上：跑到 completed 才見到 input 的工具（理論上不會，但保險起見）。
      if (toolName.startsWith("image_") && !state.canvasUnitByCall.has(callId)) {
        autoCreateCanvasUnit(state, toolName, st.input, callId)
      }
    }
    const parsed = parseToolOutput(st.output)
    // 只認明確帶 ok 欄位的結構化輸出；沒有 ok 欄位（原生工具文字輸出）一律視為成功。
    const hasOkFlag = parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean"
    const ok = hasOkFlag ? (parsed as { ok: boolean }).ok === true : true
    if (toolName.startsWith("image_")) {
      // 自動製畫布：submit 完成後把 task_id 掛回 unit，完成事件才夠關聯。
      if (ok && typeof parsed?.task_id === "string" && parsed.task_id) {
        attachCanvasTask(state, callId, parsed.task_id)
      }
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        cost_coins: typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined,
      })
      if (ok && typeof parsed?.url === "string" && parsed.url.length > 0) {
        void emitImageDone(state, parsed.url, parsed.cost_coins, parsed.task_id)
      }
    } else {
      emitToSession(state, "tool.result", { tool: toolName, ok: true })
      // 原生工具（bash 等）可能回傳的是「含圖片 URL 的 JSON」——例如引擎用
      // bash 呼叫 kotone-bridge 生圖，輸出 {text, images:[{url,...}]}。這類
      // 結果也要送 image.done，前端右側展示框才會顯示圖片（否則只有泡泡文字）。
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { images?: unknown }).images)) {
        const imgs = (parsed as { images: { url?: string; width?: number; height?: number }[] }).images
        for (const im of imgs) {
          if (typeof im?.url === "string" && im.url.length > 0) {
            void emitImageDone(state, im.url)
          }
        }
      }
    }
  } else if (status === "error") {
    emitToSession(state, "tool.result", { tool: toolName, ok: false })
    const err = st.error
    const message =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "tool failed"
    emitSessionError(state, "tool_error", message)
  }
}

function handleOpencodeEvent(event: any): void {
  try {
    const opencodeSessionId = eventSessionId(event)
    if (!opencodeSessionId) return
    const state = findSessionByOpenCodeId(opencodeSessionId)
    if (!state) return

    // session.error (if it ever appears) or any event carrying properties.error.
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      emitSessionError(state, opencodeErrorCode(err), opencodeErrorMessage(err))
      return
    }

    switch (event?.type) {
      case "message.updated": {
        // The ONLY place a role appears. message.part.updated carries no role at
        // all (verified: part keys are id/messageID/sessionID/text/type), so
        // without this map the user's own prompt — which arrives as a text part
        // on a user-role message — gets echoed back as assistant output.
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        if (mid && role) {
          state.messageRole.set(mid, role)
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        break
      }
      case "message.part.delta": {
        const p = event.properties ?? {}
        // A delta says nothing about its part's type, and reasoning parts also
        // append to a "text" field — so field==="text" alone would stream chain
        // of thought to the UI. suppressedParts is populated from the
        // message.part.updated that always precedes a part's deltas (verified by
        // raw capture: part.updated -> delta -> delta).
        // NOTE 2026-08-11: 產品要顯示思維鏈，reasoning part 不再丟棄 —— 改發
        // reasoning.delta 事件（同 shape，前端 reducer 累積到 assistant.reasoning）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0 && isAssistantMessage(state, p.messageID)) {
          if (typeof p.partID === "string" && state.suppressedParts.has(p.partID)) {
            emitToSession(state, "reasoning.delta", { text: p.delta })
            break
          }
          emitToSession(state, "message.delta", { text: p.delta })
          if (typeof p.partID === "string") {
            const rec = state.partTextEmitted.get(p.partID)
            if (rec) {
              rec.emittedLen += p.delta.length
            } else {
              state.partTextEmitted.set(p.partID, { emittedLen: p.delta.length })
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
          }
        }
        break
      }
      case "message.part.updated": {
        const part = event?.properties?.part
        if (!part || typeof part !== "object") break
        switch (part.type) {
          case "text": {
            const full = typeof part.text === "string" ? part.text : ""
            const id = typeof part.id === "string" ? part.id : ""
            if (full.length === 0 || !id) break
            // Drop unless we know this belongs to an assistant message. Losing a
            // frame is recoverable; echoing the user's own prompt back as AI
            // output is not.
            if (!isAssistantMessage(state, part.messageID)) break
            const rec = state.partTextEmitted.get(id) ?? { emittedLen: 0 }
            // part.text is the cumulative full text; deltas already covered the
            // prefix, so only emit the un-emitted suffix. A part that never
            // produced deltas has emittedLen 0 and emits its full text once.
            if (full.length > rec.emittedLen) {
              emitToSession(state, "message.delta", { text: full.slice(rec.emittedLen) })
              rec.emittedLen = full.length
              state.partTextEmitted.set(id, rec)
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
            break
          }
          case "tool":
            handleToolPartUpdate(state, part)
            break
          case "step-finish": {
            const cost = typeof part.cost === "number" ? part.cost : 0
            const msgId = typeof part.messageID === "string" ? part.messageID : undefined
            if (cost > 0 && msgId && !state.stepCostLogged.has(msgId)) {
              state.stepCostLogged.add(msgId)
              boundSet(state.stepCostLogged, STEP_COST_LOG_CAP)
              // Agent-model cost — never surfaced to the user as a charge.
              console.debug(`[gateway] step-finish: agent cost ${cost} (message ${msgId})`)
            }
            break
          }
          case "reasoning":
          default: {
            // reasoning/step-start and unknown part types never reach the
            // frontend. Record the partID so its deltas are dropped too — the
            // delta event carries no type of its own.
            const pid = typeof part.id === "string" ? part.id : ""
            if (pid) {
              state.suppressedParts.add(pid)
              boundSet(state.suppressedParts, SUPPRESSED_PART_CAP)
            }
            break
          }
        }
        break
      }
      case "session.idle": {
        // End-of-turn signal: stop the frontend typing indicator and drop the
        // per-partID delta tracking for this turn to bound memory.
        // messageRole and toolInvokeSeen are deliberately NOT cleared: a late
        // part or duplicate status for this turn would otherwise be treated as
        // unknown-role (dropped) or as a fresh call (re-emitted). Both are
        // capped, so they stay bounded without clearing.
        state.partTextEmitted.clear()
        state.stepCostLogged.clear()
        emitToSession(state, "turn.done", {})
        // 回合結束是滾動摘要壓縮的觸發點：此刻無在途生成、訊息數穩定。
        void maybeCompactSession(state)
        break
      }
      default:
        // session.updated / session.status / session.diff / session.created /
        // server.heartbeat / server.connected -> no frontend event
        break
    }
  } catch (e) {
    // Never let one malformed event kill the SSE reader loop. Log the event type
    // only — never the payload (tool inputs may contain user prompts).
    console.error(`[gateway] opencode event translation failed: type=${event?.type}`)
  }
}

function connectOpencode(): void {
  const url = `${OPENCODE_URL}/event`
  void (async () => {
    while (true) {
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: "Basic " + btoa("opencode:" + OPENCODE_PASSWORD),
            Accept: "text/event-stream",
          },
        })
        if (!res.ok || !res.body) {
          console.error(`[gateway] opencode SSE connect failed: status=${res.status}`)
          await sleep(2000)
          continue
        }
        console.log(`[gateway] opencode SSE connected: ${url}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
          let sep: number
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            let dataStr = ""
            for (const line of chunk.split("\n")) {
              const t = line.trim()
              if (t.startsWith("data:")) {
                dataStr += (dataStr ? "\n" : "") + t.slice(5).replace(/^ /, "")
              }
            }
            if (!dataStr || dataStr === "[DONE]") continue
            try {
              handleOpencodeEvent(JSON.parse(dataStr))
            } catch {
              // malformed event, skip
            }
          }
        }
        console.error(`[gateway] opencode SSE stream ended`)
      } catch (e) {
        console.error(`[gateway] opencode SSE error: ${e}`)
      }
      await sleep(2000)
    }
  })()
}

// ---- public handlers ----

async function handleCreateSession(key: string, req: Request): Promise<Response> {
  // L0 账户级记忆：编辑层在本站读取 user_profiles/agent_lessons 后随创建上送，
  // 网关只负责暂存，首条消息时注入 system。
  let memoryBody: { user_profile?: Record<string, unknown>; lessons?: string[] } = {}
  try {
    const raw = (await req.json()) as { user_profile?: Record<string, unknown>; lessons?: string[] } | null
    if (raw && typeof raw === "object") memoryBody = raw
  } catch {
    memoryBody = {}
  }

  let res: Response
  try {
    res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!res.ok) {
    return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
  }
  let body: { id?: string }
  try {
    body = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode returned an invalid create-session response", "backend_error", "backend_error")
  }
  if (!body.id) {
    return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")
  }
  const sessionId = crypto.randomUUID()
  const state: SessionState = {
    sessionId,
    apiKey: key,
    opencodeSessionId: body.id,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
    partTextEmitted: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    vettingInjected: false,
    userMemory:
      memoryBody.user_profile && Object.keys(memoryBody.user_profile).length > 0
        ? { user_profile: memoryBody.user_profile, lessons: memoryBody.lessons ?? [] }
        : undefined,
    memoryInjected: false,
  }
  sessions.set(sessionId, state)
  saveSession(state) // 建立即同步落盤：重啟後 getOwnedSession 可恢復
  const user_id = await hashKey(key)
  console.log(`[gateway] session created: ${sessionId} (opencode ${body.id})`)
  return Response.json({ session_id: sessionId, user_id })
}

async function handleSendMessage(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { content?: string; canvas_state?: unknown }
  try {
    body = (await req.json()) as { content?: string; canvas_state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) return jsonError(400, "content is required", "bad_request", "bad_request")
  // 前端附帶的畫布摘要：存入 session，供 canvas_summary 工具讀取。
  // 同一 session 的畫布狀態隨每次新訊息更新；摘要本身不進 opencode 歷史，
  // 避免 token 膨脹——agent 需要時才透過工具讀。
  if (body.canvas_state !== undefined) {
    state.canvasSummary = body.canvas_state
    state.canvasSummaryAt = Date.now()
    markDirty(state) // 畫布摘要持久化：重啟後 canvas 工具仍讀得到
  }
  // prompt_async returns 204 immediately and the reply arrives over the /event
  // SSE stream. POST /session/:id/message is SYNCHRONOUS — it blocks until the
  // model finishes (30s+), which blew the 10s timeout and made this handler
  // return 502 even though the agent had actually run.
  // 首次訊息時夾帶 system 欄位注入「意圖審查」政策：要求 agent 對用戶意圖
  // 信度不足時先反覆驗證、主動用 question 工具澄清，不可擅自揣測意圖產出。
  // system 欄位會記入 opencode user message 的 info.system，實際影響模型輸出。
  const promptBody: { parts: { type: string; text: string }[]; system?: string } = {
    parts: [{ type: "text", text: content }],
  }
  if (!state.vettingInjected) {
    const vettingLines = [
      "這是圖像影片製作助手。用戶可能描述不清楚，或意圖與表面字句不符。",
      "在動手執行任何生圖/改圖/影片任務前，先判斷自己對用戶意圖的理解信度：",
      "1. 若信度低（含糊、多種合理解讀、關鍵參數缺失、用戶前文有矛盾），先用 question 工具向用戶澄清，不要擅自選定一種解讀就埋頭產出。",
      "2. 澄清問題要具體、附上可選項（如尺寸/風格/主體/數量），一次問透，減少來回。",
      "3. 信度足夠高才直接執行；執行時若發現與用戶描述衝突，停下來重問。",
    ].join("\n")
    const memoryLines: string[] = []
    // L0 账户级记忆：首条消息带上用户画像 + 教训，模型开聊就认识用户。
    if (state.userMemory) {
      const up = state.userMemory.user_profile
      if (Object.keys(up).length > 0) {
        const fields = Object.entries(up)
          .map(([k, v]) => {
            const val = Array.isArray(v) ? v.join("、") : String(v ?? "")
            return `- ${k}: ${val}`
          })
          .join("\n")
        memoryLines.push(`以下是这个账户已确认的画像（来自之前的会话）：\n${fields}`)
      }
      if ((state.userMemory.lessons ?? []).length > 0) {
        memoryLines.push(`以下是这个账户从过往合作中提炼的教训（已被确认）：\n${(state.userMemory.lessons ?? []).map((l) => `- ${l}`).join("\n")}`)
      }
    }
    promptBody.system = [vettingLines, ...(memoryLines.length > 0 ? memoryLines : [])].join("\n\n")
    state.vettingInjected = true
    state.memoryInjected = true
    markDirty(state) // 注入標記持久化：重啟後不重複注入 system（避免 token 膨脹）
  }
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(promptBody),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode send message failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  return Response.json({ session_id: id }, { status: 202 })
}

// ---- 滾動摘要壓縮（rolling summary via opencode native summarize）----
// 訊息歷史的 owner 是 opencode：壓縮直接用它的 AI compaction 端點
// POST /session/:id/summarize（已實測：生成 summary 訊息 + compaction part，
// 模型後續上下文以摘要為準；舊訊息仍留在存儲供前端展示與 GET history 端點讀取）。
// 不在 gateway 另存一份 messages —— 那是第二份會漂移的歷史副本。
// 防抖兩層：in-memory in-flight Set（一次壓縮完成前不重複觸發）+ 持久化水位
// compact.lastCount（自上次壓縮新增不足半個閾值不觸發，重啟後水位仍在）。
const SESSION_COMPACT_THRESHOLD = Number.parseInt(process.env.SESSION_COMPACT_THRESHOLD || "40", 10) || 40
const SESSION_COMPACT_MIN_NEW = Math.max(4, Math.floor(SESSION_COMPACT_THRESHOLD / 2))
const SESSION_COMPACT_TIMEOUT_MS = 180_000
const compactionInFlight = new Set<string>()

async function maybeCompactSession(state: SessionState): Promise<void> {
  if (compactionInFlight.has(state.sessionId)) return
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; model?: { providerID?: string; modelID?: string } }
    }>
    if (!Array.isArray(msgs)) return
    const count = msgs.length
    if (count < SESSION_COMPACT_THRESHOLD) return
    const lastCount = state.compact?.lastCount ?? 0
    if (count - lastCount < SESSION_COMPACT_MIN_NEW) return
    // summarize 需要 providerID+modelID：取最近一條帶 model 資訊的訊息（與該會話實際模型一致）。
    let providerID: string | undefined
    let modelID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]?.info?.model
      if (m?.providerID && m?.modelID) {
        providerID = m.providerID
        modelID = m.modelID
        break
      }
    }
    if (!providerID || !modelID) {
      console.warn(`[gateway] compact skipped: no model info in session ${state.sessionId}`)
      return
    }
    compactionInFlight.add(state.sessionId)
    try {
      const r = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/summarize`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify({ providerID, modelID }),
        signal: AbortSignal.timeout(SESSION_COMPACT_TIMEOUT_MS),
      })
      if (r.ok) {
        state.compact = { lastCount: count, at: Date.now() }
        markDirty(state)
        console.log(`[gateway] session compacted: ${state.sessionId} (${count} messages -> summary)`)
      } else {
        console.warn(`[gateway] session compact failed: ${state.sessionId} status=${r.status}`)
      }
    } finally {
      compactionInFlight.delete(state.sessionId)
    }
  } catch (e) {
    console.warn(`[gateway] session compact error for ${state.sessionId}: ${e}`)
    compactionInFlight.delete(state.sessionId)
  }
}

function handleEventStream(key: string, id: string, req: Request): Response {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let lastEventId: number | undefined
  const raw = req.headers.get("last-event-id")
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (!Number.isNaN(n)) lastEventId = n
  }
  return openEventStream(state, lastEventId, req)
}

async function handleConfirm(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { request_id?: string; approved?: boolean }
  try {
    body = (await req.json()) as { request_id?: string; approved?: boolean }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = body.request_id
  if (!requestId) return jsonError(400, "request_id is required", "bad_request", "bad_request")
  // 404, not 200 {ok:false}: an unknown request_id means the confirm already
  // expired, was already answered, or never existed. Returning 200 made those
  // indistinguishable from success, so a frontend that lost the race would
  // show "confirmed" while the tool had actually been cancelled.
  if (!state.pendingConfirms.has(requestId)) {
    return jsonError(404, "confirm request unknown or already resolved", "not_found", "confirm_expired")
  }
  // settleConfirm emits confirm.resolved, writes the ledger and refreshes quota.
  // The tool learns the answer from its own poll, not from this response.
  settleConfirm(state, requestId, body.approved ? "approved" : "denied")
  return Response.json({ ok: true })
}

function normalizeQuestionOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ label: string; description?: string }> = []
  for (const opt of raw) {
    if (!opt || typeof opt !== "object") continue
    const rec = opt as Record<string, unknown>
    const label = typeof rec.label === "string" ? rec.label.trim() : ""
    if (!label) continue
    const description = typeof rec.description === "string" ? rec.description : undefined
    out.push(description ? { label, description } : { label })
  }
  return out
}

function normalizeQuestionItems(raw: unknown): PendingQuestion["questions"] {
  if (!Array.isArray(raw)) return []
  const out: PendingQuestion["questions"] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const question = typeof rec.question === "string" ? rec.question.trim() : ""
    if (!question) continue
    const header = typeof rec.header === "string" ? rec.header : undefined
    const options = normalizeQuestionOptions(rec.options)
    out.push(header ? { question, header, options } : { question, options })
  }
  return out
}

function isQuestionAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" && cell.length > 0))
}

async function lookupOpencodeQuestion(state: SessionState, callId: string): Promise<{ id: string; questions: PendingQuestion["questions"] } | null> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `${OPENCODE_URL}/question`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: opencodeHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const payload = await res.json()
      const list = Array.isArray(payload) ? payload : []
      for (const item of list) {
        if (!item || typeof item !== "object") continue
        const rec = item as Record<string, unknown>
        const id = typeof rec.id === "string" ? rec.id : ""
        if (!id.startsWith("que")) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const toolCallId = typeof tool?.callID === "string" ? tool.callID : ""
        const sessionID = typeof rec.sessionID === "string" ? rec.sessionID : ""
        if (toolCallId && toolCallId !== callId) continue
        if (sessionID && sessionID !== state.opencodeSessionId) continue
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        return { id, questions }
      }
    } catch {
      // try the next lookup path
    }
  }
  return null
}

async function emitQuestionRequest(state: SessionState, callId: string, input: unknown): Promise<void> {
  if (!callId) return
  for (const pending of state.pendingQuestions.values()) {
    if (pending.callId === callId) return
  }
  let lookedUp = await lookupOpencodeQuestion(state, callId)
  for (let attempt = 0; attempt < 8 && !lookedUp?.id; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    lookedUp = await lookupOpencodeQuestion(state, callId)
  }
  const fallbackQuestions = normalizeQuestionItems((input as { questions?: unknown } | null)?.questions)
  const requestId = lookedUp?.id ?? ""
  const questions = lookedUp?.questions?.length ? lookedUp.questions : fallbackQuestions
  if (!requestId || questions.length === 0) {
    console.warn(`[gateway] question tool ${callId} has no que_* request yet`)
    if (state.toolStatusSeen.has(`${callId}:running`)) state.toolStatusSeen.delete(`${callId}:running`)
    if (state.toolStatusSeen.has(`${callId}:pending`)) state.toolStatusSeen.delete(`${callId}:pending`)
    return
  }
  if (state.pendingQuestions.has(requestId)) return
  state.pendingQuestions.set(requestId, { requestId, callId, questions })
  emitToSession(state, "question.request", { request_id: requestId, questions })
}

async function hydratePendingQuestions(state: SessionState): Promise<void> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `${OPENCODE_URL}/question`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: opencodeHeaders(),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) continue
      const payload = await res.json()
      const list = Array.isArray(payload) ? payload : []
      for (const item of list) {
        if (!item || typeof item !== "object") continue
        const rec = item as Record<string, unknown>
        const id = typeof rec.id === "string" ? rec.id : ""
        if (!id.startsWith("que")) continue
        const sessionID = typeof rec.sessionID === "string" ? rec.sessionID : ""
        if (sessionID && sessionID !== state.opencodeSessionId) continue
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        if (state.pendingQuestions.has(id)) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const callId = typeof tool?.callID === "string" ? tool.callID : ""
        state.pendingQuestions.set(id, { requestId: id, callId, questions })
        emitToSession(state, "question.request", { request_id: id, questions })
      }
      return
    } catch {
      // try the next lookup path
    }
  }
}

async function rejectOpencodeQuestion(requestId: string, sessionId: string): Promise<void> {
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
    `${OPENCODE_URL}/question/${encodeURIComponent(requestId)}/reject`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opencodeHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok || res.status === 404) return
    } catch {
      // best-effort
    }
  }
}

async function handleQuestion(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { request_id?: string; answers?: unknown }
  try {
    body = (await req.json()) as { request_id?: string; answers?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : ""
  if (!requestId || !requestId.startsWith("que")) {
    return jsonError(400, "request_id is required", "bad_request", "bad_request")
  }
  if (!isQuestionAnswers(body.answers)) {
    return jsonError(400, "answers is required", "bad_request", "bad_request")
  }
  if (!state.pendingQuestions.has(requestId)) {
    return jsonError(404, "question request unknown or already resolved", "not_found", "question_expired")
  }
  const urls = [
    `${OPENCODE_URL}/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `${OPENCODE_URL}/question/${encodeURIComponent(requestId)}/reply`,
  ]
  let lastStatus = 0
  let lastText = ""
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify({ answers: body.answers }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        state.pendingQuestions.delete(requestId)
        const first = body.answers.flat().find((cell) => cell.length > 0) ?? ""
        emitToSession(state, "question.replied", { request_id: requestId, answer: first })
        return Response.json({ ok: true })
      }
      lastStatus = res.status
      lastText = await res.text().catch(() => "")
      if (res.status !== 404) break
    } catch (err) {
      lastText = err instanceof Error ? err.message : "upstream unreachable"
    }
  }
  return jsonError(lastStatus >= 400 ? lastStatus : 502, lastText || "failed to reply to question", "backend_error", "backend_error")
}

// Best-effort upstream cleanup. Shared by the explicit DELETE route and the
// idle reaper so a reaped session never leaves an orphan opencode session
// behind (each one holds its own message history on disk).
async function deleteOpencodeSession(opencodeSessionId: string): Promise<void> {
  try {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // best-effort: an orphan upstream session is not worth failing a request over
  }
}

// Drop a session from the map, resolve anything still waiting on it, and close
// its streams. Shared teardown for DELETE and the reaper.
function teardownSession(id: string, state: SessionState, reason: string): void {
  sessions.delete(id)
  dirtySessions.delete(id)
  deleteSessionRow(id) // 持久化鏡像：teardown（DELETE / idle reap）同步刪 row
  revokeSseTicketsFor(id) // a ticket must not outlive the session it names
  // A pending spend must never auto-approve on teardown. Record the denial
  // rather than just dropping it: a tool still polling has to be able to read
  // the answer, and after teardown this state object is all that is left.
  for (const [requestId, pending] of state.pendingConfirms) {
    clearTimeout(pending.timer)
    state.resolvedConfirms.set(requestId, { outcome: "denied", resolvedAt: Date.now() })
    emitToSession(state, "confirm.resolved", { request_id: requestId, approved: false })
  }
  state.pendingConfirms.clear()
  for (const [requestId] of state.pendingQuestions) {
    emitToSession(state, "question.rejected", { request_id: requestId, reason: reason || "session_closed" })
    void rejectOpencodeQuestion(requestId, state.opencodeSessionId)
  }
  state.pendingQuestions.clear()
  emitToSession(state, "session.closed", { reason })
  closeSessionStreams(state)
}

async function handleDeleteSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  teardownSession(id, state, "deleted")
  await deleteOpencodeSession(state.opencodeSessionId)
  const delUploadDir = path.join(UPLOADS_DIR, state.sessionId)
  if (existsSync(delUploadDir)) {
    void rm(delUploadDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.error(`[gateway] upload cleanup error for ${id}:`, e)
    })
  }
  console.log(`[gateway] session deleted: ${id}`)
  return Response.json({ ok: true })
}

// GET /agent/v1/sessions/:id — 會話恢復端點（重啟後歷史仍在的讀取路徑）。
// 歷史從 opencode（權威存儲）讀取；getOwnedSession 內含 DB lazy reload，
// 因此進程重啟後仍可解析。只讀，不改任何狀態、不動 CORS/SSE/ticket 行為。
async function handleGetSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // upstream opencode session 已不在（被外部清理等）：仍回會話元數據，標記歷史不可用。
      return Response.json({
        session_id: id,
        opencode_session_id: state.opencodeSessionId,
        history_available: false,
        message_count: 0,
        messages: [],
      })
    }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; time?: { created?: number } }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const messages = (Array.isArray(msgs) ? msgs : []).map((m) => ({
      role: m.info?.role ?? "unknown",
      created_at: m.info?.time?.created ?? null,
      text: (m.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .slice(0, 20_000),
      has_tool_parts: (m.parts ?? []).some((p) => p.type === "tool"),
    }))
    return Response.json({
      session_id: id,
      opencode_session_id: state.opencodeSessionId,
      history_available: true,
      message_count: messages.length,
      messages,
    })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
}

// Force-stop the in-flight assistant turn on the opencode side. This is a real
// system-level cancel (not a soft "please stop" prompt): the running turn is
// terminated immediately, no further tools run, no more money is spent.
async function handleAbortSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/abort`, {
      method: "POST",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode abort failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  return Response.json({ ok: true })
}

function extractBalance(data: unknown): number | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof obj[k] === "number") return obj[k]
    }
    if (obj.data && typeof obj.data === "object") return extractBalance(obj.data)
  }
  return null
}

// The platform exposes no balance endpoint yet (/v1/quota, /v1/balance,
// /v1/credits, /v1/me, /v1/usage, /v1/account all 404 with an HTML body as of
// 2026-08-07 — it is PRD part 1 work). Returning 0 here would be a lie that
// renders in the UI as "you have no coins" and would block the purchase flow.
// So: null means "unknown", and `available:false` tells the frontend to hide the
// balance chip rather than render a zero. When the platform ships the endpoint,
// set QUOTA_URL and this starts returning real numbers with no other change.
let quotaUnavailableLogged = false

async function fetchBalance(key: string): Promise<number | null> {
  try {
    const res = await fetch(QUOTA_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint unavailable (${QUOTA_URL} -> ${res.status}); reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("json")) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint returned ${ct || "unknown content-type"}, not json; reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    return extractBalance(await res.json())
  } catch {
    return null
  }
}

function quotaPayload(balance: number | null): Record<string, unknown> {
  return balance === null
    ? { balance_coins: null, currency: "coins", available: false, reason: "platform_balance_endpoint_missing" }
    : { balance_coins: balance, currency: "coins", available: true }
}

async function handleQuota(key: string): Promise<Response> {
  return Response.json(quotaPayload(await fetchBalance(key)))
}

async function emitQuotaChanged(state: SessionState): Promise<void> {
  try {
    const balance = await fetchBalance(state.apiKey)
    // Don't fire a quota.changed carrying "unknown" — a frontend that renders it
    // would flash the balance chip to blank on every image. Stay silent instead.
    if (balance === null) return
    emitToSession(state, "quota.changed", quotaPayload(balance))
  } catch (e) {
    console.error(`[gateway] quota.changed emit failed: ${e}`)
  }
}

/**
 * opencode errors are shaped { name, data: { message } } -- NOT { code, message }.
 * Reading .message straight off the object yields undefined, which is how every
 * real failure ("Invalid API Key", a whisper audio model driven as chat) reached
 * the browser as the useless literal "session error".
 * Order matters: data.message is the human reason, name is the class.
 */
function opencodeErrorMessage(err: unknown): string {
  if (typeof err === "string" && err.length > 0) return err
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; name?: unknown; data?: { message?: unknown } }
    const nested = e.data?.message
    if (typeof nested === "string" && nested.length > 0) return nested
    if (typeof e.message === "string" && e.message.length > 0) return e.message
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "session error"
}

function opencodeErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown }
    if (typeof e.code === "string" && e.code.length > 0) return e.code
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "backend_error"
}

function emitSessionError(state: SessionState, code: string, message: string): void {
  // Always log: a session.error that only exists in the browser costs a VPS dig
  // to diagnose. Codes/messages here are model-provider text, never credentials.
  console.error(`[gateway] session.error code=${code} message=${message}`)
  emitToSession(state, "session.error", { code, message })
}

// ---- internal handlers (loopback only) ----

interface LedgerEntry {
  ts: string
  user_id: string
  session_id: string
  opencode_session_id: string
  task_id?: string
  model?: string
  cost_coins?: number
  result_url?: string
  kind: string
  event: string
}

async function appendLedger(entry: LedgerEntry): Promise<void> {
  try {
    await appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf-8")
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}

async function appendLedgerFor(state: SessionState, overrides: Partial<LedgerEntry>): Promise<void> {
  try {
    await appendLedger({
      ts: new Date().toISOString(),
      user_id: await hashKey(state.apiKey),
      session_id: state.sessionId,
      opencode_session_id: state.opencodeSessionId,
      ...overrides,
    })
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}

function isLoopback(ip: string | null): boolean {
  if (!ip) return false
  if (ip === "127.0.0.1" || ip === "::1") return true
  return ip.startsWith("127.") || ip.startsWith("::ffff:127.")
}

// 畫布摘要讀取：opencode 的 canvas_summary 工具用 session_id（opencode 或
// gateway 任一 id 皆可）查當前畫布狀態。GET only、loopback only。
// 摘要 = 前端最後一次發訊息時附帶的 canvas_state（節點/連線/預算），
// 純透傳不加工；前端在每輪訊息都會更新，所以這裡永遠是最新。
async function handleCanvasStateRead(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const state = resolveSession(sessionId)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json({
    ok: true,
    canvas_state: state.canvasSummary ?? null,
    updated_at: state.canvasSummaryAt ?? null,
  })
}

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
const CANVAS_STATE_TTL_MS = 30 * 60 * 1000
const CANVAS_OPS_TIMEOUT_MS = Number.parseInt(process.env.CANVAS_OPS_TIMEOUT_MS || "30000", 10) || 30_000
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
])

interface CanvasSnapshotEntry {
  state: unknown
  updatedAt: number
}

// 畫布快照存放。key 統一收斂到 gateway sessionId（session 可解析時），
// 讓 opencode session id / gateway session id 兩種呼叫方命中同一份。
const canvasStates = new Map<string, CanvasSnapshotEntry>()

function canvasKeyFor(sessionId: string): string {
  const state = resolveSession(sessionId)
  return state ? state.sessionId : sessionId
}

// 惰性 TTL 清理：每次讀寫順手掃（條目數 = 活躍畫布數，量級小）。
function sweepCanvasStates(): void {
  const now = Date.now()
  for (const [k, v] of canvasStates) {
    if (now - v.updatedAt > CANVAS_STATE_TTL_MS) canvasStates.delete(k)
  }
}

function storeCanvasState(
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
function getCanvasState(sessionId: string): CanvasSnapshotEntry | null {
  sweepCanvasStates()
  return canvasStates.get(canvasKeyFor(sessionId)) ?? null
}

interface CanvasOpsResult {
  ok: boolean
  error?: string
  created_node_ids?: string[]
}

interface PendingCanvasOps {
  sessionKey: string
  settle: (result: CanvasOpsResult) => void
}

const pendingCanvasOps = new Map<string, PendingCanvasOps>()

function validateCanvasOps(ops: unknown): { ok: true; ops: unknown[] } | { ok: false; message: string } {
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
function dispatchCanvasOps(
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

function resolveCanvasOps(sessionId: string, requestId: string, result: CanvasOpsResult): boolean {
  const pending = pendingCanvasOps.get(requestId)
  if (!pending) return false
  if (pending.sessionKey !== canvasKeyFor(sessionId)) return false
  pending.settle(result)
  return true
}

function sanitizeOpsResult(body: Record<string, unknown>): CanvasOpsResult {
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
async function handleCanvasStateWrite(req: Request): Promise<Response> {
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
  if (!stored.ok) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// GET /internal/canvas/snapshot — 工具讀最新快照（與既有 GET /internal/canvas/state 分開）。
async function handleCanvasSnapshotRead(req: Request): Promise<Response> {
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

// POST /internal/canvas/dispatch-ops — opencode canvas_* 工具的下發入口。
// 阻塞至前端回執或逾時；timeout_ms 僅供測試縮短，上限即預設值。
async function handleCanvasDispatchOps(req: Request): Promise<Response> {
  let body: { session_id?: unknown; ops?: unknown; label?: unknown; timeout_ms?: unknown }
  try {
    body = (await req.json()) as { session_id?: unknown; ops?: unknown; label?: unknown; timeout_ms?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(body.session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const v = validateCanvasOps(body.ops)
  if (!v.ok) return jsonError(400, v.message, "bad_request", "bad_request")
  const label = typeof body.label === "string" && body.label ? body.label.slice(0, 200) : undefined
  const rawTimeout = typeof body.timeout_ms === "number" && Number.isFinite(body.timeout_ms) ? body.timeout_ms : CANVAS_OPS_TIMEOUT_MS
  const timeoutMs = Math.max(1_000, Math.min(CANVAS_OPS_TIMEOUT_MS, rawTimeout))
  try {
    const { request_id, result } = await dispatchCanvasOps(state, v.ops, label, timeoutMs)
    return Response.json({ ok: true, request_id, result })
  } catch (e) {
    const err = e as { code?: string; request_id?: string }
    if (err?.code === "OPS_TIMEOUT") {
      return Response.json(
        { ok: false, code: "OPS_TIMEOUT", request_id: err.request_id ?? null, error: "前端未在時限內回執畫布操作結果" },
        { status: 504 },
      )
    }
    console.error("[gateway] canvas dispatch-ops error:", e)
    return jsonError(500, "canvas ops dispatch failed", "server_error", "server_error")
  }
}

// POST /internal/canvas/ops-result — loopback 回執（body 帶 session_id）。
async function handleCanvasOpsResultInternal(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : ""
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!sessionId || !requestId) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

// POST /agent/v1/sessions/:id/canvas/state — 前端（經站點代理）快照上行。
async function handleCanvasStatePublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { state?: unknown }
  try {
    body = (await req.json()) as { state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (body.state === null || body.state === undefined || typeof body.state !== "object") {
    return jsonError(400, "state (object) is required", "bad_request", "bad_request")
  }
  const stored = storeCanvasState(state.sessionId, body.state)
  if (!stored.ok) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// POST /agent/v1/sessions/:id/canvas/ops-result — 前端（經站點代理）回執。
async function handleCanvasOpsResultPublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!requestId) return jsonError(400, "request_id is required", "bad_request", "bad_request")
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(state.sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

async function handleConfirmRequest(req: Request): Promise<Response> {  let body: {
    session_id?: string
    request_id?: string
    amount_coins?: number
    description?: string
    model?: string
    task_id?: string
  }
  try {
    body = (await req.json()) as {
      session_id?: string
      request_id?: string
      amount_coins?: number
      description?: string
      model?: string
      task_id?: string
    }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  // Idempotent by request_id. A re-post of a live request must NOT supersede it:
  // superseding used to resolve the earlier waiter to false, which with a polling
  // caller would read as "user denied" even though nobody had answered yet.
  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }

  const amount = typeof body.amount_coins === "number" ? body.amount_coins : 0
  const description = typeof body.description === "string" ? body.description : ""

  const timer = setTimeout(() => {
    // Expiry is a real outcome and must be announced. The old code only deleted
    // the entry, so the frontend's confirm card stayed on screen forever with no
    // way to tell it had already been decided against.
    settleConfirm(state, request_id, "expired")
  }, CONFIRM_TIMEOUT_MS)
  state.pendingConfirms.set(request_id, {
    timer,
    ledger: { amount_coins: amount, task_id: body.task_id, model: body.model },
  })

  // Surface the billing request to the frontend, then return immediately.
  // This request does NOT block for the answer: CONFIRM_TIMEOUT_MS (15 min)
  // exceeds both Bun's idleTimeout ceiling (255s) and the caller's abort, so
  // the tool polls /internal/confirm-status instead.
  emitToSession(state, "confirm.request", { request_id, amount_coins: amount, description })

  return Response.json({ status: "pending", request_id }, { status: 202 })
}

/**
 * Move a confirm from pending to resolved, announce it, and bill it.
 * Single path for all three ways a confirm can end (user answer, expiry,
 * session teardown) so none of them can forget to emit confirm.resolved.
 */
function settleConfirm(state: SessionState, requestId: string, outcome: ConfirmOutcome): boolean {
  const pending = state.pendingConfirms.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  state.pendingConfirms.delete(requestId)

  state.resolvedConfirms.set(requestId, { outcome, resolvedAt: Date.now() })
  if (state.resolvedConfirms.size > CONFIRM_RESOLVED_CAP) {
    const oldest = state.resolvedConfirms.keys().next()
    if (!oldest.done) state.resolvedConfirms.delete(oldest.value)
  }

  const approved = outcome === "approved"
  emitToSession(state, "confirm.resolved", { request_id: requestId, approved })

  if (approved) {
    if (pending.ledger) {
      void appendLedgerFor(state, {
        kind: "confirm",
        event: "approved",
        cost_coins: pending.ledger.amount_coins,
        task_id: pending.ledger.task_id,
        model: pending.ledger.model,
      })
    }
    void emitQuotaChanged(state)
  }
  return true
}

/** Poll target for the tool: has the user answered this confirm yet? */
async function handleConfirmStatus(req: Request): Promise<Response> {
  let body: { session_id?: string; request_id?: string }
  try {
    body = (await req.json()) as { session_id?: string; request_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  // A vanished session means the session was deleted or reaped out from under
  // the tool. That is a denial, not an unknown: nothing may be spent for a
  // session that no longer exists.
  if (!state) return Response.json({ status: "denied", request_id, reason: "session_gone" })

  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }
  // Neither pending nor recently resolved: the answer aged out of the retention
  // window, or this id was never registered. Fail closed.
  return Response.json({ status: "denied", request_id, reason: "unknown_request" })
}

async function handleResumeSession(req: Request): Promise<Response> {
  let body: { session_id?: string; content?: string }
  try {
    body = (await req.json()) as { session_id?: string; content?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, content } = body
  if (!session_id || typeof content !== "string" || content.trim() === "") {
    return jsonError(400, "session_id and content are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  // Async, same reason as handleSendMessage: the poller must not be held open
  // for the length of an LLM turn.
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode resume failed: ${res.status}`, "backend_error", "backend_error")
    }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  return Response.json({ ok: true })
}

async function handleSessionKey(req: Request): Promise<Response> {
  let body: { session_id?: string }
  try {
    body = (await req.json()) as { session_id?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id } = body
  if (!session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const user_id = await hashKey(state.apiKey)
  return Response.json({ ok: true, api_key: state.apiKey, user_id })
}

async function handleInternalEmit(req: Request): Promise<Response> {
  let body: { session_id?: string; event?: string; data?: unknown }
  try {
    body = (await req.json()) as { session_id?: string; event?: string; data?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, event, data } = body
  if (!session_id || typeof event !== "string") {
    return jsonError(400, "session_id and event are required", "bad_request", "bad_request")
  }
  if (!INTERNAL_EMIT_ALLOWED.has(event) && !CANVAS_EMIT_ALLOWED.has(event)) {
    return jsonError(400, `event not allowed: ${event}`, "bad_request", "bad_request")
  }
  const state = resolveSession(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  if (event === "image.done") {
    const d = (data ?? {}) as { url?: string; cost_coins?: number; task_id?: string }
    // Shared deduped path so /internal/emit and the opencode translation can
    // never announce the same url twice in one session. Awaited so the redirect
    // resolution completes before the poller gets its 200 and resumes the
    // session — otherwise the agent could describe an image the UI lacks.
    await emitImageDone(state, d.url ?? "", d.cost_coins, d.task_id)
  } else if (event === "session.error") {
    const d = (data ?? {}) as { code?: string; message?: string }
    emitSessionError(state, d.code ?? "backend_error", d.message ?? "session error")
  } else if (event === "quota.changed") {
    void emitQuotaChanged(state)
  } else if (event === "tool.result") {
    emitToSession(state, "tool.result", data ?? {})
  } else if (CANVAS_EMIT_ALLOWED.has(event)) {
    // 畫布事件：純透傳，Frontend reducer 決定如何渲染。不做任何加工，
    // 保留 data 原樣。這讓 opencode 的 canvas_* 工具可以直接 speak 畫布
    // 指令給前端，而不需要透過 message.delta 繞一圈。
    emitToSession(state, event, data ?? {})
  }
  return Response.json({ ok: true })
}

/**
 * POST /agent/v1/optimize-prompt — 同步影片 prompt 優化。
 *
 * 這是 Image Studio 的「隱形提示詞導演」後端：generate-videos 進上游前，
 * 把用戶短 prompt + 金礦工業級導演規則送給 opencode（deepseek）大腦，
 * 同步拿回優化稿。與 agent 對話 session 完全隔離：每次請求建一個臨時
 * opencode session，用完即刪，不進 sessions 池、不開 SSE 流。
 *
 * body: { prompt: string, duration_seconds?: number, generate_audio?: boolean }
 * 回應: 200 { ok, prompt, model } / 502 { ok:false, ... }（上游不可用）
 *
 * 規則來源：Higgsfield Hell Grind 95 分鐘長片 pipeline + Seedance 2.0 官方
 * prompt 架構（OSideMedia/higgsfield-ai-prompt-skill，MIT）——31 子 skill 的
 * 共通核心全文編譯進 system prompt，一次讀完，不需 agent 多步思考。
 */

// 金礦工業級規則全文。用戶輸入可能只是「幫我生成浩克對戰蜘蛛俠的電影」這種
// 一句話抽象請求——規則負責把它變成可用 production prompt。
const OPTIMIZE_DIRECTOR_PREFIX = `You are a professional video and image prompt director trained on the Higgsfield Hell Grind 95-minute feature film pipeline and Seedance 2.0 production prompt rules.

Turn the user's request into ONE production-ready generation prompt. The user may be a non-expert writing one vague sentence — you must still produce a complete, usable prompt. Output ONLY the generated prompt, no preamble, no commentary, no markdown.

THE SIX-SLOT FORMULA (every prompt must contain all six, in this order):
[Camera movement] + [Subject] + [Action] + [Setting] + [Style] + [Lighting]
If the user's input is missing slots, fill them with the most effective defaults for the scene type. 50-80 words is the sweet spot for a single shot.

BLOCK SCAFFOLD (for multi-shot / long-form work):
SCENE CONTEXT → ACTIVE REFERENCES → LOCATION MAP → FIRST FRAME/BLOCKING → FORMAT MODE → OPTICS → CAMERA → ACTION → PERFORMANCE → PHYSICS → LIGHTING → COLOR GRADE → WARDROBE → AUDIO → STYLE → OUTPUT SETTINGS → POSITIVE LOCKS. Write only the blocks the shot needs. 2000+ words is fine here — structure replaces the word cap.

HARD RULES (each one exists because a shot failed without it):
1. POSITIVE PHRASING ONLY. Never write negative instructions ("does not", "no X"). Declare what IS true. Seedance parses every token as a positive instruction. Short lock tails inside a positive declaration ("Stable composition, no flicker") are fine.
2. ANTI-SLOP. Replace empty adjectives with named referents: "cinematic" -> a lighting setup or lens spec ("golden-hour backlight", "anamorphic 2.39:1 flare"); "epic" -> "large-scale"; "fast" -> describe physics ("feet striking hard, each stride at full extension"); "beautiful"/"high quality" -> delete, describe the specific visual.
3. EMOTION = MUSCLE. Never write emotion labels ("she looks scared"). Write "jaw clenches, nostrils flare, shallow breath, shoulders pull inward". One visible micro-event every 1-2 seconds (a blink, a breath, a nostril move). Layered emotion: dominant state in the face, underlying state in breath/posture/hands, the tell in the eyes.
4. NAME THE CAMERA WITH AN ENDPOINT. Not "the camera moves" but "slow dolly-in, ending on her hands around the cup". One primary move per shot, max one texture modifier ("slightly handheld"). Camera matches emotion: jittery handheld for anger, smooth breathing for calm, static slow push for revelation.
5. ONE PRIMARY ACTION per clip, 1-2 secondary max. Chain 2-3 connected actions in one direction so motion spends the whole clip. A deliberate there-and-back is two shots, never one prompt. Never let a short action finish early.
6. AGE-BLIND. Never describe characters by age (boy/girl/child/kid/teen/young/little). Use role, clothing, action. The content filter tightens sharply the moment it reads a minor.
7. IP AND REAL PEOPLE. Never name copyrighted characters (Hulk, Spider-Man, etc.) or real celebrities. Describe them by their defining visual traits, role, and actions instead: "an enormous green-skinned muscle-bound figure whose rage grows as it fights" / "a slight acrobatic hero in red-and-blue body armor who webs and swings". This is mandatory even when the user named the IP directly.
8. FOV IN DEGREES ONLY (for multishot): 180 fisheye / 107 ultra-wide arch / 84 wide group / 63 observational / 47 neutral / 29 portrait / 18 close portrait / 12 tele-detail / 8 extreme. Add "no drift mid-segment".
9. MEASURABLE LANGUAGE. Speed in km/h. Fog/haze in % and meters. Giant scale via human-height comparison ("as tall as four humans stacked"). Left/right always from the camera. White balance fixed in Kelvin (3200K/4000K/5600K/8500K). Mass and size in real units so gravity reads correctly.
10. HOMOGRAPH TRAP. If a word has a second physical reading the model may take it: tearing (rip/cry), shoot, duck, bolt, draw, wave, charge, rock, drop, fire, strike, break, pound, snap. Replace with phrasing only ONE thing can look like: "wind tearing at her coat" -> "wind whipping violently at her coat".
11. END WITH A QUALITY TAIL if video: "Stable composition, no flicker, detailed texture preserved." Audio: "SFX only, no music" unless the user asked for a soundtrack.
12. CUT DISCIPLINE. Keep one continuous shot unless the scene demands a cut. If a cut is needed, name the type (HARD CUT / SMASH CUT / MATCH CUT / REVERSE CUT) and timing. Every cut changes BOTH shot size AND camera character (double-contrast rule). Never repeat either across a cut.
13. POSITIVE LOCKS for multi-shot: "The set contains only what is described. Character identity and environment stay identical across every cut. No extra people, no duplicated furniture." For 2+ characters write real heights to prevent equalization drift.

WHEN THE USER IS VAGUE (they will be — they are a non-expert):
- Infer the scene type, pick the right template, and produce a complete prompt anyway.
- Decide camera, lighting, and style from the mood of the request.
- If they named a copyrighted hero, rewrite per rule 7 — never paste the IP name.
- If they described a shot type (battle, chase, dialogue, horror, product), use the strongest expected structure for that type.

Translate any Chinese user input to English in the output prompt.

USER:`
async function handleOptimizePrompt(key: string, req: Request): Promise<Response> {
  let body: { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  try {
    body = (await req.json()) as { prompt?: string; duration_seconds?: number; generate_audio?: boolean }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return jsonError(400, "prompt is required", "bad_request", "bad_request")

  // 開一個一次性 opencode session（與對話 pool 無關）。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${OPTIMIZE_DIRECTOR_PREFIX}\n\n${prompt}`

    const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode optimize failed: ${res.status}`, "backend_error", "backend_error")
    }

    const payload = (await res.json()) as { info?: { modelID?: string }; parts?: Array<{ type?: string; text?: string }> }
    // 最後一個 text part = 最終答案。opencode 同步 message 的 parts 順序是
    // step-start → text → step-finish，通常只有一個 text。
    const texts = (payload.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text ?? "")
    const optimized = texts.length > 0 ? texts[texts.length - 1].trim() : ""
    if (!optimized) {
      return jsonError(502, "opencode returned no text", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, prompt: optimized, model: payload.info?.modelID ?? "unknown" })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    // 一次性 session，事後必刪。
    await fetch(`${OPENCODE_URL}/session/${sessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

const EXTRACT_LESSONS_PREFIX = `You are a memory curator for an AI image-generation assistant.
Your ONLY job: given a conversation transcript between a user and the assistant, extract up to 6 durable lessons about THIS USER that would help a future session serve them better without re-asking.

Rules:
- Lessons must be about the user's stable preferences, working habits, specs, style, workflow, or recurring corrections.
- One lesson per line. Each lesson is ONE short sentence (under 40 words), imperative-ish or declarative, e.g. "User batches 4 images at a time and wants them all in one canvas" or "User prefers 4:5 aspect ratio for product shots".
- Never invent facts not supported by the transcript.
- Skip one-time requests, greetings, and anything non-durable.
- Output ONLY the lessons, one per line, no preamble, no numbering, no markdown.`

async function handleExtractLessons(key: string, req: Request): Promise<Response> {
  let body: { transcript?: string; max_lessons?: number }
  try {
    body = (await req.json()) as { transcript?: string; max_lessons?: number }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : ""
  if (!transcript) return jsonError(400, "transcript is required", "bad_request", "bad_request")
  if (transcript.length > 100_000) return jsonError(400, "transcript too large", "bad_request", "bad_request")
  const maxLessons = Math.min(Math.max(Number(body.max_lessons) || 6, 1), 8)

  // 一次性 opencode session（与对话 pool 无关），同步取结果后即删。
  let session: { id?: string }
  try {
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return jsonError(502, `opencode create session failed: ${res.status}`, "backend_error", "backend_error")
    session = (await res.json()) as { id?: string }
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
  if (!session.id) return jsonError(502, "opencode did not return a session id", "backend_error", "backend_error")

  const sessionId = session.id
  try {
    const content = `${EXTRACT_LESSONS_PREFIX}\n\n<transcript>\n${transcript}\n</transcript>\n\n提取该用户的教训,每行一条。`
    const res = await fetch(`${OPENCODE_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: content }] }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return jsonError(502, `opencode extract failed: ${res.status}`, "backend_error", "backend_error")
    }
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    const raw = texts.length > 0 ? texts[texts.length - 1] : ""
    const lessons = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, maxLessons)
    if (lessons.length === 0) {
      return jsonError(502, "opencode returned no lessons", "backend_error", "backend_error")
    }
    return Response.json({ ok: true, lessons })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  } finally {
    await fetch(`${OPENCODE_URL}/session/${sessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }
}

// ---- CORS ----

// Explicit allowlist, not "*": these responses are authenticated with a
// sk-biz-* key, and a wildcard origin combined with credentials is exactly the
// configuration browsers refuse (and that would let any site drive a user's
// paid account). Configure via CORS_ORIGINS as a comma-separated list.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://image.tinchak0207.xyz")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean)

function corsOriginFor(origin: string | null): string | null {
  if (!origin) return null // same-origin / curl: no CORS headers needed
  const normalized = origin.replace(/\/+$/, "")
  if (CORS_ORIGINS.includes(normalized)) return origin
  if (CORS_ORIGINS.includes("*")) return origin // echo the caller, never literal "*"
  // local dev: 192.168.*, localhost, 127.0.0.1
  if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(normalized)) return origin
  return null
}

function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) return {}
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // last-event-id must be allowed or SSE resume-after-reconnect fails preflight.
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
    // Varying on Origin keeps a CDN from caching one origin's headers for another.
    Vary: "Origin",
  }
}

// ---- HTTP server ----

const server = Bun.serve({
  port: PORT,
  // Bun's default idleTimeout is 10s, which would kill the long-lived SSE
  // streams this gateway depends on. 255s is Bun's maximum; SSE stays alive
  // past it via the 20s heartbeat.
  //
  // This 255s ceiling is also why confirmation is no longer a blocking request:
  // CONFIRM_TIMEOUT_MS is 15 minutes, which no HTTP request can span, so
  // /internal/confirm-request registers and returns while the tool polls
  // /internal/confirm-status for the answer.
  idleTimeout: 255,
  async fetch(req: Request, srv): Promise<Response> {
    // CORS wrapper: the frontend is served from a different origin (Vercel)
    // than this gateway (VPS behind nginx), so without these headers every
    // browser call fails preflight and the whole frontend integration is dead.
    const origin = req.headers.get("origin")
    const allowed = corsOriginFor(origin)

    // Preflight must be answered BEFORE the auth check — the browser sends
    // OPTIONS with no Authorization header, so a 401 here would block the
    // real request from ever being sent.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) })
    }

    const res = await handleRequest(req, srv)
    if (!allowed) return res
    // Response headers are immutable once constructed, so rebuild. The body is
    // passed through by reference, which keeps SSE streaming intact.
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(corsHeaders(allowed))) headers.set(k, v)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  },
})

async function handleRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): Promise<Response> {
  {
    const url = new URL(req.url)
    const pathname = url.pathname
    let clientIp: string | null = null
    try {
      clientIp = srv.requestIP(req)?.address ?? null
    } catch {
      clientIp = null
    }

    // Health (no auth). Also served under /agent/healthz because nginx proxies
    // /agent/ to this port WITHOUT stripping the prefix, so /healthz alone is
    // not reachable from outside and an external uptime check would get 401.
    if (req.method === "GET" && (pathname === "/healthz" || pathname === "/agent/healthz")) {
      return Response.json({ ok: true, timestamp: new Date().toISOString(), sessions: sessions.size })
    }

    // Internal routes: loopback-only, no API key
    if (pathname.startsWith("/internal/")) {
      if (!isLoopback(clientIp)) {
        return jsonError(403, "internal endpoint only reachable from localhost", "forbidden", "forbidden")
      }
      if (req.method === "POST" && pathname === "/internal/confirm-request") {
        return handleConfirmRequest(req)
      }
      if (req.method === "POST" && pathname === "/internal/confirm-status") {
        return handleConfirmStatus(req)
      }
      if (req.method === "POST" && pathname === "/internal/resume-session") {
        return handleResumeSession(req)
      }
      if (req.method === "POST" && pathname === "/internal/session-key") {
        return handleSessionKey(req)
      }
      if (req.method === "POST" && pathname === "/internal/emit") {
        return handleInternalEmit(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/state") {
        return handleCanvasStateRead(req)
      }
      // Wave C：畫布快照寫入 / 工具快照讀取 / ops 下發 / 回執（皆 loopback）。
      if (req.method === "POST" && pathname === "/internal/canvas/state") {
        return handleCanvasStateWrite(req)
      }
      if (req.method === "GET" && pathname === "/internal/canvas/snapshot") {
        return handleCanvasSnapshotRead(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/dispatch-ops") {
        return handleCanvasDispatchOps(req)
      }
      if (req.method === "POST" && pathname === "/internal/canvas/ops-result") {
        return handleCanvasOpsResultInternal(req)
      }
      // 工作流引擎端點：接受 session_id（opencode 或 gateway id）解析 session。
      if (pathname === "/internal/workflow/templates" && req.method === "GET") {
        return workflowServiceTemplates()
      }
      if (pathname.startsWith("/internal/workflow/")) {
        const m = new URL(req.url)
        const sessionId = m.searchParams.get("session_id") || (await req.json().catch(() => ({})))?.session_id || ""
        const session = sessionId ? resolveSession(sessionId) : undefined
        if (!session) return jsonError(404, "session not found", "not_found", "not_found")
        return handleWorkflowInternal(req, session)
      }
      return jsonError(404, "not found", "not_found", "not_found")
    }

    // Ticket-authenticated SSE. Checked before the Bearer gate because the
    // browser EventSource cannot send a header at all; the ticket IS the
    // credential here. Read-only and single-session — see issueSseTicket.
    {
      const m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
      if (req.method === "GET" && m) {
        const ticket = url.searchParams.get("ticket")
        if (ticket) {
          const state = redeemSseTicket(ticket, m[1])
          if (!state) return jsonError(401, "invalid or expired SSE ticket", "unauthorized", "unauthorized")
          let lastEventId: number | undefined
          const raw = req.headers.get("last-event-id") || url.searchParams.get("last_event_id")
          if (raw) {
            const n = Number.parseInt(raw, 10)
            if (!Number.isNaN(n)) lastEventId = n
          }
          return openEventStream(state, lastEventId, req)
        }
      }
    }

    // Public routes: require a valid Bearer sk-biz-* key
    const key = getBearer(req)
    if (!key || !key.startsWith("sk-biz-")) {
      return jsonError(401, "missing or invalid API key", "unauthorized", "unauthorized")
    }
    if (!(await validateApiKey(key))) {
      return jsonError(401, "invalid API key", "unauthorized", "unauthorized")
    }

    if (req.method === "GET" && pathname === "/agent/v1/quota") {
      return handleQuota(key)
    }

    if (req.method === "POST" && pathname === "/agent/v1/sessions") {
      return handleCreateSession(key, req)
    }

    if (req.method === "POST" && pathname === "/agent/v1/optimize-prompt") {
      return handleOptimizePrompt(key, req)
    }

    if (req.method === "POST" && pathname === "/agent/v1/extract-lessons") {
      return handleExtractLessons(key, req)
    }

    let m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/messages$/)
    if (req.method === "POST" && m) {
      return handleSendMessage(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/events$/)
    if (req.method === "GET" && m) {
      return handleEventStream(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/confirm$/)
    if (req.method === "POST" && m) {
      return handleConfirm(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/question$/)
    if (req.method === "POST" && m) {
      return handleQuestion(key, m[1], req)
    }

    // Mint a query-string credential for EventSource. Authenticated with the
    // Bearer key, so only the session owner can obtain one.
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/sse-ticket$/)
    if (req.method === "POST" && m) {
      if (!getOwnedSession(key, m[1])) return jsonError(404, "session not found", "not_found", "not_found")
      return Response.json({ ticket: issueSseTicket(key, m[1]), expires_in_ms: SSE_TICKET_TTL_MS })
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/abort$/)
    if (req.method === "POST" && m) {
      return handleAbortSession(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      return handleGetSession(key, m[1])
    }
    if (req.method === "DELETE" && m) {
      return handleDeleteSession(key, m[1])
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/attachments$/)
    if (req.method === "POST" && m) {
      return handleAttachmentUpload(key, m[1], req)
    }

    // Wave C：畫布快照上行與 canvas.ops 回執（前端經站點代理呼叫）。
    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/state$/)
    if (req.method === "POST" && m) {
      return handleCanvasStatePublic(key, m[1], req)
    }

    m = pathname.match(/^\/agent\/v1\/sessions\/([^/]+)\/canvas\/ops-result$/)
    if (req.method === "POST" && m) {
      return handleCanvasOpsResultPublic(key, m[1], req)
    }

    return jsonError(404, "not found", "not_found", "not_found")
  }
}

// Heartbeat keeps frontend SSE streams alive and prunes dead clients.
setInterval(() => {
  const ping = encoder.encode(": ping\n\n")
  for (const state of sessions.values()) {
    for (const client of state.clients) {
      try {
        client.controller.enqueue(ping)
      } catch {
        state.clients.delete(client)
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS)

// Idle-session reaper. Sessions were previously freed only by an explicit
// DELETE, so a closed browser tab leaked its SessionState — including a
// 200-frame replay buffer — for the lifetime of the process. A session is
// reaped only when it has NO connected SSE clients AND no activity for
// SESSION_IDLE_TTL_MS, so an active stream or an in-flight generate is never
// collected. The upstream opencode session is deleted too, otherwise opencode
// accumulates its own orphaned state on disk.
setInterval(() => {
  const now = Date.now()
  for (const [ticket, rec] of sseTickets) {
    if (rec.expiresAt <= now) sseTickets.delete(ticket)
  }
  for (const [id, state] of sessions) {
    // Drop confirm answers past their retention window so a long-lived session
    // does not accumulate them forever.
    for (const [requestId, rec] of state.resolvedConfirms) {
      if (now - rec.resolvedAt > CONFIRM_RESOLVED_TTL_MS) state.resolvedConfirms.delete(requestId)
    }
    if (state.clients.size > 0) continue
    // A pending confirm pins the session. With CONFIRM_TIMEOUT_MS at 15 min and
    // SESSION_IDLE_TTL_MS at 30 min this cannot pin it forever: the confirm
    // expires first, and the next sweep is free to reap.
    if (state.pendingConfirms.size > 0) continue
    if (state.pendingQuestions.size > 0) continue
    if (now - state.lastActivityAt < SESSION_IDLE_TTL_MS) continue
    const idleMs = now - state.lastActivityAt
    teardownSession(id, state, "idle_timeout")
    void deleteOpencodeSession(state.opencodeSessionId)
    const reaperUploadDir = path.join(UPLOADS_DIR, state.sessionId)
    if (existsSync(reaperUploadDir)) {
      void rm(reaperUploadDir, { recursive: true, force: true }).catch(() => {})
    }
    console.log(`[gateway] reaped idle session ${id} after ${Math.round(idleMs / 1000)}s idle`)
  }
  // DB 孤兒 row 清掃：gateway 重啟後無人 reference 的持久化 row（updated_at 超過
  // 7 天）連同 upstream opencode session 與 uploads 一起回收，避免 sessions.db
  // 無限增長。7 天 >> SESSION_IDLE_TTL_MS：寧可晚刪，不誤刪可恢復的會話。
  for (const stale of sweepStaleRows(7 * 24 * 60 * 60 * 1000)) {
    if (sessions.has(stale.sessionId)) continue // 剛被 lazy reload 回來的不動
    void deleteOpencodeSession(stale.opencodeSessionId)
    const staleUploadDir = path.join(UPLOADS_DIR, stale.sessionId)
    if (existsSync(staleUploadDir)) {
      void rm(staleUploadDir, { recursive: true, force: true }).catch(() => {})
    }
    console.log(`[gateway] swept stale persisted session ${stale.sessionId}`)
  }
}, SESSION_REAP_INTERVAL_MS)

// Single global connection to opencode's event stream, fanned out per session.
connectOpencode()

console.log(`[gateway] listening on :${server.port}, opencode=${OPENCODE_URL}`)
