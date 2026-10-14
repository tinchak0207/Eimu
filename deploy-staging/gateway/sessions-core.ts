// sessions-core.ts —— 自 index.ts 第二阶段 Wave1 抽取：服务端会话持久化／N1 重启重投／会话解析与 SSE 票据／会话拆除（逐行原样搬运）。
import { rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { initPersistence, saveSession, loadSessionById, loadSessionByOpencodeId, deleteSessionRow, hydrateRow } from "./persistence"
import { forgetCriticPassState } from "./subagent"
import type { SessionState } from "./types-gateway.ts"
import { OPENCODE_URL, UPLOADS_DIR } from "./constants-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { canvasStates } from "./canvas-cascade-state.ts"
import { emitToSession, stripStaleTurnTextFromReplay, closeSessionStreams } from "./sse-core.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { sseTickets, SSE_TICKET_TTL_MS } from "./auth-gw.ts"
import { armWatchdogTimer, armHeartbeatTimer, clearAckTimer, clearWatchdogTimer, clearQuestionHeartbeat } from "./timers-gw.ts"
import { personaModel } from "./model-registry.ts"
import { workflowService, workflowOwnerBySession, workflowSnapshotFor, restoreWorkflowsFromSnapshot } from "./workflow-gw.ts"
import { memoryRecallPrefetch, memoryRecallInflight } from "./memory-wiring.ts"
import { rejectOpencodeQuestion } from "./questions-gw.ts"
import { notify } from "./internal-waiters.ts"
import { recoverSteerCommandsOnRevive } from "./steer-ledger-gw.ts"
// TODO(整合 Wave1): 以下为「仍住 index.ts 且尚未 export」符号的 declare 占位（stage1 记忆「subagent 占位符法」，bun build 不查名可过）。
// 整合阶段把下行注释还原成真 import、删除全部 declare，即完成桥接：
// import { workflowOwnerBySession, workflowSnapshotFor, workflowService, sseTickets, SSE_TICKET_TTL_MS, stripStaleTurnTextFromReplay, armWatchdogTimer, armHeartbeatTimer, personaModel, restoreWorkflowsFromSnapshot, memoryRecallPrefetch, memoryRecallInflight, rejectOpencodeQuestion, clearAckTimer, clearWatchdogTimer, clearQuestionHeartbeat, closeSessionStreams } from "./index.ts"
// ---- 服务端会话持久化（bun:sqlite，见 persistence.ts）----
// 进程重启不再丢会话：session row 落在 sessions.db；getOwnedSession 与事件
// fan-out ���内存 miss 时 lazy reload。讯息历史的权威存储是 opencode（重启不丢），
// DB 只保存 gateway 自有的那部分状态（身分映射 / replayBuffer / 去重集合 / 注入标记）。
initPersistence()
export const sessions = new Map<string, SessionState>()

// dirty 标记 + 防抖 flush：emitToSession 等高频变更只标记，每 3 秒统一落盘；
// 建立/删除走同步写。重启最多丢 3 秒内的 replay 帧，讯息本身永远安全在 opencode。
export const dirtySessions = new Set<string>()
export const PERSIST_FLUSH_INTERVAL_MS = 3000

export function markDirty(state: SessionState): void {
  // 画布快照同步：落盘前把 canvasStates 的最新快照抄回 session（单一事实来源
  // 在 canvasStates，DB 栏位只是它的镜像，重启后回灌用）。
  const snap = canvasStates.get(state.sessionId)
  if (snap && snap.state && typeof snap.state === "object") {
    state.canvasSnapshot = snap.state as SessionState["canvasSnapshot"]
  }
  // 工作流快照同步（同构）：单一事实来源在 workflowService 的 Map，
  // session.workflowSnapshot 只是镜像，重启后回灌用。
  if (workflowOwnerBySession.get(state.sessionId)) {
    state.workflowSnapshot = workflowSnapshotFor(state)
  }
  dirtySessions.add(state.sessionId)
}

export function flushDirtySessions(): void {
  if (dirtySessions.size === 0) return
  for (const id of [...dirtySessions]) {
    const st = sessions.get(id)
    if (!st) {
      // 会话已拆：dirty 标记跟着回收（不是「保存成功」，是已无对象可存）。
      dirtySessions.delete(id)
      continue
    }
    // 旧实作先 clear 再 save：一次失败 = 这一帧永久丢失、且永不重试。
    // 现在只有 saveSession 明确回传成功才清 dirty；失败保留，下一轮（3s 后）自然重试。
    if (saveSession(st)) dirtySessions.delete(id)
  }
}

setInterval(flushDirtySessions, PERSIST_FLUSH_INTERVAL_MS)

// systemd restart（SIGTERM）前把**全部**内存会话写盘，不只是 dirty 的那批。
// 2026-10-13：旧实作只 flush dirty（清完 dirty 再 save、失败不重试），一旦落盘路径
// 出问题，退出前最后一帧就再也没机会补回来。退出前全量写一次成本可忽略，
// 换的是「重启后会话映射不丢」。
export function flushAllSessions(): void {
  for (const st of sessions.values()) {
    try {
      saveSession(st)
    } catch (e) {
      console.error(`[gateway] shutdown flush failed for ${st.sessionId}:`, e)
    }
  }
}

function shutdownFlush(signal: string): void {
  try {
    flushAllSessions()
  } catch (e) {
    // best-effort：flush 失败不阻止退出
    console.error(`[gateway] ${signal} flush error:`, e)
  }
  process.exit(0)
}

process.on("SIGTERM", () => shutdownFlush("SIGTERM"))
process.on("SIGINT", () => shutdownFlush("SIGINT"))

// ── N1 规格3（2026-08-27）：重启斩 turn 的自动重投 ──────────────────
// 评测实锤：opencode-server 重启斩杀 in-flight turn（无 idle、无 turn.done），
// 用户端纯 ping 静默。重启后 session 从 DB 恢复时，若 lastTurnActiveAt
//（turn 开始时打点、正常结束时清零的持久化栏位）非零且距 now 在窗口内 =
// 重启前有 in-flight turn → 自动重投 lastPromptBody（完整档）。
// 幂等保护（三重）：
//   1. 重投前确认 turnGen 未变（恢复期间没有新消息进来）
//   2. 重投前确认 lastTurnActiveAt 仍非零（turn 未正常结束）
//   3. 进程级 Set 防同一 session 重复触发（fan-out + lazy 两条恢复路径）
// 重投失败（opencode 不可达等）→ 诚实告知「服务重启过，上一条消息被中断」，
// 绝不静默。老会话（超过窗口）不追溯重投——避免僵尸会话甦醒刷屏。
export const TURN_REPROMPT_WINDOW_MS = Number.parseInt(process.env.TURN_REPROMPT_WINDOW_MS || "600000", 10) || 600_000
export const repromptedSessions = new Set<string>()

/** R4-A S3②：中断告知帧补投暂存。恢复瞬间常无 SSE 客户端（R4 实锤：帧
 *  发出时无人在线，重连又不带 Last-Event-ID → 用户永远看不到），有客户端
 *  在线则即时可达、不暂存；无客户端则挂到 state，openEventStream 接入时补投。 */
export function stashOrEmitRestoreNotice(state: SessionState, text: string): void {
  emitToSession(state, "message.delta", { text })
  if (state.clients.size === 0) {
    state.pendingRestoreNotice = { text, at: Date.now() }
    console.log(`[gateway] N1 restore notice stashed for next SSE attach — session=${state.sessionId}`)
  }
}

/** R4-A S3②：重投被斩 turn 的共用投递体（原 maybeReprompInterruptedTurn 内联逻辑）。 */export function dispatchInterruptedTurn(state: SessionState, body: NonNullable<SessionState["lastPromptBody"]>, gen: number): void {
  fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`)
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return // 新消息已进来，本条让位
      console.log(`[gateway] N1 reprompt dispatched: session=${cur.sessionId} gen=${gen}`)
      // N2：重投轮从零文本开始——剥掉旧 turn 文本帧，避免重连重放。
      stripStaleTurnTextFromReplay(cur)
      // 重投轮视为新 turn 活动：重置计数、重新布哨（watchdog/ack/心跳）。
      cur.turnTextChars = 0
      cur.turnReasoningChars = 0
      cur.turnUpstreamError = null
      cur.turnToolStarted = false
      cur.watchdogRetried = false
      cur.ackSent = true // 告知帧已发（上面那句），不再补 ack
      cur.lastTurnActiveAt = Date.now()
      cur.recoveryRound = true // R5-C：redrive 属恢复轮
      markDirty(cur)
      armWatchdogTimer(cur)
      armHeartbeatTimer(cur)
    })
    .catch((e: unknown) => {
      console.error(`[gateway] N1 reprompt dispatch failed for ${state.sessionId}:`, e)
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return
      stashOrEmitRestoreNotice(cur, "自动重提失败（后端暂时不可达）。请稍后重新发送上一条消息即可继续。\n")
      emitToSession(cur, "turn.done", {})
      cur.lastTurnActiveAt = 0
      markDirty(cur)
    })
}

/**
 * R4-A S3②：lastPromptBody 不在持久化白名单（persistence.ts 只存白名单栏位，
 * R4 实锤：恢复后 body=undefined，重投降级成一句「请重新发送」且帧无人在线
 * 收不到——13 分钟悬死）。从 opencode 权威历史重推导：最后一条 user 消息即
 * 被斩 turn 的原文，重建 prompt 体重投。取不到 → 诚实降级 + turn.done 收尾。
 */
export async function redriveInterruptedTurn(state: SessionState, gen: number): Promise<void> {
  let text = ""
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const msgs = (await res.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
      if (Array.isArray(msgs)) {
        const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
        text = (lastUser?.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim()
      }
    }
  } catch (e) {
    console.error(`[gateway] N1 redrive: history fetch failed for ${state.sessionId}:`, e)
  }
  const cur = sessions.get(state.sessionId)
  if (!cur || (cur.turnGen ?? 0) !== gen) return // 用户已发新消息，本条让位
  if (!text) {
    // 重推导也失败：诚实降级收尾（要求允许的「建议重发 + turn.done」出口）。
    console.warn(`[gateway] N1 redrive: could not re-derive prompt, honest fallback — session=${state.sessionId}`)
    stashOrEmitRestoreNotice(cur, "服务重启中断了上一条消息的处理，且无法自动重提。请重新发送一次即可继续。\n")
    emitToSession(cur, "turn.done", {})
    cur.lastTurnActiveAt = 0
    markDirty(cur)
    return
  }
  console.log(`[gateway] N1 redrive: re-derived interrupted prompt from opencode history (${text.length} chars), re-dispatching — session=${cur.sessionId}`)
  const body = { parts: [{ type: "text", text }] } as NonNullable<SessionState["lastPromptBody"]>
  body.model = personaModel(cur)
  cur.lastPromptBody = body // 补回投递体：后续看门狗/抖动重试才有弹药
  dispatchInterruptedTurn(cur, body, gen)
}

// Gateway 重启不代表 OpenCode 回合停止。接管只观察原回合，绝不重发 user prompt。
const restoredTurnGenerations = new WeakMap<SessionState, number>()
export function isRestoredGatewayTurn(state: SessionState): boolean {
  return restoredTurnGenerations.get(state) === (state.turnGen ?? 0)
}
export function maybeReprompInterruptedTurn(state: SessionState): void {
  restoredTurnGenerations.set(state, state.turnGen ?? 0)
  if (repromptedSessions.has(state.sessionId)) return
  repromptedSessions.add(state.sessionId)
  void reconcileRestoredGatewayTurn(state)
}
export async function reconcileRestoredGatewayTurn(state: SessionState): Promise<void> {
  if (!isRestoredGatewayTurn(state) || sessions.get(state.sessionId) !== state) return
  try {
    const response = await fetch(`${OPENCODE_URL}/session/status`, {
      headers: opencodeHeaders(), signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return
    const statuses = await response.json() as Record<string, { type?: string }>
    if (!isRestoredGatewayTurn(state) || sessions.get(state.sessionId) !== state) return
    const status = statuses[state.opencodeSessionId]?.type
    if (status === "busy" || status === "retry") {
      if (!(state.lastTurnActiveAt ?? 0)) { state.lastTurnActiveAt = Date.now(); markDirty(state) }
      return
    }
    // idle 不是“没执行”：只有原当前回合权威终态才能补收尾。无证据继续等待。
    const history = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/message`, {
      headers: opencodeHeaders(), signal: AbortSignal.timeout(10000),
    })
    if (!history.ok) return
    const msgs = await history.json() as any[]
    if (!Array.isArray(msgs)) return
    const userIndex = msgs.findLastIndex((m) => m?.info?.role === "user")
    const assistant = msgs.slice(userIndex + 1).findLast((m) => m?.info?.role === "assistant")
    if (!assistant?.info?.time?.completed || (assistant.parts ?? []).some((p: any) =>
      p.type === "tool" && ["pending", "running"].includes(p.state?.status))) return
    if (!isRestoredGatewayTurn(state) || sessions.get(state.sessionId) !== state) return
    if (state.lastTurnActiveAt) {
      state.lastTurnActiveAt = 0
      markDirty(state)
      emitToSession(state, "turn.done", {})
    }
  } catch { /* 未知或暂时不可达不重投、不伪造终态 */ }
}
let restoredReconcileRunning = false
setInterval(() => {
  if (restoredReconcileRunning) return
  restoredReconcileRunning = true
  void Promise.all([...sessions.values()].filter(isRestoredGatewayTurn)
    .map(reconcileRestoredGatewayTurn)).finally(() => { restoredReconcileRunning = false })
}, 15000)



