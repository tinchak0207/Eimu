// questions-gw.ts —— 自 index.ts 第二階段 Wave3 抽取：question 工具鏈（normalizeQuestionOptions/normalizeQuestionItems/isQuestionAnswers/lookupOpencodeQuestion/emitQuestionRequest/hydratePendingQuestions/rejectOpencodeQuestion/handleQuestion/settleQuestion），原 index.ts 5181–5450 行，逐行機械搬運。
import type { PendingQuestion, SessionState } from "./types-gateway.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { opencodeFetch } from "./opencode-client.ts"
import { jsonError } from "./gw-lib.ts"
import { armQuestionHeartbeat, armQuestionAssumeTimer, clearQuestionHeartbeat, armMidturnStallTimer } from "./timers-gw.ts"
// 2026-10-02：記錄「用戶真的答覆過 question」。此紀錄是模板偏離（deviate_from_template）
// 的「用戶同意憑據」——模型自宣告不等於有用戶同意，須以網關記錄的用戶真答覆為準。
// 只在 handleQuestion（用戶真答覆）路徑記；settleQuestion 的自動跳過代答與 3 分鐘超時
// 自動代答**都不是用戶同意**，一律不記（見下方 handleQuestion 成功分支）。
import { markUserAnsweredQuestion } from "./canvas-cascade-state.ts"
// TODO(整合 Wave3): timers 同波 W13 在建 timers-gw.ts（armAckTimer/armHeartbeatTimer/... ），落地後換成真 import（bun build 硬查 named import）。
export function normalizeQuestionOptions(raw: unknown): Array<{ label: string; description?: string }> {
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

export function normalizeQuestionItems(raw: unknown): PendingQuestion["questions"] {
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

export function isQuestionAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" && cell.length > 0))
}

export async function lookupOpencodeQuestion(state: SessionState, callId: string): Promise<{ id: string; questions: PendingQuestion["questions"] } | null> {
  const urls = [
    `/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `/question`,
  ]
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, {
        timeoutMs: 5000,
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
        if (toolCallId && toolCallId !== callId) continue
        // 2026-08-31: 移除 sessionID 過濾——opencode question record 的
        // sessionID 常是幽靈 session（不存在於 session 清單），會濾掉全部卡片。
        // tool.callID 已全域唯一，無跨 session 誤配風險。
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

export async function emitQuestionRequest(state: SessionState, callId: string, input: unknown): Promise<void> {
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
  // R8-B 工單 #3：pending 期間 30s 心跳接管用戶可見性（R8 實錘 129s 零幀死寂）。
  armQuestionHeartbeat(state)
  // 片AJ：3 分鐘無人回覆按推薦方案代答繼續（assumed）。
  armQuestionAssumeTimer(state)
}

export async function hydratePendingQuestions(state: SessionState): Promise<void> {
  const urls = [
    `/api/session/${encodeURIComponent(state.opencodeSessionId)}/question`,
    `/question`,
  ]
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, {
        timeoutMs: 5000,
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
        // 2026-08-31: 同 lookupOpencodeQuestion，移除 sessionID 過濾（幽靈 session 誤殺）
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        if (state.pendingQuestions.has(id)) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const callId = typeof tool?.callID === "string" ? tool.callID : ""
        state.pendingQuestions.set(id, { requestId: id, callId, questions })
        emitToSession(state, "question.request", { request_id: id, questions })
        // R8-B 工單 #3：hydrate 出的 pending question 同樣布心跳。
        armQuestionHeartbeat(state)
        // 片AJ：hydrate 的 pending 同樣布 3 分鐘代答哨。
        armQuestionAssumeTimer(state)
      }
      return
    } catch {
      // try the next lookup path
    }
  }
}

export async function rejectOpencodeQuestion(requestId: string, sessionId: string): Promise<void> {
  const urls = [
    `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
    `/question/${encodeURIComponent(requestId)}/reject`,
  ]
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, {
        method: "POST",
        body: "{}",
        timeoutMs: 5000,
      })
      if (res.ok || res.status === 404) return
    } catch {
      // best-effort
    }
  }
}

