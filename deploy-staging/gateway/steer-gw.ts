// steer-gw.ts —— REQ-D2（steer：回合中引導）的網關接線層。
//
// 四件事：
//   1. 受理端點 POST /agent/v1/sessions/:id/steer（router.ts 轉發到 handleSteer）。
//   2. 真注入：回合卡在 question 斷點（pendingQuestions 非空）時，steer 文本以
//      「答覆」語義回灌 question 工具結果 —— opencode 在同一個 turn 內讀到它繼續跑，
//      不終止回合、不另起用戶訊息。輪子＝questions-gw.settleQuestion（既有調用鏈，
//      此處只換 answer 內容為用戶的引導語）。
//   3. 誠實排隊：沒有 question 斷點時，opencode 物理上沒有「回合中注入」的入口
//      （mid-turn prompt 只會被靜默排隊到本輪結束）。這裡不假裝生效——收進
//      state.pendingSteers，本回合收尾時按 FIFO 拼成一條下一回合的指引投遞，
//      過程中每一條的狀態都上報（queued → applied / aborted / failed），UI 必須看得見。
//   4. 命令身份（REQ-D2b，2026-09-23）：受理前查 tombstone、**投遞前**落地 steer_id +
//      凍結 payload_hash、終態即墓碑、重放一律回可辨識錯誤碼。兩條投遞腿（question 注入
//      與隊列投遞）都必須帶同一身份——否則重連後同一條指引可以被投遞第二次。
//      身份語義在 steer-identity.ts，持久層在 persistence.ts（steer_commands 表），
//      恢復掃描在 steer-ledger-gw.ts。
//
// 純決策在 steer-core.ts（零 import、可 node --test 直跑）；本檔只做 I/O 與接線。
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
// REQ-D2b（2026-09-23）：命令身份（持久 tombstone）——受理前查、投遞前落地、終態即墓碑。
import { freezeSteerPayload, planSteerBegin, steerWireStatus, type SteerCommand } from "./steer-identity.ts"
import { steerCommandFrames, steerLedger } from "./steer-ledger-gw.ts"

// ─────────────────────────── 投遞縫（依賴反轉，與 director.ts 的 setDirectorEmitter 同款）
//
// 為什麼不直接 import messages-gw.handleSendMessage：opencode-event-handler → steer-gw
// 是本刀新增的邊，再讓 steer-gw → messages-gw → opencode-client → opencode-event-handler
// 繞成新環。改由組合根（index.ts）注入「投遞一條下一回合訊息」的能力——
// 生產走 handleSendMessage（帶著記憶注入/計時/閘門全套既有語義），測試可注入假的。

export type SteerTurnDeliverer = (state: SessionState, text: string) => Promise<boolean>

let driveTurn: SteerTurnDeliverer | null = null

export function setSteerTurnDeliverer(fn: SteerTurnDeliverer): void {
  driveTurn = fn
}

/** 隊列讀寫的唯一入口（缺席＝空，避免每個呼叫點都 ?? []）。 */
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

/** 一條排隊 steer 的狀態上報給它的全部 id（本體 + 別名）——同文去重命中的第二個
 *  徽章才有終態可收，否則它永遠停在「排队中」（D2-3 的反向假話）。 */
function emitSteerStatusForAll(
  state: SessionState,
  steer: PendingSteer,
  status: SteerStatus,
  extra?: { reason?: string },
): void {
  for (const id of steerFrameIds(steer)) emitSteerStatus(state, id, status, extra)
}

/** 重放拒絕的文案（每一條都說清「不會重複發送」，不含糊）。 */
const STEER_REPLAY_MESSAGES: Record<string, string> = {
  steer_replay_settled: "这条引导已经有结果了，不会重复发送",
  steer_replay_in_flight: "这条引导已经在处理中，不会重复发送",
  steer_payload_mismatch: "同一条引导身份带着不同内容，已拒绝，不会重复发送",
  steer_id_conflict: "引导身份不属于本会话，已拒绝",
}