// 内存 miss 时从 DB lazy reload（进程重启后的会话恢复路径）。
// 选 lazy 而非启动全量载入：冷会话占多数，lazy 免付启动成本、不把僵尸
// session 钉在内存，且 reaper 的 idle 规则照常生效。

/**
 * REQ-D2b（2026-09-23）：重启恢复时的 steer 命令身份收口。
 *
 * 会话从 DB 恢复 = 上一条进程（可能）死过。此刻 pendingSteers（volatile）已经不存在，
 * 而持久层的 steer_commands 表还记得每一条命令的最后状态：
 *   * 若是 dispatched（投递已发出、没等到确认）→ 落 uncertain：**不知道**上游收没收到，
 *     说 failed 是假话、重新投递是同一条指引送第二次（本刀要禁的事故）；
 *   * 若是 queued（进程中断于投递前）→ 同样落 uncertain：队列是 volatile 的，永不自动重发。
 * 两个都上报「未确认·未重送」（reason: restart_unconfirmed / restart_never_dispatched）。
 *
 * 帧走 emitToSession → 进 replayBuffer：重连的客户端带 Last-Event-ID 续传时会收到，
 * 徽章不会停在旧的「排队中」。零记录＝零动作（无 steer 的会话与改动前逐位等价）。
 */
