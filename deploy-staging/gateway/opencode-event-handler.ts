// gateway 第二阶段重构 Wave2（2026-09-19）：opencode-event-handler.ts
// 机械抽取自 index.ts 3620–4085（handleOpencodeEvent 全函数：session.idle 收盘、
// failover/jitter 两台重试机、critic pass、Jev gate、question freeze、video release、
// compaction 触发）。除档头注释/import/declare 占位/export 前缀外与源逐行等价（diff 验 identical）。
// 依赖解析：Wave1/已建模组真 import；仍住 index.ts 未 export 的符号 declare 占位（stage1 记忆 subagent 占位符法）。
import { sessions, markDirty, findSessionByOpenCodeId, isRestoredGatewayTurn, reconcileRestoredGatewayTurn } from "./sessions-core.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { flushOtherPartTails, takeTurnEndTail } from "./outbound-sanitize.ts"
import { emitSanitizedDelta } from "./outbound-emit.ts"
import { opencodeHeaders, scheduleTitleFetch, revertDeadTail, opencodeFetch } from "./opencode-client.ts"
import { MESSAGE_ROLE_CAP, OPENCODE_URL, PART_TEXT_TRACK_CAP, STEP_COST_LOG_CAP, SUPPRESSED_PART_CAP, TURN_MAX_RETRIES, TURN_RETRY_DELAY_MS } from "./constants-gateway.ts"
import type { SessionState } from "./types-gateway.ts"
import { subagentHandlesSession, handleSubagentEvent, maybeRunMachineCriticPass, snapshotPendingCriticTargets, emitRunningSubagentsStatus, runGoalEvaluator, findRunningRun } from "./subagent"
// CC 2.1.302 移植：会话目标验收（active goal 在每回合收尾时由独立验收者判定）。
import { getActiveGoal, buildGoalEvaluatorSpec, parseGoalEvaluatorOutput, recordVerdict, GOAL_MAX_NOT_MET_STREAK } from "./session-goals.ts"
import { beastAgentField } from "./session-lifecycle.ts"
import { runJevShadowGate } from "./jev-gate"
import { emitSessionError } from "./emit-helpers.ts"
import { eventSessionId, handleToolPartUpdate, finalizeIdleStep, triggerIdleStepBreaker, isAssistantMessage, boundMap, boundSet } from "./events-translate.ts"
import { noteTurnUsage, noteTurnPromptDispatch } from "./metrics-gw.ts"
import { noteAssistantHeadForRecall, scheduleMemoryRecallPrefetch } from "./memory-wiring.ts"
import { clearWatchdogTimer, clearHeartbeatTimer, clearAckTimer, clearErrorStallTimer, clearMidturnStallTimer, armWatchdogTimer, emitTurnEndSummaryIfSilent, emitRecoveryClosingIfSilent, releasePendingVideoWorkflows } from "./timers-gw.ts"
import { markProviderDegraded, isDeadAccountError, isDeadModelError, personaModelForAttempt } from "./model-registry.ts"
import { loadUserSettings } from "./persistence.ts"
import { normalizeUserSettings } from "./sessions-http.ts"
import { noteReasoningDelta, resetReasoningCap, buildReasoningNudge } from "./reasoning-cap.ts"
import { emitUnfulfilledPlanNotice, recordUnfulfilledPlan } from "./plan-promise.ts"
import {
  shouldBlockCompletionForWorkflowWrite,
  buildWorkflowWriteGateNudge,
  WORKFLOW_WRITE_GATE_MARK,
} from "./canvas-write-gate.ts"
import { TAIL_PAYLOAD_MARKER, ensureGatewayNonce, maybeCompactSession } from "./messages-gw.ts"
// CC 2.1.302 Stop hook：收盘路径 fire-and-forget，绝不阻塞 turn.done。
import { runHooksWithBudget } from "./hooks-http.ts"
import { opencodeErrorCode, opencodeErrorMessage } from "./emit-helpers.ts"
// 2026-10-02 能力片：错误讯息即模型上下文。failover 重投时以既有 prompt_async 文本
// part 通道注入「续写指示」与「孤儿 tool_use 补 is_error」——模型可见、使用者不可见
// （设计取自 Claude Code，未复制其程式码；见 error-classify.ts 该节注解）。
import { buildFailoverInjection, buildContinuationDirective, type OrphanToolUse } from "./error-classify.ts"
// REQ-D2（2026-09-22）：回合收尾投递待投的 steer（空队列＝零动作，无 steer 的回合逐位等价）。
// 方向与既有 maybeCompactSession 同款（本档 → messages-gw 家族），不新增环。
import { flushPendingSteers } from "./steer-gw.ts"

/** Stop hook loop guard：session state → 已触发 hook 的 turnGen。 */
const stopHookTurnGen = new WeakMap<object, number>()

// TODO(来自 events-translate.ts): eventSessionId(index.ts 2715)/handleToolPartUpdate(index.ts 3309)
//   —— W7 并行在建 events-translate.ts，建成后改真 import。

// TODO(整合 Wave2): 以下为仍住 index.ts 且尚未 export 的符号 declare 占位
// （bun build 只转译不查名，建得过；index.ts 补 export 或符号迁出后替换为真 import）。

// H14（2026-10-02）：系统唤醒不冒充用户发言。prompt_async 注入的唤醒文本在 opencode 里只能是
// user-role message（身份由 opencode 存储决定）；网关侧能做的是把它从「用户发言」语义摘出——
// messageRole 改记 "system"（isAssistantMessage 仅认 "assistant"，回声抑制语义不变），
// 并以 turn.status 暂态单行告知前端（不落 transcript，参照 turn-status-transient-row 修法）。
import { isSystemWakeText } from "./system-wake.ts"
export { isSystemWakeText }
export function markSystemWakeMessage(state: SessionState, messageID: unknown, text: unknown): boolean {
  if (typeof messageID !== "string" || !isSystemWakeText(text)) return false
  if (state.messageRole.get(messageID) !== "user") return false // 已标过/非 user 讯息 → 不重发
  state.messageRole.set(messageID, "system")
  // 2026-10-04 W：此文案一律简体（原繁体硬编 + 书写体镜像已拆，均保留简体本体）。
  emitToSession(state, "turn.status", {
    text: "子代理已完成，系统自动唤醒主代理汇总中…",
  })
  return true
}