export async function handleQuestion(key: string, id: string, req: Request): Promise<Response> {
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
    `/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `/question/${encodeURIComponent(requestId)}/reply`,
  ]
  let lastStatus = 0
  let lastText = ""
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, {
        method: "POST",
        body: JSON.stringify({ answers: body.answers }),
        timeoutMs: 8000,
      })
      if (res.ok) {
        state.pendingQuestions.delete(requestId)
        const answerText = body.answers.flat().find((cell) => cell.length > 0) ?? ""
        // R8-B 工單 #4：記錄答覆語義。opencode 的 reply 端點會把 answers 作為
        // question 工具結果回灌模型上下文（R8 實錘模型正確執行「先看第三章」
        // /「就地打住」）；gateway 側職責 = 不再用兜底結語「要繼續跑嗎」自我推翻
        //（emitRecoveryClosingIfSilent 讓位），並把哨兵打點刷新到恢復段起點。
        state.questionAnsweredThisTurn = true
        state.turnFrozenByQuestion = false
        // 2026-10-02：這是「用戶真答覆」路徑（用戶在 question 卡上實際作答）→ 記錄同意憑據，
        // 供模板偏離（deviate_from_template）當「用戶同意」的機器可驗事實。settleQuestion 的
        // 自動跳過代答與 3 分鐘超時自動代答不走這裡，故不會被誤記為同意。
        markUserAnsweredQuestion(state.sessionId)
        if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
        state.turnLastFrameAt = Date.now()
        state.turnProgressAt = Date.now()
        state.lastUserVisibleAt = Date.now()
        // 恢復段重新布哨：若答覆後 opencode 未續跑，中段停滯哨 90s 兜底；
        // pending 期間停滯哨會讓位（見 armMidturnStallTimer），此處已清空 pending。
        armMidturnStallTimer(state)
        emitToSession(state, "question.replied", { request_id: requestId, answer: answerText })
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

// R9-2（2026-08-30）：question pending 時新消息入口的自動跳過代答。轉發核心
// 逐行複製 handleQuestion 的 reply 鏈路（雙 URL 兜底 + ok 後同款記賬），只換
// answer 內容為跳過語義；best-effort——上游失敗不拋出，由調用方清 Map 並照常
// 發新消息。
export async function settleQuestion(state: SessionState, requestId: string, answerOverride?: string): Promise<void> {
  const answerText = answerOverride ?? "（用户已转向新话题，本问题自动跳过）"
  // reply 端點要求 answers 為 string[][] 且每格非空（isQuestionAnswers 同款），
  // 一行對應一道 question：逐題填充同一句跳過文案。
  const pending = state.pendingQuestions.get(requestId)
  const answers = Array.from({ length: Math.max(pending?.questions.length ?? 1, 1) }, () => [answerText])
  const urls = [
    `/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `/question/${encodeURIComponent(requestId)}/reply`,
  ]
  let replied = false
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, {
        method: "POST",
        body: JSON.stringify({ answers }),
        timeoutMs: 8000,
      })
      if (res.ok) {
        replied = true
        break
      }
      if (res.status !== 404) break
    } catch {
      // best-effort
    }
  }
  state.pendingQuestions.delete(requestId)
  if (replied) {
    // ok 後記賬同 handleQuestion：答覆語義標記 + 時間戳刷新。此處布的中段哨捕獲舊
    // turnGen，handleSendMessage 隨後 bump turnGen，tick 因 gen
    // 不匹配自行失效，無殘留（見 armMidturnStallTimer 守衛）。
    state.questionAnsweredThisTurn = true
    state.turnFrozenByQuestion = false
    if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
    state.turnLastFrameAt = Date.now()
    state.turnProgressAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    armMidturnStallTimer(state)
  }
  // 無論上游成敗都按既有形態 emit：前端 question 卡必須變已決，否則永遠 pending。
  emitToSession(state, "question.replied", { request_id: requestId, answer: answerText })
}
