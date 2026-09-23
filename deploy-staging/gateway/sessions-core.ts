// sessions-core.ts —— 自 index.ts 第二階段 Wave1 抽取：服務端會話持久化／N1 重啟重投／會話解析與 SSE 票據／會話拆除（逐行原樣搬運）。
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
import { recoverSteerCommandsOnRevive } from "./steer-ledger-gw.ts"
// TODO(整合 Wave1): 以下為「仍住 index.ts 且尚未 export」符號的 declare 佔位（stage1 記憶「subagent 佔位符法」，bun build 不查名可過）。
// 整合階段把下行註釋還原成真 import、刪除全部 declare，即完成橋接：
// import { workflowOwnerBySession, workflowSnapshotFor, workflowService, sseTickets, SSE_TICKET_TTL_MS, stripStaleTurnTextFromReplay, armWatchdogTimer, armHeartbeatTimer, personaModel, restoreWorkflowsFromSnapshot, memoryRecallPrefetch, memoryRecallInflight, rejectOpencodeQuestion, clearAckTimer, clearWatchdogTimer, clearQuestionHeartbeat, closeSessionStreams } from "./index.ts"
// ---- 服務端會話持久化（bun:sqlite，見 persistence.ts）----
// 進程重啟不再丟會話：session row 落在 sessions.db；getOwnedSession 與事件
// fan-out ���內存 miss 時 lazy reload。訊息歷史的權威存儲是 opencode（重啟不丟），
// DB 只保存 gateway 自有的那部分狀態（身分映射 / replayBuffer / 去重集合 / 注入標記）。
initPersistence()
export const sessions = new Map<string, SessionState>()

// dirty 標記 + 防抖 flush：emitToSession 等高頻變更只標記，每 3 秒統一落盤；
// 建立/刪除走同步寫。重啟最多丟 3 秒內的 replay 幀，訊息本身永遠安全在 opencode。
export const dirtySessions = new Set<string>()
export const PERSIST_FLUSH_INTERVAL_MS = 3000

export function markDirty(state: SessionState): void {
  // 畫布快照同步：落盤前把 canvasStates 的最新快照抄回 session（單一事實來源
  // 在 canvasStates，DB 欄位只是它的鏡像，重啟後回灌用）。
  const snap = canvasStates.get(state.sessionId)
  if (snap && snap.state && typeof snap.state === "object") {
    state.canvasSnapshot = snap.state as SessionState["canvasSnapshot"]
  }
  // 工作流快照同步（同構）：單一事實來源在 workflowService 的 Map，
  // session.workflowSnapshot 只是鏡像，重啟後回灌用。
  if (workflowOwnerBySession.get(state.sessionId)) {
    state.workflowSnapshot = workflowSnapshotFor(state)
  }
  dirtySessions.add(state.sessionId)
}

