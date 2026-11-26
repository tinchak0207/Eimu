// 会话目标 HTTP 路由（POST /internal/goal/*）。
// 约束：
// - 只做 loopback internal 路由（由 router.ts 的 /internal/ 闸门统一守门）。
// - ask_user=true 的审批卡复用既有 confirm.request / confirm.resolved SSE 与
//   pendingConfirms/resolvedConfirms 生命周期，不自造弹窗协议。
// - 提案非阻塞：登记卡片后立即回 202；agent 不等用户答复。
// - 卡片 request_id 固定为 `goal_<id>`，与扣费确认的 UUID 互不碰撞。
import { jsonError } from "./gw-lib.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import { emitToSession } from "./sse-core.ts"
import { settleConfirm } from "./media-internal-routes.ts"
import { CONFIRM_TIMEOUT_MS } from "./constants-gateway.ts"
import type { ConfirmOutcome, SessionState } from "./types-gateway.ts"
import { internalTokenRejection } from "./task-board-http.ts"
import {
  GoalStateError,
  GoalValidationError,
  approveGoal,
  clearGoal,
  getActiveGoal,
  getGoalById,
  getLatestTerminalGoal,
  getProposedGoal,
  proposeGoal,
  recordVerdict,
  rejectGoal,
  type SessionGoal,
} from "./session-goals.ts"

/** 把 opencode 子会话 id 收敛到父 gateway 会话 id；解析不到时保持原值。 */
export function canonicalGoalSessionId(sessionId: string): string {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : sessionId
}

function liveState(sessionId: string): SessionState | undefined {
  return resolveSession(sessionId) ?? subagentParentState(sessionId)
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function goalError(e: unknown): Response {
  if (e instanceof GoalValidationError) {
    return jsonError(400, `${e.field}: ${e.message}`, "bad_request", "invalid_goal_input")
  }
  if (e instanceof GoalStateError) {
    return e.code === "not_found"
      ? jsonError(404, e.message, "not_found", "goal_not_found")
      : jsonError(409, e.message, "conflict", "goal_conflict")
  }
  return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "goal_error")
}

function goalCardRequestId(goalId: number): string {
  return `goal_${goalId}`
}

/**
 * 渲染目标确认卡。amount_coins=0 表示不涉及扣费；额外字段只供前端识别目标卡，
 * 既有确认卡组件与 /agent/v1/sessions/:id/confirm 无需改动。
 */
function deliverGoalCard(sessionId: string, goal: SessionGoal): { delivered: boolean; requestId: string } {
  const requestId = goalCardRequestId(goal.id)
  const state = liveState(sessionId)
  if (!state) return { delivered: false, requestId }
  if (state.pendingConfirms.has(requestId) || state.resolvedConfirms.has(requestId)) {
    return { delivered: false, requestId }
  }
  const timer = setTimeout(() => {
    settleConfirm(state, requestId, "expired")
  }, CONFIRM_TIMEOUT_MS)
  state.pendingConfirms.set(requestId, { timer })
  emitToSession(state, "confirm.request", {
    request_id: requestId,
    amount_coins: 0,
    description: `确认会话目标：${goal.condition}`,
    kind: "goal",
    goal_id: goal.id,
    condition: goal.condition,
  })
  watchGoalDecision(state, goal, requestId)
  return { delivered: true, requestId }
}

/** 卡片被用户点掉（或过期）后，把结果落到目标表。 */
function watchGoalDecision(state: SessionState, goal: SessionGoal, requestId: string): void {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS + 30_000
  const timer = setInterval(() => {
    try {
      const settled = state.resolvedConfirms.get(requestId)
      if (!settled) {
        // 会话被拆除时 sessions-core 会把 pending 确认统一结算为 denied 并写入 resolved，
        // 因此这里只需等 resolved；超过硬死线兜底一次，防止状态泄漏。
        if (Date.now() <= deadline) return
        clearInterval(timer)
        rejectGoal(goal.session_id, goal.id, "expired")
        return
      }
      clearInterval(timer)
      if (settled.outcome === "approved") approveGoal(goal.session_id, goal.id)
      else if (settled.outcome === "expired") rejectGoal(goal.session_id, goal.id, "expired")
      else rejectGoal(goal.session_id, goal.id, "rejected")
    } catch (e) {
      clearInterval(timer)
      // 目标已被新的提案/直设 supersede 时状态机拒绝转移，这是预期竞态，不是故障。
      if (e instanceof GoalStateError && e.code === "conflict") return
      console.warn(`[gateway] goal card settlement failed: id=${goal.id} ${e instanceof Error ? e.message : String(e)}`)
    }
  }, 500)
  ;(timer as { unref?: () => void }).unref?.()
}

/** 显式批准/拒绝/清除时，同步结算仍在场的卡片，避免卡片挂到超时。 */
function settleGoalCard(sessionId: string, goalId: number, outcome: ConfirmOutcome): void {
  const state = liveState(sessionId)
  if (!state) return
  const requestId = goalCardRequestId(goalId)
  if (state.pendingConfirms.has(requestId)) settleConfirm(state, requestId, outcome)
}

