// steer-gw.ts —— REQ-D2（steer：回合中引导）的网关接线层。
//
// 四件事：
//   1. 受理端点 POST /agent/v1/sessions/:id/steer（router.ts 转发到 handleSteer）。
//   2. 真注入：回合卡在 question 断点（pendingQuestions 非空）时，steer 文本以
//      「答覆」语义回灌 question 工具结果 —— opencode 在同一个 turn 内读到它继续跑，
//      不终止回合、不另起用户讯息。轮子＝questions-gw.settleQuestion（既有调用链，
//      此处只换 answer 内容为用户的引导语）。
//   3. 诚实排队：没有 question 断点时，opencode 物理上没有「回合中注入」的入口
//      （mid-turn prompt 只会被静默排队到本轮结束）。这里不假装生效——收进
//      state.pendingSteers，本回合收尾时按 FIFO 拼成一条下一回合的指引投递，
//      过程中每一条的状态都上报（queued → applied / aborted / failed），UI 必须看得见。
//   4. 命令身份（REQ-D2b，2026-09-23）：受理前查 tombstone、**投递前**落地 steer_id +
//      冻结 payload_hash、终态即墓碑、重放一律回可辨识错误码。两条投递腿（question 注入
//      与队列投递）都必须带同一身份——否则重连后同一条指引可以被投递第二次。
//      身份语义在 steer-identity.ts，持久层在 persistence.ts（steer_commands 表），
//      恢复扫描在 steer-ledger-gw.ts。
//
// 纯决策在 steer-core.ts（零 import、可 node --test 直跑）；本档只做 I/O 与接线。
import type { SessionState } from "./types-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { settleQuestion } from "./questions-gw.ts"
import {
  STEER_MAX_CHARS,
  STEER_MAX_QUEUE,
  abortIsUserStop,
  enqueueSteer,
  gateSteerAcceptance,
  isValidSteerId,
  planSteerFlush,
  steerFrameIds,
  type PendingSteer,
  type SteerStatus,
} from "./steer-core.ts"
// REQ-D2b（2026-09-23）：命令身份（持久 tombstone）——受理前查、投递前落地、终态即墓碑。
import { freezeSteerPayload, planSteerBegin, steerWireStatus, type SteerCommand } from "./steer-identity.ts"
import { steerCommandFrames, steerLedger } from "./steer-ledger-gw.ts"

// ─────────────────────────── 投递缝（依赖反转，与 director.ts 的 setDirectorEmitter 同款）
//
// 为什么不直接 import messages-gw.handleSendMessage：opencode-event-handler → steer-gw
// 是本刀新增的边，再让 steer-gw → messages-gw → opencode-client → opencode-event-handler
// 绕成新环。改由组合根（index.ts）注入「投递一条下一回合讯息」的能力——
// 生产走 handleSendMessage（带著记忆注入/计时/闸门全套既有语义），测试可注入假的。

export type SteerTurnDeliverer = (state: SessionState, text: string) => Promise<boolean>

let driveTurn: SteerTurnDeliverer | null = null

export function setSteerTurnDeliverer(fn: SteerTurnDeliverer): void {
  driveTurn = fn
}

/** 队列读写的唯一入口（缺席＝空，避免每个呼叫点都 ?? []）。 */
function steerQueue(state: SessionState): PendingSteer[] {
  if (!Array.isArray(state.pendingSteers)) state.pendingSteers = []
  return state.pendingSteers
}

function emitSteerStatus(
  state: SessionState,
  steerId: string,
  status: SteerStatus,
  extra?: { position?: number; text?: string; reason?: string },
): void {
  emitToSession(state, "steer.status", {
    steer_id: steerId,
    status,
    ...(typeof extra?.position === "number" ? { position: extra.position } : {}),
    ...(typeof extra?.text === "string" ? { text: extra.text } : {}),
    ...(typeof extra?.reason === "string" ? { reason: extra.reason } : {}),
  })
}

