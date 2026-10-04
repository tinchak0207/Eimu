// gateway 第二階段重構 Wave2（2026-09-19）：opencode-event-handler.ts
// 機械抽取自 index.ts 3620–4085（handleOpencodeEvent 全函數：session.idle 收盤、
// failover/jitter 兩台重試機、critic pass、Jev gate、question freeze、video release、
// compaction 觸發）。除檔頭註釋/import/declare 佔位/export 前綴外與源逐行等價（diff 驗 identical）。
// 依賴解析：Wave1/已建模組真 import；仍住 index.ts 未 export 的符號 declare 佔位（stage1 記憶 subagent 佔位符法）。
import { sessions, markDirty, findSessionByOpenCodeId } from "./sessions-core.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { flushOtherPartTails, takeTurnEndTail, sessionUserScript } from "./outbound-sanitize.ts"
import { emitSanitizedDelta } from "./outbound-emit.ts"
import { opencodeHeaders, scheduleTitleFetch, revertDeadTail } from "./opencode-client.ts"
import { MESSAGE_ROLE_CAP, OPENCODE_URL, PART_TEXT_TRACK_CAP, STEP_COST_LOG_CAP, SUPPRESSED_PART_CAP, TURN_MAX_RETRIES, TURN_RETRY_DELAY_MS } from "./constants-gateway.ts"
import type { SessionState } from "./types-gateway.ts"
import { subagentHandlesSession, handleSubagentEvent, maybeRunMachineCriticPass, snapshotPendingCriticTargets } from "./subagent"
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
import { maybeCompactSession } from "./messages-gw.ts"
import { opencodeErrorCode, opencodeErrorMessage } from "./emit-helpers.ts"
// 2026-10-02 能力片：錯誤訊息即模型上下文。failover 重投時以既有 prompt_async 文本
// part 通道注入「續寫指示」與「孤兒 tool_use 補 is_error」——模型可見、使用者不可見
// （設計取自 Claude Code，未複製其程式碼；見 error-classify.ts 該節註解）。
import { buildFailoverInjection, buildContinuationDirective, type OrphanToolUse } from "./error-classify.ts"
// REQ-D2（2026-09-22）：回合收尾投遞待投的 steer（空隊列＝零動作，無 steer 的回合逐位等價）。
// 方向與既有 maybeCompactSession 同款（本檔 → messages-gw 家族），不新增環。
import { flushPendingSteers } from "./steer-gw.ts"

// TODO(來自 events-translate.ts): eventSessionId(index.ts 2715)/handleToolPartUpdate(index.ts 3309)
//   —— W7 並行在建 events-translate.ts，建成後改真 import。

// TODO(整合 Wave2): 以下為仍住 index.ts 且尚未 export 的符號 declare 佔位
// （bun build 只轉譯不查名，建得過；index.ts 補 export 或符號遷出後替換為真 import）。

// H14（2026-10-02）：系統喚醒不冒充用戶發言。prompt_async 注入的喚醒文本在 opencode 裡只能是
// user-role message（身份由 opencode 存儲決定）；網關側能做的是把它從「用戶發言」語義摘出——
// messageRole 改記 "system"（isAssistantMessage 僅認 "assistant"，回聲抑制語義不變），
// 並以 turn.status 暫態單行告知前端（不落 transcript，參照 turn-status-transient-row 修法）。
import { isSystemWakeText } from "./system-wake.ts"
export { isSystemWakeText }
export function markSystemWakeMessage(state: SessionState, messageID: unknown, text: unknown): boolean {
  if (typeof messageID !== "string" || !isSystemWakeText(text)) return false
  if (state.messageRole.get(messageID) !== "user") return false // 已標過/非 user 訊息 → 不重發
  state.messageRole.set(messageID, "system")
  // 2026-10-04 T2 反向洩漏修復：此文案原為繁體硬編，簡體用戶會吃到繁體；改依會話
  // 黏性書寫體出對應版本（繁體本體保留）。
  emitToSession(state, "turn.status", {
    text:
      sessionUserScript(state) === "hant"
        ? "子代理已完成，系統自動喚醒主代理匯總中…"
        : "子代理已完成，系统自动唤醒主代理汇总中…",
  })
  return true
}