/** ask_user=false 的可见通知：走既有 message.delta 正文通道，不新增 SSE 事件名。 */
function emitGoalNotice(sessionId: string, text: string): void {
  const state = liveState(sessionId)
  if (!state) return
  emitToSession(state, "message.delta", { text: `\n【会话目标】${text}\n` })
}

function sessionIdOf(body: Record<string, unknown>): string {
  return typeof body.session_id === "string" ? body.session_id.trim() : ""
}

/**
 * POST /internal/goal/propose|approve|reject|clear|status|verdict
 * body 一律 JSON；session_id 必填。
 */
export async function handleGoal(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method not allowed", "bad_request", "method_not_allowed")
  const tokenError = internalTokenRejection(req)
  if (tokenError) return tokenError
  const body = await readJson(req)
  if (!body) return jsonError(400, "invalid json body", "bad_request", "bad_request")
  const rawSessionId = sessionIdOf(body)
  if (!rawSessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")
  const sessionId = canonicalGoalSessionId(rawSessionId)
  const payload = body

  try {
    if (pathname === "/internal/goal/propose") {
      const previousProposed = getProposedGoal(sessionId)
      const goal = proposeGoal(sessionId, {
        condition: payload.condition,
        ask_user: payload.ask_user,
        proposed_by: payload.proposed_by,
      })
      if (previousProposed && previousProposed.id !== goal.id) {
        settleGoalCard(sessionId, previousProposed.id, "denied")
      }
      if (!goal.ask_user) {
        emitGoalNotice(sessionId, `已设定：${goal.condition}`)
        return Response.json({ ok: true, goal, card_delivered: false })
      }
      const card = deliverGoalCard(sessionId, goal)
      return Response.json(
        {
          ok: true,
          goal,
          request_id: card.requestId,
          card_delivered: card.delivered,
          note: card.delivered
            ? "确认卡已推送；提案非阻塞，继续当前工作，不要等待用户答复。"
            : "确认卡未送达（会话不在线）；目标仍为 proposed，待后续审批。",
        },
        { status: 202 },
      )
    }

    if (pathname === "/internal/goal/approve") {
      // P2-7：不做 Number() 强转；非 JSON number 正整数由 approveGoal 抛 400。
      const rawGoalId = payload.goal_id !== undefined ? payload.goal_id : payload.id
      const goal = approveGoal(sessionId, rawGoalId as number)
      settleGoalCard(sessionId, goal.id, "approved")
      return Response.json({ ok: true, goal })
    }

    if (pathname === "/internal/goal/reject") {
      const rawGoalId = payload.goal_id !== undefined ? payload.goal_id : payload.id
      const goal = rejectGoal(sessionId, rawGoalId as number, "rejected")
      settleGoalCard(sessionId, goal.id, "denied")
      return Response.json({ ok: true, goal })
    }

    if (pathname === "/internal/goal/clear") {
      const goal = clearGoal(sessionId)
      if (goal) settleGoalCard(sessionId, goal.id, "denied")
      return Response.json({ ok: true, cleared: Boolean(goal), goal: goal ?? null })
    }

    if (pathname === "/internal/goal/status") {
      // P2-6：支持按 goal_id 查询任意状态（含已 met 的终态）；不传时额外返回最近终态。
      // P2-7：goal_id 只接受 JSON number 正整数，字符串/数组一律 400。
      if (payload.goal_id !== undefined || payload.id !== undefined) {
        const rawGoalId = payload.goal_id !== undefined ? payload.goal_id : payload.id
        const goal = getGoalById(sessionId, rawGoalId as number)
        if (!goal) return jsonError(404, `goal not found: ${String(rawGoalId)}`, "not_found", "goal_not_found")
        return Response.json({
          ok: true,
          goal,
          active: goal.status === "active" ? goal : null,
          proposed: goal.status === "proposed" ? goal : null,
          last_verdict: goal.last_verdict ?? goal.verdict ?? null,
          last_reason: goal.last_reason ?? goal.verdict_reason ?? null,
          not_met_streak: goal.not_met_streak,
          latest_terminal: goal,
        })
      }
      const active = getActiveGoal(sessionId) ?? null
      const latestTerminal = getLatestTerminalGoal(sessionId) ?? null
      const lastVerdictSource = active ?? latestTerminal
      return Response.json({
        ok: true,
        active,
        proposed: getProposedGoal(sessionId) ?? null,
        // G1：not_met 时目标仍是 active；P2-6：已 met 后 active 为空，从最近终态读取。
        last_verdict: lastVerdictSource?.last_verdict ?? lastVerdictSource?.verdict ?? null,
        last_reason: lastVerdictSource?.last_reason ?? lastVerdictSource?.verdict_reason ?? null,
        not_met_streak: active?.not_met_streak ?? 0,
        latest_terminal: latestTerminal,
      })
    }

    if (pathname === "/internal/goal/verdict") {
      const goal = recordVerdict(sessionId, { verdict: payload.verdict, reason: payload.reason })
      if (!goal) return jsonError(404, "no active goal", "not_found", "no_active_goal")
      return Response.json({ ok: true, goal })
    }

    return jsonError(404, "unknown goal route", "not_found", "not_found")
  } catch (e) {
    return goalError(e)
  }
}