// R9-B（2026-09-30）：其他 part 扣住的尾行（无尾换行的单行旁白）当场吐出，
// 保持「旁白 → 工具/下一段」时序；否则会被压到 session.idle 才补播（SSE 9888–9894）。
function emitOtherPartTails(state: SessionState, exceptPid?: string): void {
  const text = flushOtherPartTails(state.partStripState, exceptPid)
  if (text) {
    emitToSession(state, "message.delta", { text }, { strippable: true })
    state.lastUserVisibleAt = Date.now()
  }
}

/**
 * 回合真正收尾的唯一出口：清 in-flight 打点，再发 turn.done。
 *
 * 2026-10-02 steer 误判修复：`lastTurnActiveAt` 是 steer 受理闸（steer-gw.turnInFlight）
 * 判「现在有没有可引导的回合」的唯一依据，语义必须是「上游真的有一个在途回合」。
 * 旧版把它挂在 session.idle 一到就清，但 idle **不等于**回合结束：下面 failover／jitter
 * 两台重试机在同一轮内会再送一次 prompt_async，且刻意**不发 turn.done**（前端维持
 * 进行中）。打点先被清、重投腿又不补 ⇒ 整条重投轮的 steer 全被回 409 no_active_turn，
 * 使用者在「进行中」的回合里追加的引导一律被判「引导未能送达（未生效）」。
 * 所以清点与 turn.done 绑死成同一个出口（三个落点全走本函数），重投腿自然跳过。
 */
function emitTurnDone(state: SessionState): void {
  state.lastTurnActiveAt = 0
  markDirty(state)
  emitToSession(state, "turn.done", {})
  // F3（2026-10-10）：turn.done 清前端 turnStatus；若仍有在途 async 子代理，立刻回填
  // 进度行，避免 await 窗真空（复用 turn.status，禁止 message.delta 污染正文）。
  emitRunningSubagentsStatus(state.sessionId)
}

// ── 2026-10-02 能力片：孤儿 tool_use 追踪（设计取自 Claude Code yieldMissingToolResultBlocks
// ——换模型时替未收到结果的 tool_use 补 is_error，未复制程式码）──────────────
// 纯读观测：记录每个 session 目前 in-flight 的工具调用；工具 completed/error 即摘除。
// turn 因上游错误中断时，残留在表里的就是「孤儿」——换模型重投时注入 is_error 语义补注，
// 让接手模型知道这些工具没跑完。只写本模组私有 Map，不新增任何前端帧（使用者不可见）。
const inFlightToolsBySession = new Map<string, Map<string, OrphanToolUse>>()
const IN_FLIGHT_TOOLS_CAP = 64
function noteToolInFlight(state: SessionState, part: any): void {
  const callId = typeof part?.callID === "string" ? part.callID : ""
  if (!callId) return
  const status = typeof part?.state?.status === "string" ? part.state.status : ""
  let m = inFlightToolsBySession.get(state.sessionId)
  if (!m) {
    m = new Map()
    inFlightToolsBySession.set(state.sessionId, m)
  }
  if (status === "pending" || status === "running") {
    m.set(callId, { id: callId, name: typeof part?.tool === "string" ? part.tool : "" })
    boundMap(m, IN_FLIGHT_TOOLS_CAP)
  } else if (status === "completed" || status === "error") {
    m.delete(callId)
  }
}
/** 取出并清空该 session 的孤儿候选（failover 消费一次；正常 turn 结束亦清，防泄漏）。 */
function takeInFlightTools(state: SessionState): OrphanToolUse[] {
  const m = inFlightToolsBySession.get(state.sessionId)
  if (!m || m.size === 0) return []
  const out = [...m.values()]
  m.clear()
  return out
}
function clearInFlightTools(state: SessionState): void {
  inFlightToolsBySession.delete(state.sessionId)
}

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
  if (state.turnAborted || state.turnAbortSource === "user" || (state.turnGen ?? 0) !== turnGen) return
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

