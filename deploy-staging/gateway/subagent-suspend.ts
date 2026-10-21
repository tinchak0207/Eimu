import { notify } from "./internal-waiters.ts"
import type { SubagentRun } from "./subagent-types.ts"
import { MAX_ACTIVE_PER_PARENT, unrefTimer, isOpenCodeSessionId, readJsonObject } from "./subagent-types.ts"
import { deps, byParent, byChildOc, pendingResumeQueue, parentStateOf, resolveParentSession, unknownSessionResponse, callerCanControlRun, siblingForbiddenResponse, findLiveRun } from "./subagent-runs.ts"
import { maybeDrainCriticQueue } from "./subagent-events.ts"
import { resolveLatestRunId } from "./subagent-status.ts"
import { writeLiveLog } from "./subagent-live.ts"
import { deliverChildTurn, resolveQuestionOnAnswer } from "./subagent-messages.ts"

// ── 支柱四：主动挂起与恢复（Suspend & Resume）──────────────────────────────────
/** 挂起 timer 的单一臂法（P2 2026-10-18）：投递失败时**自动重臂**，不再让 run 永久卡在
 *  suspended（旧实现 timer 到点恢复失败后无任何后续触发源）。 */
function armSuspensionTimer(run: SubagentRun, delayMs: number): void {
  const suspension = run.suspension
  if (!suspension) return
  if (suspension.timer) clearTimeout(suspension.timer)
  suspension.timer = setTimeout(() => {
    if (run.suspension !== suspension) return
    suspension.timer = undefined
    void autoResumeSuspendedRun(run, "timer_expired").then((outcome) => {
      if (outcome === false && run.status === "suspended") armSuspensionTimer(run, Math.min(30_000, delayMs))
    })
  }, delayMs)
  unrefTimer(suspension.timer)
}

/**
 * 自动恢复挂起的 run。
 * 返回值（P1 2026-10-18 三态化）：
 *   - "resumed"：并发槽已拿到且 prompt_async 投递成功（提问此时才解除）；
 *   - "queued" ：槽位满，恢复请求与待投内容（含 question_id）已入队，**尚未投递**；
 *   - false    ：投递失败/状态不符，状态退回 suspended，调用方不得标记已答。
 */
export async function autoResumeSuspendedRun(
  run: SubagentRun,
  triggerSource: string,
  customPayload?: unknown,
  resumeText?: string,
  questionId?: string,
): Promise<"resumed" | "queued" | false> {
  if (run.status !== "suspended") return false
  const parentKey = run.parentGatewaySessionId
  const runningCount = (byParent.get(parentKey) ?? []).filter((r) => r.status === "running").length
  if (runningCount >= MAX_ACTIVE_PER_PARENT) {
    let q = pendingResumeQueue.get(parentKey)
    if (!q) {
      q = []
      pendingResumeQueue.set(parentKey, q)
    }
    if (!q.some((item) => item.run.id === run.id)) {
      // P1：question_id 随队列项保存，真正投递成功后才解除（不得在入队时就标已答）。
      q.push({ run, payload: customPayload, triggerSource, resumeText, questionId })
    }
    // F3（P1·答复被 timer 抢先吞掉修复）：入队即解除挂起时臂上的 timer（默认 30s）——否则 timer
    // 先到点会用**通用恢复文案**唤醒 run，入队的 resumeText（答问原文）永不投递（且提问已被标记
    // resolved）。排队成功后投递的唯一触发权交给 checkPendingResumeQueue。
    if (run.suspension?.timer) {
      clearTimeout(run.suspension.timer)
      run.suspension.timer = undefined
    }
    return "queued"
  }
  if (run.suspension?.timer) {
    clearTimeout(run.suspension.timer)
    run.suspension.timer = undefined
  }
  run.status = "running"
  const checkpointData = customPayload ?? run.suspension?.checkpoint_data
  // F2（P1·谎报成功＋僵尸占槽修复）：先留住 suspension 对象，投递失败时原样退回（timer 上面已
  // 就地置 undefined ⇒ 退回后也不会重臂，符合「不重臂」）。
  const savedSuspension = run.suspension
  run.suspension = undefined
  run.lastActivityAt = Date.now()
  writeLiveLog(run, true)
  // resumeText（来自发起方的答问／指示）优先：挂起子代理被唤醒时最需要的是这条内容本身，
  // 而不是「槽位已获取」的空话。无 resumeText 时维持既有文案逐字不变。
  const resumeMsg =
    resumeText ??
    (checkpointData
      ? `【挂起结束·恢复执行（触发源：${triggerSource}）】\n数据：\n${typeof checkpointData === "string" ? checkpointData : JSON.stringify(checkpointData, null, 2)}\n\n并发槽已获取，请接续下一步！`
      : `【挂起结束·恢复执行（触发源：${triggerSource}）】并发槽已获取，请继续推进！`)
  // F2：以投递结果为真值——子会话已死时 deliverChildTurn 回 false，不得无条件回 true（调用方会
  // 误回 ok:true/steered，且 run 停在 running 一直占并发槽＝僵尸占槽）。
  const delivered = await deliverChildTurn(run, resumeMsg, `auto_resume_${triggerSource}`, true)
  if (!delivered) {
    // 投递失败：不谎报——状态退回 suspended、恢复 suspension、写一次 live log，如实回 false
    // （resumed 事件此时尚未发出，不会有「已恢复」的假帧）。
    run.status = "suspended"
    run.suspension = savedSuspension
    run.lastActivityAt = Date.now()
    writeLiveLog(run, true)
    return false
  }
  // P1：真正投递成功后才解除对应提问（早于此＝父会话以为答过了，子代理其实没收到）。
  if (questionId) resolveQuestionOnAnswer(run, questionId)
  // 投递成功：发 resumed 事件（与既有 happy path 同一载荷，仅移到投递确认之后）。
  const parentState = parentStateOf(run)
  if (parentState && deps) {
    deps.emitToSession(parentState, "subagent.resumed", { id: run.id, label: run.label, trigger: triggerSource })
  }
  return "resumed"
}

