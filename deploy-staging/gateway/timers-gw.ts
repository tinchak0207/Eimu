// timers-gw.ts —— 自 index.ts 第二階段 Wave3 抽取：S6 異步心跳匯報制全家族
// （clearAckTimer/armAckTimer、N1 心跳 clearHeartbeatTimer/armHeartbeatTimer、
// R2-A watchdog clearWatchdogTimer/armWatchdogTimer、R5-C 中段停滯哨
// clearMidturnStallTimer/armMidturnStallTimer、R8-B question 心跳/代答
// clearQuestionHeartbeat/clearQuestionAssumeTimer/armQuestionAssumeTimer/
// autoAssumeQuestions/armQuestionHeartbeat/reconcilePendingQuestions、
// turnHasActivity、R4-A 錯誤停滯哨
// clearErrorStallTimer/armErrorStallTimer、emitTurnEndSummaryIfSilent/
// emitRecoveryClosingIfSilent/isInterrogativeMessage/releasePendingVideoWorkflows）
// （原 index.ts 5821–6368 行，逐行原樣搬運）。
import type { SessionState } from "./types-gateway.ts"
import { ACK_DELAY_MS, HEARTBEAT_DELAY_MS, HEARTBEAT_DELAY_AFTER_ACK_MS, MIDTURN_STALL_MS, QUESTION_ASSUME_MS, QUESTION_HEARTBEAT_MS, TURN_WATCHDOG_MS, TURN_ERROR_WATCHDOG_MS, OPENCODE_URL } from "./constants-gateway.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { personaPatienceMul } from "./sessions-http.ts"
import { opencodeHeaders } from "./opencode-client.ts"
import { workflowService, workflowOwnerBySession } from "./workflow-gw.ts"
import { emitAgentNotice } from "./emit-helpers.ts"
import { settleQuestion } from "./questions-gw.ts"
// TODO(整合 Wave3)：以下符號仍住 index.ts 且未 export（本任務禁改 index.ts；bun build
// 對未 export 的 named import 報錯，已實測 2026-09-19）。依第一階段佔位符法（記憶
// gateway-index-refactor-stage1-0919）：declare 佔位可過 bun build；整合 subagent 統一換真 import。
// TODO(index.ts:1383) workflowService（WorkflowService 實例）
// TODO(index.ts:1513) workflowOwnerBySession
// TODO(index.ts:5752) emitAgentNotice
// TODO(settleQuestion 來自 questions-gw.ts，Wave3 同波在建) settleQuestion（現住 index.ts:5406）
/** 規格2：30s ack timer 的清理（發出或失效後都調用）。 */
export function clearAckTimer(state: SessionState): void {
  if (state.ackTimer) {
    clearTimeout(state.ackTimer)
    state.ackTimer = null
  }
}

/** 規格2：用戶消息送達 opencode 後啟動 30s ack 計時。
 *  罪狀2 表現修復（2026-08-29）：ack 觸發時不再發 message.delta 假助手文本
 *  （此前「收到，正在处理…」以正文身份污染轉錄），改走 emitAgentNotice 通知
 *  通道（前端 AgentNoticeRow 渲染路徑，S8 進度匯報同款，該通道自帶 turn.done
 *  收打字指示器；真實 turn 收尾時 idle 路徑照常發 turn.done，前端冪等）。
 *  活動判定改用 turnHasActivity——思考期（reasoning.delta）不再被誤判死寂。
 *  persona=thoughtful 時延遲 ×1.5（等待容忍窗，S7）。 */
