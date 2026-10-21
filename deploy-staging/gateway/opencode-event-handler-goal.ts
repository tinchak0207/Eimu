import { opencodeFetch } from "./opencode-client.ts"
import { registerSessionTeardownHook, markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { getActiveGoal, buildGoalEvaluatorSpec, parseGoalEvaluatorOutput, recordVerdict, GOAL_MAX_NOT_MET_STREAK } from "./session-goals.ts"
import { runGoalEvaluator, findRunningRun } from "./subagent"
import type { SessionState } from "./types-gateway.ts"
// ── CC 2.1.302：会话目标验收（收盘挂点）─────────────────────────────────────
// 有 active goal、无 pending question、本回合未验收时，派一名独立验收者（复用
// runGoalEvaluator = critic 同一套 dispatchAttempt/modelChain/超时轮子），
// 只看最近正文（≤8000 字）判 {verdict,reason}，落 recordVerdict。
// 有界：同目标每回合最多 1 次；连续 3 次 not_met 后停止自动验收并发一条可见说明。
const GOAL_EVAL_TRANSCRIPT_MAX_CHARS = 8000
const goalEvalBySession = new Map<
  string,
  { goalId: number; lastTurnGen: number; inFlight: boolean; dispatched: boolean; notMet: number; stopped: boolean }
>()

export function installGoalEvalTeardown(): void {
  registerSessionTeardownHook((id) => {
    goalEvalBySession.delete(id)
  })
}

async function recentTranscriptTail(opencodeSessionId: string): Promise<string> {
  const res = await opencodeFetch(`/session/${encodeURIComponent(opencodeSessionId)}/message`, { timeoutMs: 8000 })
  if (!res.ok) throw new Error(`transcript HTTP ${res.status}`)
  const msgs = (await res.json()) as Array<Record<string, any>>
  const lines: string[] = []
  for (const m of Array.isArray(msgs) ? msgs.slice(-40) : []) {
    const role = m?.info?.role === "user" ? "user" : "assistant"
    for (const p of Array.isArray(m?.parts) ? m.parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) lines.push(`${role}: ${p.text.trim()}`)
      // 验收者禁止自取证，必须能看到对话中已有的真实工具结果，不能只喂助手自述。
      if (p?.type === "tool" && (p.state?.status === "completed" || p.state?.status === "error")) {
        const evidence = p.state.status === "completed" ? p.state.output : p.state.error
        if (typeof evidence === "string" && evidence.trim()) lines.push(`tool ${String(p.tool ?? "unknown")} (${p.state.status}): ${evidence.trim()}`)
      }
    }
  }
  const text = lines.join("\n")
  return text.length > GOAL_EVAL_TRANSCRIPT_MAX_CHARS ? text.slice(-GOAL_EVAL_TRANSCRIPT_MAX_CHARS) : text
}

/** 从验收者输出里取判定：JSON 优先，其次 critic 的末行 VERDICT（P1-2）。 */
const parseGoalVerdict = parseGoalEvaluatorOutput

/** 与 buildGoalEvaluatorSpec 的 label 一致；用于判断验收 run 是否还活着。 */
const GOAL_EVALUATOR_LABEL = "目标验收"

/** not_met 的一次性 nudge：走既有 prompt_async 通道注入，并给用户一行可见说明。 */
async function injectGoalNudge(state: SessionState, reason: string): Promise<void> {
  await deliverGoalNudge(state, reason)
}