/** 槽位空出时检查恢复队列。
 *  P2（2026-10-18）：shift 后投递失败必须**重入队并重臂 timer**——旧实现直接丢弃，run 永远
 *  卡在 suspended，父会话也再没有触发源。 */
export function checkPendingResumeQueue(parentId: string): void {
  if (!parentId) return
  const q = pendingResumeQueue.get(parentId)
  if (!q || q.length === 0) return
  const runningCount = (byParent.get(parentId) ?? []).filter((r) => r.status === "running").length
  if (runningCount >= MAX_ACTIVE_PER_PARENT) return
  const next = q.shift()
  if (!next) return
  // F8（P2·无界常驻修复）：队列抽空即删键——否则每个曾入队的父会话永久留键（非空时还持有 run
  // 引用）。下一个仍留队时保持键，条数由 handleSubagentResume/autoResume 的「同 run 不重复入队」有界。
  if (q.length === 0) pendingResumeQueue.delete(parentId)
  void autoResumeSuspendedRun(next.run, next.triggerSource, next.payload, next.resumeText, next.questionId).then((outcome) => {
    if (outcome !== false) return
    // 失败：重入队（队首，保持原顺序）＋重臂 timer；下一次槽位释放或 timer 到点再试。
    let queue = pendingResumeQueue.get(parentId)
    if (!queue) {
      queue = []
      pendingResumeQueue.set(parentId, queue)
    }
    if (!queue.some((item) => item.run.id === next.run.id)) queue.unshift(next)
    const timeoutMs = Math.min(30_000, Math.max(5_000, (next.run.suspension?.condition.timeout_seconds ?? 30) * 1000))
    armSuspensionTimer(next.run, timeoutMs)
    console.warn(`[gateway] resume queue delivery failed, re-queued: id=${next.run.id} label="${next.run.label}"`)
  })
}

/**
 * POST /internal/subagent/suspend
 * body { session_id, subagent_id?, reason?, condition?: { type?: "timer"|"manual", timeout_seconds? }, checkpoint_data? }
 */
