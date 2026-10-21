import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SubagentCheckpoint, TypedArtifact, ScratchpadEntry } from "./subagent-types.ts"
import { SUBAGENT_CHECKPOINTS_DIR, SUBAGENT_NOTE_QUEUE_MAX, SUBAGENT_QUESTION_MAX, SUBAGENT_BUS_MAX_CHARS, SUBAGENT_NOTIFY_THROTTLE_MS, SUBAGENT_QUESTION_DEFAULT_TTL_MS, SUBAGENT_QUESTION_MAX_TTL_MS, SUBAGENT_UNTRUSTED_PREFIX, SUBAGENT_INTERNAL_BODY_WITHHELD, isInternalReviewRun, readJsonObject } from "./subagent-types.ts"
import { deps, byChildOc, sessionScratchpads, sessionArtifactRegistries, subagentParentState, parentStateOf, resolveParentSession, unknownSessionResponse, findLiveRun } from "./subagent-runs.ts"
import { writeLiveLog, pushParentNote } from "./subagent-live.ts"

/**
 * POST /internal/subagent/notify —— 子→父回报（spec §3.1；照 X5/X9）。
 * body { session_id(子会话 oc id), kind:"progress"|"blocked"|"question", text, question? }
 * 语义：父会话在途回合 → 只追加 state.subagentNotes ＋ 发 `subagent.note` 帧，回
 * `skipped_inactive`（**不打断**）；父空闲 → 唤醒一次回 `accepted`。唤醒节流 60s；
 * `question` 不节流并登记阻塞式提问（有界、带 question_id／is_blocking／超时）。
 * 立场：这是「子代理之言」——送进父会话的正文带不可信前缀（Y4），不构成授权。
 */
