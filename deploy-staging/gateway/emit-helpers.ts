// emit-helpers.ts —— 自 index.ts 第二階段 Wave3 抽取：錯誤訊息解讀與匯報 emit（opencodeErrorMessage/opencodeErrorCode/emitSessionError/emitAgentNotice/reportNodeTerminalState），原 index.ts 5671–5818 行，逐行機械搬運。
import type { SessionState } from "./types-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { humanizeSupplierError } from "./humanize-gw.ts"
import { TURN_MAX_RETRIES } from "./constants-gateway.ts"
import { boundSet } from "./events-translate.ts"
import { workflowBilling } from "./workflow-gw.ts"
import { armErrorStallTimer } from "./timers-gw.ts"
// 2026-10-04 T2：上游錯誤人話依會話黏性書寫體出對應版本。
import { sessionUserScript } from "./outbound-sanitize.ts"
// TODO(整合 Wave3): timers 同波 W13 在建 timers-gw.ts（armAckTimer/armHeartbeatTimer/... ），落地後換成真 import（bun build 硬查 named import）。
/**
 * opencode errors are shaped { name, data: { message } } -- NOT { code, message }.
 * Reading .message straight off the object yields undefined, which is how every
 * real failure ("Invalid API Key", a whisper audio model driven as chat) reached
 * the browser as the useless literal "session error".
 * Order matters: data.message is the human reason, name is the class.
 */
export function opencodeErrorMessage(err: unknown): string {
  if (typeof err === "string" && err.length > 0) return err
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; name?: unknown; data?: { message?: unknown } }
    const nested = e.data?.message
    if (typeof nested === "string" && nested.length > 0) return nested
    if (typeof e.message === "string" && e.message.length > 0) return e.message
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "session error"
}

export function opencodeErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; name?: unknown }
    if (typeof e.code === "string" && e.code.length > 0) return e.code
    if (typeof e.name === "string" && e.name.length > 0) return e.name
  }
  return "backend_error"
}