export async function handleSubagentSuspend(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    subagent_id?: string
    reason?: string
    condition?: {
      type?: "timer" | "manual" | "poll_task"
      timeout_seconds?: number
    }
    checkpoint_data?: Record<string, unknown>
  }
  const childOc = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!childOc) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填（子代理自己的 opencode 会话 id 或 parent session id）" }, { status: 400 })
  const wantId = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  const run = byChildOc.get(childOc) ?? (wantId ? findLiveRun(childOc, wantId) : undefined)
  if (!run) {
    return Response.json({ ok: false, code: "not_found", error: "找不到指定的子代理" }, { status: 404 })
  }
  if (run.status !== "running") {
    return Response.json({ ok: false, code: "not_suspendable", error: `子代理当前状态为 ${run.status}，只有 running 状态可主动挂起` }, { status: 409 })
  }
  const cond = body.condition && typeof body.condition === "object" ? body.condition : { type: "timer" as const, timeout_seconds: 30 }
  const timeoutSec = Math.max(1, Math.min(Number(cond.timeout_seconds) || 30, 1800))
  const resumeToken = crypto.randomUUID()
  run.status = "suspended"
  run.suspension = {
    reason: String(body.reason || "主动挂起等待异步任务/释放槽位").slice(0, 500),
    // poll_task 输入保留兼容但按 timer 处理（没有真实轮询器时不得假装在轮询）。
    condition: {
      type: cond.type === "manual" ? "manual" : "timer",
      timeout_seconds: timeoutSec,
    },
    checkpoint_data: typeof body.checkpoint_data === "object" && body.checkpoint_data !== null && !Array.isArray(body.checkpoint_data) ? body.checkpoint_data : undefined,
    suspended_at: Date.now(),
    resume_token: resumeToken,
  }
  if (run.suspension.condition.type === "timer") {
    armSuspensionTimer(run, timeoutSec * 1000)
  }
  // P0（2026-10-18 suspend 不真停修复）：此时若子会话仍有一轮在生成，必须 abort——只改状态
  // 不中止生成 = 算力继续烧、事件继续流、父会话以为它停了。**不 DELETE**（挂起要保留历史，
  // resume 复用同一会话）。并发口径明确为「挂起不占槽，但已停止生成」。
  if (isOpenCodeSessionId(run.opencodeSessionId) && deps) {
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  writeLiveLog(run, true)
  const parentState = parentStateOf(run)
  if (parentState) {
    deps.emitToSession(parentState, "subagent.suspended", {
      id: run.id,
      label: run.label,
      reason: run.suspension.reason,
      condition: run.suspension.condition,
    })
  }
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  checkPendingResumeQueue(run.parentGatewaySessionId)
  return Response.json({
    ok: true,
    status: "suspended",
    subagent_id: run.id,
    resume_token: resumeToken,
    timeout_seconds: timeoutSec,
    note: "已中止当前生成并交出并发槽位（挂起不占槽、不再消耗算力；子会话与历史保留）。超时或调用 subagent_resume 时恢复执行。",
  })
}

/**
 * POST /internal/subagent/resume
 * body { session_id, subagent_id, resume_token?, payload?, trigger_source? }
 */
