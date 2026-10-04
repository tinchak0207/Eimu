// questions-gw.ts —— 自 index.ts 第二阶段 Wave3 抽取：question 工具链（normalizeQuestionOptions/normalizeQuestionItems/isQuestionAnswers/lookupOpencodeQuestion/emitQuestionRequest/hydratePendingQuestions/rejectOpencodeQuestion/handleQuestion/settleQuestion），原 index.ts 5181–5450 行，逐行机械搬运。
import type { PendingQuestion, SessionState } from "./types-gateway.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { opencodeFetch } from "./opencode-client.ts"
import { jsonError } from "./gw-lib.ts"
import { armQuestionHeartbeat, armQuestionAssumeTimer, clearQuestionHeartbeat, armMidturnStallTimer } from "./timers-gw.ts"
// 2026-10-02：记录「用户真的答覆过 question」。此纪录是模板偏离（deviate_from_template）
// 的「用户同意凭据」——模型自宣告不等于有用户同意，须以网关记录的用户真答覆为准。
// 只在 handleQuestion（用户真答覆）路径记；settleQuestion 的自动跳过代答与 3 分钟超时
// 自动代答**都不是用户同意**，一律不记（见下方 handleQuestion 成功分支）。
import { markUserAnsweredQuestion } from "./canvas-cascade-state.ts"
// TODO(整合 Wave3): timers 同波 W13 在建 timers-gw.ts（armAckTimer/armHeartbeatTimer/... ），落地后换成真 import（bun build 硬查 named import）。
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
        // 2026-08-31: 移除 sessionID 过滤——opencode question record 的
        // sessionID 常是幽灵 session（不存在于 session 清单），会滤掉全部卡片。
        // tool.callID 已全域唯一，无跨 session 误配风险。
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
  // R8-B 工单 #3：pending 期间 30s 心跳接管用户可见性（R8 实锤 129s 零帧死寂）。
  armQuestionHeartbeat(state)
  // 片AJ：3 分钟无人回覆按推荐方案代答继续（assumed）。
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
        // 2026-08-31: 同 lookupOpencodeQuestion，移除 sessionID 过滤（幽灵 session 误杀）
        const questions = normalizeQuestionItems(rec.questions)
        if (questions.length === 0) continue
        if (state.pendingQuestions.has(id)) continue
        const tool = rec.tool && typeof rec.tool === "object" ? (rec.tool as Record<string, unknown>) : null
        const callId = typeof tool?.callID === "string" ? tool.callID : ""
        state.pendingQuestions.set(id, { requestId: id, callId, questions })
        emitToSession(state, "question.request", { request_id: id, questions })
        // R8-B 工单 #3：hydrate 出的 pending question 同样布心跳。
        armQuestionHeartbeat(state)
        // 片AJ：hydrate 的 pending 同样布 3 分钟代答哨。
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
        // R8-B 工单 #4：记录答覆语义。opencode 的 reply 端点会把 answers 作为
        // question 工具结果回灌模型上下文（R8 实锤模型正确执行「先看第三章」
        // /「就地打住」）；gateway 侧职责 = 不再用兜底结语「要继续跑吗」自我推翻
        //（emitRecoveryClosingIfSilent 让位），并把哨兵打点刷新到恢复段起点。
        state.questionAnsweredThisTurn = true
        state.turnFrozenByQuestion = false
        // 2026-10-02：这是「用户真答覆」路径（用户在 question 卡上实际作答）→ 记录同意凭据，
        // 供模板偏离（deviate_from_template）当「用户同意」的机器可验事实。settleQuestion 的
        // 自动跳过代答与 3 分钟超时自动代答不走这里，故不会被误记为同意。
        markUserAnsweredQuestion(state.sessionId)
        if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
        state.turnLastFrameAt = Date.now()
        state.turnProgressAt = Date.now()
        state.lastUserVisibleAt = Date.now()
        // 恢复段重新布哨：若答覆后 opencode 未续跑，中段停滞哨 90s 兜底；
        // pending 期间停滞哨会让位（见 armMidturnStallTimer），此处已清空 pending。
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

// R9-2（2026-08-30）：question pending 时新消息入口的自动跳过代答。转发核心
// 逐行复制 handleQuestion 的 reply 链路（双 URL 兜底 + ok 后同款记账），只换
// answer 内容为跳过语义；best-effort——上游失败不抛出，由调用方清 Map 并照常
// 发新消息。
export async function settleQuestion(state: SessionState, requestId: string, answerOverride?: string): Promise<void> {
  const answerText = answerOverride ?? "（用户已转向新话题，本问题自动跳过）"
  // reply 端点要求 answers 为 string[][] 且每格非空（isQuestionAnswers 同款），
  // 一行对应一道 question：逐题填充同一句跳过文案。
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
    // ok 后记账同 handleQuestion：答覆语义标记 + 时间戳刷新。此处布的中段哨捕获旧
    // turnGen，handleSendMessage 随后 bump turnGen，tick 因 gen
    // 不匹配自行失效，无残留（见 armMidturnStallTimer 守卫）。
    state.questionAnsweredThisTurn = true
    state.turnFrozenByQuestion = false
    if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
    state.turnLastFrameAt = Date.now()
    state.turnProgressAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    armMidturnStallTimer(state)
  }
  // 无论上游成败都按既有形态 emit：前端 question 卡必须变已决，否则永远 pending。
  emitToSession(state, "question.replied", { request_id: requestId, answer: answerText })
}