export function emitSessionError(state: SessionState, code: string, message: string): void {
  // Always log: a session.error that only exists in the browser costs a VPS dig
  // to diagnose. Codes/messages here are model-provider text, never credentials.
  console.error(`[gateway] session.error code=${code} message=${message}`)
  // 2026-09-02：用戶中止（MessageAbortedError / Tool execution aborted）不是錯誤——
  // 此前每個被殺工具都彈一條紅色「已按你的要求中止本轮」notice（一次中止 3-4 連彈），
  // MessageAbortedError 還會誤布錯誤停滯哨（中止後又彈「上游刚才报错了」）。
  // 中止的 UI 收尾由 turn.done 表達；這裡只留日誌，不發幀、不記上游錯、不布哨。
  if (code === "MessageAbortedError" || /abort/i.test(message)) return
  // 2026-08-31：上游模型错误（TLS 断链/输出审核 400/欠费 403 等）记入 flag，
  // idle 收尾走 failover 换模重投；tool_error 是工具拒绝、Aborted 是用户打断，
  // 都不是渠道问题，不记。
  // 0919 語義補充：failover 消費該 flag 後置 null，但重試輪再犯時這裡會再記——
  // 重試耗盡的誠實收尾（isDeadAccountError 分流）依賴「最後一次」的留存。
  if (code !== "tool_error" && code !== "MessageAbortedError") state.turnUpstreamError = message
  // S5a：供應商/上游錯誤人話化——原文 message 保留，映射命中時加 human_message。
  const human = humanizeSupplierError(message, sessionUserScript(state))
    // 2026-08-27 代理池轮换：LLM 上游的 RegionError/FreeUsageLimit 是瞬态错误
  // （轮换 IP 命中被地区屏蔽/限流的节点），下一次请求大概率换节点就好了。
  // 归零 turnTextChars 让 session.idle 的抖动重试路径自动重发 prompt。
  if (/not available in your country|RegionError|FreeUsageLimit|Rate limit exceeded/i.test(message)) {
    if ((state.turnTextChars ?? 0) === 0 && state.lastPromptBody && (state.turnRetries ?? 0) < TURN_MAX_RETRIES) {
      state.turnTextChars = 0 // 保持零文本，抖动重试会接手
    }
  }
  // 修復3a（2026-09-19）：per-turn 同文去重——一個 turn 的 failover 鏈每跳一次
  // 就有一條 session.error，同文（humanize 後的 human_message，無則 message）
  // 重複直發曾讓用戶一輪收 5-6 條紅幀（事故實錘）。本 turn 已發過同文 → 只記
  // log 不發幀；turnUpstreamError 已在上面照常記（failover 邏輯依賴它，不受影響）。
  // 去重僅作用幀發送；abort 路徑在函數開頭已早退，此處天然不觸及。
  const dedupKey = human || message
  const emitted = state.turnEmittedErrors ?? []
  // 重試預算內＝failover 必然在 idle 接手（條件與 opencode-event-handler failover 塊同構：
  // 非 tool_error、未中止、重試次數未用滿）→ 醜錯幀不下發，改由重試排隊處播「重试中 (x/N)」進度行。
  const willRetry =
    code !== "tool_error" && !state.turnAborted && (state.turnRetries ?? 0) < TURN_MAX_RETRIES
  if (emitted.includes(dedupKey)) {
    console.error(`[gateway] session.error [coalesced] duplicate this turn, frame suppressed code=${code}`)
  } else if (willRetry) {
    console.error("[gateway] session.error [retrying] frame held back")
  } else {
    state.turnEmittedErrors = [...emitted, dedupKey].slice(-32)
    emitToSession(state, "session.error", { code, message, ...(human ? { human_message: human } : {}) })
  }
  // R4-A S3①：上游/LLM 錯誤（非工具拒絕）後布停滯哨——R4 實錘 APIError 後
  // turn 空轉 5 分鐘零告警。tool_error 是工具被拒，turn 照常走，不布哨。
  if (code !== "tool_error") armErrorStallTimer(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// S6（2026-08-27）：異步心跳匯報制——「承諾逐條匯報」的兌現層。
// 三件事全在 gateway 做（agent 模型靠不住，閘門自己開口）：
//   1) 節點終態 60s 內主動匯報（成功含花費；失敗含中文短句與退款事實）
//   2) 用戶消息 30s 無回應先發短 ack
//   3) 質詢類消息未答覆期間凍結視頻類工作流自動開跑（agent 回覆完才放行）
// 匯報幀走 message 通道：事件名 message.delta + turn.done，前端現有
// reducer 直接渲染成 agent 消息——零前端改動的最小破壞實現。

/** S6 匯報專用：以 agent 口吻經 message 通道發一條完整短訊（delta + turn.done）。 */
export function emitAgentNotice(state: SessionState, text: string): void {
  if (!text) return
  // R4-A S8：本輪已有主動匯報 → turn 收尾兜底匯報讓位。
  state.turnNoticeSent = true
  emitToSession(state, "message.delta", { text })
  emitToSession(state, "turn.done", {})
}

/**
 * 規格1：節點終態匯報。workflow-service 每個節點落終態後都會 emit
 * canvas.node.updated（success/error）；在 index.ts 端掛鉤子（不動
 * workflow-service 的 emit 契約）：終態幀 → 節點元資訊 + 資金事實 → 60s
 * 立即匯報（實測為同步緊跟，遠小於 60s 預算）。資金事實來源：
 *   - 花費：終態幀自帶 cost_coins（成功路徑上游 poll 結果）
 *   - 退款：工作流視頻失敗路徑無退款憑證可查——誠實說「退款狀態查不到，
 *     已產生的扣款以平台帳單為準」，絕不口頭宣稱已退（I 罪狀反義詞）。
 */
export function reportNodeTerminalState(
  state: SessionState,
  payload: {
    unit_id?: string
    node_id?: string
    patch?: { status?: string; cost_coins?: number; errorDetails?: string; human_message?: string }
    cost_coins?: number
  },
): void {
  const nodeId = typeof payload.node_id === "string" ? payload.node_id : ""
  const status = payload.patch?.status
  if (!nodeId || (status !== "success" && status !== "error")) return
  // 去重：同一節點同一終態只匯報一次（rerun 會先置 running 清鍵，可再觸發）。
  if (!state.nodeTerminalReported) state.nodeTerminalReported = new Set()
  const key = `${nodeId}:${status}`
  if (state.nodeTerminalReported.has(key)) return
  state.nodeTerminalReported.add(key)
  boundSet(state.nodeTerminalReported, 400)

  // 節點顯示名：標題不可得時用 node_id 尾段（role-序號）。
  const shortId = nodeId.includes("-") ? nodeId.slice(nodeId.lastIndexOf("-") + 1) : nodeId
  const kindLabel = nodeId.includes("video") ? "视频节点" : nodeId.includes("image") ? "图片节点" : "节点"
  const label = `${kindLabel} ${shortId}`
  const cost = typeof payload.patch?.cost_coins === "number"
    ? payload.patch.cost_coins
    : typeof payload.cost_coins === "number"
      ? payload.cost_coins
      : undefined

  if (status === "success") {
    const costText = typeof cost === "number" ? `，花费 ${cost} 币` : "（费用以平台账单为准）"
    emitAgentNotice(state, `【进度汇报】${label} 已完成${costText}。结果已同步到画布，可随时查看。`)
    return
  }
  // 失敗：中文短句優先（S5a human_message），否則錯誤原文；資金話術只引用
  // billing 真值（修 2）——實測實錄節點失敗後 confirm approved 25.001/75.001 幣
  // 零 refund，舊文案「本次失败未产生成功扣款」無帳本依據（欺君）。有批准額
  // 且已退款留痕 → 如實講退款；無批准額 → 如實講未走批量扣費。
  const reason = payload.patch?.human_message || payload.patch?.errorDetails || "未知原因"
  const wfBilling = payload.unit_id ? workflowBilling.get(payload.unit_id) : undefined
  const moneyText = wfBilling
    ? wfBilling.refunded_coins > 0
      ? `本次工作流已批准扣费 ${wfBilling.confirmed_coins} 币，失败部分已全额退回 ${wfBilling.refunded_coins} 币（账本已留痕，余额已刷新）。`
      : `本次工作流已批准扣费 ${wfBilling.confirmed_coins} 币，失败部分的退款以平台账单为准。`
    : "本节点所在工作流未走批量扣费确认，失败未产生新增扣费。"
  emitAgentNotice(
    state,
    `【进度汇报】${label} 失败：${reason}。${moneyText}可在画布上重试该节点。`,
  )
}