export async function handleSubagentNotify(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    kind?: string
    text?: string
    question?: { header?: string; options?: unknown; is_blocking?: boolean; is_secret?: boolean; auto_resolution_ms?: number }
  }
  const childOc = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!childOc) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填（子代理自己的 opencode 会话 id）" }, { status: 400 })
  const kind = body.kind === "blocked" ? "blocked" : body.kind === "question" ? "question" : "progress"
  const run = byChildOc.get(childOc) ?? [...byChildOc.values()].find((r) => r.opencodeSessionId === childOc)
  // G7（2026-10-14 修复）：question 若 present 必须是**普通对象**——错型（数组/字串/数字）一律
  // 400 具名 code，不再当 `{}` 照登记（旧行为会把 `["a"]` 登记成一条空阻塞提问）。
  if (body.question !== undefined && body.question !== null && (typeof body.question !== "object" || Array.isArray(body.question))) {
    return Response.json({ ok: false, code: "invalid_question", error: "question 必须是对象：{ header, options?, is_blocking?, is_secret?, auto_resolution_ms? }。" }, { status: 400 })
  }
  const q = body.question ?? {}
  const text = (typeof body.text === "string" ? body.text.trim() : "").slice(0, SUBAGENT_BUS_MAX_CHARS)
  // G7：question.auto_resolution_ms present 但非有限正数 → 400（不再静默回退默认 600s）。
  if (q.auto_resolution_ms !== undefined && (typeof q.auto_resolution_ms !== "number" || !Number.isFinite(q.auto_resolution_ms) || q.auto_resolution_ms <= 0)) {
    return Response.json({ ok: false, code: "invalid_question", error: "question.auto_resolution_ms 必须是有限正数。" }, { status: 400 })
  }
  if (!text && kind !== "question") {
    return Response.json({ ok: false, code: "missing_required_args", error: "text 必填（kind=question 时可用 question.header 代替）" }, { status: 400 })
  }
  // G7：kind=question 既无 text 也无 question.header → 400（不得登记空提问）。
  if (kind === "question" && !text && !(typeof q.header === "string" && q.header.trim())) {
    return Response.json({ ok: false, code: "missing_required_args", error: "kind=question 需要 text 或非空 question.header。" }, { status: 400 })
  }
  if (!run) {
    // 兜底（runtime 侧契约：session_id 是子代理自己的 opencode 会话 id）：run 已摘出注册表
    // 但**父会话**仍可由既有 subagentParentState 轮子（byChildOc→recentChildParent→durable
    // 绑定三层）反查到。此时仍把回报送到父会话（不静默丢弃），只是没有本路的队列/节流记账
    // ⇒ 如实回报（question 照旧登记 id，但不挂在 run 上）。
    const fallback = subagentParentState(childOc)
    if (!fallback) {
      return Response.json({ ok: false, code: "not_found", error: "子会话不存在或该子代理已结束（回报需要子代理仍在跑）" }, { status: 404 })
    }
    const questionId = kind === "question" ? crypto.randomUUID() : undefined
    const notes = (fallback.subagentNotes ?? []) as Array<{ id: string; run_id: string; kind: string; text: string; at: number }>
    notes.push({ id: crypto.randomUUID(), run_id: childOc, kind, text: text || String(q.header ?? ""), at: Date.now() })
    if (notes.length > SUBAGENT_NOTE_QUEUE_MAX) notes.splice(0, notes.length - SUBAGENT_NOTE_QUEUE_MAX)
    fallback.subagentNotes = notes
    try {
      deps.emitToSession(fallback, "subagent.note", { id: childOc, kind, text: text || String(q.header ?? ""), at: Date.now(), ...(questionId ? { question_id: questionId, header: String(q.header ?? "子代理提问") } : {}) })
    } catch {
      /* 帧失败不影响回报送达父会话队列 */
    }
    const busy0 = fallback.ackTimer != null
    if (busy0 || typeof deps.wakeParentNote !== "function") {
      return Response.json({ ok: true, delivery: "skipped_inactive", parent_woken: false, ...(questionId ? { question_id: questionId } : {}), note: "子代理已不在跑：回报已存进父会话队列（未打扰在途回合）。" })
    }
    // S1(b)（FIX-G2）：兜底路径此前**零节流**——H3 实跑：run 摘出注册表后用同一 child id
    // 发 20 条 progress，父会话被唤醒 20/20（每次＝一轮真实 LLM 回合＝烧钱）。此处按**父会话**
    // 维度记账（fallback.lastNoteWakeAt 与主路径 state.lastNoteWakeAt 同一对象），换 child id
    // 也绕不过；被限流时如实回 delivery:"throttled"，回报仍留在 fallback.subagentNotes（不丢）。
    // FIX-G3（T1）：兜底路径同样**分道**——阻塞式提问走提问道（父会话维度，换 child id 绕不过），
    // progress／blocked／非阻塞提问走普通道；两时戳各自独立（progress 不抑制提问，反之亦然）。
    const nowWake0 = Date.now()
    const isBlockingQuestion0 = kind === "question" && q.is_blocking !== false
    const lastWake0 = isBlockingQuestion0
      ? (typeof fallback.lastBlockingQuestionWakeAt === "number" ? fallback.lastBlockingQuestionWakeAt : 0)
      : (typeof fallback.lastNoteWakeAt === "number" ? fallback.lastNoteWakeAt : 0)
    if (lastWake0 > 0 && nowWake0 - lastWake0 < SUBAGENT_NOTIFY_THROTTLE_MS) {
      return Response.json({
        ok: true,
        delivery: "throttled",
        parent_woken: false,
        throttled: true,
        ...(questionId ? { question_id: questionId } : {}),
        note: isBlockingQuestion0
          ? `父会话最近 ${Math.round((nowWake0 - lastWake0) / 1000)}s 内已因提问被唤醒过（提问道独立计时），本条只入队不唤醒（提问节流 ${Math.round(SUBAGENT_NOTIFY_THROTTLE_MS / 1000)}s）；回报仍在父会话队列里，不会丢；若你在等答复可先用 subagent_status 复核 pending_questions。`
          : `父会话最近 ${Math.round((nowWake0 - lastWake0) / 1000)}s 内已被唤醒过，本条只入队不唤醒（节流 ${Math.round(SUBAGENT_NOTIFY_THROTTLE_MS / 1000)}s）；回报仍在父会话队列里，不会丢。`,
      })
    }
    if (isBlockingQuestion0) {
      fallback.lastBlockingQuestionWakeAt = nowWake0
    } else {
      fallback.lastNoteWakeAt = nowWake0
    }
    deps.wakeParentNote(fallback, { id: childOc, label: "（已结束的子代理）", kind, text: `${SUBAGENT_UNTRUSTED_PREFIX}\n${text || String(q.header ?? "")}` })
    return Response.json({ ok: true, delivery: "accepted", parent_woken: true, ...(questionId ? { question_id: questionId } : {}), note: "子代理已不在跑：回报已送达父会话（未挂在本路队列上，无法按 question_id 解除阻塞）。" })
  }
  const state = parentStateOf(run)
  if (!state) return Response.json({ ok: false, code: "not_found", error: "父会话已回收，回报无法送达" }, { status: 404 })
  const noteText = text || String(q.header ?? "").slice(0, SUBAGENT_BUS_MAX_CHARS) || "（子代理提问，未附正文）"
  // S3（FIX-G2）：内审 run 的正文抑制对**所有**出口一致生效。这里算一次 reportText，供
  // 回报队列／提问登记／父会话回报记录／SSE note 帧／唤醒载荷共用（都只拿到「不外传」的如实说明）。
  const reportText = isInternalReviewRun(run) ? SUBAGENT_INTERNAL_BODY_WITHHELD : noteText
  pushParentNote(run, kind, reportText)
  // X5：阻塞式提问登记（有界）。**本轮不做超时自动答**：到期只如实消解（见 livenessTick）。
  let questionId: string | undefined
  if (kind === "question") {
    const now = Date.now()
    const autoMs = typeof q.auto_resolution_ms === "number" && Number.isFinite(q.auto_resolution_ms) && q.auto_resolution_ms > 0
      ? Math.min(q.auto_resolution_ms, SUBAGENT_QUESTION_MAX_TTL_MS)
      : SUBAGENT_QUESTION_DEFAULT_TTL_MS
    questionId = crypto.randomUUID()
    run.pendingQuestions.push({
      id: questionId,
      header: String(q.header ?? "子代理提问").slice(0, 200),
      text: reportText,
      options: Array.isArray(q.options) ? q.options.slice(0, 8).map((o) => String(o).slice(0, 200)) : undefined,
      is_blocking: q.is_blocking !== false,
      is_secret: q.is_secret === true,
      asked_at: now,
      resolve_by: now + autoMs,
    })
    if (run.pendingQuestions.length > SUBAGENT_QUESTION_MAX) run.pendingQuestions.shift()
    writeLiveLog(run, true)
  }
  // 父会话自身的回报记录（有界）：busy 时这就是「存在队列里、不打断」的落点。
  const notes = (state.subagentNotes ?? []) as Array<{ id: string; run_id: string; kind: string; text: string; at: number }>
  notes.push({ id: crypto.randomUUID(), run_id: run.id, kind, text: reportText, at: Date.now() })
  if (notes.length > SUBAGENT_NOTE_QUEUE_MAX) notes.splice(0, notes.length - SUBAGENT_NOTE_QUEUE_MAX)
  state.subagentNotes = notes
  try {
    deps.emitToSession(state, "subagent.note", {
      id: run.id,
      kind,
      text: reportText,
      at: Date.now(),
      ...(questionId ? { question_id: questionId, header: run.pendingQuestions.find((x) => x.id === questionId)?.header, options: q.options, is_blocking: q.is_blocking !== false } : {}),
    })
  } catch (e) {
    console.error(`[gateway] subagent note emit failed: id=${run.id}`, e)
  }
  // 父忙（本回合在途）＝只入队不打断（X9 SkippedInactive）；未注入唤醒出口＝同样只入队并如实回报。
  const busy = state.ackTimer != null
  if (busy || typeof deps.wakeParentNote !== "function") {
    return Response.json({
      ok: true,
      delivery: "skipped_inactive",
      parent_woken: false,
      ...(questionId ? { question_id: questionId } : {}),
      note: busy ? "父会话正在跑一轮，已存进回报队列等它结束（不打断）。" : "已存进回报队列（本部署未注入空闲唤醒出口）。",
    })
  }
  // S1(a)（2026-10-14 FIX-G2；FIX-G3 分道修复 T1）：唤醒节流对**所有 kind**（含 question）
  // 一致生效——H3 实跑用 40 条 kind:"question" 绕过节流唤醒父会话 40 次（每次＝一轮真实
  // LLM 回合＝烧钱）。但**不再共用单一时戳**（旧版会让一条 progress 把兄弟子代理窗内的
  // 阻塞提问一并压掉 → 父空闲时该提问永远不唤醒、等到 question_abandoned，子代理白等 10 分钟）。
  // FIX-G3 分**两条独立道**（两个时戳各自独立）：
  //   · 阻塞式提问道（kind==="question" 且 is_blocking!==false）＝优先道，仅受父会话
  //     state.lastBlockingQuestionWakeAt 窗口约束；**不受** progress 类唤醒记账影响。
  //   · 普通道（progress／blocked／is_blocking:false 的非阻塞提问）＝受父会话
  //     state.lastNoteWakeAt（＋本路 run.lastNoteWakeAt 补充）窗口约束。
  // 记账挂**父会话 state**（跨子代理/兄弟一致，防 child id 轮换）；run 维度**不**参与提问道
  // 判定（不得让某 run 的唤醒反过来抑制他子代理的提问）。被限流时如实回 delivery:"throttled"，
  // 回报已 pushParentNote／state.subagentNotes 入队（不丢），只是不唤醒。
  const nowWake = Date.now()
  const isBlockingQuestion = kind === "question" && q.is_blocking !== false
  const lastWake = isBlockingQuestion
    ? (typeof state.lastBlockingQuestionWakeAt === "number" ? state.lastBlockingQuestionWakeAt : 0)
    : Math.max(run.lastNoteWakeAt ?? 0, typeof state.lastNoteWakeAt === "number" ? state.lastNoteWakeAt : 0)
  if (lastWake > 0 && nowWake - lastWake < SUBAGENT_NOTIFY_THROTTLE_MS) {
    return Response.json({
      ok: true,
      delivery: "throttled",
      parent_woken: false,
      throttled: true,
      ...(questionId ? { question_id: questionId } : {}),
      note: isBlockingQuestion
        ? `父会话最近 ${Math.round((nowWake - lastWake) / 1000)}s 内已因提问被唤醒过（提问道独立计时），本条只入队不唤醒（提问节流 ${Math.round(SUBAGENT_NOTIFY_THROTTLE_MS / 1000)}s）；回报仍在父会话队列里（notes_count 可见）、不会丢；若你在等答复可先用 subagent_status 复核 pending_questions。`
        : `父会话最近 ${Math.round((nowWake - lastWake) / 1000)}s 内已被唤醒过，本条只入队不唤醒（节流 ${Math.round(SUBAGENT_NOTIFY_THROTTLE_MS / 1000)}s）；回报仍在父会话队列里（notes_count 可见），不会丢。`,
    })
  }
  if (isBlockingQuestion) {
    state.lastBlockingQuestionWakeAt = nowWake
  } else {
    run.lastNoteWakeAt = nowWake
    state.lastNoteWakeAt = nowWake
  }
  // 已交给父会话的回报＝已读，从「未读回报」栏清出（question 留到答复/消解）。
  const wakeNotes = run.pendingParentNotes.filter((n) => n.kind !== "question")
  run.pendingParentNotes = run.pendingParentNotes.filter((n) => n.kind === "question")
  writeLiveLog(run)
  deps.wakeParentNote(state, {
    id: run.id,
    label: run.label,
    kind,
    text:
      wakeNotes.length > 0
        ? `${SUBAGENT_UNTRUSTED_PREFIX}\n${wakeNotes.map((n) => `[${n.kind}] ${n.text}`).join("\n")}`
        : `${SUBAGENT_UNTRUSTED_PREFIX}\n${reportText}`,
  })
  return Response.json({
    ok: true,
    delivery: "accepted",
    parent_woken: true,
    ...(questionId ? { question_id: questionId } : {}),
    note: "已唤醒父会话一次（回答/指示用 subagent_message 回报本路）。",
  })
}