/**
 * 重放拒絕（D2b）：同一 steer_id 的第二次投遞——回**可辨識的錯誤碼**（絕不靜默接受成
 * 第二次投遞），同時把既有命令的當前誠實狀態補發給它的全部 id（重連後前端的徽章才不會
 * 停在舊狀態）。HTTP 409 是刻意的：語義是「你的訊息沒被吞，只是這條不需要再送」；
 * 前端以 code 區分（`steer_replay_*` 不落回正常送出腿，見 agent-chat-client.isSteerUnavailableError）。
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
  // 回體刻意自帶 `status`（既有命令的上屏狀態）：前端據此把徽章糾正成事實，
  // 而不是把它留成「未能送達」的猜測（見 agent-chat-client 的 steerReplayStatus）。
  return Response.json(
    {
      error: { message: STEER_REPLAY_MESSAGES[code] ?? "这条引导已经处理过，不会重复发送", type: code, code },
      steer_id: command.steerId,
      status: steerWireStatus(command.state),
    },
    { status: httpStatus },
  )
}

/** 回合在跑嗎（＝有可引導的當前回合）。lastTurnActiveAt 由 handleSendMessage 打點、
 *  session.idle 正常收尾清零（question 凍結分支不清）——正是「當前回合」的權威開關。 */
function turnInFlight(state: SessionState): boolean {
  return (state.lastTurnActiveAt ?? 0) > 0
}

/**
 * 真注入：回合卡在 question 斷點 → 把引導語當作答覆回灌，當前回合內生效。
 * 回傳被注入的 requestId 清單；空清單＝沒有斷點可用（呼叫端落回誠實排隊）。
 */