/** 导出仅供离线验收（G2 turnGen 记账）；生产只由 maybeRunGoalAcceptance 调用。 */
export async function deliverGoalNudge(state: SessionState, reason: string): Promise<void> {
  if (state.turnAborted || state.turnAbortSource === "user") return
  const turnGen = state.turnGen ?? 0
  emitToSession(state, "message.delta", { text: `目标验收尚未通过，已提醒继续补齐：${reason}\n` })
  const body = {
    ...beastAgentField(state),
    parts: [
      {
        type: "text",
        text: `【目标验收·未达成】独立验收者判定当前会话目标尚未达成。依据：${reason}\n请继续推进目标，补齐验收缺失的证据与交付，不要只重复声明已完成。`,
      },
    ],
  }
  const res = await opencodeFetch(`/session/${state.opencodeSessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 10000,
  })
  if (!res.ok) throw new Error(`status ${res.status}`)
  // 请求在途时用户停止或开启新回合，旧 nudge 不得恢复 running 状态或撤销停止。
  // 上方 `=== "user"` 的窄化会跨越 await 残留成 "system"，这里重新读取并显式取宽类型。
  const abortSource = state.turnAbortSource as SessionState["turnAbortSource"]
  if (state.turnAborted || abortSource === "user" || (state.turnGen ?? 0) !== turnGen) return
  // G2：nudge 也是一次「新回合起点」——必须与用户消息/唤醒路径同样 bump turnGen，
  // 否则 session.idle 的「本回合已验收」闸会把它当成同一回合而永不再验收。
  state.lastPromptBody = body as NonNullable<SessionState["lastPromptBody"]>
  state.turnGen = (state.turnGen ?? 0) + 1
  state.turnTextChars = 0
  state.turnReasoningChars = 0
  state.turnRetries = 0
  state.retryQueued = false
  state.turnUpstreamError = null
  state.turnToolStarted = false
  state.watchdogRetried = false
  state.questionAnsweredThisTurn = false
  state.deathDeclared = false
  state.lastTurnActiveAt = Date.now()
  markDirty(state)
  armWatchdogTimer(state)
}

/**
 * session.idle 收盘挂点（fire-and-forget，永不影响 turn.done）。
 * 判据：有 active goal；无 pending question；本轮尚未验收过。
 */
export function maybeRunGoalAcceptance(state: SessionState): void {
  try {
    if (!state?.sessionId || !state.opencodeSessionId) return
    if (state.pendingQuestions.size > 0) return
    if (state.turnAborted || state.turnAbortSource === "user") return
    const goal = getActiveGoal(state.sessionId)
    if (!goal) return
    // G1 熔断：连续 not_met 次数已持久化，重启后仍然生效。
    if (goal.not_met_streak >= GOAL_MAX_NOT_MET_STREAK) {
      goalEvalBySession.set(state.sessionId, {
        goalId: goal.id,
        lastTurnGen: state.turnGen ?? 0,
        inFlight: false,
        dispatched: false,
        notMet: goal.not_met_streak,
        stopped: true,
      })
      return
    }
    const turnGen = state.turnGen ?? 0
    const prev = goalEvalBySession.get(state.sessionId)
    if (prev && prev.goalId === goal.id) {
      // P1-1：验收 run 可能被硬停（stopSubagentRun 不走 finishRun，onTerminal 永不回调），
      // 旧版 inFlight 会永久为 true、目标从此不再验收。若注册表里已找不到该验收 run，
      // 说明它已停止/异常收尾——清 inFlight 并放开「本回合已验收」闸，下一 idle 重新验收。
      // 次数约束仍由持久化的 not_met_streak（GOAL_MAX_NOT_MET_STREAK）负责。
      if (prev.inFlight && prev.dispatched && !findRunningRun(state.sessionId, GOAL_EVALUATOR_LABEL)) {
        prev.inFlight = false
        prev.lastTurnGen = -1
      }
    }
    if (prev && prev.goalId === goal.id && (prev.inFlight || prev.lastTurnGen === turnGen || prev.stopped)) return
    const record = { goalId: goal.id, lastTurnGen: turnGen, inFlight: true, dispatched: false, notMet: prev?.goalId === goal.id ? prev.notMet : 0, stopped: false }
    goalEvalBySession.set(state.sessionId, record)
    void (async () => {
      let dispatched = false
      try {
        const tail = await recentTranscriptTail(state.opencodeSessionId)
        // transcript 的异步读取也可能跨回合；旧请求不得派发或改写新验收记录。
        if (goalEvalBySession.get(state.sessionId) !== record || (state.turnGen ?? 0) !== turnGen || state.turnAborted || state.turnAbortSource === "user") return
        const active = getActiveGoal(state.sessionId)
        if (!active || active.id !== goal.id) return
        const spec = buildGoalEvaluatorSpec(goal.condition)
        dispatched = runGoalEvaluator(state, { label: spec.label, prompt: `${spec.prompt}${tail}` }, (result) => {
          const current = goalEvalBySession.get(state.sessionId)
          if (current !== record) return
          current.inFlight = false
          // 只释放本次记录；旧回合结果不得写入 verdict 或触发新回合 nudge。
          if ((state.turnGen ?? 0) !== turnGen || state.turnAborted || state.turnAbortSource === "user") return
          const active = getActiveGoal(state.sessionId)
          if (!active || active.id !== goal.id) return
          if (result.status !== "ok") {
            console.error(`[gateway] goal evaluator ended ${result.status}: session=${state.sessionId} ${result.error || ""}`)
            return
          }
          const parsed = parseGoalVerdict(result.text)
          if (!parsed) {
            const updated = recordVerdict(state.sessionId, { verdict: "not_met", reason: "验收输出不可解析" })
            current.notMet = Math.max(current.notMet + 1, updated?.not_met_streak ?? 0)
            if (current.notMet >= GOAL_MAX_NOT_MET_STREAK) {
              current.stopped = true
              emitToSession(state, "message.delta", {
                text: `目标已连续 ${current.notMet} 次未通过自动验收，本轮起停止自动验收；请人工确认目标或调整条件后再继续。\n`,
              })
              return
            }
            void injectGoalNudge(state, "验收输出不可解析").catch((e) => console.error(`[gateway] goal nudge failed: session=${state.sessionId}`, e))
            return
          }
          const updated = recordVerdict(state.sessionId, parsed)
          if (parsed.verdict === "met") {
            emitToSession(state, "message.delta", { text: `目标验收已通过：${parsed.reason}\n` })
            return
          }
          current.notMet = Math.max(current.notMet + 1, updated?.not_met_streak ?? 0)
          if (current.notMet >= GOAL_MAX_NOT_MET_STREAK) {
            current.stopped = true
            emitToSession(state, "message.delta", {
              text: `目标已连续 ${current.notMet} 次未通过自动验收，本轮起停止自动验收；请人工确认目标或调整条件后再继续。\n`,
            })
            return
          }
          void injectGoalNudge(state, parsed.reason).catch((e) => console.error(`[gateway] goal nudge failed: session=${state.sessionId}`, e))
        })
        record.dispatched = dispatched
      } catch (e) {
        console.error(`[gateway] goal acceptance failed: session=${state.sessionId}`, e)
      } finally {
        const current = goalEvalBySession.get(state.sessionId)
        if (!dispatched && current === record) current.inFlight = false
      }
    })()
  } catch (e) {
    console.error("[gateway] goal acceptance gate failed:", e)
  }
}