/** 一条排队 steer 的状态上报给它的全部 id（本体 + 别名）——同文去重命中的第二个
 *  徽章才有终态可收，否则它永远停在「排队中」（D2-3 的反向假话）。 */
function emitSteerStatusForAll(
  state: SessionState,
  steer: PendingSteer,
  status: SteerStatus,
  extra?: { reason?: string },
): void {
  for (const id of steerFrameIds(steer)) emitSteerStatus(state, id, status, extra)
}

/** 重放拒绝的文案（每一条都说清「不会重复发送」，不含糊）。 */
const STEER_REPLAY_MESSAGES: Record<string, string> = {
  steer_replay_settled: "这条引导已经有结果了，不会重复发送",
  steer_replay_in_flight: "这条引导已经在处理中，不会重复发送",
  steer_payload_mismatch: "同一条引导身份带着不同内容，已拒绝，不会重复发送",
  steer_id_conflict: "引导身份不属于本会话，已拒绝",
}

/**
 * 重放拒绝（D2b）：同一 steer_id 的第二次投递——回**可辨识的错误码**（绝不静默接受成
 * 第二次投递），同时把既有命令的当前诚实状态补发给它的全部 id（重连后前端的徽章才不会
 * 停在旧状态）。HTTP 409 是刻意的：语义是「你的讯息没被吞，只是这条不需要再送」；
 * 前端以 code 区分（`steer_replay_*` 不落回正常送出腿，见 agent-chat-client.isSteerUnavailableError）。
 */
function rejectSteerReplay(
  state: SessionState,
  command: SteerCommand,
  code: string,
  httpStatus: number,
): Response {
  for (const frame of steerCommandFrames(command, code)) {
    emitToSession(state, "steer.status", frame.data)
  }
  console.log(
    `[gateway] steer replay rejected (${code}): steer=${command.steerId} state=${command.state} session=${state.sessionId}`,
  )
  // 回体刻意自带 `status`（既有命令的上屏状态）：前端据此把徽章纠正成事实，
  // 而不是把它留成「未能送达」的猜测（见 agent-chat-client 的 steerReplayStatus）。
  return Response.json(
    {
      error: { message: STEER_REPLAY_MESSAGES[code] ?? "这条引导已经处理过，不会重复发送", type: code, code },
      steer_id: command.steerId,
      status: steerWireStatus(command.state),
    },
    { status: httpStatus },
  )
}

/** 回合在跑吗（＝有可引导的当前回合）。lastTurnActiveAt 由 handleSendMessage 打点、
 *  session.idle 正常收尾清零（question 冻结分支不清）——正是「当前回合」的权威开关。 */
function turnInFlight(state: SessionState): boolean {
  return (state.lastTurnActiveAt ?? 0) > 0
}

/**
 * 真注入：回合卡在 question 断点 → 把引导语当作答覆回灌，当前回合内生效。
 * 回传被注入的 requestId 清单；空清单＝没有断点可用（呼叫端落回诚实排队）。
 */
async function injectIntoQuestionBreakpoint(state: SessionState, text: string): Promise<string[]> {
  const requestIds = [...state.pendingQuestions.keys()]
  if (requestIds.length === 0) return []
  const injected: string[] = []
  for (let i = 0; i < requestIds.length; i++) {
    // 第一张卡吃用户的引导语（这正是「追加指引」的落点）；同轮其余卡照旧用
    // 「已转向新话题」的跳过语义收敛——一句引导语不该被当成多题的答案。
    const answer = i === 0 ? text : undefined
    try {
      await settleQuestion(state, requestIds[i], answer)
      injected.push(requestIds[i])
    } catch (err) {
      console.error(`[gateway] steer inject failed: question=${requestIds[i]} session=${state.sessionId}:`, err)
    }
  }
  return injected
}

