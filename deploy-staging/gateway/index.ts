// 生產 gateway 唯一真源快照（2026-09-15 拉回，8306 行）。勿以 .gateway-work/ 下舊目錄為準（PRD D7）。
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { loadUserSettings, sweepStaleRows } from "./persistence"
import { initSubagent, recoverReworkRunsOnStartup } from "./subagent"
import { setDirectorEmitter, setDirectorSessionResolver } from "./director"
import { setSteerTurnDeliverer } from "./steer-gw.ts"
import { handleSendMessage } from "./messages-gw.ts"
import { resolveSession, sessions, findSessionByOpenCodeId, teardownSession, deleteOpencodeSession, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { corsOriginFor, corsHeaders, encoder, sseTickets, uploadTickets } from "./auth-gw.ts"
import { handleRequest } from "./router.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
import { opencodeHeaders, connectOpencode } from "./opencode-client.ts"
import { opencodeErrorMessage } from "./emit-helpers.ts"
import { loadAgentModelRegistry, bindingRef, personaModel } from "./model-registry.ts"
import type { AgentModelRef } from "./model-registry.ts"
import { normalizeUserSettings } from "./sessions-http.ts"
import { PORT, HEARTBEAT_INTERVAL_MS, CONFIRM_RESOLVED_TTL_MS, SESSION_IDLE_TTL_MS, SESSION_SWEEP_DAYS, SESSION_REAP_INTERVAL_MS, UPLOADS_DIR, OPENCODE_URL } from "./constants-gateway.ts"

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



// ---- HTTP server ----

// ─── Director（片3，2026-09-02）：/agent/v1/director 家族 ───
// emitter/resolver 注入：复用现有 emitToSession 与 resolveSession，不发明新机制。
setDirectorEmitter((sid, name, data) => {
  const st = resolveSession(sid)
  if (st) emitToSession(st, name, data)
})
setDirectorSessionResolver((sid) => {
  const st = resolveSession(sid)
  return st ? { sessionId: st.sessionId, apiKey: st.apiKey } : undefined
})

// ─── REQ-D2（2026-09-22）：steer 回合中引導的投遞縫 ───
// 回合收尾時待投的 steer 要變成「下一回合」，走的必須是既有用戶訊息受理鏈
//（handleSendMessage：記憶注入/計時/閘門/壓縮讓位全套語義），不另造投遞輪子。
// 這條縫是為了不讓 steer-gw → messages-gw → opencode-client → opencode-event-handler
// 繞成新環；合成 Request 只為滿足既有簽名，body 與前端送出的 shape 一致。
setSteerTurnDeliverer(async (state, text) => {
  const req = new Request(`http://gateway.internal/agent/v1/sessions/${state.sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  })
  const res = await handleSendMessage(state.apiKey, state.sessionId, req)
  return res.ok
})

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
// collected. Since 2026-08-29 the upstream opencode session is NOT deleted
// here: message history lives there, and deleting it turned revived sessions
// into empty shells. Cleanup rides the 7-day stale sweep and explicit DELETE.
setInterval(() => {
  const now = Date.now()
  for (const [ticket, rec] of sseTickets) {
    if (rec.expiresAt <= now) sseTickets.delete(ticket)
  }
  for (const [ticket, rec] of uploadTickets) {
    if (rec.expiresAt <= now) uploadTickets.delete(ticket)
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
    teardownSession(id, state, "idle_timeout", true)
    // 2026-08-29 修復「空殼會話」：閒置回收不再刪 opencode 會話與上傳目錄。
    // 訊息歷史權威在 opencode，DB row（keepRow=true）revive 後靠它回填正文；
    // 之前這裡刪掉 opencode → 恢復出來只有殼沒有內容（天天丟記錄）。
    // opencode/上傳的清理只跟 7 天 stale sweep 與顯式 DELETE 走。
    console.log(`[gateway] reaped idle session ${id} after ${Math.round(idleMs / 1000)}s idle`)
  }
  // DB 孤兒 row 清掃：gateway 重啟後無人 reference 的持久化 row（updated_at 超過
  // 7 天）連同 upstream opencode session 與 uploads 一起回收，避免 sessions.db
  // 無限增長。7 天 >> SESSION_IDLE_TTL_MS：寧可晚刪，不誤刪可恢復的會話。
  // 永久保留默認關閉（SESSION_SWEEP_DAYS=0 → sweepRows=[]）；env>0 恢復 N 天清掃。
  const sweepRows = SESSION_SWEEP_DAYS > 0 ? sweepStaleRows(SESSION_SWEEP_DAYS * 24 * 60 * 60 * 1000) : []
  for (const stale of sweepRows) {
    if (sessions.has(stale.sessionId)) continue // 剛被 lazy reload 回來的不動
    void deleteOpencodeSession(stale.opencodeSessionId)
    const staleUploadDir = path.join(UPLOADS_DIR, stale.sessionId)
    if (existsSync(staleUploadDir)) {
      void rm(staleUploadDir, { recursive: true, force: true }).catch(() => {})
    }
    console.log(`[gateway] swept stale persisted session ${stale.sessionId}`)
  }
}, SESSION_REAP_INTERVAL_MS)

// ── R6（2026-09-10）subagent async 完成喚醒 ─────────────────────────────
// async dispatch 的子代理終態（成功/失敗皆喚）時，把結果摘要以系統消息投進
// 父會話並續 turn。輪子 = workflow 喚醒掃描器的 prompt_async 段（2026-09-01 修 3）：
// beastAgentField 帶 agent 欄＋lastPromptBody 落盤＋turn 計數重置＋watchdog 布哨。
// 冪等：finishRun 的 status 守衛保每 run 只喚一次；本函數 turn 在途（ackTimer
// 掛著）時讓位重試一次（60s），仍掛則放棄——結果留在 completed（10 分鐘 TTL）
// 可被 subagent_status 工具查詢，不重複注入。
async function wakeSessionForSubagent(
  parentState: any,
  run: { id: string; label: string; status: "ok" | "error"; summary: string; error?: string },
): Promise<void> {
  if (!parentState) {
    console.warn("[gateway] subagent wake skipped: parent session gone")
    return
  }
  const shortId = String(run.id).slice(0, 8)
  const deliver = async (state: any): Promise<void> => {
    const verdict = run.status === "ok" ? "完成" : "失败"
    const payload = run.status === "ok" ? run.summary : run.error || run.summary || "未知原因"
    const content =
      `【子代理${verdict}·系统自动唤醒】subagent ${shortId}（label="${run.label}"）已${verdict}。` +
      (run.status === "ok" ? `结果摘要：${payload}` : `失败原因：${payload}`) +
      `\n请基于以上真实结果立即继续推进（汇总/补派/返工），并简报当前进度。若尚有其他子代理在跑，可用 subagent_status 工具查询并在简报里说明还剩几路在跑；注意：最终成品未交付前，禁止宣称「已全部完成」，禁止结束回合等待用户——没有可推进动作时也要说明下一步计划。`
    // 刀 1（2026-09-19）：喚醒摘要收集（Jev 測謊題的事實面；有界 16 條，session.idle 消費）。
    state.jevGateSummaries = [...(state.jevGateSummaries ?? [] as string[]), content.slice(0, 300)].slice(-16)
    const body = { ...beastAgentField(state), parts: [{ type: "text", text: content }] }
    const res = await fetch(`${OPENCODE_URL}/session/${state.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    state.lastPromptBody = body
    state.turnGen = (state.turnGen ?? 0) + 1
    state.turnTextChars = 0
    state.turnReasoningChars = 0
    state.turnRetries = 0
    state.turnAborted = false
    state.turnAbortSource = undefined // D2-1b：新輪起點清中止來源（與 turnAborted 同點）
    state.retryQueued = false
    state.turnUpstreamError = null
    state.turnToolStarted = false
    state.watchdogRetried = false
    state.questionAnsweredThisTurn = false
    state.deathDeclared = false
    // 2026-10-02 steer 誤判修復：喚醒輪也是「進行中的回合」——lastTurnActiveAt 是
    // steer 受理閘（steer-gw.turnInFlight）的唯一依據。此漏點曾讓喚醒驅動的會話
    // （MV 全程）所有 steer 被 409 no_active_turn 誤判失敗、前端彈兩條無用提示。
    state.lastTurnActiveAt = Date.now()
    markDirty(state)
    armWatchdogTimer(state)
    console.log(`[gateway] subagent wake resumed: session=${state.sessionId} sub=${shortId} status=${run.status}`)
  }
  try {
    if (parentState.ackTimer != null) {
      console.log(`[gateway] subagent wake deferred (turn in flight): session=${parentState.sessionId} sub=${shortId}`)
      await new Promise((r) => setTimeout(r, 60_000))
      const cur = resolveSession(parentState.sessionId)
      if (!cur || cur.ackTimer != null) {
        console.warn(`[gateway] subagent wake abandoned (turn still in flight): session=${parentState.sessionId} sub=${shortId}`)
        return
      }
    }
    await deliver(parentState)
  } catch (e) {
    console.error(`[gateway] subagent wake dispatch failed: session=${parentState.sessionId} sub=${shortId}:`, e)
  }
}

// 子代理运行时：复用现有 emit/lookup 管道（subagent.* 帧走 emitToSession 出口）。
initSubagent({
  emitToSession,
  resolveSession,
  findSessionByOpenCodeId,
  openCodeUrl: OPENCODE_URL,
  openCodeHeaders: opencodeHeaders,
  // 野獸模式（MOE 改革，2026-09-08）：父會話 settings.beast_mode 布林；dispatch
  // 時快照進 run，任務書頭部注入 Expert 憲法（prompt 約束；物理斷路留樁）。
  beastMode: (parentState: any) => loadUserSettings(parentState?.apiKey)?.beast_mode === true,
  // R6（2026-09-10）async 完成喚醒出口：subagent.ts finishRun 在 async run 終態時
  // 呼叫（成功與失敗皆喚）。輪子見上方 wakeSessionForSubagent（workflow 喚醒同款）。
  wakeParent: wakeSessionForSubagent,
  // 2026-08-31：子代理错误透传 + persona 模型链（与主路径同源，见 subagent.ts 头注）。
  describeError: opencodeErrorMessage,
  subagentModelChain: (parentState: any) => {
    const persona =
      normalizeUserSettings(loadUserSettings(parentState?.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
    const fallbacks = (loadAgentModelRegistry()?.bindings?.fallbacks?.[persona] ?? [])
      .map(bindingRef)
      .filter((r): r is AgentModelRef => r !== null)
    return [personaModel(parentState), ...fallbacks]
  },
})

// Single global connection to opencode's event stream, fanned out per session.
connectOpencode()

// 刀 F（2026-09-15）：啟動掃描 in-flight rework 孤兒（延後一拍讓 opencode /event 先連上、
// 父會話可 lazy 恢復；探針與 wake 都帶超時，失敗留記錄交下次重啟，不卡啟動）。
setTimeout(() => {
  void recoverReworkRunsOnStartup().catch((e) => console.error("[gateway] rework recovery scan failed:", e))
}, 3000)

console.log(`[gateway] listening on :${server.port}, opencode=${OPENCODE_URL}`)

// ── 第一階段橋接 re-export（16 個舊橋接符號已遷入第二階段模組，re-export 保住 import { X } from "./index.ts" 的下游）──
export { contentTypeForExt } from "./uploads-media.ts"
export { opencodeHeaders } from "./opencode-client.ts"
export { getOwnedSession, resolveSession } from "./sessions-core.ts"
export { humanMessageFor } from "./humanize-gw.ts"
export { emitToSession } from "./sse-core.ts"
export { TAIL_PAYLOAD_MARKER } from "./messages-gw.ts"
export { resolveConnectedVideoDuration } from "./workflow-gw.ts"
// 第二階段模組橋接 re-export（media-internal-routes/sessions-http/pricing-gateway/canvas-cascade-state/
// events-translate/plan-gw/sessions-core/outbound-sanitize/opencode-event-handler/workflow-gw 曾以 ./index.ts 橋接的符號）
export { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
export { emitImageDone, emitVideoDone, emitAudioDone, toolErrorPayload, trackTurnNodeTerminal, resolveInvisibleUploadPaths } from "./events-translate.ts"
export { emitSessionError, emitAgentNotice } from "./emit-helpers.ts"
export { emitQuestionRequest, hydratePendingQuestions, rejectOpencodeQuestion, settleQuestion } from "./questions-gw.ts"
export { workflowService, workflowOwnerBySession, workflowSnapshotFor, restoreWorkflowsFromSnapshot, workflowBilling, workflowGenerateApproved, wfGenerateContinuations, runWfGenerate } from "./workflow-gw.ts"
export { memoryRecallPrefetch, memoryRecallInflight, scheduleMemoryRecallPrefetch, memoryPostIngest } from "./memory-wiring.ts"

