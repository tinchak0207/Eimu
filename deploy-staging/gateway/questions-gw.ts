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
import { planQuantityGuard, mergeGuardedAnswers } from "./question-quantity-guard.ts"
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

/** 用户真答覆必须是「非空行 × 非空 cell」：`[[]]`、`[["x"],[]]`、`[[""]]` 都不是答覆。 */
export function isQuestionAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(
    (row) =>
      Array.isArray(row) &&
      row.length > 0 &&
      row.every((cell) => typeof cell === "string" && cell.trim().length > 0),
  )
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

// 2026-11-04 数量闸：用户原话已明确数量=1 而模型弹「N 候选／N 张」扩量问卡 → 不展示，直接以单量代答。
// 按 callId 记「已处置」，防 pending/running 多次触发 emitQuestionRequest 重复代答（第二次 reply 会 404）。
const quantityGuardHandled = new WeakMap<SessionState, Set<string>>()

async function replyOpencodeQuestion(state: SessionState, requestId: string, answers: string[][]): Promise<boolean> {
  const urls = [
    `/api/session/${encodeURIComponent(state.opencodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    `/question/${encodeURIComponent(requestId)}/reply`,
  ]
  for (const url of urls) {
    try {
      const res = await opencodeFetch(url, { method: "POST", body: JSON.stringify({ answers }), timeoutMs: 8000 })
      if (res.ok) return true
      if (res.status !== 404) return false
    } catch {
      // try next
    }
  }
  return false
}

/**
 * 返回 true＝已被数量闸整张代答（调用方不得再展示）；false＝照常展示（visibleQuestions/guardMerge 经 out 带回）。
 * 代答失败（上游不通）时退回「照常展示」，绝不静默吞卡。
 */
async function applyQuantityGuard(
  state: SessionState,
  requestId: string,
  callId: string,
  questions: PendingQuestion["questions"],
): Promise<{ handled: boolean; questions: PendingQuestion["questions"]; guardMerge?: PendingQuestion["guardMerge"] }> {
  const plan = planQuantityGuard(state.lastUserMessage, questions)
  if (plan.kind === "none") return { handled: false, questions }
  if (plan.kind === "partial") {
    console.warn(`[gateway] question-quantity-guard partial session=${state.sessionId} req=${requestId} hidden=${plan.merge.auto.length}/${plan.merge.total}`)
    return { handled: false, questions: plan.visible, guardMerge: plan.merge }
  }
  const seen = quantityGuardHandled.get(state) ?? new Set<string>()
  quantityGuardHandled.set(state, seen)
  const key = callId || requestId
  if (seen.has(key)) return { handled: true, questions }
  seen.add(key)
  const ok = await replyOpencodeQuestion(state, requestId, plan.answers)
  if (!ok) {
    seen.delete(key)
    console.warn(`[gateway] question-quantity-guard reply failed session=${state.sessionId} req=${requestId}; fall back to showing the card`)
    return { handled: false, questions }
  }
  console.warn(`[gateway] question-quantity-guard auto-answered session=${state.sessionId} req=${requestId} answers=${JSON.stringify(plan.answers).slice(0, 120)}`)
  // 不是用户同意：不 markUserAnsweredQuestion、不置 questionAnsweredThisTurn。刷新进度哨，等模型续跑。
  state.turnLastFrameAt = Date.now()
  state.turnProgressAt = Date.now()
  armMidturnStallTimer(state)
  return { handled: true, questions }
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
  const guarded = await applyQuantityGuard(state, requestId, callId, questions)
  if (guarded.handled) return
  if (state.pendingQuestions.has(requestId)) return
  state.pendingQuestions.set(requestId, { requestId, callId, questions: guarded.questions, ...(guarded.guardMerge ? { guardMerge: guarded.guardMerge } : {}) })
  emitToSession(state, "question.request", { request_id: requestId, questions: guarded.questions })
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
        const guarded = await applyQuantityGuard(state, id, callId, questions)
        if (guarded.handled) continue
        state.pendingQuestions.set(id, { requestId: id, callId, questions: guarded.questions, ...(guarded.guardMerge ? { guardMerge: guarded.guardMerge } : {}) })
        emitToSession(state, "question.request", { request_id: id, questions: guarded.questions })
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
      if (res.ok) return
    } catch {
      // best-effort
    }
  }
  throw new Error("question_reject_unconfirmed")
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
  // 数量闸 partial：卡里只展示了部分子问题，其余已代答——把用户答案按原序合并回完整 answers 再回给 opencode。
  const guardMerge = state.pendingQuestions.get(requestId)?.guardMerge
  const replyAnswers: string[][] = guardMerge ? mergeGuardedAnswers(guardMerge, body.answers) : body.answers
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
        body: JSON.stringify({ answers: replyAnswers }),
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
  // 跳过与超时都不是答案。拒绝未获上游确认时抛错并保留 pending，不能假清卡。
  await rejectOpencodeQuestion(requestId, state.opencodeSessionId)
  state.pendingQuestions.delete(requestId)
  state.turnFrozenByQuestion = false
  if (state.pendingQuestions.size === 0) clearQuestionHeartbeat(state)
  emitToSession(state, "question.rejected", { request_id: requestId, reason: answerOverride ? "expired_without_consent" : "skipped_without_consent" })
}