export function flushDirtySessions(): void {
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

// ── N1 規格3（2026-08-27）：重啟斬 turn 的自動重投 ──────────────────
// 評測實錘：opencode-server 重啟斬殺 in-flight turn（無 idle、無 turn.done），
// 用戶端純 ping 靜默。重啟後 session 從 DB 恢復時，若 lastTurnActiveAt
//（turn 開始時打點、正常結束時清零的持久化欄位）非零且距 now 在窗口內 =
// 重啟前有 in-flight turn → 自動重投 lastPromptBody（完整檔）。
// 冪等保護（三重）：
//   1. 重投前確認 turnGen 未變（恢復期間沒有新消息進來）
//   2. 重投前確認 lastTurnActiveAt 仍非零（turn 未正常結束）
//   3. 進程級 Set 防同一 session 重複觸發（fan-out + lazy 兩條恢復路徑）
// 重投失敗（opencode 不可達等）→ 誠實告知「服務重啟過，上一條消息被中斷」，
// 絕不靜默。老會話（超過窗口）不追溯重投——避免殭屍會話甦醒刷屏。
export const TURN_REPROMPT_WINDOW_MS = Number.parseInt(process.env.TURN_REPROMPT_WINDOW_MS || "600000", 10) || 600_000
export const repromptedSessions = new Set<string>()

/** R4-A S3②：中斷告知幀補投暫存。恢復瞬間常無 SSE 客戶端（R4 實錘：幀
 *  發出時無人在線，重連又不帶 Last-Event-ID → 用戶永遠看不到），有客戶端
 *  在線則即時可達、不暫存；無客戶端則掛到 state，openEventStream 接入時補投。 */
export function stashOrEmitRestoreNotice(state: SessionState, text: string): void {
  emitToSession(state, "message.delta", { text })
  if (state.clients.size === 0) {
    state.pendingRestoreNotice = { text, at: Date.now() }
    console.log(`[gateway] N1 restore notice stashed for next SSE attach — session=${state.sessionId}`)
  }
}

/** R4-A S3②：重投被斬 turn 的共用投遞體（原 maybeReprompInterruptedTurn 內聯邏輯）。 */export function dispatchInterruptedTurn(state: SessionState, body: NonNullable<SessionState["lastPromptBody"]>, gen: number): void {
  fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
    method: "POST",
    headers: opencodeHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`)
      const cur = sessions.get(state.sessionId)
      if (!cur || (cur.turnGen ?? 0) !== gen) return // 新消息已進來，本條讓位
      console.log(`[gateway] N1 reprompt dispatched: session=${cur.sessionId} gen=${gen}`)
      // N2：重投輪從零文本開始——剝掉舊 turn 文本幀，避免重連重放。
      stripStaleTurnTextFromReplay(cur)
      // 重投輪視為新 turn 活動：重置計數、重新布哨（watchdog/ack/心跳）。
      cur.turnTextChars = 0
      cur.turnReasoningChars = 0
      cur.turnUpstreamError = null
      cur.turnToolStarted = false
      cur.watchdogRetried = false
      cur.ackSent = true // 告知幀已發（上面那句），不再補 ack
      cur.lastTurnActiveAt = Date.now()
      cur.recoveryRound = true // R5-C：redrive 屬恢復輪
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
 * R4-A S3②：lastPromptBody 不在持久化白名單（persistence.ts 只存白名單欄位，
 * R4 實錘：恢復後 body=undefined，重投降級成一句「请重新发送」且幀無人在線
 * 收不到——13 分鐘懸死）。從 opencode 權威歷史重推導：最後一條 user 消息即
 * 被斬 turn 的原文，重建 prompt 體重投。取不到 → 誠實降級 + turn.done 收尾。
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
  if (!cur || (cur.turnGen ?? 0) !== gen) return // 用戶已發新消息，本條讓位
  if (!text) {
    // 重推導也失敗：誠實降級收尾（要求允許的「建議重發 + turn.done」出口）。
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
  cur.lastPromptBody = body // 補回投遞體：後續看門狗/抖動重試才有彈藥
  dispatchInterruptedTurn(cur, body, gen)
}

export function maybeReprompInterruptedTurn(state: SessionState): void {
  const at = state.lastTurnActiveAt ?? 0
  if (!at || Date.now() - at > TURN_REPROMPT_WINDOW_MS) return
  if (repromptedSessions.has(state.sessionId)) return // 已處理過（雙恢復路徑）
  repromptedSessions.add(state.sessionId)
  const body = state.lastPromptBody
  const gen = state.turnGen ?? 0
  console.log(`[gateway] N1 reprompt: in-flight turn detected at restore (gen=${gen}, ${Math.round((Date.now() - at) / 1000)}s ago) — session=${state.sessionId}`)
  // 誠實告知先行（無論重投成敗，用戶都該知道發生過中斷）；無在線客戶端時
  // 暫存待 SSE 接入補投（R4-A S3②）。
  stashOrEmitRestoreNotice(state, "服务刚经历过一次重启，你上一条消息的处理被中断了。正在为你自动重新提交…\n")
  if (!body) {
    // R4 實錘缺口：lastPromptBody 未持久化 → 舊路徑在這裡只發一句降級話術
    // 就收工（且幀常無人在線收不到）。改為從 opencode 歷史重推導並重投。
    void redriveInterruptedTurn(state, gen)
    return
  }
  dispatchInterruptedTurn(state, body, gen)
}


// 內存 miss 時從 DB lazy reload（進程重啟後的會話恢復路徑）。
// 選 lazy 而非啟動全量載入：冷會話佔多數，lazy 免付啟動成本、不把殭屍
// session 釘在內存，且 reaper 的 idle 規則照常生效。

/**
 * REQ-D2b（2026-09-23）：重啟恢復時的 steer 命令身份收口。
 *
 * 會話從 DB 恢復 = 上一條進程（可能）死過。此刻 pendingSteers（volatile）已經不存在，
 * 而持久層的 steer_commands 表還記得每一條命令的最後狀態：
 *   * 若是 dispatched（投遞已發出、沒等到確認）→ 落 uncertain：**不知道**上游收沒收到，
 *     說 failed 是假話、重新投遞是同一條指引送第二次（本刀要禁的事故）；
 *   * 若是 queued（進程中斷於投遞前）→ 同樣落 uncertain：隊列是 volatile 的，永不自動重發。
 * 兩個都上報「未確認·未重送」（reason: restart_unconfirmed / restart_never_dispatched）。
 *
 * 幀走 emitToSession → 進 replayBuffer：重連的客戶端帶 Last-Event-ID 續傳時會收到，
 * 徽章不會停在舊的「排队中」。零記錄＝零動作（無 steer 的會話與改動前逐位等價）。
 */
function recoverUnconfirmedSteers(state: SessionState): void {
  try {
    for (const frame of recoverSteerCommandsOnRevive(state)) {
      emitToSession(state, "steer.status", frame.data)
    }
  } catch (e) {
    // 恢復失敗不得阻止會話恢復（身份層是補強，不是會話活著的必要條件）。
    console.error(`[gateway] steer ledger recovery failed for ${state.sessionId}:`, e)
  }
}

export function hydrateFromDb(id: string): SessionState | null {  const row = loadSessionById(id)
  if (!row) return null
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本檔不改）不認得 sessionTasks，重啟恢復的 session
  // 該欄為 undefined；此處補空 Map，令所有下游 state.sessionTasks.* 存取安全（在途閘自然放行）。
  if (!state.sessionTasks) state.sessionTasks = new Map()
  sessions.set(state.sessionId, state)
  // 畫布快照回灌：DB 鏡像 → canvasStates，重啟後 /internal/canvas/snapshot
  // 仍能讀到完整節點/連線（TTL 重新起算，行為等同活躍畫布）。
  if (state.canvasSnapshot && typeof state.canvasSnapshot === "object") {
    canvasStates.set(state.sessionId, { state: state.canvasSnapshot, updatedAt: Date.now() })
  }
  // 工作流快照回灌（對齊 canvas 快照）：DB 鏡像 → workflowService，重啟後
  // /internal/workflow/status 仍能讀到該工作流的真實狀態。
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
  // 內存 miss：重啟後 opencode 事件 fan-out 仍能透過 DB 恢復 session 狀態，
  // 在途回合的後續事件照常進 replayBuffer。
  const row = loadSessionByOpencodeId(opencodeSessionId)
  if (!row) return undefined
  const state = hydrateRow(row) as unknown as SessionState
  // 0831：hydrateRow（persistence.ts，本檔不改）不認得 sessionTasks，重啟恢復的 session
  // 該欄為 undefined；此處補空 Map，令所有下游 state.sessionTasks.* 存取安全（在途閘自然放行）。
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
  // 三段解析：內存 → opencode id（fan-out 路徑）→ gateway id（DB 懶加載）。
  // 第三段是 2026-08-27 畫布快照修復的一部分：重啟後用 gateway session id
  // 查 /internal/canvas/snapshot 也要能觸發 DB 恢復（含 canvasStates 回灌），
  // 否則只有 opencode id 形式的查詢能恢復。
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
  // 工作流擁有權清理：session 已拆，內存工作流一併摘除（idle reap 保留 row 時，
  // 快照仍在 DB，revive 後可再恢復）。
  const wfid = workflowOwnerBySession.get(id)
  if (wfid) {
    workflowOwnerBySession.delete(id)
    const wf = workflowService.get(wfid)
    if (wf && wf.owner === state) workflowService.forget(wfid)
  }
  // idle reaper keeps the sqlite row: lazy reload can revive the session later.
  // Only explicit DELETE removes the durable record.
  if (!keepRow) deleteSessionRow(id) // 持久化鏡像：teardown（DELETE / idle reap）同步刪 row
  revokeSseTicketsFor(id) // a ticket must not outlive the session it names
  repromptedSessions.delete(id) // N1：重投去重集合隨會話拆除回收，防記憶體緩漲
  // 刀 2：機器 critic pass 內存狀態（待審清單/派遣登記/已用旗標）隨會話回收。
  // idle reap（keepRow=true）只是內存回收、DB row 保留可 revive —— 不清持久旗標
  //（revive 後仍受「每會話 ≤1 次」約束），但內存鏡像要清防緩漲。
  if (!keepRow) forgetCriticPassState(id)
  memoryRecallPrefetch.delete(id) // §7 召回預取緩存隨會話銷毀清理（2026-09-15 PRD P0-4）
  memoryRecallInflight.delete(id)
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
  clearAckTimer(state) // S6：會話拆了，ack timer 不得再觸發（發了也沒人收）
  clearWatchdogTimer(state) // R2-A：看門狗同撤，不得對死會話重投
  clearQuestionHeartbeat(state) // R8-B：question 心跳同撤
  state.pendingVideoWorkflows = [] // 凍結的工作流隨會話一併作廢
  // 2026-09-12：idle reap（keepRow=true）是內存回收不是會話死亡。emitToSession 會把 closed 幀
  // 寫進 replayBuffer 並落盤，之後任何 Last-Event-ID=0 的回放都會帶上它 → 前端按合同把會話
  // 判死，永久鎖死。只有真刪除（keepRow=false：用戶 end()/DELETE）才宣告 session.closed。
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