export function armAckTimer(state: SessionState): void {
  clearAckTimer(state)
  state.ackSent = false
  const gen = state.turnGen ?? 0
  state.ackTimer = setTimeout(() => {
    state.ackTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一輪、turn 毫無動靜（無正文無思維鏈無工具）、還沒發過 ack」時補 ack。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.ackSent) {
      console.log(`[gateway] S6 ack skipped: session=${state.sessionId} gen=${gen} cur=${Boolean(cur)} turnText=${cur?.turnTextChars ?? "?"} turnReasoning=${cur?.turnReasoningChars ?? "?"} ackSent=${cur?.ackSent ?? "?"}`)
      return
    }
    cur.ackSent = true
    console.log(`[gateway] S6 ack sent (notice): session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", { text: "收到，模型思考中…" })
    // 通知通道自帶 turn.done；此處不再額外發任何幀。
  }, ACK_DELAY_MS * personaPatienceMul(state))
}

// ── N1 規格1（2026-08-27）：30s 心跳提示——死寂窗口的中段補口 ──
// 語義與 S6 ack 不同：ack 是「收到你的消息」（30s），心跳是「模型還在憋、
// 沒吐字也沒開工具」（ack 之後再等一輪）。錯峰規則：ack 尚未發 → 心跳在
// HEARTBEAT_DELAY_MS(30s) 起跳；ack 已發 → 順延到 HEARTBEAT_DELAY_AFTER_ACK_MS
// (45s)，避免同一時刻雙發。每 turn 最多 1 條；模型開口（吐字/開工具）即失效。
export function clearHeartbeatTimer(state: SessionState): void {
  if (state.heartbeatTimer) {
    clearTimeout(state.heartbeatTimer)
    state.heartbeatTimer = null
  }
}

export function armHeartbeatTimer(state: SessionState): void {
  clearHeartbeatTimer(state)
  state.heartbeatSent = false
  const gen = state.turnGen ?? 0
  state.heartbeatTimer = setTimeout(() => {
    state.heartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    // 只在「同一輪、turn 完全沒動靜（無字無工具）、本輪還沒發過心跳」時補一條。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.heartbeatSent) {
      return
    }
    // 錯峰：S6 ack 在同一時刻剛發過（30s 邊界撞車）→ 心跳順延一輪再判。
    if (cur.ackTimer || (cur.ackSent === true && Date.now() - (cur.lastUserAt ?? 0) < HEARTBEAT_DELAY_AFTER_ACK_MS)) {
      const deferMs = Math.max(1000, HEARTBEAT_DELAY_AFTER_ACK_MS - HEARTBEAT_DELAY_MS)
      cur.heartbeatTimer = setTimeout(() => {
        cur.heartbeatTimer = null
        const c2 = sessions.get(cur.sessionId)
        if (!c2 || (c2.turnGen ?? 0) !== gen || turnHasActivity(c2) || c2.heartbeatSent) return
        c2.heartbeatSent = true
        console.log(`[gateway] N1 heartbeat sent (post-ack): session=${c2.sessionId} gen=${gen}`)
        emitToSession(c2, "turn.status", { text: "仍在等待模型响应，请稍候…" })
      }, deferMs)
      return
    }
    cur.heartbeatSent = true
    console.log(`[gateway] N1 heartbeat sent: session=${cur.sessionId} gen=${gen}`)
    emitToSession(cur, "turn.status", { text: "仍在等待模型响应，请稍候…" })
    // 不發 turn.done：turn 仍在途，前端維持輸入中。
    // S7：persona=thoughtful 時本延遲 ×1.5（投遞時按 settings 計算，不改全局常量）。
  }, HEARTBEAT_DELAY_MS * personaPatienceMul(state))
}

// ── R2-A（2026-08-27）：turn 啟動看門狗 ─────────────────────────────
// 評測實錘：批准重跑後 prompt_async 202，但 295s 零 tool.invoke 零
// message.delta——turn 在壓縮後的長會話上靜默死亡，連 session.idle 都
// 不發，抖動重試（掛在 idle 上）永遠等不到。看門狗直接以「turn 動靜」為
// 準：90s 無動靜 → 誠實告警 + 防重複檢查後自動重投一次；再 90s 無動靜
// → 判會話損壞，建議新開。工具開跑或模型吐字即視為活著（turnToolStarted
// / turnTextChars 任一非零）。
export function clearWatchdogTimer(state: SessionState): void {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer)
    state.watchdogTimer = null
  }
}

// ── R5-C（2026-08-28）：中段停滯哨 ─────────────────────────────────
// 覆蓋啟動看門狗管不到的格：turn 已啟動（有過 tool/正文/任何幀）後中段凍結。
// 判定 = turnLastFrameAt（emitToSession 全量刷新）起算 90s 零新幀。第一咬：
// 誠實告警 + 單次重投 lastPromptBody（防風暴，midturnStallRetried 鎖）；第二咬
// （重投後仍零幀）：如實收尾 + turn.done。turnHasActivity=false 時靜默退出
//（那格歸啟動看門狗），idle 撤哨。
export function clearMidturnStallTimer(state: SessionState): void {
  if (state.midturnStallTimer) {
    clearTimeout(state.midturnStallTimer)
    state.midturnStallTimer = null
  }
}

export function armMidturnStallTimer(state: SessionState): void {
  clearMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.midturnStallTimer = setTimeout(() => {
    state.midturnStallTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!turnHasActivity(cur)) return // turn 未啟動：啟動看門狗管，不重疊
    // R8-B 工單 #3：question pending 期間靜默屬預期（等用戶答覆），
    // 心跳接管用戶可見性；此處重投只會打斷掛起的 question 工具。
    if (cur.pendingQuestions.size > 0 || cur.pendingConfirms.size > 0) return
    const last = cur.turnLastFrameAt ?? 0
    if (!(last > 0 && Date.now() - last >= MIDTURN_STALL_MS)) {
      armMidturnStallTimer(cur) // 還有幀進來：滾動續盯，直到 idle 撤哨
      return
    }
    if (!cur.midturnStallRetried) {
      // ── 第一咬：告警 + 單次重投（復用 watchdog 模式）──
      cur.midturnStallRetried = true
      cur.recoveryRound = true
      console.warn(`[gateway] R5-C midturn-stall: zero frames for ${Math.round((Date.now() - last) / 1000)}s (gen=${gen}), alerting + single re-dispatch — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "处理似乎卡住了，我重新尝试一下，请稍候" })
      const body = cur.lastPromptBody
      if (!body) {
        armMidturnStallTimer(cur)
        return
      }
      fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] R5-C midturn-stall: re-dispatch sent — session=${cur.sessionId} gen=${gen}`)
          stripStaleTurnTextFromReplay(cur)
          cur.turnLastFrameAt = Date.now()
          armMidturnStallTimer(cur) // 續盯第二輪判定
        })
        .catch((e: unknown) => {
          console.error(`[gateway] R5-C midturn-stall re-dispatch failed: session=${cur.sessionId}:`, e)
          armMidturnStallTimer(cur)
        })
      return
    }
    // ── 第二咬：重投後仍零幀——如實收尾 ──
    console.warn(`[gateway] R5-C midturn-stall: still frozen after re-dispatch (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "重新尝试后仍没有进展，我先停止等待。刚才完成的部分不会丢，稍后重新发送消息即可继续。\n",
    })
    emitToSession(cur, "turn.done", {})
    cur.lastTurnActiveAt = 0
    markDirty(cur)
  }, MIDTURN_STALL_MS)
}