/**
 * POST /agent/v1/sessions/:id/steer  body { content, steer_id }（steer_id 必填，见下）
 *
 * 回传形态（前端据此显示，绝不含糊）：
 *   200 { ok:true, status:"injected", steer_id, injected_into:[que_*], applied_in_turn:true }
 *   200 { ok:true, status:"queued", steer_id, position, deduped? }
 *   400 { ok:false, code:"steer_id_required" } —— 没带 steer_id（D-7 fail-closed，网关不自铸）
 *   400 { ok:false, code:"steer_id_invalid" }  —— 带了但不在值域 [A-Za-z0-9._-]{1,64} 内
 *   409 { ok:false, code:"no_active_turn" }   —— 没在跑的回合，直接送普通讯息即可
 *   409 { ok:false, code:"turn_aborted" }     —— **用户**停止了本回合，同上
 *   429 { ok:false, code:"steer_queue_full", limit } —— 超限诚实拒绝
 *
 * D-6（2026-09-23）：`turn_aborted` 只代表用户停止。内部空转断路器中止（turnAbortSource
 * ="system"）的窗口**照常受理**——那只是换一种方式续跑同一轮，指引不会失效（见下）。
 *
 * D2b（2026-09-23）新增的重放拒绝（同一 steer_id 的第二次投递，全部 HTTP 409、
 * 前端**不得**落回正常送出腿——否则就等于把同一条指引送了第二次）：
 *   409 { ok:false, code:"steer_replay_settled" }     已有终态结论（tombstone 命中）
 *   409 { ok:false, code:"steer_replay_in_flight" }   仍在途（未确认，永不自动重发）
 *   409 { ok:false, code:"steer_payload_mismatch" }   同 id 带不同内容（在途被改写）
 *   409 { ok:false, code:"steer_id_conflict" }        同 id 属于别的会话
 */
