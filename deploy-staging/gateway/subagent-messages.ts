import { saveDurableSubagentRun, durableSubagentRun, durableSubagentRuns } from "./job-store"
import { currentKernelFingerprint, decideKernelResume } from "./agent-kernel.ts"
import type { SubagentRun, ResumeOutcome } from "./subagent-types.ts"
import { MAX_ACTIVE_PER_PARENT, HARD_TIMEOUT_MS, ASYNC_HARD_TIMEOUT_MS, SUBAGENT_BUSY_MESSAGE, subagentResumeTtlMs, SUBAGENT_CHILD_QUEUE_MAX, SUBAGENT_BUS_MAX_CHARS, partialBodyOf, isOpenCodeSessionId, readJsonObject, childFacingFrame } from "./subagent-types.ts"
import { deps, byParent, byChildOc, completed, resumable, resumeInFlight, parentStateOf, resolveParentSession, unknownSessionResponse, callerCanControlRun, siblingForbiddenResponse, findLiveRun, pruneCompleted, rememberChildParent, removeFromRegistries } from "./subagent-runs.ts"
import { finishRun, armHeartbeat } from "./subagent-finish.ts"
import { summarizeChild } from "./subagent-liveness.ts"
import { recentRunsForParent, resolveLatestRunId } from "./subagent-status.ts"
import { writeLiveLog, ensureTranscript } from "./subagent-live.ts"
import { autoResumeSuspendedRun } from "./subagent-suspend.ts"

/** 轮子：向子会话投一条消息（与 dispatchAttempt 同一条 prompt_async 轮廓——不是第二套派工；
 *  仅不重设 model：会话自己的模型设置才是在跑的那一个）。回 true＝opencode 已受理。
 *  刻意**不**把受理当成功：受理≠已处理（X3），呼叫端据此措辞。
 *  `startsNewTurn`：本次投递是否开启**新回合**（续跑／idle 边界排队投递／soft 收尾指令＝true；
 *  往正在跑的轮里插指示＝false）。只有开新轮才把 currentTurnId 清空——否则同一轮里连续两次
 *  `steer{expected_turn_id}` 会因第一次投递把轮 id 抹掉而第二次必然 turn_mismatch（实测踩到）。 */