// ── R8-B 工單 #3（2026-08-29）：question pending 心跳 ──
// pending 期間每 30s 一幀用戶可見心跳（message 通道直發，不帶 turn.done——
// turn 還掛著等答覆）。答覆/拒絕/會話拆除時撤哨。
export function clearQuestionHeartbeat(state: SessionState): void {
  if (state.questionHeartbeatTimer) {
    clearTimeout(state.questionHeartbeatTimer)
    state.questionHeartbeatTimer = null
  }
  // 片AJ：assume 代答哨與心跳同生共死——既有全部答覆/跳過/拆除路徑已調本函數。
  clearQuestionAssumeTimer(state)
}

// ── 片AJ（2026-09-07）：question 卡 3 分鐘超時按推薦方案代答 ──
// 背景（片AB 評測 T4 實錘）：無人值守跑批時 question 卡在確認門前無限掛死。
// 語義：3 分鐘未回覆 → 各題取第一選項（agent 約定推薦選項放第一位）組成代答
// 文案並標注 assumed，轉發核心復用 settleQuestion（雙 URL 兜底 + ok 後記賬 +
// question.replied 前端變已決）。best-effort：上游失敗照 settleQuestion 既有
// 形態收尾，不重試不拋出（reconcile/新消息路徑接管）。confirm（花錢決策）不在此列。
export function clearQuestionAssumeTimer(state: SessionState): void {
  if (state.questionAssumeTimer) {
    clearTimeout(state.questionAssumeTimer)
    state.questionAssumeTimer = null
  }
}

