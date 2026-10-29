// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave2）：session 生命周期 handlers。
// 原行区间：499–508（能力断路 beastAgentField）、4139–4242（public handlers banner＋
// handleCreateSession，含尾部双空行使区间与 model-registry.ts 4243–4376 无缝衔接）、
// 5145–5179（handleEventStream＋handleConfirm）。逐行机械抽取（python），仅加 export
// 前缀＋本档头＋单行 import，其余一字未动。
import type { MemoryDocLite, SessionState } from "./types-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession, sessions, deleteOpencodeSession, leanSeat, seatDecision, projectModeSwitch, seatUserId, projectModeAllowlist } from "./sessions-core.ts"
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
// subagent_dispatch 派发 Expert。S2：空 agent 会被 opencode 落到 build，这里始终带席位。
// S19（2026-10-28）：推送路径按**锁存席位**映射——`creator` 已被 S14 重定义为 10 工具
// 工程席位，旧席位会话（含缺键→creator_legacy）的野兽模式必须走 orchestrator_legacy
// （原席位逐字拷贝），不能指到新的 orchestrator。工程会话恒 creator，beast 不换席位、也不读设置。
export function beastAgentField(state: SessionState): Record<string, string> {
  if (leanSeat(state)) return { agent: "creator" }
  try {
    if (loadUserSettings(state.apiKey)?.beast_mode === true) return { agent: "orchestrator_legacy" }
  } catch {}
  return { agent: "creator_legacy" }
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

  // 2026-10-19 修画布写穿：创建时必须带真实席位。过去 body 是空对象，OpenCode
  // 会把会话绑定到默认 build；后续每轮 prompt 虽带 agent=creator/orchestrator，
  // 工具 schema 仍是创建时的 build（workflow_write=false），调用根本到不了网关。
  // S19 回滚安全（2026-10-28）：`creator` 已被 S14 重定义为 10 工具的工程席位，而 OpenCode
  // 在创建时绑定工具表。创建 body 的 agent 必须与随后 `sessions.set` 的席位锁存**同一决定**，
  // 否则 EIMU_PROJECT_MODE=off 时新会话会绑到新 creator，回滚路径直接坏掉。这里只读一次
  // 设置/env，算出决定后把三个键随 state 一起写死（锁存见到已存在的 seat 不再二次读 env）。
  let beastMode = false
  try {
    beastMode = loadUserSettings(key)?.beast_mode === true
  } catch {
    beastMode = false
  }
  const seat = seatDecision({
    mode: projectModeSwitch(),
    userId: seatUserId(key),
    allowlist: projectModeAllowlist(),
    beastMode,
  })
  // 工程席位 → creator；旧席位 → beast ? orchestrator_legacy : creator_legacy（与 S14
  // resolvePromptSeat 的每轮席位逐项一致）。
  const agent = seat.seat === "creator" ? "creator" : seat.beast ? "orchestrator_legacy" : "creator_legacy"
  let res: Response
  try {
    res = await opencodeFetch(`/session`, {
      method: "POST",
      body: JSON.stringify({ agent }),
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
    // S19：与创建 body 同一份决定（不二次读 env）——sessions.set 的锁存见到 seat 已存在即跳过。
    seat: seat.seat,
    projectMode: seat.projectMode,
    beast: seat.beast,
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