export async function deliverChildTurn(run: SubagentRun, text: string, tag: string, startsNewTurn = false): Promise<boolean> {
  if (!deps || !isOpenCodeSessionId(run.opencodeSessionId)) return false
  const body: Record<string, unknown> = { parts: [{ type: "text", text }] }
  if (run.agent) body.agent = run.agent
  try {
    const res = await fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/prompt_async`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      console.error(`[gateway] subagent bus deliver failed (${tag}): id=${run.id} label="${run.label}" status=${res.status}`)
      return false
    }
    // 新回合开始：上一轮的 turn id 作废（否则后续 steer{expected_turn_id} 会误匹配）。
    if (startsNewTurn) run.currentTurnId = undefined
    run.lastActivityAt = Date.now()
    // F8 活性语义：投递成功＝本会话重新有在途事实（清上一 attempt 的在途工具残留同 dispatchAttempt）。
    run.pendingTools.clear()
    run.pendingToolSince?.clear()
  run.pendingToolInfo?.clear()
    console.log(`[gateway] subagent bus deliver (${tag}): id=${run.id} label="${run.label}" child=${run.opencodeSessionId}`)
    return true
  } catch (e) {
    console.error(`[gateway] subagent bus deliver threw (${tag}): id=${run.id} label="${run.label}"`, e)
    return false
  }
}

/** X6/QueueOnly：子会话 idle 边界投递排队的父→子消息（`start_if_idle` 在跑时的语义：
 *  不打断当前轮，等这一轮结束再处理）。投递成功＝本 run 继续跑（不收尾）；投递失败＝排队
 *  原样保留（不静默丢）并按原语义收尾。无排队时本函数根本不被呼叫＝零回归。 */
export async function flushPendingChildMessages(run: SubagentRun): Promise<void> {
  const queued = run.pendingChildMessages.slice()
  if (queued.length === 0) return
  const text = `【发起方的排队指示·按序处理】\n${queued.map((m, i) => `${i + 1}. ${m.text}`).join("\n")}`
  const ok = await deliverChildTurn(run, text, "queued_parent_message", true)
  if (ok) {
    run.pendingChildMessages = run.pendingChildMessages.filter((m) => !queued.some((q) => q.id === m.id))
    return
  }
  console.error(`[gateway] subagent queued message delivery failed: id=${run.id} — 排队消息保留，本回合按原语义收尾`)
  void summarizeChild(run)
}

/** C4/X7：在接续索引里按 id／label 前缀找可续跑的终态 run（本会话归属才可寻址）。 */
export function findResumableRun(parentGatewaySessionId: string, idOrLabel: string): SubagentRun | undefined {
  const list = [...resumable.values()].filter((r) => r.parentGatewaySessionId === parentGatewaySessionId && (r.resumeUntil ?? 0) > Date.now())
  // D9：同名终态按 finishedAt 取最新（resumeUntil 由终态时刻派生）。
  const byName = list.filter((r) => r.name === idOrLabel).sort((a, b) => (b.resumeUntil ?? 0) - (a.resumeUntil ?? 0))
  return list.find((r) => r.id === idOrLabel) ?? byName[0] ?? list.find((r) => r.label.startsWith(idOrLabel))
}

/** D7：按 run id 找在途或可续跑的 run（fork 结果回投 requester 用）。 */
export function findRunById(id: string): SubagentRun | undefined {
  for (const run of byChildOc.values()) if (run.id === id) return run
  for (const list of byParent.values()) for (const run of list) if (run.id === id) return run
  for (const run of resumable.values()) if (run.id === id) return run
  return undefined
}

/**
 * P1（2026-10-18）：fork 结果的投递对象判定（纯函数）。
 * requester 只有仍在跑（running／interrupted 且未 stopped）才可接收——已终态/已停止的
 * requester 其子会话没有 watcher，投进去＝起一轮无人消费的 turn、父会话永远等不到结果。
 * 这种情况一律回落主会话（"main"），由 finishRun 走 wakeParent 并记录事实。
 */
export function forkResultDeliveryTarget(
  requester: { stopped?: boolean; status?: string } | undefined,
): "requester" | "main" {
  if (!requester) return "main"
  if (requester.stopped) return "main"
  if (requester.status !== "running" && requester.status !== "interrupted") return "main"
  return "requester"
}

/** G1（2026-10-14 跨会话越权修复）：本父会话是否拥有该 run id。用于 status 的磁盘产物回退闸——
 *  归属来源＝completed 记录 / resumable 索引 / durable 行，任一命中即算拥有；全查无＝不拥有
 *  （不落 artifact 分支，防止用他会话的 run id 经落盘路径越权读取）。 */
export function parentOwnsRunId(parentKey: string, runId: string): boolean {
  const rec = completed.get(runId)
  if (rec && rec.parent === parentKey) return true
  const res = resumable.get(runId)
  if (res && res.parentGatewaySessionId === parentKey) return true
  const d = durableSubagentRun(runId)
  if (d && d.parentGatewaySessionId === parentKey) return true
  return false
}

/** Y1：已终态记录（含 durable）——cancel 的 `not_cancelable` 与「已取消」判定要用它。 */
export function findTerminalRecord(
  parentGatewaySessionId: string,
  idOrLabel: string,
): { id: string; label?: string; name?: string; status: string; resumable: boolean } | undefined {
  const recs: Array<{ id: string; label?: string; name?: string; status: string; resumable: boolean; at: number }> = []
  for (const [id, rec] of completed) {
    if (rec.parent !== parentGatewaySessionId) continue
    recs.push({ id, label: rec.label, name: rec.name, status: rec.status, resumable: resumable.has(id), at: rec.finishedAt })
  }
  for (const run of resumable.values()) {
    if (run.parentGatewaySessionId !== parentGatewaySessionId) continue
    if (recs.some((r) => r.id === run.id)) continue
    recs.push({ id: run.id, label: run.label, name: run.name, status: run.status, resumable: true, at: run.stoppedAt ?? run.startedAt })
  }
  try {
    for (const row of durableSubagentRuns()) {
      if (!row?.result || row.parentGatewaySessionId !== parentGatewaySessionId) continue
      if (recs.some((r) => r.id === row.id)) continue
      recs.push({ id: row.id, label: row.result?.label ?? row.label, name: row.result?.name, status: row.result?.status ?? row.status, resumable: false, at: row.result?.finishedAt ?? 0 })
    }
  } catch {
    /* durable 层异常不阻断终态判定（内存表已给结论） */
  }
  const byId = recs.find((r) => r.id === idOrLabel)
  if (byId) return byId
  // D9：同名终态按 finishedAt 取最新（旧实现取 Map 插入序第一条）。
  const nameMatches = recs.filter((r) => (r.name ?? "") === idOrLabel).sort((a, b) => b.at - a.at)
  if (nameMatches[0]) return nameMatches[0]
  return recs.find((r) => (r.label ?? "").startsWith(idOrLabel))
}

/** X3：接受标识（照 DeliveryReceipt）。**不是**「已被处理」的证据——响应文案已明写。 */
function nextSubmissionId(run: SubagentRun): string {
  run.submissionSeq += 1
  return `${run.id}#${run.submissionSeq}`
}

/** X6：当前轮不可 steer 的情形（Codex NonSteerableTurnKind{Review,Compact} 的对应物）：
 *  交付闸门重派在途（reworking）与机器内审 run——对它们下中途指示会污染判定。 */
function turnNotSteerable(run: SubagentRun): boolean {
  return run.reworking === true || run.machineCriticPass === true
}

async function resumeTerminalRun(
  old: SubagentRun,
  text: string,
  kind: string,
): Promise<ResumeOutcome> {
  if (!deps) return { ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized", status: 500 }
  if (old.stopped) {
    // Y4：**你自己停的**子代理不自动续——发消息被拒并告知「已取消」。
    return { ok: false, code: "agent_cancelled", error: `「${old.label}」是被人工停止的（已取消），不会自动续跑；要它继续请重新派工。`, status: 409 }
  }
  const kernel = decideKernelResume(
    old.kernelFingerprint,
    currentKernelFingerprint(old.agent, old.modelOverride?.modelID ?? old.modelChain?.[0]?.modelID),
  )
  if (!kernel.ok) return { ok: false, code: kernel.code, error: kernel.error, status: kernel.status }
  if (!isOpenCodeSessionId(old.opencodeSessionId)) {
    return { ok: false, code: "not_messageable", error: `「${old.label}」的子会话不可续（会话 id 非法或子会话已被回收）；请重新派工。`, status: 409 }
  }
  const list = byParent.get(old.parentGatewaySessionId) ?? []
  // F4（P2·并发口径不一致修复）：与其余六处（dispatch / autoResumeSuspendedRun /
  // checkPendingResumeQueue / handleSubagentResume / critic 两处）**同一口径**——只数
  // status === "running" 的（suspended/interrupted 已交出并发槽）。此前用 list.length 把
  // suspended 也算满，会把对终态 run 的合法续跑误回并发满。
  if (list.filter((r) => r.status === "running").length >= MAX_ACTIVE_PER_PARENT) {
    return { ok: false, code: "concurrency_limit", error: SUBAGENT_BUSY_MESSAGE, status: 409 }
  }
  // G3（2026-10-14 竞态修复）：认领必须在**任何 await 之前且同步完成**——否则投递 await 窗内
  // 并发第二条 start_or_steer 会各自复活出两个孤儿 run（同一条旧 run 被双重复活、重复投递、
  // 各占一个并发槽、32s 后被 stale 判 error 谎报失败）。resumable 索引＋resumeInFlight 双闸。
  if (resumeInFlight.has(old.id) || !resumable.has(old.id)) {
    return { ok: false, code: "resume_in_flight", error: "该终态子代理的续跑正在投递中，请用 subagent_status 复核后再试。", status: 409 }
  }
  resumeInFlight.add(old.id)
  const savedResumeUntil = old.resumeUntil
  resumable.delete(old.id)
  old.resumeUntil = undefined
  const run: SubagentRun = {
    // 复制原 run 的事实（agent/beastMode/prompt/modelChain/childPath/artifacts…），再逐项重置
    // 与「上一段生命」绑定的状态——不做第二套初始化逻辑，避免两处漂移。
    ...old,
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    status: "running",
    resumedFrom: old.id,
    // P1（2026-10-18 同步 run resume 永无通知修复）：终态续跑由 subagent_message 发起，
    // 发起方不再有工具在轮询；若沿用旧的 asyncMode=false，finishRun 不会 wakeParent，
    // 结果永远送不回父会话。只要注入了唤醒出口就一律 async（finishRun 走既有唤醒链）。
    asyncMode: typeof deps.wakeParent === "function" ? true : old.asyncMode,
    summary: undefined,
    error: undefined,
    stopped: undefined,
    stoppedBy: undefined,
    stoppedAt: undefined,
    softStopping: undefined,
    resumeUntil: undefined,
    usage: undefined,
    partialPersist: undefined,
    orphaned: undefined,
    recoveredWatcher: undefined,
    reworkFailure: undefined,
    reworking: false,
    machineCriticPass: undefined,
    machineCriticRejected: undefined,
    criticReviewed: undefined,
    livePath: undefined,
    liveWrittenAt: undefined,
    transcriptHideNoted: undefined,
    transcriptEnded: undefined,
    currentTurnId: undefined,
    lastToolName: undefined,
    timeoutTimer: undefined,
    deadlineTimer: undefined,
    heartbeatTimer: undefined,
    earlyPartialTimer: undefined,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    toolStatusEmitted: new Map(),
    toolTimeline: [],
    pendingChildMessages: [],
    pendingParentNotes: [],
    pendingQuestions: [],
    submissionSeq: 0,
    artifacts: [...(old.artifacts ?? [])],
  }
  byChildOc.set(run.opencodeSessionId, run)
  list.push(run)
  byParent.set(run.parentGatewaySessionId, list)
  ensureTranscript(run)
  const delivered = await deliverChildTurn(run, childFacingFrame(text, kind), "resume", true)
  if (!delivered) {
    removeFromRegistries(run)
    // G3：投递失败 ⇒ **恢复认领**（旧 run 放回 resumable 并还原 resumeUntil），父会话可重试。
    resumeInFlight.delete(old.id)
    resumable.set(old.id, old)
    old.resumeUntil = savedResumeUntil
    return { ok: false, code: "not_messageable", error: `续跑投递失败（子会话已失效或 opencode 不可达）；原终态记录与产物不受影响。`, status: 502 }
  }
  // G5(b)（2026-10-14 竞态修复）：投递 await 期间，接续窗口回收可能已并发把子会话 DELETE 掉。
  // 若本续跑 run 不再是该子会话的持有者 ⇒ 回**诚实的失败**（绝不回 started 造成「回了 started
  // 但 run 永无事件」的孤儿）。此时不恢复 resumable（窗口已过，会话已回收）。
  if (byChildOc.get(run.opencodeSessionId) !== run) {
    resumeInFlight.delete(old.id)
    removeFromRegistries(run)
    return { ok: false, code: "session_reclaimed", error: `续跑期间子会话已被回收（接续窗口到期）；本条指示未送达。原终态记录与产物不受影响，请重新派工。`, status: 409 }
  }
  resumeInFlight.delete(old.id)
  rememberChildParent(run.opencodeSessionId, run)
  saveDurableSubagentRun(run)
  const idx = completed.get(old.id)
  if (idx) idx.resumable = false
  // 续跑段同样是完整的一次派遣：硬顶＋心跳按 async 档重新预算（同 startRework 的理由）。
  const hardMs = run.asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout in resume (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    run.partialPersist = true
    void finishRun(run, "error", partialBodyOf(run), `子代理续跑超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  armHeartbeat(run, hardMs)
  const state = parentStateOf(run)
  if (state) {
    try {
      deps.emitToSession(state, "subagent.started", { id: run.id, label: run.label, resumed_from: old.id })
    } catch {
      /* 帧失败不影响续跑 */
    }
  }
  writeLiveLog(run, true)
  console.log(`[gateway] subagent resumed: id=${run.id} resumed_from=${old.id} label="${run.label}" child=${run.opencodeSessionId}`)
  return { ok: true, run, submissionId: nextSubmissionId(run) }
}

/**
 * POST /internal/subagent/message —— 父→子消息（spec §3.1）。
 * body { session_id, subagent_id, text, mode?, expected_turn_id?, kind?, question_id? }
 * 语义（照 X6 `TurnInputMode`）：
 *   - `start_or_steer`（缺省）：在跑 → steer；空闲／已终态且仍在接续窗口 → 后台续跑；
 *   - `start_if_idle`：在跑 → 只入队（QueueOnly，不打断当前轮），idle 边界才投递；
 *   - `steer`：必须正在跑且有 `expected_turn_id` 匹配当前轮；不符 → `turn_mismatch`，
 *     当前轮不可 steer（内审／重派在途）→ `turn_not_steerable`，**不静默**。
 * 回应必带 `submission_id` 与「接受标识不代表已被处理」注记（照 X3）。
 * 人工硬停（stopped）的 run → `agent_cancelled`（照 Y4「你自己停的」）。
 */
export async function handleSubagentMessage(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  pruneCompleted()
  const body = (await readJsonObject(req)) as {
    session_id?: string
    subagent_id?: string
    text?: string
    mode?: string
    expected_turn_id?: string
    kind?: string
    question_id?: string
  }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  const target = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  if (!sid || !target) {
    return Response.json({ ok: false, code: "missing_required_args", error: "session_id 与 subagent_id 必填（subagent_id 可为完整 runId／label 前缀／latest）" }, { status: 400 })
  }
  const rawText = typeof body.text === "string" ? body.text.trim() : ""
  if (!rawText) return Response.json({ ok: false, code: "missing_required_args", error: "text 必填（要投给子代理的指示原文）" }, { status: 400 })
  const text = rawText.slice(0, SUBAGENT_BUS_MAX_CHARS)
  // G6（2026-10-14 修复）：mode/kind 若**存在**必须合法，非法值不再静默降级——如实回 400 具名
  // code。不传 mode/kind 时行为逐字不变（默认 start_or_steer／message）。
  const rawMode = body.mode
  if (rawMode !== undefined && rawMode !== "start_or_steer" && rawMode !== "start_if_idle" && rawMode !== "steer") {
    return Response.json(
      { ok: false, code: "invalid_mode", error: `mode 非法：只接受 start_or_steer／start_if_idle／steer（收到 ${JSON.stringify(rawMode)}）。` },
      { status: 400 },
    )
  }
  const rawKind = body.kind
  if (rawKind !== undefined && rawKind !== "message" && rawKind !== "question" && rawKind !== "followup") {
    return Response.json(
      { ok: false, code: "invalid_kind", error: `kind 非法：只接受 message／question／followup（收到 ${JSON.stringify(rawKind)}）。` },
      { status: 400 },
    )
  }
  const mode = rawMode === "start_if_idle" ? "start_if_idle" : rawMode === "steer" ? "steer" : "start_or_steer"
  const kind = rawKind === "question" ? "question" : rawKind === "followup" ? "followup" : "message"
  // G6：mode=steer 必须带 expected_turn_id（否则「精确 steer」无从判据）；缺 → 400 具名 code。
  if (mode === "steer" && (typeof body.expected_turn_id !== "string" || !body.expected_turn_id.trim())) {
    return Response.json(
      { ok: false, code: "missing_expected_turn_id", error: 'mode:"steer" 需要 expected_turn_id（先 subagent_status 取 current_turn_id）。' },
      { status: 400 },
    )
  }
  // S4（FIX-G2）：session_id 必须解析到真实会话，否则 404 unknown_session（不回退原始字符串当父键）。
  const parent = resolveParentSession(sid)
  if (!parent) return unknownSessionResponse(sid)
  const parentKey = parent.sessionId
  const wantId = target === "latest" ? resolveLatestRunId(parentKey) ?? target : target
  // P2（2026-10-18 同级越权）：子代理只能给自己的子 run 发消息；兄弟 run 一律 403。
  // 终态目标没有内存 run 可判归属，按 durable 行（含 parentSubagentId/forkRequesterRunId）判。
  const callerRun = byChildOc.get(sid)
  if (callerRun) {
    const liveForAuth = findLiveRun(parentKey, wantId)
    if (liveForAuth) {
      if (!callerCanControlRun(sid, liveForAuth)) return siblingForbiddenResponse()
    } else {
      const durableTarget = durableSubagentRun(wantId)
      if (!durableTarget || !callerCanControlRun(sid, durableTarget)) return siblingForbiddenResponse()
    }
  }

  const live = findLiveRun(parentKey, wantId)
  if (live) {
    // 收尾中的 run（soft stop 在途）：既有轮已 abort，新指示会与「立即收尾」打架 ⇒ 如实拒绝
    // 并指出出路（收尾后可在接续窗口内续跑），不静默吞掉。
    if (live.softStopping) {
      return Response.json(
        { ok: false, code: "not_messageable", error: `「${live.label}」正在收尾（已请求它写完当前成果就结束），此刻不再接收新指示。收尾后 ${Math.round(subagentResumeTtlMs() / 1000)}s 内可用同一条通道续跑。` },
        { status: 409 },
      )
    }
    const running = live.status === "running"
    const notSteerable = turnNotSteerable(live)
    if (mode === "steer" || (running && !notSteerable && mode === "start_or_steer")) {
      // `steer` 是精确投递：没有在跑的轮、轮不可 steer、或轮 id 不符，一律如实拒绝（不静默）。
      if (mode === "steer" && !running) {
        return Response.json({ ok: false, code: "not_messageable", error: `「${live.label}」当前没有在跑的回合，无法精确 steer；用 start_or_steer 或 start_if_idle。` }, { status: 409 })
      }
      if (mode === "steer" && notSteerable) {
        return Response.json({ ok: false, code: "turn_not_steerable", error: `「${live.label}」当前回合不可 steer（内审／重派交接在途）；请等这一轮结束或改用 start_if_idle 排队。` }, { status: 409 })
      }
      if (mode === "steer" && typeof body.expected_turn_id === "string" && body.expected_turn_id && live.currentTurnId !== body.expected_turn_id) {
        return Response.json(
          {
            ok: false,
            code: "turn_mismatch",
            error: `expected_turn_id 与当前轮不符（当前轮 ${live.currentTurnId ?? "未知"}，期望 ${body.expected_turn_id}）；指示未投递。用 subagent_status 取 current_turn_id 后重投。`,
            current_turn_id: live.currentTurnId ?? null,
          },
          { status: 409 },
        )
      }
      const delivered = await deliverChildTurn(live, childFacingFrame(text, kind), mode === "steer" ? "steer" : "start_or_steer")
      if (!delivered) {
        return Response.json({ ok: false, code: "not_messageable", error: `投递失败（opencode 不可达或子会话已失效）；指示未投递。` }, { status: 502 })
      }
      const questionResolved = resolveQuestionOnAnswer(live, body.question_id)
      return Response.json({
        ok: true,
        delivery: "steered",
        subagent_id: live.id,
        submission_id: nextSubmissionId(live),
        note: "接受标识不代表已被处理：它只证明这一条已经交给子代理，子代理在下一次回报里确认是否落实。",
        ...(questionResolved ? { question_resolved: true } : {}),
      })
    }
    // 挂起态（支柱四）：挂起的 run 不会自己结束本轮，走下面的 QueueOnly 排队＝永不送达
    // （尤其 blocking 提问的答复会永远卡在队列里、问题永不解除）。故此处立即唤醒：清挂起、
    // 取并发槽（满则入恢复队列）、把指示／答复原文投进子会话，并按 question_id 解除提问。
    if (live.status === "suspended") {
      // P1（2026-10-18 答复过早解除修复）：question 只在**真正投递成功**后解除。
      // autoResume 现在回三态：resumed（已投递）/ queued（槽满入队，尚未投递）/ false。
      // queued 时把 question_id 随队列项一起保存，等队列真正投递成功再解除（见 checkPendingResumeQueue）。
      const hadQuestion = typeof body.question_id === "string" && body.question_id.length > 0 &&
        (live.pendingQuestions?.some((q) => q.id === body.question_id) ?? false)
      const outcome = await autoResumeSuspendedRun(
        live,
        kind === "question" ? "answer" : "message",
        undefined,
        childFacingFrame(text, kind),
        body.question_id,
      )
      if (outcome === false) {
        return Response.json({ ok: false, code: "not_messageable", error: `「${live.label}」挂起态唤醒失败；指示未投递（提问保持未答，可重投）。` }, { status: 502 })
      }
      const questionResolved = outcome === "resumed" && hadQuestion && !(live.pendingQuestions?.some((q) => q.id === body.question_id) ?? false)
      return Response.json({
        ok: true,
        delivery: outcome === "resumed" ? "resumed" : "queued",
        subagent_id: live.id,
        submission_id: nextSubmissionId(live),
        note:
          outcome === "resumed"
            ? "挂起子代理已被唤醒并获得并发槽位，指示／答复已投递（复用同一子会话与历史）。接受标识不代表已被处理。"
            : "并发槽位已满，唤醒请求与指示／答复已入恢复队列；投递成功后才解除提问。",
        ...(questionResolved ? { question_resolved: true } : {}),
      })
    }
    // QueueOnly（X9 同旨）：不打断当前轮，等它自己 idle 再投（`start_if_idle` 在跑时的语义；
    // 内审/重派在途的 start_or_steer 也走这条腿——不污染正在跑的判定轮）。
    live.pendingChildMessages.push({ id: crypto.randomUUID(), text, at: Date.now() })
    if (live.pendingChildMessages.length > SUBAGENT_CHILD_QUEUE_MAX) {
      live.pendingChildMessages.splice(0, live.pendingChildMessages.length - SUBAGENT_CHILD_QUEUE_MAX)
    }
    // P1（2026-10-18）：QueueOnly 分支此前从不解除提问——答复明明已排队，父会话却一直看到
    // pending_questions，子代理白等到超时。投递（入队）成功后按 question_id 精确解除。
    const questionResolved = resolveQuestionOnAnswer(live, body.question_id)
    writeLiveLog(live)
    return Response.json({
      ok: true,
      delivery: "queued",
      subagent_id: live.id,
      submission_id: nextSubmissionId(live),
      pending_count: live.pendingChildMessages.length,
      ...(questionResolved ? { question_resolved: true } : {}),
      note: "已排队（不打断当前轮）：子代理这一轮结束时按序处理。接受标识不代表已被处理。",
    })
  }

  // 已终态：仍在接续窗口 → 后台续跑（Y4）；人工停的 → agent_cancelled；窗口已过 → 如实说明。
  const terminal = findTerminalRecord(parentKey, wantId)
  if (terminal && terminal.status === "stopped") {
    return Response.json(
      { ok: false, code: "agent_cancelled", error: `「${terminal.label ?? ""}」是被人工停止的（已取消），不会自动续跑；要它继续请重新派工。`, subagent_id: terminal.id },
      { status: 409 },
    )
  }
  // G3（2026-10-14 竞态修复）：该终态 run 的续跑正在投递中（已被并发第一条认领）——如实回
  // resume_in_flight，绝不当作「窗口已过」谎报 not_messageable，更不二次复活成孤儿。
  if (terminal && resumeInFlight.has(terminal.id)) {
    return Response.json(
      { ok: false, code: "resume_in_flight", error: "该终态子代理的续跑正在投递中，请用 subagent_status 复核后再试。", subagent_id: terminal.id },
      { status: 409 },
    )
  }
  const revivable = findResumableRun(parentKey, wantId)
  if (revivable) {
    const res = await resumeTerminalRun(revivable, text, kind)
    if (!res.ok) return Response.json({ ok: false, code: res.code ?? "not_messageable", error: res.error ?? "续跑失败", subagent_id: revivable.id }, { status: res.status ?? 409 })
    return Response.json({
      ok: true,
      delivery: "started",
      subagent_id: res.run?.id ?? revivable.id,
      resumed_from: revivable.id,
      submission_id: res.submissionId,
      note: "已在后台续跑（复用同一个子会话与历史，不需重新派工）。接受标识不代表已被处理。",
    })
  }
  // 既不在跑、不可续跑、也没有终态记录 ⇒ 真的不存在（404）；有终态记录但过窗 ⇒ 409 如实说明。
  if (!terminal) {
    return Response.json(
      { ok: false, code: "not_found", error: `找不到子代理：${target}（本会话没有这个 run、也没有可续跑的终态记录）`, recent_runs: recentRunsForParent(parentKey, 3) },
      { status: 404 },
    )
  }
  // 已经被续跑过的 run：原 id 不再是投递对象（那次续跑是它的下一段生命），指出新 id 而不是
  // 让父会话以为「窗口过期」去重派（重派＝重复劳动，正是本轮要消的病）。
  const continuation = findContinuationOf(terminal.id)
  return Response.json(
    {
      ok: false,
      code: "not_messageable",
      error: continuation
        ? `「${terminal.label ?? ""}」已经被续跑（当前那一段是 ${continuation.id}，状态 ${continuation.status}）；请把指示投给 ${continuation.id}，不要重新派工。`
        : `「${terminal.label ?? ""}」已结束（${terminal.status}）且已过接续窗口（窗口只在进程存活期间有效），无法续跑；请重新派工。`,
      ...(continuation ? { continuation_id: continuation.id } : {}),
      recent_runs: recentRunsForParent(parentKey, 3),
    },
    { status: 409 },
  )
}

/** C4：某 run 的「续跑段」（它的下一段生命）——按 resumedFrom 反查在跑／可续跑／终态记录。 */
function findContinuationOf(runId: string): { id: string; status: string } | undefined {
  for (const run of resumable.values()) if (run.resumedFrom === runId) return { id: run.id, status: run.status }
  for (const p of byParent.values()) for (const run of p) if (run.resumedFrom === runId) return { id: run.id, status: run.status }
  for (const [id, rec] of completed) if (rec.resumedFrom === runId) return { id, status: rec.status }
  return undefined
}

/** X5/Y1/Y2：父会话的答复到达 ⇒ 解除对应的阻塞式提问登记（只按 question_id 精确解除；
 *  没有 id／id 不符＝不动，绝不猜着解）。回 true＝确实解除了一条。 */
export function resolveQuestionOnAnswer(run: SubagentRun, questionId: string | undefined): boolean {
  if (typeof questionId !== "string" || !questionId) return false
  const hit = run.pendingQuestions?.find((q) => q.id === questionId)
  if (!hit) return false
  run.pendingQuestions = run.pendingQuestions.filter((q) => q.id !== questionId)
  writeLiveLog(run)
  console.log(`[gateway] subagent question answered: id=${run.id} question=${questionId}`)
  return true
}