export function armQuestionAssumeTimer(state: SessionState): void {
  clearQuestionAssumeTimer(state)
  state.questionAssumeTimer = setTimeout(() => {
    state.questionAssumeTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0) return
    void autoAssumeQuestions(cur)
  }, QUESTION_ASSUME_MS)
}

export async function autoAssumeQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  const labels: string[] = []
  for (const pending of state.pendingQuestions.values()) {
    for (const q of pending.questions) {
      const label = q.options?.[0]?.label
      if (label) labels.push(label)
    }
  }
  // 0919 斷點③修復：話術不得冒充「推荐方案」——gateway 沒有任何管道知道哪個
  // 選項是模型推薦的（options 無推薦標記欄位），盲取 options[0] 標成推薦＝
  // 撒謊。改為如實標「代答了首項」；agent 側 prompt 契約本就要求預設答案
  // 放第一項（AGENTS.md §3.6），首項是事實上的預設，但稱呼必須誠實。
  const answerText = `（用户 3 分钟未回复，已代答第一项继续：${labels.length ? labels.join("；") : "无选项，按默认方案"}。后续结果请标注 assumed）`
  const count = state.pendingQuestions.size
  for (const requestId of [...state.pendingQuestions.keys()]) {
    try {
      await settleQuestion(state, requestId, answerText)
    } catch (err) {
      console.error(`[gateway] auto-assume question failed: ${requestId} — session=${state.sessionId}:`, err)
      state.pendingQuestions.delete(requestId)
    }
  }
  state.pendingQuestions.clear()
  clearQuestionHeartbeat(state)
  console.log(`[session] auto-assumed ${count} pending question(s) after ${QUESTION_ASSUME_MS}ms — session=${state.sessionId}`)
}

export function armQuestionHeartbeat(state: SessionState): void {
  clearQuestionHeartbeat(state)
  const tick = (): void => {
    state.questionHeartbeatTimer = null
    const cur = sessions.get(state.sessionId)
    if (!cur || cur.pendingQuestions.size === 0 || cur.turnAborted) return
    // R9-1：心跳走服務端事件（heartbeat），不再複製成 message.delta 消息泡——
    // 前端 reducer 對未知事件只推 lastEventId、不產生新條目，復讀機根治。
    // question 卡本身已是「等待選擇」的視覺錨點，心跳只是維持「後端還活著」。
    emitToSession(cur, "heartbeat", { type: "question_pending", pendingAt: Date.now() })
    // R8-B 驗收實錄：opencode 側 question 會靜默過期（上游 /question 清單變空、
    // reply 端點回 QuestionNotFoundError），gateway 若不知情 = 心跳永久循環 +
    // turn 永久凍結。每拍對賬一次，過期即摘除並解除凍結，交還既有哨兵接管。
    void reconcilePendingQuestions(cur)
    cur.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
  }
  state.questionHeartbeatTimer = setTimeout(tick, QUESTION_HEARTBEAT_MS)
}