async function injectIntoQuestionBreakpoint(state: SessionState, text: string): Promise<string[]> {
  const requestIds = [...state.pendingQuestions.keys()]
  if (requestIds.length === 0) return []
  const injected: string[] = []
  for (let i = 0; i < requestIds.length; i++) {
    // 第一張卡吃用戶的引導語（這正是「追加指引」的落點）；同輪其餘卡照舊用
    // 「已轉向新話題」的跳過語義收斂——一句引導語不該被當成多題的答案。
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
 * POST /agent/v1/sessions/:id/steer  body { content, steer_id }（steer_id 必填，見下）
 *
 * 回傳形態（前端據此顯示，絕不含糊）：
 *   200 { ok:true, status:"injected", steer_id, injected_into:[que_*], applied_in_turn:true }
 *   200 { ok:true, status:"queued", steer_id, position, deduped? }
 *   400 { ok:false, code:"steer_id_required" } —— 沒帶 steer_id（D-7 fail-closed，網關不自鑄）
 *   400 { ok:false, code:"steer_id_invalid" }  —— 帶了但不在值域 [A-Za-z0-9._-]{1,64} 內
 *   409 { ok:false, code:"no_active_turn" }   —— 沒在跑的回合，直接送普通訊息即可
 *   409 { ok:false, code:"turn_aborted" }     —— **用戶**停止了本回合，同上
 *   429 { ok:false, code:"steer_queue_full", limit } —— 超限誠實拒絕
 *
 * D-6（2026-09-23）：`turn_aborted` 只代表用戶停止。內部空轉斷路器中止（turnAbortSource
 * ="system"）的窗口**照常受理**——那只是換一種方式續跑同一輪，指引不會失效（見下）。
 *
 * D2b（2026-09-23）新增的重放拒絕（同一 steer_id 的第二次投遞，全部 HTTP 409、
 * 前端**不得**落回正常送出腿——否則就等於把同一條指引送了第二次）：
 *   409 { ok:false, code:"steer_replay_settled" }     已有終態結論（tombstone 命中）
 *   409 { ok:false, code:"steer_replay_in_flight" }   仍在途（未確認，永不自動重發）
 *   409 { ok:false, code:"steer_payload_mismatch" }   同 id 帶不同內容（在途被改寫）
 *   409 { ok:false, code:"steer_id_conflict" }        同 id 屬於別的會話
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
  // D-7（fail-closed，2026-09-23）：身份只認客戶端提供的那一個，網關**不得自鑄**。
  // 自鑄＝每個沒帶 id 的請求都拿到一個全新的身份，「手動重送」於是永遠是第二條獨立命令，
  // ARL-02 的不變量（同一條指引一生只投遞一次）就只在客戶端穩定帶同一 id 時才碰巧成立。
  // 我方前端總會帶 id（use-agent-chat.newSteerId → agent-chat-client.steerAgentSession），
  // 所以 fail-closed 對它零影響；不帶 id 的舊客戶端不會被靜默收成新命令，而是拿到明確的
  // 400 與修法（沿用同一個 id 即可安全重送）。
  // 為什麼是 400 而非 409：409 會被前端判成「沒有可引導的回合」而落回普通送出腿
  //（steer 模式下普通送出＝打斷本輪），既與事實不符（回合其實在跑，D-6 已修），
  // 也正好繞過本閘的用意。400 只會被當成一次誠實的提交失敗。
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

  // ⓪ 重放閘（D2b）：**排在停止閘之前**。順序是刻意的——409 no_active_turn 的語義是
  // 「改走正常送出」，而若這條指引其實已經送過（tombstone 命中）或還在途中（未確認），
  // 改走正常送出就等於把它送第二次，正是本刀要禁的事故。所以先問身份層（持久層）：
  // 同 id 一律拒絕，回可辨識錯誤碼，並口頭補一句「不會重複發送」。
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

  // 停止優先的閘（D2-1a 修復，D-6 校正）：不只看「回合在跑」，還要看「回合有沒有被
  // **用戶**停掉」。abort 落地後到 idle 幀之間的那段窗口，lastTurnActiveAt 仍是舊值、
  // pendingQuestions 可能還在——只憑 turnInFlight 就會放行，接著走①的注入腿把用戶的
  // 引導語當「答覆」POST 進一個已經中止的回合，還回 applied_in_turn:true（假話）。
  //
  // D-6：閘門把中止來源一起交給純核心（abortIsUserStop 是停止優先的唯一判據）——
  // 系統中止（空轉斷路器）窗口**照常受理**，因為那只是換一種方式續跑同一輪，排隊中的
  // 指引本來就被刻意保留；舊版一律回「本轮已中止，引导不会再生效」是假話，還讓前端
  // fallback 成普通送出（steer 模式下即打斷本輪），違背用戶選的「不打断」語義。
  const gate = gateSteerAcceptance({
    turnInFlight: turnInFlight(state),
    turnAborted: state.turnAborted === true,
    turnAbortSource: state.turnAbortSource,
  })
  if (gate.kind === "reject") {
    const message =
      gate.reason === "turn_aborted"
        ? "本轮已由用户停止，引导不会再生效，请直接发送消息"
        : "当前没有正在进行中的回合，请直接发送消息"
    return jsonError(409, message, gate.reason, gate.reason)
  }

  // 身份落地（D2b，**投遞之前**）：steer_id + 凍結 payload_hash（含 content 與關聯
  // turn/session 標識）先寫進 sessions.db 的 steer_commands 表，之後才碰上游。
  // 為什麼順序不能顛倒：一旦投遞出去而進程在確認前中斷，唯一能阻止重放的東西就是
  // 這條持久記錄——反過來先投遞再落地，中間那道裂縫正好就是事故現場。
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
    // 上面查過一次仍有記錄＝查詢與落地之間的競態（同一 ms 重放）。同樣拒絕，不覆寫。
    return rejectSteerReplay(state, begun.command, begun.code, begun.httpStatus)
  }

  // ① 真注入優先：回合卡在 question 斷點 → 這一條在本回合內生效。
  // D-6：**中止輪（任何來源）都不得走注入腿**——中止輪殘留的 question 卡已經失效，
  // 把引導語當「答覆」回灌再回 applied_in_turn:true，就是把 D2-1a 那顆假話換個地方說
  //（該論據與中止來源無關）。系統中止窗口因此落到下面的誠實排隊腿：狀態如實回 queued，
  // 指引留在隊列裡等本輪收尾照常投遞。
  const injectEligible = state.turnAborted !== true && state.pendingQuestions.size > 0
  if (injectEligible) {
    // 注入＝第二條投遞腿，同樣帶身份：**先標 dispatched（投遞已發出、尚未確認）再注入**。
    // 中斷點在注入與確認之間 → 重啟恢復落 uncertain，永不自動重發（否則重連後可被重放）。
    steerLedger.markDispatched(steerId, Date.now())
    const injectedInto = await injectIntoQuestionBreakpoint(state, content)
    if (injectedInto.length > 0) {
      console.log(
        `[gateway] steer injected into frozen turn: steer=${steerId} session=${state.sessionId} questions=${injectedInto.length}`,
      )
      // 確認到達 → 終態 injected（凍結，遲到幀不得改寫）。
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
    // 斷點在投遞途中消失（競態）：命令停在 dispatched＝在途未確認。落回排隊腿時**不改狀態**
    // ——對使用者仍是「排隊中」（steer-identity.steerWireStatus 把 dispatched 映回 queued），
    // 而重啟恢復會把它落 uncertain；絕不假裝沒送過（那會讓重放合法化）。
  }

  // ② 誠實排隊：入隊判定（順序／同 id 與同文去重／上限）走純核心。
  const queue = steerQueue(state)
  const outcome = enqueueSteer(queue, rawContent, { now: Date.now(), id: steerId })
  if (outcome.kind === "rejected") {
    // 未受理＝不得留下懸空的「在途」記錄（那會讓同一 id 之後永遠被 in_flight 擋住，
    // 而它其實從沒進過投遞管線）。誠實落 failed 終態並記原因。
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
    // empty/too_long 已在上面攔過（此處只剩競態），照實回 400。
    return jsonError(400, `指引无效（${outcome.reason}）`, `steer_${outcome.reason}`, "bad_request")
  }
  if (!outcome.deduped) {
    queue.push(outcome.steer)
    state.lastActivityAt = Date.now()
  } else if (outcome.steer.id !== steerId && !(outcome.steer.aliases ?? []).includes(steerId)) {
    // 同文去重命中：本次的 id 記成別名，之後的終態幀兩個 id 都發——否則這個新徽章
    // 永遠收不到終態（它的 id 不在隊列條目上），畫面停「排队中」＝反向假話。
    outcome.steer.aliases = [...(outcome.steer.aliases ?? []), steerId]
    // D2b：別名 id 同樣進 tombstone 覆蓋面（別名重放＝同一條邏輯 steer 的第二個徽章重放，
    // 一樣不得被投遞第二次）。
    steerLedger.addAlias(outcome.steer.id, steerId)
  }
  // 排隊中也要上報：UI 顯示「已排隊（本回合结束後生效）」而不是假裝已生效。
  // 本體 id 與別名 id 一起上報（同文重複送達時，兩個徽章都必須看得見排隊位置）。
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
 * 停止閘（優先於 steer）：**用戶**按了停止 → 待投隊列全數作廢並上報 aborted。
 * 由 session-read.handleAbortSession 呼叫，位置在 abort 落地之後、收尾幀之前。
 * 注意：只有用戶停止走這裡；內部斷路器中止不呼叫本函數（見 D2-1b）。
 */
export function dropPendingSteers(state: SessionState, reason: "aborted" = "aborted"): PendingSteer[] {
  const queue = steerQueue(state)
  if (queue.length === 0) return []
  const dropped = [...queue]
  state.pendingSteers = []
  for (const steer of dropped) {
    emitSteerStatusForAll(state, steer, "aborted", { reason })
    // D2b：終態即 tombstone——這條指引有結論了（未生效·已作廢），此後同 id 重放一律拒絕，
    // 不會因為「用戶按了停止」而在重連後偷偷再投一次。
    steerLedger.settle(steer.id, "aborted", Date.now(), reason)
  }
  console.log(
    `[gateway] steer dropped (${reason}): ${dropped.length} pending steer(s) session=${state.sessionId}`,
  )
  return dropped
}

/**
 * 回合收尾鉤子（opencode-event-handler 的 session.idle 正常收尾路徑呼叫）。
 *
 * 順序紀律：
 *   空隊列 → 零動作（無 steer 的回合與改動前逐位等價）。
 *   用戶停止（abortIsUserStop）→ 全數作廢（停止優先），不投遞。
 *   系統中止（空轉止損斷路器）→ **不丟**：它只是換一種方式續跑同一輪，
 *     用戶沒有叫停，指引不因此失效 → 照常拼批投遞（這是 D2-1b 的語義裁定）。
 *   逾時（deadline 已過）→ 落 failed 終態，不投遞（D2-3 誠實解，見下）。
 *   否則 → FIFO 拼批，走 handleSendMessage 投成下一回合；逐條上報 applied/failed。
 *
 * D2-3 選型理由（為什麼不是持久化隊列）：pendingSteers 的生命週期綁在「一個活的
 * 在途回合」上——網關重啟後上游 turn 已經沒有了，重放那個隊列等於替一個不存在的
 * 回合投遞（會多開一輪、用戶沒按送出）。所以選「隊列帶 deadline + 前端超時翻
 * 未能送達」：網關側對逾時條目補終態幀（queue_expired），前端側對「收不到任何
 * 終態幀」（含網關重啟這個必然收不到的場景）以同一個 TTL 自行翻終態，
 * 兩端都不會留下永久的「排队中」。
 *
 * D2b 補強：**持久化的是身份，不是隊列**。隊列照舊 volatile（理由同上），但每一條
 * 命令的 steer_id / payload_hash / 終態墓碑落在 steer_commands 表——投遞前 markDispatched、
 * 確認後 settle，重啟後未確認者一律 uncertain 且永不自動重發（見 steer-ledger-gw）。
 * 兩者分工：TTL 是 UI 時間兜底，身份層是防重複投遞的正解。
 */
export async function flushPendingSteers(state: SessionState): Promise<void> {
  const queue = steerQueue(state)
  if (queue.length === 0) return
  const userStopped = abortIsUserStop(state.turnAborted, state.turnAbortSource)
  const plan = planSteerFlush(queue, { turnAborted: userStopped, now: Date.now() })
  // dropped 兩種來歷：aborted（用戶停止，停止優先）／expired（逾時，誠實落未生效）。
  for (const drop of plan.dropped) {
    const steer = queue.find((s) => s.id === drop.id)
    if (!steer) continue
    if (drop.reason === "aborted") {
      emitSteerStatusForAll(state, steer, "aborted", { reason: "aborted" })
      steerLedger.settle(steer.id, "aborted", Date.now(), "aborted")
    } else {
      emitSteerStatusForAll(state, steer, "failed", { reason: "queue_expired" })
      // 逾時＝不再投遞（TTL 的 UI 兜底語義），終態 tombstone 記 failed：與身份層的分工見
      // steer-core.STEER_QUEUE_TTL_MS 註釋——TTL 說「等太久了」，身份層說「這條結案了」。
      steerLedger.settle(steer.id, "failed", Date.now(), "queue_expired")
    }
  }
  if (!plan.batch) {
    state.pendingSteers = []
    return
  }
  // 先清隊列再投遞：投遞本身會開新回合，若此刻又來一條 steer，它該進新回合的隊列。
  state.pendingSteers = []
  const { text, ids } = plan.batch
  // 保序取回要投遞的條目本體（ids 只是 id；別名要一起收終態幀，否則別名徽章永停排队中）。
  const live = ids
    .map((id) => queue.find((s) => s.id === id))
    .filter((s): s is PendingSteer => s !== undefined)
  if (!driveTurn) {
    // 未接線＝誠實失敗（不靜默丟，也不假裝生效）。組合根 index.ts 必接。
    for (const steer of live) {
      emitSteerStatusForAll(state, steer, "failed", { reason: "delivery_unwired" })
      steerLedger.settle(steer.id, "failed", Date.now(), "delivery_unwired")
    }
    console.error(`[gateway] steer flush: deliverer not wired — ${ids.length} steer(s) dropped session=${state.sessionId}`)
    return
  }
  // ★ D2b 的關鍵一格：**投遞之前**先把這條命令標成 dispatched（持久）。
  //   語義＝「投遞已發出、還沒等到確認」。若進程此刻中斷（或 driveTurn 卡到重啟），
  //   重啟恢復只會把它落 uncertain 且**永不自動重發**——沒有這一格，重啟後這條指引
  //   在持久層看起來還是「沒送過」，重放就合法了（waoowaoo ARL-02 要解的事故）。
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
    // 確認到達 → 終態凍結（applied／failed）。同一 id 此後重放一律被 tombstone 擋住。
    steerLedger.settle(steer.id, delivered ? "applied" : "failed", Date.now(), delivered ? undefined : "delivery_failed")
  }
  console.log(
    `[gateway] steer flush ${status}: ${ids.length} steer(s) session=${state.sessionId}`,
  )
}