function recoverUnconfirmedSteers(state: SessionState): void {
  try {
    for (const frame of recoverSteerCommandsOnRevive(state)) {
      emitToSession(state, "steer.status", frame.data)
    }
  } catch (e) {
    // 恢复失败不得阻止会话恢复（身份层是补强，不是会话活著的必要条件）。
    console.error(`[gateway] steer ledger recovery failed for ${state.sessionId}:`, e)
  }
}

export function hydrateFromDb(id: string): SessionState | null {  const row = loadSessionById(id)
  if (!row) return null
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本档不改）不认得 sessionTasks，重启恢复的 session
  // 该栏为 undefined；此处补空 Map，令所有下游 state.sessionTasks.* 存取安全（在途闸自然放行）。
  if (!state.sessionTasks) state.sessionTasks = new Map()
  sessions.set(state.sessionId, state)
  // 画布快照回灌：DB 镜像 → canvasStates，重启后 /internal/canvas/snapshot
  // 仍能读到完整节点/连线（TTL 重新起算，行为等同活跃画布）。
  if (state.canvasSnapshot && typeof state.canvasSnapshot === "object") {
    canvasStates.set(state.sessionId, { state: state.canvasSnapshot, updatedAt: Date.now() })
  }
  // 工作流快照回灌（对齐 canvas 快照）：DB 镜像 → workflowService，重启后
  // /internal/workflow/status 仍能读到该工作流的真实状态。
  try {
    restoreWorkflowsFromSnapshot(state)
  } catch (e) {
    console.error(`[gateway] workflow restore failed for ${state.sessionId}:`, e)
  }
  console.log(`[gateway] session restored from db: ${state.sessionId} (opencode ${state.opencodeSessionId})`)
  recoverUnconfirmedSteers(state)
  maybeReprompInterruptedTurn(state)
  return state
}