export async function handleSubagentResume(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    subagent_id?: string
    resume_token?: string
    payload?: unknown
    trigger_source?: string
  }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  const target = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  if (!sid || !target) {
    return Response.json({ ok: false, code: "missing_required_args", error: "session_id 与 subagent_id 必填" }, { status: 400 })
  }
  const parent = resolveParentSession(sid)
  if (!parent) return unknownSessionResponse(sid)
  const parentKey = parent.sessionId
  const wantId = target === "latest" ? resolveLatestRunId(parentKey) ?? target : target
  const run = findLiveRun(parentKey, wantId)
  if (!run) {
    return Response.json({ ok: false, code: "not_found", error: `找不到子代理：${target}` }, { status: 404 })
  }
  // P2（2026-10-18 同级越权）：子代理只能恢复自己派出的子 run。
  if (!callerCanControlRun(sid, run)) return siblingForbiddenResponse()
  if (run.status !== "suspended") {
    return Response.json({ ok: false, code: "not_suspended", error: `子代理当前状态为 ${run.status}，非 suspended 挂起状态无法 resume` }, { status: 409 })
  }
  const token = typeof body.resume_token === "string" ? body.resume_token.trim() : ""
  if (token && run.suspension?.resume_token && token !== run.suspension.resume_token) {
    return Response.json({ ok: false, code: "invalid_resume_token", error: "resume_token 不匹配" }, { status: 403 })
  }
  const runningCount = (byParent.get(parentKey) ?? []).filter((r) => r.status === "running").length
  if (runningCount >= MAX_ACTIVE_PER_PARENT) {
    let q = pendingResumeQueue.get(parentKey)
    if (!q) {
      q = []
      pendingResumeQueue.set(parentKey, q)
    }
    if (!q.some((item) => item.run.id === run.id)) {
      q.push({ run, payload: body.payload, triggerSource: body.trigger_source || "manual" })
    }
    // G2（2026-10-14 修复·同型 F3）：入队即解除挂起时臂上的 timer——否则 timer 先到点会用通用
    // 恢复文案唤醒 run，队列项里的 payload 永不投递。投递唯一触发权交给 checkPendingResumeQueue。
    if (run.suspension?.timer) {
      clearTimeout(run.suspension.timer)
      run.suspension.timer = undefined
    }
    return Response.json({
      ok: true,
      queued: true,
      status: "suspended",
      subagent_id: run.id,
      note: "当前并发槽位已满（3/3），恢复请求已入队排队，待槽位空出后自动恢复",
    })
  }
  // F2（P1·谎报成功修复）：autoResumeSuspendedRun 以投递结果为真值，投递失败（子会话不可达/已失效）
  // 时如实回 502 not_messageable，绝不回「已恢复运行」。
  // P1（2026-10-18 同步 run resume 永无通知修复）：手动 resume 意味着已经没有工具在轮询——
  // 若原 run 是同步（asyncMode=false），完成后不会 wakeParent，父会话永远等不到通知。改为 async。
  if (run.asyncMode !== true && typeof deps.wakeParent === "function") {
    run.asyncMode = true
    console.log(`[gateway] subagent resume switched to async notify: id=${run.id} label="${run.label}"`)
  }
  const resumed = await autoResumeSuspendedRun(run, body.trigger_source || "manual", body.payload)
  if (resumed === false) {
    return Response.json(
      { ok: false, code: "not_messageable", error: "挂起子代理唤醒失败（子会话不可达或已失效）；未投递。", subagent_id: run.id },
      { status: 502 },
    )
  }
  if (resumed === "queued") {
    return Response.json({
      ok: true,
      queued: true,
      status: "suspended",
      subagent_id: run.id,
      note: "当前并发槽位已满（3/3），恢复请求已入队排队，待槽位空出后自动恢复",
    })
  }
  return Response.json({
    ok: true,
    status: "running",
    subagent_id: run.id,
    note: "子代理已恢复运行并获得并发槽位",
  })
}

/**
 * D1（2026-10-02）：工具层重复呼叫断路器的强制收尾端点。
 * 由 .opencode/plugin/eimu-guard.ts 在「同一 (session, tool, 正规化 args) 第 N+5 次」时呼叫：
 * 中止该会话当前生成并回灌一则系统说明。**轮询类工具不触发**（2026-10-02 使用者裁定：保留轮询）。
 * body { session_id, tool, count }。
 */
export async function handleLoopBreaker(req: Request): Promise<Response> {
  if (!deps) {
    return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  }
  const body = (await readJsonObject(req)) as { session_id?: string; tool?: string; count?: number }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sid) {
    return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  }
  const state = deps.resolveSession(sid) ?? deps.findSessionByOpenCodeId(sid)
  const ocId = state?.opencodeSessionId
  if (ocId) {
    void fetch(`${deps.openCodeUrl}/session/${ocId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  if (state) {
    deps.emitToSession(state, "turn.status", {
      // 2026-10-04 F4：去内部化——不贴内部工具名（工具面属后厨），只说用户视角的后果与出路。
      text: `同一个动作被以完全相同的参数重复了 ${body.count ?? 0} 次，已结束本轮以免空转；请换个做法，或告诉我新的方向。`,
    })
  }
  console.warn(
    `[gateway] loop-breaker abort: session=${state?.sessionId ?? sid} tool=${body.tool ?? "?"} count=${body.count ?? 0} aborted=${Boolean(ocId)}`,
  )
  return Response.json({ ok: true, aborted: Boolean(ocId), session_id: state?.sessionId ?? sid })
}