export function handleOpencodeEvent(event: any): void {
  try {
    const opencodeSessionId = eventSessionId(event)
    if (!opencodeSessionId) return
    // 子代理运行时：子 opencode 会话的事件翻译成 subagent.* 帧发到父会话，
    // 不进入常规翻译（常规路径按 opencode id 查 sessions，子会话查不到会直接丢）。
    if (subagentHandlesSession(opencodeSessionId)) {
      handleSubagentEvent(event, opencodeSessionId)
      return
    }
    const state = findSessionByOpenCodeId(opencodeSessionId)
    if (!state) return

    // session.error (if it ever appears) or any event carrying properties.error.
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      emitSessionError(state, opencodeErrorCode(err), opencodeErrorMessage(err))
      return
    }

    switch (event?.type) {
      case "message.updated": {
        // The ONLY place a role appears. message.part.updated carries no role at
        // all (verified: part keys are id/messageID/sessionID/text/type), so
        // without this map the user's own prompt — which arrives as a text part
        // on a user-role message — gets echoed back as assistant output.
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        if (mid && role) {
          // H14：已标为 system 的唤醒讯息，后续 message.updated 不得回写成 user。
          if (!(role === "user" && state.messageRole.get(mid) === "system")) state.messageRole.set(mid, role)
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        // 压缩复读机修复（2026-10-02）：compaction 代理产出的「摘要讯息」role 也是
        // assistant（同会话、mode=primary，只有 summary:true 能辨识），会被
        // isAssistantMessage 放行、把摘要草稿整段灌进用户可见流——模型压缩时前端
        // 秒变复读机（同一份摘要反覆重跑＝反覆上屏）。标成第三种角色 "compaction"
        // 后 text/reasoning 两条流都不再上屏；压缩动作改以 turn.status 一行告知。
        if (mid && role === "assistant" && info?.summary === true) {
          state.messageRole.set(mid, "compaction")
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        // Phase 0 观测：assistant message 自带的 tokens/cache 用量（事件本来就送到，
        // 零额外往返）；事件不含此栏位时保持 null，不补请求、不加延迟。
        noteTurnUsage(state, info)
        break
      }
      case "message.part.delta": {
        // 中止残响（2026-09-02）：用户中止后 opencode 排队中的迟到 delta 全丢，
        // 直到下一轮 prompt 起点重置（turnAborted L4165）。
        if (state.turnAborted) break
        const p = event.properties ?? {}
        // A delta says nothing about its part's type, and reasoning parts also
        // append to a "text" field — so field==="text" alone would stream chain
        // of thought to the UI. suppressedParts is populated from the
        // message.part.updated that always precedes a part's deltas (verified by
        // raw capture: part.updated -> delta -> delta).
        // NOTE 2026-08-11: 产品要显示思维链，reasoning part 不再丢弃 —— 改发
        // reasoning.delta 事件（同 shape，前端 reducer 累积到 assistant.reasoning）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0 && isAssistantMessage(state, p.messageID)) {
          if (typeof p.partID === "string" && state.suppressedParts.has(p.partID)) {
            emitToSession(state, "reasoning.delta", { text: p.delta.replace(/\uFFFD/g, "") }) // 2026-10-02 乱码守门
            // 罪状2 根因修复（2026-08-29）：思维链字数计入 turn 活动——
            // 让 ack/心跳/看门狗/停滞哨（turnHasActivity）知道模型活著。
            state.turnReasoningChars = (state.turnReasoningChars ?? 0) + p.delta.length
            // P2b 刀2：非空 reasoning 文字 = 本 step 不空（trim 后才算）。
            if (p.delta.trim().length > 0) state.stepHasReasoning = true
            // 2026-10-02：无工具长推理上限——两段式（见 reasoning-cap.ts 档头）：
            //   soft＝首回合软限用尽：只诚实上报，不腰斩正在规划的回合（修 46.5s 误伤）；
            //   hard＝达中止门槛：中止 + 动作导向、保留推理的 nudge 同轮重投。
            {
              const capVerdict = noteReasoningDelta(state, p.delta.length, {
                text: p.delta,
                ctx: { hasTool: state.turnToolStarted === true, hasText: (state.turnTextChars ?? 0) > 0 },
              })
              if (
                capVerdict.kind !== "none" && !isRestoredGatewayTurn(state) &&
                !state.idleNudgeSent && !state.turnAborted && (state.lastTurnActiveAt ?? 0) > 0 && state.lastPromptBody
              ) {
                if (capVerdict.kind === "soft") {
                  console.warn(`[gateway] reasoning-cap: first-gen soft budget used — session=${state.sessionId}`)
                  // 2026-10-04 W：守卫文案一律简体（书写体镜像已拆）。
                  emitToSession(state, "turn.status", {
                    text: "首轮规划较长，已提示模型立即给出结论并开始行动。",
                  })
                } else {
                  resetReasoningCap(state)
                  console.warn(`[gateway] reasoning-cap: no-action reasoning exceeded — session=${state.sessionId}`)
                  triggerIdleStepBreaker(
                    state,
                    buildReasoningNudge({
                      hasTool: state.turnToolStarted === true,
                      tail: capVerdict.tail,
                    }),
                  )
                }
              }
            }
            break
          }
          // R9-B：新 part 开讲前，先吐出前面 part 扣住的尾行（pid 口径同 emitSanitizedDelta）。
          emitOtherPartTails(state, typeof p.partID === "string" && p.partID ? p.partID : "_turn")
          // S2b：出站文本先过内部框架段剥离器（## Objective 等四段）。
          // turnTextChars 仍按原文计——剥到零输出代表模型确实说过话，不触发抖动重试。
          emitSanitizedDelta(state, p.partID, p.delta)
          state.turnTextChars = (state.turnTextChars ?? 0) + p.delta.length
          // §7 召回辅助：留本轮正文头部（buildRecallQuery 只需前 200 字元）。
          noteAssistantHeadForRecall(state, p.delta)
          // P2b 刀2：非空正文 delta = 本 step 不空。
          if (p.delta.trim().length > 0) { state.stepHasText = true; resetReasoningCap(state) }
          if (typeof p.partID === "string") {
            const rec = state.partTextEmitted.get(p.partID)
            if (rec) {
              rec.emittedLen += p.delta.length
            } else {
              state.partTextEmitted.set(p.partID, { emittedLen: p.delta.length })
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
          }
        }
        break
      }
      case "message.part.updated": {
        const part = event?.properties?.part
        if (!part || typeof part !== "object") break
        switch (part.type) {
          case "text": {
            // 中止残响（2026-09-02）：part.text 是累积全文，partTextEmitted 在 idle
            // 已清——中止轮的补发会整段当「新后缀」重发（N2 同场景根因），丢弃。
            if (state.turnAborted) break
            const full = typeof part.text === "string" ? part.text : ""
            const id = typeof part.id === "string" ? part.id : ""
            if (full.length === 0 || !id) break
            markSystemWakeMessage(state, part.messageID, full)
            // Drop unless we know this belongs to an assistant message. Losing a
            // frame is recoverable; echoing the user's own prompt back as AI
            // output is not.
            if (!isAssistantMessage(state, part.messageID)) break
            // P2b 刀2：非空正文 text part = 本 step 不空。
            if (full.trim().length > 0) state.stepHasText = true
            const rec = state.partTextEmitted.get(id) ?? { emittedLen: 0 }
            // part.text is the cumulative full text; deltas already covered the
            // prefix, so only emit the un-emitted suffix. A part that never
            // produced deltas has emittedLen 0 and emits its full text once.
            if (full.length > rec.emittedLen) {
              // R9-B：同 delta 路径——先吐出其他 part 扣住的尾行。
              emitOtherPartTails(state, id)
              // S2b：part.updated 补发的后缀同样过剥离器（与 delta 路径共用逐 part 状态）。
              emitSanitizedDelta(state, id, full.slice(rec.emittedLen))
              state.turnTextChars = (state.turnTextChars ?? 0) + (full.length - rec.emittedLen)
              // §7 召回辅助：补发后缀同样入正文头部（无 delta 的单帧 part 靠这条）。
              noteAssistantHeadForRecall(state, full.slice(rec.emittedLen))
              rec.emittedLen = full.length
              state.partTextEmitted.set(id, rec)
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
            break
          }
          case "compaction": {
            // 压缩动作可见化（前端零改动：走既有 turn.status 通道）。同一 part 只报一次；
            // 该 part 所属讯息一并标非 assistant（摘要不入对话流，见 message.updated 段）。
            if (typeof part.messageID === "string") {
              state.messageRole.set(part.messageID, "compaction")
              boundMap(state.messageRole, MESSAGE_ROLE_CAP)
            }
            const cid = typeof part.id === "string" ? part.id : ""
            if (cid) {
              const seen = state.compactionNotified ?? new Set<string>()
              if (!seen.has(cid)) {
                seen.add(cid)
                state.compactionNotified = seen
                boundSet(seen, PART_TEXT_TRACK_CAP)
                emitToSession(state, "turn.status", {
                  text: part.auto === false ? "正在压缩上下文记忆…" : "上下文较长，系统正在自动压缩历史记忆（不影响本轮任务）…",
                })
              }
            }
            break
          }
          case "tool":
            // R9-B：工具调用起点（pending/running）＝前面的旁白已讲完，尾行当场吐出，
            // 让「先让歌跑起来：」出现在 tool.invoke 之前而非回合结束后。
            if (!state.turnAborted && (part.state?.status === "pending" || part.state?.status === "running")) {
              emitOtherPartTails(state)
            }
            // 2026-10-02：孤儿 tool_use 追踪（纯读，使用者不可见）。
            noteToolInFlight(state, part)
            handleToolPartUpdate(state, part)
            // P2b 刀2：出现 tool = 本 step 不空。
            // 空转补丁（2026-10-02）：裸 true/date/:/空 command 的 bash 不算「有动作」——
            // step-5-preview 实测 64% bash 是此类空转，原本因「有 tool」躲过止损。
            {
              const _inp = (part.state?.input ?? {}) as { command?: unknown }
              const _cmd = typeof _inp.command === "string" ? _inp.command.trim() : ""
              const _noop = part.tool === "bash" && (_cmd === "" || _cmd === "true" || _cmd === "date" || _cmd === ":")
              if (_noop) state.stepNoopTool = true
              else { state.stepHasTool = true; resetReasoningCap(state) }
            }
            break
          case "step-finish": {
            const cost = typeof part.cost === "number" ? part.cost : 0
            const msgId = typeof part.messageID === "string" ? part.messageID : undefined
            if (cost > 0 && msgId && !state.stepCostLogged.has(msgId)) {
              state.stepCostLogged.add(msgId)
              boundSet(state.stepCostLogged, STEP_COST_LOG_CAP)
              // Agent-model cost — never surfaced to the user as a charge.
              console.debug(`[gateway] step-finish: agent cost ${cost} (message ${msgId})`)
            }
            // P2b 刀2：step 收尾结算——空 step 累计，任一活动归零；达阈值即止损。
            finalizeIdleStep(state)
            state.stepOpen = false
            break
          }
          case "reasoning":
          default: {
            // reasoning/step-start and unknown part types never reach the
            // frontend. Record the partID so its deltas are dropped too — the
            // delta event carries no type of its own.
            const pid = typeof part.id === "string" ? part.id : ""
            // P2b 刀2：step-start = 新 step 起点（上一 step 若无 step-finish 先结算）。
            if (part.type === "step-start") {
              if (state.stepOpen) finalizeIdleStep(state)
              state.stepOpen = true
              state.stepHasTool = false
              state.stepHasText = false
              state.stepHasReasoning = false
            } else if (
              part.type === "reasoning" &&
              typeof part.text === "string" &&
              part.text.trim().length > 0
            ) {
              state.stepHasReasoning = true
            }
            if (pid) {
              state.suppressedParts.add(pid)
              boundSet(state.suppressedParts, SUPPRESSED_PART_CAP)
            }
            break
          }
        }
        break
      }
      case "session.idle": {
        // R8-B 工单 #3/#9（2026-08-29）：question pending 期间 turn 冻结——
        // 不发 turn.done、不触发抖动重试/压缩/视频放行。R8 实锤：turn.done
        // 4604.8 早于 question.replied 4634.5（死而复生型状态）。等待期用户
        // 可见性由 question 心跳（armQuestionHeartbeat，30s/帧）接管。
        if (state.pendingQuestions.size > 0) {
          console.log(
            `[gateway] R8-B turn frozen: question pending (x${state.pendingQuestions.size}) — skip turn.done — session=${state.sessionId}`,
          )
          state.turnFrozenByQuestion = true
          clearWatchdogTimer(state)
          clearHeartbeatTimer(state)
          clearAckTimer(state)
          clearErrorStallTimer(state)
          clearMidturnStallTimer(state)
          break
        }
        // 会话摘要标题（2026-09-12）：正常收尾路径（非 question 冻结分支）挂
        // 一次性抓取链——首条消息后 opencode 异步生成标题，idle 即回合结束，
        // 2s/8s/20s 重试覆盖生成滞后；已有标题则空转返回（幂等）。
        scheduleTitleFetch(state)
        // End-of-turn signal: stop the frontend typing indicator and drop the
        // per-partID delta tracking for this turn to bound memory.
        // messageRole and toolInvokeSeen are deliberately NOT cleared: a late
        // part or duplicate status for this turn would otherwise be treated as
        // unknown-role (dropped) or as a fresh call (re-emitted). Both are
        // capped, so they stay bounded without clearing.
        // S2b：回合结束——把各 part 剥离器扣住的最后一行安全文本吐出
        //（在 turn.done 之前，前端收帧顺序不乱），再清状态。
        // 中止窗口不吐剥离器尾巴（2026-09-02）：用户叫停后再冒一句=没停干净。
        // R9-B（2026-09-30）：只吐最后一个 part（最终答覆）的尾行；更早 part 的尾行
        // 已在下一段/工具起点当场吐出，残留即过期旁白——丢弃留日志，不接在答覆后补播。
        if (!state.turnAborted) {
          const { tail, dropped } = takeTurnEndTail(state.partStripState)
          if (tail) emitToSession(state, "message.delta", { text: tail }, { strippable: true })
          if (dropped.length) {
            console.log(`[gateway] R9-B stale part tails dropped at idle: x${dropped.length} — session=${state.sessionId}`)
          }
        }
        // S1 补口（2026-08-29，smoke agent_text 根因）：一次性「英文已略去」提示
        // 此前只在流式路径（emitSanitizedDelta）发——单行英文回覆（无尾换行）
        // 整段扣在 pending、idle 时被 flush 压掉 → 零 message.delta 静默 turn.done
        // （实锤：同英文 prompt 四轮，模型三轮回英文，md-count 全为 0）。
        // flush 后补发同一条提示，避免整段回覆无声消失。
        if (!state.englishNoticeSent) {
          for (const [, stripSt] of state.partStripState) {
            if (stripSt.sawEnglish) {
              state.englishNoticeSent = true
              // 2026-10-04 W：英文剥离提示一律简体（书写体镜像已拆）。
              emitToSession(state, "turn.status", {
                text: "已自动略去一段英文内部思考，中文回复不受影响",
              })
              break
            }
          }
        }
        // P2b 刀2：turn 结束——未收尾的 step 先结算，再清空转止损状态
        //（idleNudgeSent 刻意不清：同 turn 周期只补一次，下一轮起点才重置）。
        if (state.stepOpen) finalizeIdleStep(state)
        state.stepOpen = false
        state.idleSteps = 0
        state.stepHasTool = false
        state.stepHasText = false
        state.stepHasReasoning = false
        state.partStripState.clear()
        state.partTextEmitted.clear()
        state.stepCostLogged.clear()
        // R2-A 看门狗：turn 正常结束（idle 到达），撤哨。
        clearWatchdogTimer(state)
        // N1 规格1：心跳 timer 撤销（turn 已结束，不再补心跳）。
        clearHeartbeatTimer(state)
        // R4-A S3①：错误停滞看门狗同撤（turn 已收尾，不再追错误后的停滞）。
        clearErrorStallTimer(state)
        // R5-C：中段停滞哨同撤（turn 已收尾）。
        clearMidturnStallTimer(state)
        // 恢复的原回合由 OC 收尾；发布不能触发 failover/jitter/质量补写重投。
        if (isRestoredGatewayTurn(state)) { void reconcileRestoredGatewayTurn(state); break }
        // N1 规格3：in-flight 打点的清除**不在这里**（2026-10-02 steer 误判修复）。
        // 这一格只是「idle 到了」，还不是「回合结束了」——下面 failover／jitter 两条
        // 重投腿会在同一轮内再送 prompt_async（语义＝同一回合的下一跳，故刻意不发
        // turn.done）。旧版先在这里清 lastTurnActiveAt、重投腿又不补，整条重投轮的
        // steer 受理闸就一律回 409 no_active_turn（用户看到「引导未能送达（未生效）＋
        // 当前没有进行中的回合」，正是该日回报的误判）。清点改由 emitTurnDone 独占。
        // §7 prefetch（2026-09-15 PRD P0-4）：回合收尾后台预算下一回合的召回候选
        //（用户路径零新增延迟；query = 本回合用户消息 + 本轮 assistant 头部）。
        void scheduleMemoryRecallPrefetch(state)
        // 抖动重试：本轮零文本输出 = 上游模型抖动早死（finish=unknown）。
        // 不发 turn.done（前端维持输入中状态），延迟后重放同一条 prompt。
        // 注意（2026-08-29 罪状2 修复时明确保留）：这里及下面两处重试判定刻意
        // 只看 turnTextChars、不含 turnReasoningChars——思维链是「活著」的证据
        // （归 turnHasActivity 管），但「零正文」仍是抖动死亡的唯一特征；
        // 把 reasoning 算进来会让「只思考不说话」的 turn 免于重投，禁止改回。
        // 2026-08-31：上游模型错误 failover（每轮断线事故：shuai TLS 抖动 mid-turn 断）。
        // jitter 重试刻意只覆盖「零正文」轮——正文/工具已流动的中途断线此前无人接手，
        // turn 直接死。这里接管：零输出→重投原任务书；已有输出→注入续读指令
        //（opencode 历史里有 partial assistant 消息，模型从中断点继续，不重复已完成步骤）。
        // 取模与 jitter 同源：personaModelForAttempt 走 [persona 主模型, ...fallbacks]。
        if (
          state.turnUpstreamError &&
          !state.turnAborted &&
          (state.turnRetries ?? 0) < TURN_MAX_RETRIES
        ) {
          if (state.retryQueued) break // 重试已排队（jitter/failover），等它接手
          state.retryQueued = true
          const upstreamErr = state.turnUpstreamError
          state.turnUpstreamError = null
          const gen = state.turnGen ?? 0
          const attempt = (state.turnRetries ?? 0) + 1
          // 黏性解除（2026-09-21）：本轮把钉住的渠道跑挂了＝不再押它，交回常规链轮转。
          state.stickyModel = null
          emitToSession(state, "turn.status", { text: `重试中 (${attempt}/${TURN_MAX_RETRIES})` })
          const hadOutput = (state.turnTextChars ?? 0) > 0 || Boolean(state.turnToolStarted)
          const baseBody = state.lastPromptBody
          // 2026-09-13 刀1（b-ai 余额归零事故教训）：确定性「账户死」类错误（credit/balance/
          // quota 耗尽）不是瞬态抖动——backoff＋整 turn 重投只会白等并继续鞭打死账户。
          // 命中即：给该 provider 打 60s 降权＋零退避＋直接进链上下一个活 provider
          //（personaModelForAttempt 已过滤降权者，取链首即第一个活家）。429/过载/TLS
          // 断线等瞬态一律不动，仍走原 backoff 链。
          const deadAccount = isDeadAccountError(upstreamErr)
          // 修复4：死模型与死帐户共享「零退避立即换下一个」的待遇（deadFast），
          // 但只死帐户参与降权标记——死模型降权整个 provider 会误伤同家活模型
          //（见 isDeadModelError 处注释），故死模型只跳 backoff、不 markProviderDegraded。
          const deadFast = deadAccount || isDeadModelError(upstreamErr)
          // 修复1：降权对象＝实际 dispatch 的 provider（lastDispatchedModel），
          // 缺席才回退 turn 起点模型（保守兼容）。baseBody.model 在 failover 换模后
          // 不回写，是事故里张冠李戴的源头，仅作 fallback 不再当主依据。
          const degradedTarget = state.lastDispatchedModel?.providerID ?? baseBody?.model?.providerID
          if (deadAccount && degradedTarget) {
            markProviderDegraded(degradedTarget, upstreamErr.slice(0, 120))
          }
          // 2026-10-02 能力片：串流中断/换模型时，以既有 prompt_async 文本通道注入
          // 「续写指示」＋「孤儿 tool_use is_error 补注」。仅 hadOutput（有中断处可续）
          // 时注入；零产出重投照原样重放任务书。注入是 user-role message，模型可见、
          // 使用者不可见（isAssistantMessage 闸挡掉）。
          const orphanTools = hadOutput ? takeInFlightTools(state) : []
          clearInFlightTools(state)
          const retryInjection = buildFailoverInjection({ hadOutput, orphanTools })
          const retryBody: NonNullable<SessionState["lastPromptBody"]> = hadOutput
            ? // 有中断处：注入续写指示（＋孤儿工具补注），让模型从断点续跑。
              { parts: [{ type: "text", text: retryInjection }] }
            : baseBody
              ? // 零产出：重放原任务书（没有中断处可续，不注入）。
                { ...baseBody, parts: baseBody.parts.map((pt) => ({ ...pt })) }
              : // 零产出且无原任务书可重放：仍须送非空文本（不可送空 prompt）。
                { parts: [{ type: "text", text: buildContinuationDirective() }] }
          if (orphanTools.length > 0) {
            console.log(
              `[gateway] turn failover: injected orphan tool_use is_error note (x${orphanTools.length}) — session=${state.sessionId} tools=${orphanTools.map((t) => t.name || t.id).join(",")}`,
            )
          }
          console.log(
            `[gateway] turn failover: upstream error, schedule retry #${attempt} (hadOutput=${hadOutput} deadAccount=${deadAccount}) — session=${state.sessionId} error=${upstreamErr.slice(0, 160)}`,
          )
          setTimeout(async () => {
            const cur = sessions.get(state.sessionId)
            // 不看 turnTextChars（旧轮文本已计入，作让位条件会自杀）：
            // 只看会话拆除/进入下一轮/用户打断三种让位。
            if (!cur || (cur.turnGen ?? 0) !== gen) return
            // 用户叫停：重投不发车。abort 端不碰打点，若这张 idle（＝排定本重投的那一张）
            // 走完才叫停，这里就是唯一的收口点——不清会留下「假在途」，之后的引导全被
            // 收进队列却等不到投递。
            if (cur.turnAborted) {
              cur.lastTurnActiveAt = 0
              markDirty(cur)
              return
            }
            try {
              // 刀1：死账户取「降权过滤后链首」＝下一个活 provider（attempt=1 → pool[0]，
              // 刚被打死的一家已不在 pool）；一般错误（含修复4死模型——不降权，链未变）
              // 维持原取模轮转。
              const attemptModel = deadAccount
                ? personaModelForAttempt(cur, 1)
                : personaModelForAttempt(cur, attempt)
              retryBody.model = attemptModel
              // 修复1：重投后实际 dispatch 的模型同步记档（降权判定用，见 failover 块上方）。
              cur.lastDispatchedModel = { providerID: attemptModel.providerID, modelID: attemptModel.modelID }
              // 2026-10-01 去重：上一条 user（原 prompt 或上一条续写提示）其后零产出 → 先撤再投，不叠两条。
              await revertDeadTail(cur.opencodeSessionId)
              const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
                method: "POST",
                headers: opencodeHeaders(),
                body: JSON.stringify(retryBody),
                signal: AbortSignal.timeout(10000),
              })
              if (!res.ok) throw new Error(`status ${res.status}`)
              cur.turnRetries = attempt
              cur.retryQueued = false
              console.log(
                `[gateway] turn failover #${attempt} dispatched model=${attemptModel.providerID}/${attemptModel.modelID} — session=${cur.sessionId}`,
              )
              // Phase 0 观测：重投成功 = 同一 turn 的下一次尝试（attempt+1）。
              noteTurnPromptDispatch(cur, attemptModel.providerID, attemptModel.modelID)
              // N2 同款：剥掉旧轮文本帧，断线重连不整段重放旧文案。
              stripStaleTurnTextFromReplay(cur)
              cur.turnToolStarted = false
              armWatchdogTimer(cur)
            } catch (e) {
              console.error(`[gateway] turn failover #${attempt} failed:`, e)
              cur.retryQueued = false
              emitTurnDone(cur) // 重试发不出去：放弃，别留前端挂着
            }
          }, deadFast ? 0 : TURN_RETRY_DELAY_MS)
          break // 不发 turn.done：重试轮结束自然会发
        }
        if (
          (state.turnTextChars ?? 0) === 0 &&
          !state.turnAborted &&
          state.lastPromptBody &&
          (state.turnRetries ?? 0) < TURN_MAX_RETRIES
        ) {
          if (state.retryQueued) break // 重试已排队，等它接手
          state.retryQueued = true
          // 零产出重投：本次无「中断处」可续，孤儿候选直接清（防 Map 泄漏）。
          clearInFlightTools(state)
          const gen = state.turnGen ?? 0
          const attempt = (state.turnRetries ?? 0) + 1
          emitToSession(state, "turn.status", { text: `重试中 (${attempt}/${TURN_MAX_RETRIES})` })
          const body = state.lastPromptBody
          console.log(`[gateway] turn jitter: schedule retry #${attempt} for ${state.sessionId}`)
          setTimeout(async () => {
            const cur = sessions.get(state.sessionId)
            if (!cur || (cur.turnGen ?? 0) !== gen) return
            // 用户叫停：同 failover 腿，清打点收口（重投不发车，也不发 turn.done）。
            if (cur.turnAborted) {
              cur.lastTurnActiveAt = 0
              markDirty(cur)
              return
            }
            // 只看 turnTextChars（语义保留见上方注释）：重投窗口内模型开口说正文才让位
            //（那是回合仍活著的证据，打点照旧不清）。
            if ((cur.turnTextChars ?? 0) > 0) return
            try {
              // 跨渠道 failover（2026-08-29）：重投前按 attempt 从链
              // [persona 主模型, ...registry.bindings.fallbacks[persona]] 取模换模型，
              // 根治「主/备模同源全死」事故。registry 异常时链只有主模型（行为=现状）。
              const attemptModel = personaModelForAttempt(cur, attempt)
              const prevModel = body.model
              if (
                !prevModel ||
                attemptModel.providerID !== prevModel.providerID ||
                attemptModel.modelID !== prevModel.modelID
              ) {
                console.log(
                  `[gateway] turn retry #${attempt} failover model=${attemptModel.providerID}/${attemptModel.modelID} — session=${cur.sessionId}`,
                )
              }
              body.model = attemptModel
              // 修复1：jitter 重投同样记实际 dispatch 模型（与 failover 重投对称）。
              cur.lastDispatchedModel = { providerID: attemptModel.providerID, modelID: attemptModel.modelID }
              // 2026-10-01 去重：零正文重投原 prompt 前撤掉上一条零产出的同一 user 讯息，历史只留一条。
              await revertDeadTail(cur.opencodeSessionId)
              const res = await fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
                method: "POST",
                headers: opencodeHeaders(),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000),
              })
              if (!res.ok) throw new Error(`status ${res.status}`)
              cur.turnRetries = attempt
              cur.retryQueued = false
              console.log(`[gateway] turn retry #${attempt} dispatched for ${cur.sessionId}`)
              // Phase 0 观测：jitter 重投成功 = 同一 turn 的下一次尝试（attempt+1）。
              noteTurnPromptDispatch(cur, attemptModel.providerID, attemptModel.modelID)
              // N2：重试轮开始——把旧 turn 累积的文本帧从 replayBuffer 剥掉，
              // 断线重连不再整段重放旧文案（canvas/confirm 等状态帧保留）。
              stripStaleTurnTextFromReplay(cur)
              // R2-A：重投轮同样可能 turn 不启动——重置标记并重新布哨。
              cur.turnToolStarted = false
              armWatchdogTimer(cur)
            } catch (e) {
              console.error(`[gateway] turn retry #${attempt} failed:`, e)
              cur.retryQueued = false
              emitTurnDone(cur) // 重试发不出去：放弃，别让前端挂著
            }
          }, TURN_RETRY_DELAY_MS)
          break // 不发 turn.done：重试轮结束时自然会发
        }
        state.retryQueued = false
        // 正常收尾：in-flight 工具追踪清空（本轮结束，无孤儿语义跨轮）。
        clearInFlightTools(state)
        // 黏性渠道（2026-09-21 暴君裁定）：本轮由重试模型接手（turnRetries>0）且产出真实正文
        // ＝该渠道实证可用，钉死本 session；personaModel() 下一轮直接用它。
        if (
          (state.turnTextChars ?? 0) > 0 &&
          (state.turnRetries ?? 0) > 0 &&
          !state.turnAborted &&
          state.lastDispatchedModel
        ) {
          const stickyPersona =
            normalizeUserSettings(loadUserSettings(state.apiKey)).persona === "thoughtful" ? "thoughtful" : "efficient"
          state.stickyModel = {
            providerID: state.lastDispatchedModel.providerID,
            modelID: state.lastDispatchedModel.modelID,
            persona: stickyPersona,
          }
          console.log(
            `[gateway] sticky channel pinned model=${state.stickyModel.providerID}/${state.stickyModel.modelID} — session=${state.sessionId}`,
          )
        }
        // R4-A S3①：抖动重试已耗尽且本轮全程零文本零工具 = 上游连续报错/空转，
        // 旧路径直接静默 turn.done（R4 实锤：APIError 后 turn 空转 5 分钟无一句
        // 中文解释）——补诚实收尾话术再交棒。
        // （下方判定同样只看 turnTextChars——语义保留理由见抖动重试处注释。）
        if (
          (state.turnTextChars ?? 0) === 0 &&
          !state.turnToolStarted &&
          !state.turnAborted &&
          (state.turnRetries ?? 0) >= TURN_MAX_RETRIES
        ) {
          // 修复2：幂等收尾——连续第二个 idle 过同一终局门时，本轮已收过尾就直接
          // 跳过（含下方 turn.done，不重发；09-19 事故 journal 成对 warn 实锤）。
          // 旗标记「已收尾的 turnGen」，跨 turn 自然失效。
          if (state.turnExhaustedClosedGen === (state.turnGen ?? 0)) break
          state.turnExhaustedClosedGen = state.turnGen ?? 0
          // 0919 诚实归因（video-director 试产事故）：收尾帧不得一律「上游持续报错」
          // ——真因是欠费时明说欠费（未提交/未扣费/充值前重试无效），是死模型时明说
          // 渠道缺模型。turnUpstreamError 在 failover 块被消费后置 null，但同轮
          // 最后一次 session.error 会再记（6670 行），此时非空 = 重试链死因仍在。
          const lastErr = state.turnUpstreamError ?? ""
          const exhaustedText = isDeadAccountError(lastErr)
            ? `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游渠道账户欠费：未提交、未扣费、无产物，充值前重试不会成功，请联系维护方）。\n`
            : isDeadModelError(lastErr)
              ? `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游渠道缺少该模型，已尝试自动换线仍未成功）。\n`
              : `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游持续报错）。你上一条消息可能没有处理成功，请重新发送一次即可继续；若内容较长，建议让我分章/分段处理。\n`
          emitToSession(state, "message.delta", { text: exhaustedText })
          console.warn(`[gateway] S3① jitter retries exhausted with zero output, closing turn honestly — session=${state.sessionId} lastError=${lastErr.slice(0, 120) || "none"}`)
        }
        // R4-A S8：turn 收尾兜底汇报——本轮有节点落终态但零主动汇报时，
        // 发一帧环名制中文总结（成功清单/失败清单/下一步），杜绝悄悄收工。
        emitTurnEndSummaryIfSilent(state)
        // R5-C：恢复轮零小结零汇报时补强制结语（S8 让位条件见函数注释）。
        emitRecoveryClosingIfSilent(state)
        {
          // C 方案（2026-10-02）：把「未兑现的开场计画」记进 state，下一轮 system 注入一行事实
          //（recordUnfulfilledPlan 读 planExperts，故必须在本行清 planExperts 之前）。
          recordUnfulfilledPlan(state)
          // 诚实告知改走耐久通道 message.delta（原 turn.status 暂态单行、紧接 turn.done 会一闪即逝）。
          emitUnfulfilledPlanNotice(state, (name, data) => emitToSession(state, name, data))
          state.planExperts = undefined
        }
        // 2026-10-11 修画布硬闸：多步影音制作未 workflow_write 真写穿 → 不得完成（每会话补写 1 次）。
        if (
          shouldBlockCompletionForWorkflowWrite({
            avProductionIntent: state.avProductionIntent === true,
            workflowWriteSucceeded: state.workflowWriteSucceeded === true,
            nudgeSent: state.workflowWriteGateNudgeSent === true,
            turnAborted: state.turnAborted === true,
            hasLastPromptBody: Boolean(state.lastPromptBody),
          })
        ) {
          state.workflowWriteGateNudgeSent = true
          const nudge = buildWorkflowWriteGateNudge(state.avProductionTemplateId)
          emitToSession(state, "message.delta", {
            text: `这一轮还差最后一步没落定，正在补上，稍等一下。\n`,
          })
          const body = state.lastPromptBody
          if (body) {
            const gen = state.turnGen ?? 0
            const tailBlock = `${TAIL_PAYLOAD_MARKER}⟦gw:${ensureGatewayNonce(state)}⟧ `
            const parts = body.parts.map((pt) => ({ ...pt }))
            const last = parts.length > 0 ? parts[parts.length - 1] : undefined
            if (last && "text" in last && last.type === "text" && typeof last.text === "string") {
              last.text = `${last.text}${tailBlock}${nudge}`
            } else {
              parts.push({ type: "text", text: `${tailBlock}${nudge}` })
            }
            const nudgeBody = { ...body, parts }
            state.retryQueued = true
            console.warn(
              `[gateway] canvas-write-gate: ${WORKFLOW_WRITE_GATE_MARK} block completion (no workflow_write) — session=${state.sessionId} template=${state.avProductionTemplateId ?? "?"}`,
            )
            setTimeout(async () => {
              const cur = sessions.get(state.sessionId)
              if (!cur || (cur.turnGen ?? 0) !== gen) return
              if (cur.turnAborted) {
                cur.lastTurnActiveAt = 0
                cur.retryQueued = false
                markDirty(cur)
                return
              }
              try {
                await revertDeadTail(cur.opencodeSessionId)
                const res = await opencodeFetch(`/session/${cur.opencodeSessionId}/prompt_async`, {
                  method: "POST",
                  body: JSON.stringify(nudgeBody),
                  timeoutMs: 10000,
                })
                if (!res.ok) throw new Error(`status ${res.status}`)
                cur.retryQueued = false
                cur.turnToolStarted = false
                console.log(`[gateway] canvas-write-gate: nudge dispatched — session=${cur.sessionId}`)
              } catch (e) {
                console.error(`[gateway] canvas-write-gate nudge failed:`, e)
                cur.retryQueued = false
                emitTurnDone(cur)
              }
            }, TURN_RETRY_DELAY_MS)
            break // 不发 turn.done：等补写轮结束
          }
        }
        emitTurnDone(state)
        // 刀 2（2026-09-15）：机器 critic pass —— 收盘判定点。
        // 四轮实录证明「叫 orchestrator 派 critic」无效（playbook 第 18 条四轮在场、四轮零派遣），
        // 改由 gateway 在此直接派。判据门槛与有界性全在 maybeRunMachineCriticPass 内：
        // beast + 有 Expert 交付 + 本轮零 critic 派遣 + 未声明未经审核 + 每会话 ≤1 次。
        // 非 beast / 无 Expert 交付 / 通用子代理路径完全不受影响（待审清单为空即零动作）。
        // 派遣非阻塞（内部 async），失败只留一行 log，不影响 turn.done 已发的事实。
        maybeRunMachineCriticPass(state, state.criticUnreviewedDeclared === true)
        // CC 2.1.302：会话目标验收（有 active goal 时，同回合最多派一次独立验收者）。
        maybeRunGoalAcceptance(state)
        // 刀 1（2026-09-19）：Jev 测谎闸＋空壳栏初筛 — shadow 模式收盘消费点。
        // fire-and-forget（内部 2s 超时、永不 throw、失败只留一行 log）；
        // 快照在本轮数据（brief 尾段/唤醒摘要/待审交付）后即刻清空 volatile。
        // JEV_ENABLED ≠ true 时 runJevShadowGate 零动作（行为与部署前逐位等价）。
        {
          const briefTail = state.jevBriefTail ?? ""
          const gateSummaries = state.jevGateSummaries ?? []
          state.jevBriefTail = ""
          state.jevGateSummaries = []
          if (briefTail || gateSummaries.length > 0) {
            void runJevShadowGate({
              briefTail,
              gateSummaries,
              deliveries: snapshotPendingCriticTargets(state.sessionId),
            })
          }
        }
        // S6 规格2：turn 正常结束，ack timer 不再需要。
        clearAckTimer(state)
        // S6 规格3：质询回覆完成 → 放行被冻结的视频工作流（先释放再压缩）。
        releasePendingVideoWorkflows(state)
        // 回合结束是滚动摘要压缩的触发点：此刻无在途生成、讯息数稳定。
        void maybeCompactSession(state)
        // CC 2.1.302 Stop hook：turn.done 已发（上方 emitTurnDone），此处仅
        // fire-and-forget。runHooksWithBudget 永不 throw，超时/无配置都不影响收盘。
        // loop guard：同一 turnGen 只触发一次，避免 Stop hook 的 block/continuation
        // 造成无限收盘循环。blocked 不得静默：落日志 + turn.status 让前端可见。
        {
          const alreadyRan = stopHookTurnGen.get(state) === state.turnGen
          stopHookTurnGen.set(state, state.turnGen)
          if (!alreadyRan) {
            void runHooksWithBudget(
              "Stop",
              {
                hook_event_name: "Stop",
                session_id: state.sessionId,
                stop_hook_active: false,
                cwd: process.cwd(),
              },
              { timeoutMs: 60_000 },
            ).then((result) => {
              if (result.errors.length > 0) {
                console.warn(`[gateway] hooks Stop errors session=${state.sessionId}: ${result.errors.join(" | ")}`)
              }
              if (result.blocked) {
                const reason = result.reason ?? "Stop hook blocked"
                console.warn(`[gateway] Stop hook blocked session=${state.sessionId} reason=${reason.slice(0, 500)}`)
                try {
                  emitToSession(state, "turn.status", { text: `收盘 hook 报告阻塞：${reason.slice(0, 500)}` })
                } catch {
                  /* SSE 不可达不改变 hook 已报告阻塞的事实 */
                }
              }
            }).catch((e) => {
              console.warn(`[gateway] hooks Stop failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`)
            })
          }
        }
        // REQ-D2（2026-09-22）：本回合排队中的 steer（回合执行中用户追加的指引）
        // 在此投递——空队列零动作（与改动前逐位等价）；turnAborted 时 planSteerFlush
        // 全数作废（停止优先），不投递。放在 turn.done 之后：前端先看到本回合收尾，
        // 才看到下一回合的引导语开场。fire-and-forget（投递失败只上报 failed 帧）。
        void flushPendingSteers(state)
        break
      }
      default:
        // session.updated / session.status / session.diff / session.created /
        // server.heartbeat / server.connected -> no frontend event
        break
    }
  } catch (e) {
    // Never let one malformed event kill the SSE reader loop. Log the event type
    // only — never the payload (tool inputs may contain user prompts).
    console.error(`[gateway] opencode event translation failed: type=${event?.type}`)
  }
}