export function getOwnedSession(key: string, id: string): SessionState | null {
  const state = sessions.get(id) ?? hydrateFromDb(id)
  if (!state || state.apiKey !== key) return null
  state.lastActivityAt = Date.now()
  return state
}

// Mint an SSE ticket for a session the caller already owns.
export function issueSseTicket(key: string, sessionId: string): string {
  const ticket = `st_${crypto.randomUUID().replace(/-/g, "")}`
  sseTickets.set(ticket, { sessionId, apiKey: key, expiresAt: Date.now() + SSE_TICKET_TTL_MS })
  return ticket
}

// Redeem a ticket for its session. Expiry is checked here rather than by a
// sweeper alone so a stale entry can never authenticate a stream.
export function redeemSseTicket(ticket: string, sessionId: string): SessionState | null {
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

export function revokeSseTicketsFor(sessionId: string): void {
  for (const [ticket, rec] of sseTickets) {
    if (rec.sessionId === sessionId) sseTickets.delete(ticket)
  }
}

export function findSessionByOpenCodeId(opencodeSessionId: string): SessionState | undefined {
  for (const state of sessions.values()) {
    if (state.opencodeSessionId === opencodeSessionId) return state
  }
  // 内存 miss：重启后 opencode 事件 fan-out 仍能透过 DB 恢复 session 状态，
  // 在途回合的后续事件照常进 replayBuffer。
  const row = loadSessionByOpencodeId(opencodeSessionId)
  if (!row) return undefined
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本档不改）不认得 sessionTasks，重启恢复的 session
  // 该栏为 undefined；此处补空 Map，令所有下游 state.sessionTasks.* 存取安全（在途闸自然放行）。
  if (!state.sessionTasks) state.sessionTasks = new Map()
  sessions.set(state.sessionId, state)
  if (state.canvasSnapshot && typeof state.canvasSnapshot === "object") {
    canvasStates.set(state.sessionId, { state: state.canvasSnapshot, updatedAt: Date.now() })
  }
  try {
    restoreWorkflowsFromSnapshot(state)
  } catch (e) {
    console.error(`[gateway] workflow restore failed for ${state.sessionId}:`, e)
  }
  console.log(`[gateway] session restored from db (event fan-out): ${state.sessionId}`)
  recoverUnconfirmedSteers(state)
  maybeReprompInterruptedTurn(state)
  return state
}

export function resolveSession(id: string): SessionState | undefined {
  // 三段解析：内存 → opencode id（fan-out 路径）→ gateway id（DB 懒加载）。
  // 第三段是 2026-08-27 画布快照修复的一部分：重启后用 gateway session id
  // 查 /internal/canvas/snapshot 也要能触发 DB 恢复（含 canvasStates 回灌），
  // 否则只有 opencode id 形式的查询能恢复。
  const state = sessions.get(id) ?? findSessionByOpenCodeId(id) ?? hydrateFromDb(id)
  if (state) state.lastActivityAt = Date.now()
  return state
}



// Best-effort upstream cleanup. Shared by the explicit DELETE route and the
// idle reaper so a reaped session never leaves an orphan opencode session
// behind (each one holds its own message history on disk).
export async function deleteOpencodeSession(opencodeSessionId: string): Promise<void> {
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
export function teardownSession(id: string, state: SessionState, reason: string, keepRow = false): void {
  sessions.delete(id)
  dirtySessions.delete(id)
  // 工作流拥有权清理：session 已拆，内存工作流一并摘除（idle reap 保留 row 时，
  // 快照仍在 DB，revive 后可再恢复）。
  const wfid = workflowOwnerBySession.get(id)
  if (wfid) {
    workflowOwnerBySession.delete(id)
    const wf = workflowService.get(wfid)
    if (wf && wf.owner === state) workflowService.forget(wfid)
  }
  // idle reaper keeps the sqlite row: lazy reload can revive the session later.
  // Only explicit DELETE removes the durable record.
  if (!keepRow) deleteSessionRow(id) // 持久化镜像：teardown（DELETE / idle reap）同步删 row
  revokeSseTicketsFor(id) // a ticket must not outlive the session it names
  repromptedSessions.delete(id) // N1：重投去重集合随会话拆除回收，防记忆体缓涨
  // 刀 2：机器 critic pass 内存状态（待审清单/派遣登记/已用旗标）随会话回收。
  // idle reap（keepRow=true）只是内存回收、DB row 保留可 revive —— 不清持久旗标
  //（revive 后仍受「每会话 ≤1 次」约束），但内存镜像要清防缓涨。
  if (!keepRow) forgetCriticPassState(id)
  memoryRecallPrefetch.delete(id) // §7 召回预取缓存随会话销毁清理（2026-09-15 PRD P0-4）
  memoryRecallInflight.delete(id)
  // A pending spend must never auto-approve on teardown. Record the denial
  // rather than just dropping it: a tool still polling has to be able to read
  // the answer, and after teardown this state object is all that is left.
  for (const [requestId, pending] of state.pendingConfirms) {
    clearTimeout(pending.timer)
    state.resolvedConfirms.set(requestId, { outcome: "denied", resolvedAt: Date.now() })
    emitToSession(state, "confirm.resolved", { request_id: requestId, approved: false })
    // WP2（2026-10-14）：拆除路径绕过 settleConfirm，须自行叫醒该 confirm 的长挂起 waiter
    //（否则 wait_ms 要等满才 abort 唤醒，最长 60s）。只补 notify——不改本循环既有 emit/落账语义
    //（settleConfirm 的 denied 分支会额外 resumeWorkflowGate(false)，此处刻意不引入以保行为不变）。
    notify(`confirm:${state.sessionId}:${requestId}`)
  }
  state.pendingConfirms.clear()
  for (const [requestId] of state.pendingQuestions) {
    emitToSession(state, "question.rejected", { request_id: requestId, reason: reason || "session_closed" })
    void rejectOpencodeQuestion(requestId, state.opencodeSessionId)
  }
  state.pendingQuestions.clear()
  clearAckTimer(state) // S6：会话拆了，ack timer 不得再触发（发了也没人收）
  clearWatchdogTimer(state) // R2-A：看门狗同撤，不得对死会话重投
  clearQuestionHeartbeat(state) // R8-B：question 心跳同撤
  state.pendingVideoWorkflows = [] // 冻结的工作流随会话一并作废
  // 2026-09-12：idle reap（keepRow=true）是内存回收不是会话死亡。emitToSession 会把 closed 帧
  // 写进 replayBuffer 并落盘，之后任何 Last-Event-ID=0 的回放都会带上它 → 前端按合同把会话
  // 判死，永久锁死。只有真删除（keepRow=false：用户 end()/DELETE）才宣告 session.closed。
  if (!keepRow) emitToSession(state, "session.closed", { reason })
  closeSessionStreams(state)
}

export async function handleDeleteSession(key: string, id: string): Promise<Response> {
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