// ── 支柱一：父子通信 RPC（AskParent）────────────────────────────────────────
/**
 * POST /internal/subagent/ask-parent
 * body { session_id, subagent_id?, header, question, options?, is_blocking?, is_secret?, timeout_seconds? }
 * 子代理向发起方（orchestrator / 用户）定向提问。
 */
export async function handleSubagentAskParent(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    subagent_id?: string
    header?: string
    question?: string
    options?: unknown
    is_blocking?: boolean
    is_secret?: boolean
    timeout_seconds?: number
  }
  const childOc = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!childOc) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填（子代理自己的 opencode 会话 id 或 parent session id）" }, { status: 400 })
  const rawQ = typeof body.question === "string" ? body.question.trim() : ""
  if (!rawQ) return Response.json({ ok: false, code: "missing_required_args", error: "question 必填（提问详情）" }, { status: 400 })
  const wantId = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  const run = byChildOc.get(childOc) ?? (wantId ? findLiveRun(childOc, wantId) : undefined)
  if (!run) {
    return Response.json({ ok: false, code: "not_found", error: "找不到指定的子代理" }, { status: 404 })
  }
  const questionId = crypto.randomUUID()
  const now = Date.now()
  const autoMs = typeof body.timeout_seconds === "number" && body.timeout_seconds > 0
    ? Math.min(body.timeout_seconds * 1000, 600_000)
    : 600_000
  const header = String(body.header || "子代理提问").slice(0, 200)
  const isBlocking = body.is_blocking !== false
  const isSecret = body.is_secret === true
  const options = Array.isArray(body.options) ? body.options.slice(0, 8).map((o) => String(o).slice(0, 200)) : undefined
  // F6（P2·内审正文旁路修复）：内审（machineCriticPass）run 的提问正文对所有父向外发出口一致抑制
  // （与 notify 的 reportText / SSE 的 hideBody 同一条件）。此前 ask-parent 直接落 rawQ ⇒ 内审正文
  // 连同 header 经父会话回报队列 / SSE note 帧 / 唤醒载荷外泄。工具回执给子代理自己的原文不受影响。
  const parentFacingQ = isInternalReviewRun(run) ? SUBAGENT_INTERNAL_BODY_WITHHELD : rawQ.slice(0, SUBAGENT_BUS_MAX_CHARS)
  const qItem = {
    id: questionId,
    header,
    text: parentFacingQ,
    options,
    is_blocking: isBlocking,
    is_secret: isSecret,
    asked_at: now,
    resolve_by: now + autoMs,
  }
  if (!run.pendingQuestions) run.pendingQuestions = []
  run.pendingQuestions.push(qItem)
  if (run.pendingQuestions.length > SUBAGENT_QUESTION_MAX) run.pendingQuestions.shift()
  writeLiveLog(run, true)

  const parentState = parentStateOf(run)
  if (!parentState) {
    return Response.json({ ok: true, question_id: questionId, is_blocking: isBlocking, resolve_by: qItem.resolve_by, parent_woken: false, note: "已记录提问，父会话离线" })
  }
  const notes = (parentState.subagentNotes ?? []) as Array<{ id: string; run_id: string; kind: string; text: string; at: number }>
  notes.push({ id: crypto.randomUUID(), run_id: run.id, kind: "question", text: `[${header}] ${parentFacingQ}`, at: now })
  if (notes.length > SUBAGENT_NOTE_QUEUE_MAX) notes.splice(0, notes.length - SUBAGENT_NOTE_QUEUE_MAX)
  parentState.subagentNotes = notes

  deps.emitToSession(parentState, "subagent.note", {
    id: run.id,
    kind: "question",
    text: `[${header}] ${parentFacingQ}`,
    at: now,
    question_id: questionId,
    header,
    options,
    is_blocking: isBlocking,
  })

  const busy = parentState.ackTimer != null
  if (busy || typeof deps.wakeParentNote !== "function") {
    return Response.json({
      ok: true,
      question_id: questionId,
      delivery: "skipped_inactive",
      parent_woken: false,
      is_blocking: isBlocking,
      resolve_by: qItem.resolve_by,
      note: busy ? "父会话正在处理当前回合，已存入待答队列（不打断）。" : "已入队（无空闲唤醒出口）。",
    })
  }

  const nowWake = Date.now()
  const lastWake = typeof parentState.lastBlockingQuestionWakeAt === "number" ? parentState.lastBlockingQuestionWakeAt : 0
  if (isBlocking && lastWake > 0 && nowWake - lastWake < SUBAGENT_NOTIFY_THROTTLE_MS) {
    return Response.json({
      ok: true,
      question_id: questionId,
      delivery: "throttled",
      parent_woken: false,
      is_blocking: isBlocking,
      resolve_by: qItem.resolve_by,
      note: `父会话最近 ${Math.round((nowWake - lastWake) / 1000)}s 内已因提问被唤醒过，本提问已登记入队，将在下次回合送达。`,
    })
  }

  if (isBlocking) {
    parentState.lastBlockingQuestionWakeAt = nowWake
  } else {
    run.lastNoteWakeAt = nowWake
    parentState.lastNoteWakeAt = nowWake
  }
  deps.wakeParentNote(parentState, {
    id: run.id,
    label: run.label,
    kind: "question",
    text: `${SUBAGENT_UNTRUSTED_PREFIX}\n[提问·${header}] ${parentFacingQ}`,
  })
  return Response.json({
    ok: true,
    question_id: questionId,
    delivery: "accepted",
    parent_woken: true,
    is_blocking: isBlocking,
    resolve_by: qItem.resolve_by,
    note: "提问已送达并成功唤醒发起方；回答将通过 subagent_message 回送本子会话。",
  })
}