export async function handleSteer(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { content?: unknown; steer_id?: unknown }
  try {
    body = (await req.json()) as { content?: unknown; steer_id?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const rawContent = typeof body.content === "string" ? body.content : ""
  if (!rawContent.replace(/\s+/g, " ").trim()) {
    return jsonError(400, "content is required", "steer_empty", "bad_request")
  }
  if (rawContent.replace(/\s+/g, " ").trim().length > STEER_MAX_CHARS) {
    return jsonError(400, `指引过长（上限 ${STEER_MAX_CHARS} 字）`, "steer_too_long", "bad_request")
  }
  // D-7（fail-closed，2026-09-23）：身份只认客户端提供的那一个，网关**不得自铸**。
  // 自铸＝每个没带 id 的请求都拿到一个全新的身份，「手动重送」于是永远是第二条独立命令，
  // ARL-02 的不变量（同一条指引一生只投递一次）就只在客户端稳定带同一 id 时才碰巧成立。
  // 我方前端总会带 id（use-agent-chat.newSteerId → agent-chat-client.steerAgentSession），
  // 所以 fail-closed 对它零影响；不带 id 的旧客户端不会被静默收成新命令，而是拿到明确的
  // 400 与修法（沿用同一个 id 即可安全重送）。
  // 为什么是 400 而非 409：409 会被前端判成「没有可引导的回合」而落回普通送出腿
  //（steer 模式下普通送出＝打断本轮），既与事实不符（回合其实在跑，D-6 已修），
  // 也正好绕过本闸的用意。400 只会被当成一次诚实的提交失败。
  if (body.steer_id === undefined || body.steer_id === null) {
    return jsonError(
      400,
      "缺少 steer_id：引导必须带客户端生成的 steer_id（同一条指引重送时请沿用同一个 id）",
      "steer_id_required",
      "steer_id_required",
    )
  }
  if (!isValidSteerId(body.steer_id)) {
    return jsonError(
      400,
      "steer_id 非法：只允许 [A-Za-z0-9._-]{1,64}（请用客户端生成的 id，不要自己裁剪）",
      "steer_id_invalid",
      "steer_id_invalid",
    )
  }
  const steerId = body.steer_id
  const content = rawContent.replace(/\s+/g, " ").trim()

  // ⓪ 重放闸（D2b）：**排在停止闸之前**。顺序是刻意的——409 no_active_turn 的语义是
  // 「改走正常送出」，而若这条指引其实已经送过（tombstone 命中）或还在途中（未确认），
  // 改走正常送出就等于把它送第二次，正是本刀要禁的事故。所以先问身份层（持久层）：
  // 同 id 一律拒绝，回可辨识错误码，并口头补一句「不会重复发送」。
  const frozen = freezeSteerPayload({
    steerId,
    sessionId: state.sessionId,
    opencodeSessionId: state.opencodeSessionId,
    turnGen: state.turnGen ?? 0,
    content,
  })
  const known = steerLedger.get(steerId)
  const replay = planSteerBegin(known, { steerId, sessionId: state.sessionId, payloadHash: frozen.payloadHash })
  if (replay && replay.kind === "rejected") {
    return rejectSteerReplay(state, replay.command, replay.code, replay.httpStatus)
  }

  // 停止优先的闸（D2-1a 修复，D-6 校正）：不只看「回合在跑」，还要看「回合有没有被
  // **用户**停掉」。abort 落地后到 idle 帧之间的那段窗口，lastTurnActiveAt 仍是旧值、
  // pendingQuestions 可能还在——只凭 turnInFlight 就会放行，接著走①的注入腿把用户的
  // 引导语当「答覆」POST 进一个已经中止的回合，还回 applied_in_turn:true（假话）。
  //
  // D-6：闸门把中止来源一起交给纯核心（abortIsUserStop 是停止优先的唯一判据）——
  // 系统中止（空转断路器）窗口**照常受理**，因为那只是换一种方式续跑同一轮，排队中的
  // 指引本来就被刻意保留；旧版一律回「本轮已中止，引导不会再生效」是假话，还让前端
  // fallback 成普通送出（steer 模式下即打断本轮），违背用户选的「不打断」语义。
  const gate = gateSteerAcceptance({
    turnInFlight: turnInFlight(state),
    turnAborted: state.turnAborted === true,
    turnAbortSource: state.turnAbortSource,
  })
  if (gate.kind === "reject") {
    // 2026-10-02 观测补口：被拒路径从前**一行日志都没有**，所以「引导全部未能送达」
    // 这种系统性症状在生产上完全不可见（上一轮修复只能靠前端画面反推）。这里把闸门
    // 的四个输入原样记下来，下一次同症状可直接定位是打点没打（lastTurnActiveAt=0）
    // 还是用户叫停（turnAborted）。
    console.warn(
      `[gateway] steer rejected (${gate.reason}): steer=${steerId} session=${state.sessionId} ` +
        `lastTurnActiveAt=${state.lastTurnActiveAt ?? 0} turnAborted=${state.turnAborted === true} ` +
        `turnAbortSource=${state.turnAbortSource ?? "none"} turnGen=${state.turnGen ?? 0}`,
    )
    const message =
      gate.reason === "turn_aborted"
        ? "本轮已由用户停止，引导不会再生效，请直接发送消息"
        : "当前没有正在进行中的回合，请直接发送消息"
    return jsonError(409, message, gate.reason, gate.reason)
  }

  // 身份落地（D2b，**投递之前**）：steer_id + 冻结 payload_hash（含 content 与关联
  // turn/session 标识）先写进 sessions.db 的 steer_commands 表，之后才碰上游。
  // 为什么顺序不能颠倒：一旦投递出去而进程在确认前中断，唯一能阻止重放的东西就是
  // 这条持久记录——反过来先投递再落地，中间那道裂缝正好就是事故现场。
  const begun = steerLedger.begin({
    steerId,
    sessionId: state.sessionId,
    ownerKey: key,
    content,
    opencodeSessionId: state.opencodeSessionId,
    turnGen: state.turnGen ?? 0,
    now: Date.now(),
  })
  if (begun.kind === "rejected") {
    // 上面查过一次仍有记录＝查询与落地之间的竞态（同一 ms 重放）。同样拒绝，不覆写。
    return rejectSteerReplay(state, begun.command, begun.code, begun.httpStatus)
  }

  // ① 真注入优先：回合卡在 question 断点 → 这一条在本回合内生效。
  // D-6：**中止轮（任何来源）都不得走注入腿**——中止轮残留的 question 卡已经失效，
  // 把引导语当「答覆」回灌再回 applied_in_turn:true，就是把 D2-1a 那颗假话换个地方说
  //（该论据与中止来源无关）。系统中止窗口因此落到下面的诚实排队腿：状态如实回 queued，
  // 指引留在队列里等本轮收尾照常投递。
  const injectEligible = state.turnAborted !== true && state.pendingQuestions.size > 0
  if (injectEligible) {
    // 注入＝第二条投递腿，同样带身份：**先标 dispatched（投递已发出、尚未确认）再注入**。
    // 中断点在注入与确认之间 → 重启恢复落 uncertain，永不自动重发（否则重连后可被重放）。
    steerLedger.markDispatched(steerId, Date.now())
    const injectedInto = await injectIntoQuestionBreakpoint(state, content)
    if (injectedInto.length > 0) {
      console.log(
        `[gateway] steer injected into frozen turn: steer=${steerId} session=${state.sessionId} questions=${injectedInto.length}`,
      )
      // 确认到达 → 终态 injected（冻结，迟到帧不得改写）。
      steerLedger.settle(steerId, "injected", Date.now())
      emitSteerStatus(state, steerId, "injected", { text: content })
      return Response.json({
        ok: true,
        steer_id: steerId,
        status: "injected",
        applied_in_turn: true,
        injected_into: injectedInto,
      })
    }
    // 断点在投递途中消失（竞态）：命令停在 dispatched＝在途未确认。落回排队腿时**不改状态**
    // ——对使用者仍是「排队中」（steer-identity.steerWireStatus 把 dispatched 映回 queued），
    // 而重启恢复会把它落 uncertain；绝不假装没送过（那会让重放合法化）。
  }

  // ② 诚实排队：入队判定（顺序／同 id 与同文去重／上限）走纯核心。
  const queue = steerQueue(state)
  const outcome = enqueueSteer(queue, rawContent, { now: Date.now(), id: steerId })
  if (outcome.kind === "rejected") {
    // 未受理＝不得留下悬空的「在途」记录（那会让同一 id 之后永远被 in_flight 挡住，
    // 而它其实从没进过投递管线）。诚实落 failed 终态并记原因。
    steerLedger.settle(steerId, "failed", Date.now(), `not_accepted_${outcome.reason}`)
    if (outcome.reason === "queue_full") {
      console.log(`[gateway] steer rejected (queue full): session=${state.sessionId} limit=${STEER_MAX_QUEUE}`)
      return jsonError(
        429,
        `本回合最多追加 ${STEER_MAX_QUEUE} 条指引，请等这一轮结束或先按停止`,
        "steer_queue_full",
        "steer_queue_full",
      )
    }
    // empty/too_long 已在上面拦过（此处只剩竞态），照实回 400。
    return jsonError(400, `指引无效（${outcome.reason}）`, `steer_${outcome.reason}`, "bad_request")
  }
  if (!outcome.deduped) {
    queue.push(outcome.steer)
    state.lastActivityAt = Date.now()
  } else if (outcome.steer.id !== steerId && !(outcome.steer.aliases ?? []).includes(steerId)) {
    // 同文去重命中：本次的 id 记成别名，之后的终态帧两个 id 都发——否则这个新徽章
    // 永远收不到终态（它的 id 不在队列条目上），画面停「排队中」＝反向假话。
    outcome.steer.aliases = [...(outcome.steer.aliases ?? []), steerId]
    // D2b：别名 id 同样进 tombstone 覆盖面（别名重放＝同一条逻辑 steer 的第二个徽章重放，
    // 一样不得被投递第二次）。
    steerLedger.addAlias(outcome.steer.id, steerId)
  }
  // 排队中也要上报：UI 显示「已排队（本回合结束后生效）」而不是假装已生效。
  // 本体 id 与别名 id 一起上报（同文重复送达时，两个徽章都必须看得见排队位置）。
  for (const frameId of steerFrameIds(outcome.steer)) {
    emitSteerStatus(state, frameId, "queued", {
      position: outcome.position,
      text: outcome.steer.text,
    })
  }
  console.log(
    `[gateway] steer queued: steer=${outcome.steer.id} session=${state.sessionId} position=${outcome.position} deduped=${outcome.deduped}`,
  )
  return Response.json({
    ok: true,
    steer_id: outcome.steer.id,
    status: "queued",
    position: outcome.position,
    applied_in_turn: false,
    ...(outcome.deduped ? { deduped: true } : {}),
  })
}

/**
 * 停止闸（优先于 steer）：**用户**按了停止 → 待投队列全数作废并上报 aborted。
 * 由 session-read.handleAbortSession 呼叫，位置在 abort 落地之后、收尾帧之前。
 * 注意：只有用户停止走这里；内部断路器中止不呼叫本函数（见 D2-1b）。
 */
export function dropPendingSteers(state: SessionState, reason: "aborted" = "aborted"): PendingSteer[] {
  const queue = steerQueue(state)
  if (queue.length === 0) return []
  const dropped = [...queue]
  state.pendingSteers = []
  for (const steer of dropped) {
    emitSteerStatusForAll(state, steer, "aborted", { reason })
    // D2b：终态即 tombstone——这条指引有结论了（未生效·已作废），此后同 id 重放一律拒绝，
    // 不会因为「用户按了停止」而在重连后偷偷再投一次。
    steerLedger.settle(steer.id, "aborted", Date.now(), reason)
  }
  console.log(
    `[gateway] steer dropped (${reason}): ${dropped.length} pending steer(s) session=${state.sessionId}`,
  )
  return dropped
}

/**
 * 回合收尾钩子（opencode-event-handler 的 session.idle 正常收尾路径呼叫）。
 *
 * 顺序纪律：
 *   空队列 → 零动作（无 steer 的回合与改动前逐位等价）。
 *   用户停止（abortIsUserStop）→ 全数作废（停止优先），不投递。
 *   系统中止（空转止损断路器）→ **不丢**：它只是换一种方式续跑同一轮，
 *     用户没有叫停，指引不因此失效 → 照常拼批投递（这是 D2-1b 的语义裁定）。
 *   逾时（deadline 已过）→ 落 failed 终态，不投递（D2-3 诚实解，见下）。
 *   否则 → FIFO 拼批，走 handleSendMessage 投成下一回合；逐条上报 applied/failed。
 *
 * D2-3 选型理由（为什么不是持久化队列）：pendingSteers 的生命周期绑在「一个活的
 * 在途回合」上——网关重启后上游 turn 已经没有了，重放那个队列等于替一个不存在的
 * 回合投递（会多开一轮、用户没按送出）。所以选「队列带 deadline + 前端超时翻
 * 未能送达」：网关侧对逾时条目补终态帧（queue_expired），前端侧对「收不到任何
 * 终态帧」（含网关重启这个必然收不到的场景）以同一个 TTL 自行翻终态，
 * 两端都不会留下永久的「排队中」。
 *
 * D2b 补强：**持久化的是身份，不是队列**。队列照旧 volatile（理由同上），但每一条
 * 命令的 steer_id / payload_hash / 终态墓碑落在 steer_commands 表——投递前 markDispatched、
 * 确认后 settle，重启后未确认者一律 uncertain 且永不自动重发（见 steer-ledger-gw）。
 * 两者分工：TTL 是 UI 时间兜底，身份层是防重复投递的正解。
 */
export async function flushPendingSteers(state: SessionState): Promise<void> {
  const queue = steerQueue(state)
  if (queue.length === 0) return
  const userStopped = abortIsUserStop(state.turnAborted, state.turnAbortSource)
  const plan = planSteerFlush(queue, { turnAborted: userStopped, now: Date.now() })
  // dropped 两种来历：aborted（用户停止，停止优先）／expired（逾时，诚实落未生效）。
  for (const drop of plan.dropped) {
    const steer = queue.find((s) => s.id === drop.id)
    if (!steer) continue
    if (drop.reason === "aborted") {
      emitSteerStatusForAll(state, steer, "aborted", { reason: "aborted" })
      steerLedger.settle(steer.id, "aborted", Date.now(), "aborted")
    } else {
      emitSteerStatusForAll(state, steer, "failed", { reason: "queue_expired" })
      // 逾时＝不再投递（TTL 的 UI 兜底语义），终态 tombstone 记 failed：与身份层的分工见
      // steer-core.STEER_QUEUE_TTL_MS 注释——TTL 说「等太久了」，身份层说「这条结案了」。
      steerLedger.settle(steer.id, "failed", Date.now(), "queue_expired")
    }
  }
  if (!plan.batch) {
    state.pendingSteers = []
    return
  }
  // 先清队列再投递：投递本身会开新回合，若此刻又来一条 steer，它该进新回合的队列。
  state.pendingSteers = []
  const { text, ids } = plan.batch
  // 保序取回要投递的条目本体（ids 只是 id；别名要一起收终态帧，否则别名徽章永停排队中）。
  const live = ids
    .map((id) => queue.find((s) => s.id === id))
    .filter((s): s is PendingSteer => s !== undefined)
  if (!driveTurn) {
    // 未接线＝诚实失败（不静默丢，也不假装生效）。组合根 index.ts 必接。
    for (const steer of live) {
      emitSteerStatusForAll(state, steer, "failed", { reason: "delivery_unwired" })
      steerLedger.settle(steer.id, "failed", Date.now(), "delivery_unwired")
    }
    console.error(`[gateway] steer flush: deliverer not wired — ${ids.length} steer(s) dropped session=${state.sessionId}`)
    return
  }
  // ★ D2b 的关键一格：**投递之前**先把这条命令标成 dispatched（持久）。
  //   语义＝「投递已发出、还没等到确认」。若进程此刻中断（或 driveTurn 卡到重启），
  //   重启恢复只会把它落 uncertain 且**永不自动重发**——没有这一格，重启后这条指引
  //   在持久层看起来还是「没送过」，重放就合法了（waoowaoo ARL-02 要解的事故）。
  for (const steer of live) steerLedger.markDispatched(steer.id, Date.now())
  let delivered = false
  try {
    delivered = await driveTurn(state, text)
  } catch (err) {
    console.error(`[gateway] steer flush delivery failed: session=${state.sessionId}:`, err)
  }
  const status: SteerStatus = delivered ? "applied" : "failed"
  for (const steer of live) {
    emitSteerStatusForAll(state, steer, status, delivered ? undefined : { reason: "delivery_failed" })
    // 确认到达 → 终态冻结（applied／failed）。同一 id 此后重放一律被 tombstone 挡住。
    steerLedger.settle(steer.id, delivered ? "applied" : "failed", Date.now(), delivered ? undefined : "delivery_failed")
  }
  console.log(
    `[gateway] steer flush ${status}: ${ids.length} steer(s) session=${state.sessionId}`,
  )
}