// R9-B（2026-09-30）：其他 part 扣住的尾行（無尾換行的單行旁白）當場吐出，
// 保持「旁白 → 工具/下一段」時序；否則會被壓到 session.idle 才補播（SSE 9888–9894）。
function emitOtherPartTails(state: SessionState, exceptPid?: string): void {
  const text = flushOtherPartTails(state.partStripState, exceptPid)
  if (text) {
    emitToSession(state, "message.delta", { text }, { strippable: true })
    state.lastUserVisibleAt = Date.now()
  }
}

/**
 * 回合真正收尾的唯一出口：清 in-flight 打點，再發 turn.done。
 *
 * 2026-10-02 steer 誤判修復：`lastTurnActiveAt` 是 steer 受理閘（steer-gw.turnInFlight）
 * 判「現在有沒有可引導的回合」的唯一依據，語義必須是「上游真的有一個在途回合」。
 * 舊版把它掛在 session.idle 一到就清，但 idle **不等於**回合結束：下面 failover／jitter
 * 兩台重試機在同一輪內會再送一次 prompt_async，且刻意**不發 turn.done**（前端維持
 * 進行中）。打點先被清、重投腿又不補 ⇒ 整條重投輪的 steer 全被回 409 no_active_turn，
 * 使用者在「進行中」的回合裡追加的引導一律被判「引導未能送達（未生效）」。
 * 所以清點與 turn.done 綁死成同一個出口（三個落點全走本函數），重投腿自然跳過。
 */
function emitTurnDone(state: SessionState): void {
  state.lastTurnActiveAt = 0
  markDirty(state)
  emitToSession(state, "turn.done", {})
}