// ── 支柱二：检查点增量流（ReportCheckpoint）────────────────────────────────
/**
 * POST /internal/subagent/checkpoint
 * body { session_id, subagent_id?, stage, progress, data?, summary? }
 * 子代理上报阶段完成检查点，立即落盘并通知主代理。
 */
export async function handleSubagentCheckpoint(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    subagent_id?: string
    stage?: string
    progress?: number
    data?: Record<string, unknown>
    summary?: string
  }
  const childOc = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!childOc) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  const wantId = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  const run = byChildOc.get(childOc) ?? (wantId ? findLiveRun(childOc, wantId) : undefined)
  if (!run) {
    return Response.json({ ok: false, code: "not_found", error: "找不到指定的子代理" }, { status: 404 })
  }
  const stage = String(body.stage || "checkpoint").trim().slice(0, 100)
  const progress = Math.min(100, Math.max(0, Number(body.progress) || 0))
  const data = typeof body.data === "object" && body.data !== null && !Array.isArray(body.data) ? body.data : {}
  const summary = String(body.summary || "").trim().slice(0, 2000)
  const cpId = crypto.randomUUID()
  const checkpoint: SubagentCheckpoint = {
    id: cpId,
    run_id: run.id,
    stage,
    progress,
    data,
    summary,
    at: Date.now(),
  }
  if (!run.checkpoints) run.checkpoints = []
  run.checkpoints.push(checkpoint)
  if (run.checkpoints.length > 50) run.checkpoints.shift()
  run.lastCheckpoint = checkpoint
  try {
    mkdirSync(SUBAGENT_CHECKPOINTS_DIR, { recursive: true })
    const file = join(SUBAGENT_CHECKPOINTS_DIR, `${run.id}-${cpId}.json`)
    writeFileSync(file, JSON.stringify(checkpoint, null, 2), { encoding: "utf8", mode: 0o640 })
    try { chmodSync(file, 0o640) } catch {}
  } catch (e) {
    console.error(`[gateway] subagent checkpoint disk write failed: id=${run.id}`, e)
  }
  writeLiveLog(run)
  const parentState = parentStateOf(run)
  if (parentState) {
    deps.emitToSession(parentState, "subagent.checkpoint", {
      id: run.id,
      label: run.label,
      checkpoint,
    })
  }
  return Response.json({
    ok: true,
    checkpoint_id: cpId,
    subagent_id: run.id,
    stage,
    progress,
    at: checkpoint.at,
  })
}