/** question pending 對賬：上游已不存在的 request 摘除；全部摘完時解除凍結。 */
export async function reconcilePendingQuestions(state: SessionState): Promise<void> {
  if (state.pendingQuestions.size === 0) return
  let liveIds: Set<string> | null = null
  try {
    const res = await fetch(`${OPENCODE_URL}/question`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const arr = (await res.json()) as Array<Record<string, unknown>>
      liveIds = new Set(arr.filter((r) => typeof r?.id === "string").map((r) => r.id as string))
    }
  } catch {
    return // 查不到就不動：下一拍再對賬
  }
  if (!liveIds) return
  for (const requestId of [...state.pendingQuestions.keys()]) {
    if (!liveIds.has(requestId)) {
      state.pendingQuestions.delete(requestId)
      emitToSession(state, "question.expired", { request_id: requestId, reason: "upstream_expired" })
      console.log(`[gateway] R8-B question expired upstream: ${requestId} — session=${state.sessionId}`)
    }
  }
  if (state.pendingQuestions.size === 0) {
    clearQuestionHeartbeat(state)
    state.turnFrozenByQuestion = false
    state.turnLastFrameAt = Date.now()
    state.lastUserVisibleAt = Date.now()
    emitToSession(state, "message.delta", { text: "（选择卡片已过期。如仍要继续，请回复或重新发送消息。）\n" })
    // 凍結期間哨兵全撤過：恢復段重新布防，讓啟動看門狗/停滯哨接管收尾或重投。
    armWatchdogTimer(state)
  }
}

/** turn 是否有任何「已啟動」的證據：模型吐過字（正文或思維鏈），或工具開跑過。
 *  罪狀2 根因修復（2026-08-29）：思維鏈（reasoning.delta）也是模型活著的證據——
 *  此前只看正文與工具，思考型模型整段推理期間被 ack/心跳/看門狗/停滯哨誤判死寂。
 *  ack/心跳/看門狗/中段停滯哨全部經此函數繼承該語義。 */
export function turnHasActivity(st: SessionState): boolean {
  return (st.turnTextChars ?? 0) > 0 || (st.turnReasoningChars ?? 0) > 0 || st.turnToolStarted === true
}