// ── 2026-10-02 能力片：孤兒 tool_use 追蹤（設計取自 Claude Code yieldMissingToolResultBlocks
// ——換模型時替未收到結果的 tool_use 補 is_error，未複製程式碼）──────────────
// 純讀觀測：記錄每個 session 目前 in-flight 的工具調用；工具 completed/error 即摘除。
// turn 因上游錯誤中斷時，殘留在表裡的就是「孤兒」——換模型重投時注入 is_error 語義補注，
// 讓接手模型知道這些工具沒跑完。只寫本模組私有 Map，不新增任何前端幀（使用者不可見）。
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
/** 取出並清空該 session 的孤兒候選（failover 消費一次；正常 turn 結束亦清，防洩漏）。 */
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
          // H14：已標為 system 的喚醒訊息，後續 message.updated 不得回寫成 user。
          if (!(role === "user" && state.messageRole.get(mid) === "system")) state.messageRole.set(mid, role)
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        // 壓縮復讀機修復（2026-10-02）：compaction 代理產出的「摘要訊息」role 也是
        // assistant（同會話、mode=primary，只有 summary:true 能辨識），會被
        // isAssistantMessage 放行、把摘要草稿整段灌進用戶可見流——模型壓縮時前端
        // 秒變復讀機（同一份摘要反覆重跑＝反覆上屏）。標成第三種角色 "compaction"
        // 後 text/reasoning 兩條流都不再上屏；壓縮動作改以 turn.status 一行告知。
        if (mid && role === "assistant" && info?.summary === true) {
          state.messageRole.set(mid, "compaction")
          boundMap(state.messageRole, MESSAGE_ROLE_CAP)
        }
        // Phase 0 觀測：assistant message 自帶的 tokens/cache 用量（事件本來就送到，
        // 零額外往返）；事件不含此欄位時保持 null，不補請求、不加延遲。
        noteTurnUsage(state, info)
        break
      }
      case "message.part.delta": {
        // 中止殘響（2026-09-02）：用戶中止後 opencode 排隊中的遲到 delta 全丟，
        // 直到下一輪 prompt 起點重置（turnAborted L4165）。
        if (state.turnAborted) break
        const p = event.properties ?? {}
        // A delta says nothing about its part's type, and reasoning parts also
        // append to a "text" field — so field==="text" alone would stream chain
        // of thought to the UI. suppressedParts is populated from the
        // message.part.updated that always precedes a part's deltas (verified by
        // raw capture: part.updated -> delta -> delta).
        // NOTE 2026-08-11: 產品要顯示思維鏈，reasoning part 不再丟棄 —— 改發
        // reasoning.delta 事件（同 shape，前端 reducer 累積到 assistant.reasoning）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0 && isAssistantMessage(state, p.messageID)) {
          if (typeof p.partID === "string" && state.suppressedParts.has(p.partID)) {
            emitToSession(state, "reasoning.delta", { text: p.delta.replace(/\uFFFD/g, "") }) // 2026-10-02 亂碼守門
            // 罪狀2 根因修復（2026-08-29）：思維鏈字數計入 turn 活動——
            // 讓 ack/心跳/看門狗/停滯哨（turnHasActivity）知道模型活著。
            state.turnReasoningChars = (state.turnReasoningChars ?? 0) + p.delta.length
            // P2b 刀2：非空 reasoning 文字 = 本 step 不空（trim 後才算）。
            if (p.delta.trim().length > 0) state.stepHasReasoning = true
            // 2026-10-02：無工具長推理上限——兩段式（見 reasoning-cap.ts 檔頭）：
            //   soft＝首回合軟限用盡：只誠實上報，不腰斬正在規劃的回合（修 46.5s 誤傷）；
            //   hard＝達中止門檻：中止 + 動作導向、保留推理的 nudge 同輪重投。
            {
              const capVerdict = noteReasoningDelta(state, p.delta.length, {
                text: p.delta,
                ctx: { hasTool: state.turnToolStarted === true, hasText: (state.turnTextChars ?? 0) > 0 },
              })
              if (
                capVerdict.kind !== "none" &&
                !state.idleNudgeSent && !state.turnAborted && (state.lastTurnActiveAt ?? 0) > 0 && state.lastPromptBody
              ) {
                if (capVerdict.kind === "soft") {
                  console.warn(`[gateway] reasoning-cap: first-gen soft budget used — session=${state.sessionId}`)
                  // 2026-10-04 語言漂移：守衛文案鏡像**會話黏性**書寫體（繁體用戶不得收簡體；
                  // 繁體會話夾英文/短句不改判）。
                  emitToSession(state, "turn.status", {
                    text:
                      sessionUserScript(state) === "hant"
                        ? "首輪規劃較長，已提示模型立即給出結論並開始行動。"
                        : "首轮规划较长，已提示模型立即给出结论并开始行动。",
                  })
                } else {
                  resetReasoningCap(state)
                  console.warn(`[gateway] reasoning-cap: no-action reasoning exceeded — session=${state.sessionId}`)
                  triggerIdleStepBreaker(
                    state,
                    buildReasoningNudge({
                      hasTool: state.turnToolStarted === true,
                      tail: capVerdict.tail,
                      script: sessionUserScript(state),
                    }),
                  )
                }
              }
            }
            break
          }
          // R9-B：新 part 開講前，先吐出前面 part 扣住的尾行（pid 口徑同 emitSanitizedDelta）。
          emitOtherPartTails(state, typeof p.partID === "string" && p.partID ? p.partID : "_turn")
          // S2b：出站文本先過內部框架段剝離器（## Objective 等四段）。
          // turnTextChars 仍按原文計——剝到零輸出代表模型確實說過話，不觸發抖動重試。
          emitSanitizedDelta(state, p.partID, p.delta)
          state.turnTextChars = (state.turnTextChars ?? 0) + p.delta.length
          // §7 召回輔助：留本輪正文頭部（buildRecallQuery 只需前 200 字元）。
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
            // 中止殘響（2026-09-02）：part.text 是累積全文，partTextEmitted 在 idle
            // 已清——中止輪的補發會整段當「新後綴」重發（N2 同場景根因），丟棄。
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
              // R9-B：同 delta 路徑——先吐出其他 part 扣住的尾行。
              emitOtherPartTails(state, id)
              // S2b：part.updated 補發的後綴同樣過剝離器（與 delta 路徑共用逐 part 狀態）。
              emitSanitizedDelta(state, id, full.slice(rec.emittedLen))
              state.turnTextChars = (state.turnTextChars ?? 0) + (full.length - rec.emittedLen)
              // §7 召回輔助：補發後綴同樣入正文頭部（無 delta 的單幀 part 靠這條）。
              noteAssistantHeadForRecall(state, full.slice(rec.emittedLen))
              rec.emittedLen = full.length
              state.partTextEmitted.set(id, rec)
              boundMap(state.partTextEmitted, PART_TEXT_TRACK_CAP)
            }
            break
          }
          case "compaction": {
            // 壓縮動作可見化（前端零改動：走既有 turn.status 通道）。同一 part 只報一次；
            // 該 part 所屬訊息一併標非 assistant（摘要不入對話流，見 message.updated 段）。
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
            // R9-B：工具調用起點（pending/running）＝前面的旁白已講完，尾行當場吐出，
            // 讓「先讓歌跑起來：」出現在 tool.invoke 之前而非回合結束後。
            if (!state.turnAborted && (part.state?.status === "pending" || part.state?.status === "running")) {
              emitOtherPartTails(state)
            }
            // 2026-10-02：孤兒 tool_use 追蹤（純讀，使用者不可見）。
            noteToolInFlight(state, part)
            handleToolPartUpdate(state, part)
            // P2b 刀2：出現 tool = 本 step 不空。
            // 空轉補丁（2026-10-02）：裸 true/date/:/空 command 的 bash 不算「有動作」——
            // step-5-preview 實測 64% bash 是此類空轉，原本因「有 tool」躲過止損。
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
            // P2b 刀2：step 收尾結算——空 step 累計，任一活動歸零；達閾值即止損。
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
            // P2b 刀2：step-start = 新 step 起點（上一 step 若無 step-finish 先結算）。
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
        // R8-B 工單 #3/#9（2026-08-29）：question pending 期間 turn 凍結——
        // 不發 turn.done、不觸發抖動重試/壓縮/視頻放行。R8 實錘：turn.done
        // 4604.8 早於 question.replied 4634.5（死而復生型狀態）。等待期用戶
        // 可見性由 question 心跳（armQuestionHeartbeat，30s/幀）接管。
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
        // 會話摘要標題（2026-09-12）：正常收尾路徑（非 question 凍結分支）掛
        // 一次性抓取鏈——首條消息後 opencode 異步生成標題，idle 即回合結束，
        // 2s/8s/20s 重試覆蓋生成滯後；已有標題則空轉返回（冪等）。
        scheduleTitleFetch(state)
        // End-of-turn signal: stop the frontend typing indicator and drop the
        // per-partID delta tracking for this turn to bound memory.
        // messageRole and toolInvokeSeen are deliberately NOT cleared: a late
        // part or duplicate status for this turn would otherwise be treated as
        // unknown-role (dropped) or as a fresh call (re-emitted). Both are
        // capped, so they stay bounded without clearing.
        // S2b：回合結束——把各 part 剝離器扣住的最後一行安全文本吐出
        //（在 turn.done 之前，前端收幀順序不亂），再清狀態。
        // 中止窗口不吐剝離器尾巴（2026-09-02）：用戶叫停後再冒一句=沒停乾淨。
        // R9-B（2026-09-30）：只吐最後一個 part（最終答覆）的尾行；更早 part 的尾行
        // 已在下一段/工具起點當場吐出，殘留即過期旁白——丟棄留日誌，不接在答覆後補播。
        if (!state.turnAborted) {
          const { tail, dropped } = takeTurnEndTail(state.partStripState)
          if (tail) emitToSession(state, "message.delta", { text: tail }, { strippable: true })
          if (dropped.length) {
            console.log(`[gateway] R9-B stale part tails dropped at idle: x${dropped.length} — session=${state.sessionId}`)
          }
        }
        // S1 補口（2026-08-29，smoke agent_text 根因）：一次性「英文已略去」提示
        // 此前只在流式路徑（emitSanitizedDelta）發——單行英文回覆（無尾換行）
        // 整段扣在 pending、idle 時被 flush 壓掉 → 零 message.delta 靜默 turn.done
        // （實錘：同英文 prompt 四輪，模型三輪回英文，md-count 全為 0）。
        // flush 後補發同一條提示，避免整段回覆無聲消失。
        if (!state.englishNoticeSent) {
          for (const [, stripSt] of state.partStripState) {
            if (stripSt.sawEnglish) {
              state.englishNoticeSent = true
              // 2026-10-04 T2 語言鏡像：英文剝離提示依會話黏性書寫體出對應版本。
              emitToSession(state, "turn.status", {
                text:
                  sessionUserScript(state) === "hant"
                    ? "已自動略去一段英文內部思考，中文回覆不受影響"
                    : "已自动略去一段英文内部思考，中文回复不受影响",
              })
              break
            }
          }
        }
        // P2b 刀2：turn 結束——未收尾的 step 先結算，再清空轉止損狀態
        //（idleNudgeSent 刻意不清：同 turn 週期只補一次，下一輪起點才重置）。
        if (state.stepOpen) finalizeIdleStep(state)
        state.stepOpen = false
        state.idleSteps = 0
        state.stepHasTool = false
        state.stepHasText = false
        state.stepHasReasoning = false
        state.partStripState.clear()
        state.partTextEmitted.clear()
        state.stepCostLogged.clear()
        // R2-A 看門狗：turn 正常結束（idle 到達），撤哨。
        clearWatchdogTimer(state)
        // N1 規格1：心跳 timer 撤銷（turn 已結束，不再補心跳）。
        clearHeartbeatTimer(state)
        // R4-A S3①：錯誤停滯看門狗同撤（turn 已收尾，不再追錯誤後的停滯）。
        clearErrorStallTimer(state)
        // R5-C：中段停滯哨同撤（turn 已收尾）。
        clearMidturnStallTimer(state)
        // N1 規格3：in-flight 打點的清除**不在這裡**（2026-10-02 steer 誤判修復）。
        // 這一格只是「idle 到了」，還不是「回合結束了」——下面 failover／jitter 兩條
        // 重投腿會在同一輪內再送 prompt_async（語義＝同一回合的下一跳，故刻意不發
        // turn.done）。舊版先在這裡清 lastTurnActiveAt、重投腿又不補，整條重投輪的
        // steer 受理閘就一律回 409 no_active_turn（用戶看到「引導未能送達（未生效）＋
        // 当前没有进行中的回合」，正是該日回報的誤判）。清點改由 emitTurnDone 獨佔。
        // §7 prefetch（2026-09-15 PRD P0-4）：回合收尾後台預算下一回合的召回候選
        //（用戶路徑零新增延遲；query = 本回合用戶消息 + 本輪 assistant 頭部）。
        void scheduleMemoryRecallPrefetch(state)
        // 抖動重試：本輪零文本輸出 = 上游模型抖動早死（finish=unknown）。
        // 不發 turn.done（前端維持輸入中狀態），延遲後重放同一條 prompt。
        // 注意（2026-08-29 罪狀2 修復時明確保留）：這裡及下面兩處重試判定刻意
        // 只看 turnTextChars、不含 turnReasoningChars——思維鏈是「活著」的證據
        // （歸 turnHasActivity 管），但「零正文」仍是抖動死亡的唯一特徵；
        // 把 reasoning 算進來會讓「只思考不說話」的 turn 免於重投，禁止改回。
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
          // 黏性解除（2026-09-21）：本輪把釘住的渠道跑掛了＝不再押它，交回常規鏈輪轉。
          state.stickyModel = null
          emitToSession(state, "turn.status", { text: `重试中 (${attempt}/${TURN_MAX_RETRIES})` })
          const hadOutput = (state.turnTextChars ?? 0) > 0 || Boolean(state.turnToolStarted)
          const baseBody = state.lastPromptBody
          // 2026-09-13 刀1（b-ai 餘額歸零事故教訓）：確定性「賬戶死」類錯誤（credit/balance/
          // quota 耗盡）不是瞬態抖動——backoff＋整 turn 重投只會白等並繼續鞭打死賬戶。
          // 命中即：給該 provider 打 60s 降權＋零退避＋直接進鏈上下一个活 provider
          //（personaModelForAttempt 已過濾降權者，取鏈首即第一个活家）。429/過載/TLS
          // 斷線等瞬態一律不動，仍走原 backoff 鏈。
          const deadAccount = isDeadAccountError(upstreamErr)
          // 修復4：死模型與死帳戶共享「零退避立即換下一個」的待遇（deadFast），
          // 但只死帳戶參與降權標記——死模型降權整個 provider 會誤傷同家活模型
          //（見 isDeadModelError 處註釋），故死模型只跳 backoff、不 markProviderDegraded。
          const deadFast = deadAccount || isDeadModelError(upstreamErr)
          // 修復1：降權對象＝實際 dispatch 的 provider（lastDispatchedModel），
          // 缺席才回退 turn 起點模型（保守兼容）。baseBody.model 在 failover 換模後
          // 不回寫，是事故裡張冠李戴的源頭，僅作 fallback 不再當主依據。
          const degradedTarget = state.lastDispatchedModel?.providerID ?? baseBody?.model?.providerID
          if (deadAccount && degradedTarget) {
            markProviderDegraded(degradedTarget, upstreamErr.slice(0, 120))
          }
          // 2026-10-02 能力片：串流中斷/換模型時，以既有 prompt_async 文本通道注入
          // 「續寫指示」＋「孤兒 tool_use is_error 補注」。僅 hadOutput（有中斷處可續）
          // 時注入；零產出重投照原樣重放任務書。注入是 user-role message，模型可見、
          // 使用者不可見（isAssistantMessage 閘擋掉）。
          const orphanTools = hadOutput ? takeInFlightTools(state) : []
          clearInFlightTools(state)
          const retryInjection = buildFailoverInjection({ hadOutput, orphanTools })
          const retryBody: NonNullable<SessionState["lastPromptBody"]> = hadOutput
            ? // 有中斷處：注入續寫指示（＋孤兒工具補注），讓模型從斷點續跑。
              { parts: [{ type: "text", text: retryInjection }] }
            : baseBody
              ? // 零產出：重放原任務書（沒有中斷處可續，不注入）。
                { ...baseBody, parts: baseBody.parts.map((pt) => ({ ...pt })) }
              : // 零產出且無原任務書可重放：仍須送非空文本（不可送空 prompt）。
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
            // 用戶叫停：重投不發車。abort 端不碰打點，若這張 idle（＝排定本重投的那一張）
            // 走完才叫停，這裡就是唯一的收口點——不清會留下「假在途」，之後的引導全被
            // 收進隊列卻等不到投遞。
            if (cur.turnAborted) {
              cur.lastTurnActiveAt = 0
              markDirty(cur)
              return
            }
            try {
              // 刀1：死賬戶取「降權過濾後鏈首」＝下一個活 provider（attempt=1 → pool[0]，
              // 剛被打死的一家已不在 pool）；一般錯誤（含修復4死模型——不降權，鏈未變）
              // 維持原取模輪轉。
              const attemptModel = deadAccount
                ? personaModelForAttempt(cur, 1)
                : personaModelForAttempt(cur, attempt)
              retryBody.model = attemptModel
              // 修復1：重投後實際 dispatch 的模型同步記檔（降權判定用，見 failover 塊上方）。
              cur.lastDispatchedModel = { providerID: attemptModel.providerID, modelID: attemptModel.modelID }
              // 2026-10-01 去重：上一條 user（原 prompt 或上一條續寫提示）其後零產出 → 先撤再投，不疊兩條。
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
              // Phase 0 觀測：重投成功 = 同一 turn 的下一次嘗試（attempt+1）。
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
          if (state.retryQueued) break // 重試已排隊，等它接手
          state.retryQueued = true
          // 零產出重投：本次無「中斷處」可續，孤兒候選直接清（防 Map 洩漏）。
          clearInFlightTools(state)
          const gen = state.turnGen ?? 0
          const attempt = (state.turnRetries ?? 0) + 1
          emitToSession(state, "turn.status", { text: `重试中 (${attempt}/${TURN_MAX_RETRIES})` })
          const body = state.lastPromptBody
          console.log(`[gateway] turn jitter: schedule retry #${attempt} for ${state.sessionId}`)
          setTimeout(async () => {
            const cur = sessions.get(state.sessionId)
            if (!cur || (cur.turnGen ?? 0) !== gen) return
            // 用戶叫停：同 failover 腿，清打點收口（重投不發車，也不發 turn.done）。
            if (cur.turnAborted) {
              cur.lastTurnActiveAt = 0
              markDirty(cur)
              return
            }
            // 只看 turnTextChars（語義保留見上方注釋）：重投窗口內模型開口說正文才讓位
            //（那是回合仍活著的證據，打點照舊不清）。
            if ((cur.turnTextChars ?? 0) > 0) return
            try {
              // 跨渠道 failover（2026-08-29）：重投前按 attempt 從鏈
              // [persona 主模型, ...registry.bindings.fallbacks[persona]] 取模換模型，
              // 根治「主/備模同源全死」事故。registry 異常時鏈只有主模型（行為=現狀）。
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
              // 修復1：jitter 重投同樣記實際 dispatch 模型（與 failover 重投對稱）。
              cur.lastDispatchedModel = { providerID: attemptModel.providerID, modelID: attemptModel.modelID }
              // 2026-10-01 去重：零正文重投原 prompt 前撤掉上一條零產出的同一 user 訊息，歷史只留一條。
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
              // Phase 0 觀測：jitter 重投成功 = 同一 turn 的下一次嘗試（attempt+1）。
              noteTurnPromptDispatch(cur, attemptModel.providerID, attemptModel.modelID)
              // N2：重試輪開始——把舊 turn 累積的文本幀從 replayBuffer 剝掉，
              // 斷線重連不再整段重放舊文案（canvas/confirm 等狀態幀保留）。
              stripStaleTurnTextFromReplay(cur)
              // R2-A：重投輪同樣可能 turn 不啟動——重置標記並重新布哨。
              cur.turnToolStarted = false
              armWatchdogTimer(cur)
            } catch (e) {
              console.error(`[gateway] turn retry #${attempt} failed:`, e)
              cur.retryQueued = false
              emitTurnDone(cur) // 重試發不出去：放棄，別讓前端掛著
            }
          }, TURN_RETRY_DELAY_MS)
          break // 不發 turn.done：重試輪結束時自然會發
        }
        state.retryQueued = false
        // 正常收尾：in-flight 工具追蹤清空（本輪結束，無孤兒語義跨輪）。
        clearInFlightTools(state)
        // 黏性渠道（2026-09-21 暴君裁定）：本輪由重試模型接手（turnRetries>0）且產出真實正文
        // ＝該渠道實證可用，釘死本 session；personaModel() 下一輪直接用它。
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
        // R4-A S3①：抖動重試已耗盡且本輪全程零文本零工具 = 上游連續報錯/空轉，
        // 舊路徑直接靜默 turn.done（R4 實錘：APIError 後 turn 空轉 5 分鐘無一句
        // 中文解釋）——補誠實收尾話術再交棒。
        // （下方判定同樣只看 turnTextChars——語義保留理由見抖動重試處注釋。）
        if (
          (state.turnTextChars ?? 0) === 0 &&
          !state.turnToolStarted &&
          !state.turnAborted &&
          (state.turnRetries ?? 0) >= TURN_MAX_RETRIES
        ) {
          // 修復2：冪等收尾——連續第二個 idle 過同一終局門時，本輪已收過尾就直接
          // 跳過（含下方 turn.done，不重發；09-19 事故 journal 成對 warn 實錘）。
          // 旗標記「已收尾的 turnGen」，跨 turn 自然失效。
          if (state.turnExhaustedClosedGen === (state.turnGen ?? 0)) break
          state.turnExhaustedClosedGen = state.turnGen ?? 0
          // 0919 誠實歸因（video-director 試產事故）：收尾幀不得一律「上游持续报错」
          // ——真因是欠費時明說欠費（未提交/未扣費/充值前重試無效），是死模型時明說
          // 渠道缺模型。turnUpstreamError 在 failover 塊被消費後置 null，但同輪
          // 最後一次 session.error 會再記（6670 行），此時非空 = 重試鏈死因仍在。
          const lastErr = state.turnUpstreamError ?? ""
          const exhaustedText = isDeadAccountError(lastErr)
            ? `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游渠道账户欠费：未提交、未扣费、无产物，充值前重试不会成功，请联系维护方）。\n`
            : isDeadModelError(lastErr)
              ? `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游渠道缺少该模型，已尝试自动换线仍未成功）。\n`
              : `自动重试已用满 ${TURN_MAX_RETRIES} 次仍未完成回复（上游持续报错）。你上一条消息可能没有处理成功，请重新发送一次即可继续；若内容较长，建议让我分章/分段处理。\n`
          emitToSession(state, "message.delta", { text: exhaustedText })
          console.warn(`[gateway] S3① jitter retries exhausted with zero output, closing turn honestly — session=${state.sessionId} lastError=${lastErr.slice(0, 120) || "none"}`)
        }
        // R4-A S8：turn 收尾兜底匯報——本輪有節點落終態但零主動匯報時，
        // 發一幀環名制中文總結（成功清單/失敗清單/下一步），杜絕悄悄收工。
        emitTurnEndSummaryIfSilent(state)
        // R5-C：恢復輪零小結零匯報時補強制結語（S8 讓位條件見函數註釋）。
        emitRecoveryClosingIfSilent(state)
        {
          // C 方案（2026-10-02）：把「未兌現的開場計畫」記進 state，下一輪 system 注入一行事實
          //（recordUnfulfilledPlan 讀 planExperts，故必須在本行清 planExperts 之前）。
          recordUnfulfilledPlan(state)
          // 誠實告知改走耐久通道 message.delta（原 turn.status 暫態單行、緊接 turn.done 會一閃即逝）。
          emitUnfulfilledPlanNotice(state, (name, data) => emitToSession(state, name, data))
          state.planExperts = undefined
        }
        emitTurnDone(state)
        // 刀 2（2026-09-15）：機器 critic pass —— 收盤判定點。
        // 四輪實錄證明「叫 orchestrator 派 critic」無效（playbook 第 18 條四輪在場、四輪零派遣），
        // 改由 gateway 在此直接派。判據門檻與有界性全在 maybeRunMachineCriticPass 內：
        // beast + 有 Expert 交付 + 本輪零 critic 派遣 + 未聲明未經審核 + 每會話 ≤1 次。
        // 非 beast / 無 Expert 交付 / 通用子代理路徑完全不受影響（待審清單為空即零動作）。
        // 派遣非阻塞（內部 async），失敗只留一行 log，不影響 turn.done 已發的事實。
        maybeRunMachineCriticPass(state, state.criticUnreviewedDeclared === true)
        // 刀 1（2026-09-19）：Jev 測謊閘＋空殼欄初篩 — shadow 模式收盤消費點。
        // fire-and-forget（內部 2s 超時、永不 throw、失敗只留一行 log）；
        // 快照在本輪數據（brief 尾段/喚醒摘要/待審交付）後即刻清空 volatile。
        // JEV_ENABLED ≠ true 時 runJevShadowGate 零動作（行為與部署前逐位等價）。
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
        // S6 規格2：turn 正常結束，ack timer 不再需要。
        clearAckTimer(state)
        // S6 規格3：質詢回覆完成 → 放行被凍結的視頻工作流（先釋放再壓縮）。
        releasePendingVideoWorkflows(state)
        // 回合結束是滾動摘要壓縮的觸發點：此刻無在途生成、訊息數穩定。
        void maybeCompactSession(state)
        // REQ-D2（2026-09-22）：本回合排隊中的 steer（回合執行中用戶追加的指引）
        // 在此投遞——空隊列零動作（與改動前逐位等價）；turnAborted 時 planSteerFlush
        // 全數作廢（停止優先），不投遞。放在 turn.done 之後：前端先看到本回合收尾，
        // 才看到下一回合的引導語開場。fire-and-forget（投遞失敗只上報 failed 幀）。
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