// ── 支柱三：共享工作区状态板与具型产物契约 ──────────────────────────────────────
/**
 * POST /internal/subagent/scratchpad
 * body { session_id, action: "set"|"get"|"list"|"delete", key?, value?, category? }
 */
export async function handleSubagentScratchpad(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    action?: string
    key?: string
    value?: unknown
    category?: string
  }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sid) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  const parent = resolveParentSession(sid)
  if (!parent) return unknownSessionResponse(sid)
  const parentKey = parent.sessionId
  let pad = sessionScratchpads.get(parentKey)
  if (!pad) {
    pad = new Map<string, ScratchpadEntry>()
    sessionScratchpads.set(parentKey, pad)
  }
  // F5（P2·静默误判修复）：不再缺省 "list"——未知值（含 "SET" 等大小写/拼写错）此前静默落到末尾
  // 的 list 分支并回 ok:true（写意图被当读执行且不报错）。list 必须由**显式** action:"list" 触发。
  const action = typeof body.action === "string" ? body.action.trim() : ""
  const childRun = byChildOc.get(sid)
  const producer = childRun?.label || "orchestrator"
  if (action === "set") {
    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!key) return Response.json({ ok: false, code: "missing_key", error: "key 必填" }, { status: 400 })
    if (key.length > 128) return Response.json({ ok: false, code: "key_too_long", error: "key 长度不能超过 128" }, { status: 400 })
    if (body.value === undefined) return Response.json({ ok: false, code: "missing_value", error: "value 必填" }, { status: 400 })
    const entry: ScratchpadEntry = {
      key,
      value: body.value,
      category: typeof body.category === "string" ? body.category.trim().slice(0, 64) : undefined,
      producer,
      producer_run_id: childRun?.id,
      updated_at: Date.now(),
    }
    pad.set(key, entry)
    if (pad.size > 200) {
      const oldestKey = pad.keys().next().value
      if (oldestKey) pad.delete(oldestKey)
    }
    deps.emitToSession(parent, "subagent.scratchpad_updated", {
      key,
      category: entry.category,
      producer: entry.producer,
      updated_at: entry.updated_at,
    })
    return Response.json({ ok: true, key, updated_at: entry.updated_at })
  }
  if (action === "get") {
    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!key) return Response.json({ ok: false, code: "missing_key", error: "key 必填" }, { status: 400 })
    const entry = pad.get(key)
    return Response.json({ ok: true, key, entry: entry ?? null })
  }
  if (action === "delete") {
    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!key) return Response.json({ ok: false, code: "missing_key", error: "key 必填" }, { status: 400 })
    const deleted = pad.delete(key)
    return Response.json({ ok: true, key, deleted })
  }
  if (action === "list") {
    const cat = typeof body.category === "string" && body.category.trim() ? body.category.trim() : undefined
    const entries: ScratchpadEntry[] = []
    for (const item of pad.values()) {
      if (!cat || item.category === cat) entries.push(item)
    }
    return Response.json({ ok: true, count: entries.length, entries })
  }
  // F5：显式终局——未知 action 一律 400（不再静默当 list 读）。
  return Response.json(
    { ok: false, code: "invalid_action", error: 'action 非法：scratchpad 只接受 "set"/"get"/"delete"/"list"（区分大小写）。' },
    { status: 400 },
  )
}

