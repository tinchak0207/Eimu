// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave2）：session 生命周期 handlers。
// 原行区间：499–508（能力断路 beastAgentField）、4139–4242（public handlers banner＋
// handleCreateSession，含尾部双空行使区间与 model-registry.ts 4243–4376 无缝衔接）、
// 5145–5179（handleEventStream＋handleConfirm）。逐行机械抽取（python），仅加 export
// 前缀＋本档头＋单行 import，其余一字未动。
import type { MemoryDocLite, SessionState } from "./types-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession, sessions, deleteOpencodeSession } from "./sessions-core.ts"
import { opencodeFetch } from "./opencode-client.ts"
import { hashKey } from "./auth-gw.ts"
import { loadUserSettings, saveSession } from "./persistence.ts"
import { openEventStream } from "./sse-core.ts"
import { settleConfirm } from "./media-internal-routes.ts"
import { MEMORY_PRIVATE_DOCS_MAX } from "./memory-wiring.ts"
// TODO(整合 Wave2): MEMORY_PRIVATE_DOCS_MAX 仍住 index.ts:6883（const 未 export，补 export 后改真 import）。

// ── 能力断路（MOE 评测死线1，2026-09-08）：野兽模式 ON 时主会话跑 orchestrator
// agent（opencode.json agent.orchestrator.tools 把 blender_exec/blender_render/
// blender_export_gltf/music_gen 从工具表物理移除）→ 主会话无法直调域工具，只能
// subagent_dispatch 派发 Expert。OFF 不带 agent 栏＝default build agent＝零变化。
export function beastAgentField(state: SessionState): Record<string, string> {
  try {
    if (loadUserSettings(state.apiKey)?.beast_mode === true) return { agent: "orchestrator" }
  } catch {}
  return {}
}

// ---- public handlers ----

export async function handleCreateSession(key: string, req: Request): Promise<Response> {
  // L0 账户级记忆：编辑层在本站读取 user_profiles/agent_lessons 后随创建上送，
  // 网关只负责暂存，首条消息时注入 system。
  // 契约 §4（2026-09-15 PRD P0-4）：payload 追加 memory_docs（私有 active docs ≤8）
  // 与 memory_index_md（共享索引行）两栏，驼峰原样入 state.userMemory。
  let memoryBody: {
    user_profile?: Record<string, unknown>
    lessons?: string[]
    memory_empty?: boolean
    memory_docs?: MemoryDocLite[]
    memory_index_md?: string
  } = {}
  try {
    const raw = (await req.json()) as typeof memoryBody | null
    if (raw && typeof raw === "object") memoryBody = raw
  } catch {
    memoryBody = {}
  }
  const memoryDocsIncoming = Array.isArray(memoryBody.memory_docs) ? memoryBody.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
  const memoryIndexIncoming = typeof memoryBody.memory_index_md === "string" ? memoryBody.memory_index_md : ""
  const memoryProfileIncoming =
    memoryBody.user_profile && typeof memoryBody.user_profile === "object" ? memoryBody.user_profile : undefined
  const memoryIncoming =
    (memoryProfileIncoming && Object.keys(memoryProfileIncoming).length > 0) ||
    memoryDocsIncoming.length > 0 ||
    memoryIndexIncoming.trim().length > 0
      ? {
          user_profile: memoryProfileIncoming ?? {},
          lessons: memoryBody.lessons ?? [],
          memory_docs: memoryDocsIncoming,
          memory_index_md: memoryIndexIncoming,
        }
      : undefined

  let res: Response
  try {
    res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
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
    partStripState: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    sessionTasks: new Map(),
    canvasSnapshot: undefined,
    workflowSnapshot: undefined,
    vettingInjected: false,
    userMemory: memoryIncoming,
    // memoryInjected 死旗标已删（D1，2026-09-15 PRD P0-4）：真闸是 vettingInjected。
    profileOnboardingPending: memoryBody.memory_empty === true,
    lastPromptBody: null,
    turnGen: 0,
    turnTextChars: 0,
    turnReasoningChars: 0,
    turnRetries: 0,
    turnAborted: false,
    retryQueued: false,
  }
  sessions.set(sessionId, state)
  // 建立即同步落盘：重启后 getOwnedSession 可恢复。
  // 2026-10-13：旧实作不管成败都往下走、照回 200 ——「首次落盘失败假报成功」正是
  // 事故成因。现在落盘失败一律回 503（不假报成功），并撤掉刚建的会话（内存 + 上游
  // opencode 会话），避免留下重启即消失、且上游成孤儿的幽灵会话。
  if (!saveSession(state)) {
    sessions.delete(sessionId)
    void deleteOpencodeSession(body.id)
    console.error(`[gateway] session create aborted: persistence unavailable — session=${sessionId} (opencode ${body.id})`)
    return jsonError(503, "session persistence unavailable — refusing to create a session that would be lost on restart", "persistence_unavailable", "server_error")
  }
  const user_id = await hashKey(key)
  console.log(`[gateway] session created: ${sessionId} (opencode ${body.id})`)
  return Response.json({ session_id: sessionId, user_id })
}



export function handleEventStream(key: string, id: string, req: Request): Response {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let lastEventId: number | undefined
  const raw = req.headers.get("last-event-id") || new URL(req.url).searchParams.get("last_event_id")
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (!Number.isNaN(n)) lastEventId = n
  }
  return openEventStream(state, lastEventId, req)
}

export async function handleConfirm(key: string, id: string, req: Request): Promise<Response> {
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