/** 用戶消息/resume 送達後布哨；每次觸發後自續（第二輪觸發=終局判定）。 */
export function armWatchdogTimer(state: SessionState): void {
  clearWatchdogTimer(state)
  // R5-C：中段停滯哨與啟動看門狗同點布防/重布（含重投輪），撤哨走 idle。
  armMidturnStallTimer(state)
  const gen = state.turnGen ?? 0
  state.watchdogTimer = setTimeout(() => {
    state.watchdogTimer = null
    const cur = sessions.get(state.sessionId)
    // 會話已拆 / 已進入下一輪 / turn 已有動靜 → 哨兵靜默退出。
    if (!cur || (cur.turnGen ?? 0) !== gen || turnHasActivity(cur) || cur.turnAborted) {
      return
    }
    // 等用戶決策（confirm/question 掛起）是合法暫停，不是 LLM 無響應——
    // 掛起期間零幀流動，此前被誤判死寂：重投 prompt 造出重複回合 + 誣陷後端。
    // 靜默續哨：決策落地後活動恢復自然撤哨；卡片過期後若 turn 真死，下一輪照咬。
    if (cur.pendingConfirms.size > 0 || cur.pendingQuestions.size > 0) {
      armWatchdogTimer(cur)
      return
    }
    if (!cur.watchdogRetried) {
      // ── 第一次咬：誠實告警 + 自動重投一次 ──
      cur.watchdogRetried = true
      cur.recoveryRound = true // R5-C：恢復輪標記，收尾兜底結語用
      console.warn(`[gateway] watchdog: turn not started (gen=${gen}), notifying user and retrying once — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "处理似乎卡住了，我重新尝试一下，请稍候" })
      // 防重複：重投前實時核對 turn 仍零動靜（告警幀發送期間模型可能恰好開口）。
      if (turnHasActivity(cur)) return
      const body = cur.lastPromptBody
      if (!body) return
      fetch(`${OPENCODE_URL}/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        headers: opencodeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`)
          console.log(`[gateway] watchdog: retry dispatched for session=${cur.sessionId} gen=${gen}`)
          // N2：重投輪開始——剝掉舊 turn 的文本幀（含 watchdog 自己的告警幀），
          // 避免重連/後續 idle 補發路徑把它們整段重放。
          stripStaleTurnTextFromReplay(cur)
          // 重投已出發：重新布哨等第二輪判定（cur 仍零動靜才會咬）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) armWatchdogTimer(cur)
        })
        .catch((e: unknown) => {
          console.error(`[gateway] watchdog: retry dispatch failed for session=${cur.sessionId}:`, e)
          // 重投發不出去：這輪已無恢復手段，進入終局話術（Q3：如實三句式，
          // 不再誣陷「會話損壞」、不再建議必然失敗的「新開一個」）。
          if ((cur.turnGen ?? 0) === gen && !turnHasActivity(cur)) {
            // 修 1：死亡宣告置位——此後若仍有內容幀到達（上游慢復活），
            // emitToSession 會先發撤回幀。
            cur.deathDeclared = true
            emitToSession(cur, "message.delta", {
              text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
            })
            // N1 規格2：終局之後補一條明確指引（一次性；此路徑每 turn 只進一次）。
            emitToSession(cur, "message.delta", {
              text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
            })
            emitToSession(cur, "turn.done", {})
          }
        })
      return
    }
    // ── 第二次咬：重投也沒喚醒——LLM 後端無響應，如實告知（Q3 去誤導） ──
    console.warn(`[gateway] watchdog: turn still dead after retry (gen=${gen}), backend unresponsive — session=${cur.sessionId}`)
    // 修 1：死亡宣告置位——重投的 retry 若之後開始產出（殭屍还魂實錄：
    // 宣告死亡 10 秒後 retry 輸出照灌），第一條內容幀觸發撤回幀，用戶明確
    // 知道剛才是誤判、任務已恢復；「宣告死亡 + 靜默还魂」不再並存。
    cur.deathDeclared = true
    emitToSession(cur, "message.delta", {
      text: "自动重试后 LLM 后端仍无响应（服务端问题，不是你的操作）。已停止等待。请稍后重试发送同一条消息，若持续失败请联系管理员。\n",
    })
    // N1 規格2：終局之後補一條明確指引（一次性；第二咬每 turn ��進一次）。
    emitToSession(cur, "message.delta", {
      text: "你刚才的消息可能未处理完成，稍后重新发送即可继续。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：別讓前端永遠掛著「輸入中」
  }, TURN_WATCHDOG_MS)
}

// ── R4-A S3①（2026-08-28）：上游錯誤後停滯看門狗 ───────────────────
// R4 實錘兩個根因：1) 啟動看門狗只守「turn 從未啟動」（turnHasActivity 即
// 靜默退出），APIError 前模型已吐過字 → 哨兵瞎了；2) 抖動重試耗盡後 idle
// 直接靜默 turn.done，零話術。此哨補第一格：emitSessionError（非 tool_error）
// 布哨 → 90s 內 turn 未收尾 → 誠實告警（每 turn 一條）並續盯（重投由抖動
// 重試機制接手）；告警後再 90s 仍零進度 → 明確收尾話術 + turn.done。
// TURN_ERROR_WATCHDOG_MS 環境變量可覆蓋。
export function clearErrorStallTimer(state: SessionState): void {
  if (state.errorStallTimer) {
    clearTimeout(state.errorStallTimer)
    state.errorStallTimer = null
  }
}

export function armErrorStallTimer(state: SessionState): void {
  clearErrorStallTimer(state)
  const gen = state.turnGen ?? 0
  state.errorStallTimer = setTimeout(() => {
    state.errorStallTimer = null
    const cur = sessions.get(state.sessionId)
    // 會話已拆 / 已進入下一輪 / 已中止 → 靜默退出（idle 收尾路徑會撤哨）。
    if (!cur || (cur.turnGen ?? 0) !== gen || cur.turnAborted) return
    if (!cur.errorStallAlerted) {
      // ── 第一咬：誠實告警（每 turn 一條），續盯。
      cur.errorStallAlerted = true
      console.warn(`[gateway] error-stall watchdog: upstream error, turn unfinished after ${TURN_ERROR_WATCHDOG_MS}ms (gen=${gen}) — session=${cur.sessionId}`)
      emitToSession(cur, "turn.status", { text: "上游刚才报错了，我还在盯着处理；若持续没有进展，我会告诉你并停止等待" })
      if ((cur.turnGen ?? 0) === gen && !cur.turnAborted) armErrorStallTimer(cur)
      return
    }
    // ── 第二咬：告警後有進度 = turn 活著 → 靜默續盯，不再出幀打擾。
    const progressAt = cur.turnProgressAt ?? 0
    if (progressAt > 0 && Date.now() - progressAt < TURN_ERROR_WATCHDOG_MS) {
      armErrorStallTimer(cur)
      return
    }
    console.warn(`[gateway] error-stall watchdog: still stalled after alert (gen=${gen}), closing turn honestly — session=${cur.sessionId}`)
    emitToSession(cur, "message.delta", {
      text: "上游连续报错且自动重试未能恢复，我停止等待了。请稍后重新发送上一条消息即可继续；若内容较长，建议让我分章/分段处理。\n",
    })
    emitToSession(cur, "turn.done", {}) // 收尾：別讓前端永遠掛著「輸入中」
  }, TURN_ERROR_WATCHDOG_MS)
}

/** R4-A S8（2026-08-28）：turn 收尾兜底匯報——本輪有節點落終態但零主動匯報
 *  時補一幀中文總結（R4 實錘：第一輪 5 成功+1 失敗零匯報悄悄收工）。環名
 *  來源 = workflow graph 節點的模板預置 title（如「角色卡」），取不到才用
 *  節點 id 尾段。花費只匯總工作流裡真實存在的數字，沒有就不編。 */
export function emitTurnEndSummaryIfSilent(state: SessionState): void {
  const nodes = state.turnTerminalNodes ?? []
  if (nodes.length === 0 || state.turnNoticeSent || state.turnAborted) return
  state.turnNoticeSent = true
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  const titleById = new Map<string, string>()
  const costById = new Map<string, number>()
  if (wf) {
    const w = wf as unknown as {
      graph?: { nodes?: Array<{ id?: unknown; title?: unknown }> }
      nodeCost?: Record<string, unknown>
    }
    for (const n of w.graph?.nodes ?? []) {
      if (typeof n?.id === "string" && typeof n?.title === "string") titleById.set(n.id, n.title)
    }
    for (const [k, v] of Object.entries(w.nodeCost ?? {})) {
      if (typeof v === "number") costById.set(k, v)
    }
  }
  const labelOf = (id: string): string => titleById.get(id) || (id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : id)
  const okList = nodes.filter((n) => n.status === "success").map((n) => labelOf(n.id))
  const badList = nodes.filter((n) => n.status === "error").map((n) => labelOf(n.id))
  if (okList.length === 0 && badList.length === 0) return
  let spent = 0
  let anyCost = false
  for (const n of nodes) {
    if (n.status !== "success") continue
    const c = costById.get(n.id)
    if (typeof c === "number") {
      spent += c
      anyCost = true
    }
  }
  const lines: string[] = ["【本轮小结】"]
  lines.push(okList.length > 0 ? `已完成 ${okList.length} 个环节：${okList.join("、")}。` : "本轮没有完成的环节。")
  if (badList.length > 0) lines.push(`失败 ${badList.length} 个环节：${badList.join("、")}。失败节点可在画布上重试。`)
  if (anyCost) lines.push(`本轮已完成环节共花费 ${Math.round(spent * 100) / 100} 币。`)
  lines.push(badList.length > 0 ? "下一步：可重试失败节点，或告诉我接下来怎么调整。" : "下一步：可继续推进后续环节，或让我检查已完成环节的产出。")
  emitToSession(state, "message.delta", { text: lines.join("\n") + "\n" })
  console.log(`[gateway] S8 turn-end fallback summary: ${okList.length} ok / ${badList.length} failed — session=${state.sessionId}`)
}

/** R5-C（2026-08-28）：恢復輪強制結語——watchdog 重投/redrive/中段哨重投的
 *  恢復輪（recoveryRound=true）收尾時，若 S8 節點小結不觸發（零終態節點）且
 *  零主動匯報、且本輪有正文輸出（零文本路徑已有自己的誠實收尾），兜底補一條
 *  用戶可見結語，杜絕恢復輪悄悄收工。N 取當前工作流可執行節點數，取不到不編。 */
export function emitRecoveryClosingIfSilent(state: SessionState): void {
  if (!state.recoveryRound || state.turnAborted || state.turnNoticeSent) return
  // R8-B 工單 #4（2026-08-29）：本輪答覆過 question → 用戶語義已在模型上下文，
  // 模型自己會執行/收尾。補「要繼續跑嗎」= 剛關的門自己又拉開（R8 拒單實錘：
  // 用戶答「先不生成，就到這」後被 5125.1 幀自我推翻），讓位。
  if (state.questionAnsweredThisTurn) return
  if ((state.turnTerminalNodes ?? []).length > 0) return // S8 小結已覆蓋
  if ((state.turnTextChars ?? 0) === 0) return // 零文本路徑已有專屬收尾話術
  let n = 0
  const wfid = workflowOwnerBySession.get(state.sessionId)
  const wf = wfid ? workflowService.get(wfid) : undefined
  if (wf) {
    const g = (wf as unknown as { graph?: { nodes?: Array<{ kind?: string }> } }).graph
    n = (g?.nodes ?? []).filter((x) => x.kind !== "text" && x.kind !== "config").length
  }
  const text =
    n > 0
      ? `恢复完成：已重建 ${n} 个节点配置。要继续跑吗？\n`
      : "恢复完成：刚才中断的处理已经接上。要继续跑吗？\n"
  emitToSession(state, "message.delta", { text })
  console.log(`[gateway] R5-C recovery closing emitted: nodes=${n} — session=${state.sessionId}`)
}

/** 規格3：質詢樣式識別——問句/追責類關鍵詞（結案提問「為什麼/退款/剩什麼」命中）。 */
export function isInterrogativeMessage(text: string): boolean {
  return /为什么|为何|怎么回事|怎么回|咋|退钱|退款|失败|死了|还剩|剩什么|什么情况|啥情况|怎么办|赔|投诉|号|？|\?/.test(text)
}

/** 規格3：turn 結束（回覆完成）時放行被凍結的視頻工作流。 */
export function releasePendingVideoWorkflows(state: SessionState): void {
  const pending = state.pendingVideoWorkflows
  if (!pending || pending.length === 0) {
    state.pendingVideoWorkflows = []
    return
  }
  state.pendingVideoWorkflows = []
  emitAgentNotice(state, `已收到你的追问并答复完毕。此前暂缓的视频任务（${pending.length} 个）现在继续执行，节点完成后我会逐条汇报。`)
  for (const wfid of pending) {
    void workflowService.generate(wfid).then((r) => {
      if (!r.ok) console.error(`[workflow] ${wfid} resumed-after-question finished: ${r.status}`)
    })
  }
}