/**
 * POST /internal/subagent/artifact
 * body { session_id, action: "register"|"get"|"list", name?, type?, uri?, metadata?, artifact_id? }
 */
export async function handleSubagentArtifact(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await readJsonObject(req)) as {
    session_id?: string
    action?: string
    name?: string
    type?: string
    uri?: string
    metadata?: Record<string, unknown>
    artifact_id?: string
  }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sid) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  const parent = resolveParentSession(sid)
  if (!parent) return unknownSessionResponse(sid)
  const parentKey = parent.sessionId
  let reg = sessionArtifactRegistries.get(parentKey)
  if (!reg) {
    reg = new Map<string, TypedArtifact>()
    sessionArtifactRegistries.set(parentKey, reg)
  }
  // F5（P2·静默误判修复）：同 scratchpad——未知 action（含大小写/拼写错）不再静默落 list 回 ok:true；
  // list 必须由**显式** action:"list" 触发，其余非法值一律 400。
  const action = typeof body.action === "string" ? body.action.trim() : ""
  const childRun = byChildOc.get(sid)
  const producer = childRun?.label || "orchestrator"
  if (action === "register") {
    const name = typeof body.name === "string" ? body.name.trim() : ""
    const type = typeof body.type === "string" ? body.type.trim() : ""
    const uri = typeof body.uri === "string" ? body.uri.trim() : ""
    if (!name || !type || !uri) {
      return Response.json({ ok: false, code: "missing_required_args", error: "name, type, uri 均为必填" }, { status: 400 })
    }
    const artId = crypto.randomUUID()
    const artifact: TypedArtifact = {
      id: artId,
      name: name.slice(0, 128),
      type: type.slice(0, 64),
      uri: uri.slice(0, 1024),
      metadata: typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata) ? body.metadata : undefined,
      producer,
      run_id: childRun?.id || "",
      registered_at: Date.now(),
    }
    reg.set(artId, artifact)
    if (reg.size > 200) {
      const oldestId = reg.keys().next().value
      if (oldestId) reg.delete(oldestId)
    }
    if (childRun) {
      childRun.artifacts.push({
        kind: artifact.type,
        url: artifact.uri,
        cost_coins: typeof artifact.metadata?.cost_coins === "number" ? artifact.metadata.cost_coins : undefined,
      })
    }
    deps.emitToSession(parent, "subagent.artifact_registered", { artifact })
    return Response.json({ ok: true, artifact_id: artId, artifact })
  }
  if (action === "get") {
    const artId = typeof body.artifact_id === "string" ? body.artifact_id.trim() : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (artId) {
      const hit = reg.get(artId)
      return Response.json({ ok: true, artifact: hit ?? null })
    }
    if (name) {
      const hit = [...reg.values()].find((a) => a.name === name)
      return Response.json({ ok: true, artifact: hit ?? null })
    }
    return Response.json({ ok: false, code: "missing_args", error: "artifact_id 或 name 必传其一" }, { status: 400 })
  }
  if (action === "list") {
    const filterType = typeof body.type === "string" && body.type.trim() ? body.type.trim() : undefined
    const artifacts: TypedArtifact[] = []
    for (const a of reg.values()) {
      if (!filterType || a.type === filterType) artifacts.push(a)
    }
    return Response.json({ ok: true, count: artifacts.length, artifacts })
  }
  // F5：显式终局——未知 action 一律 400（不再静默当 list 读）。
  return Response.json(
    { ok: false, code: "invalid_action", error: 'action 非法：artifact 只接受 "register"/"get"/"list"（区分大小写）。' },
    { status: 400 },
  )
}

