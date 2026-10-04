// emit-helpers.ts —— 自 index.ts 第二阶段 Wave3 抽取：错误讯息解读与汇报 emit（opencodeErrorMessage/opencodeErrorCode/emitSessionError/emitAgentNotice/reportNodeTerminalState），原 index.ts 5671–5818 行，逐行机械搬运。
import type { SessionState } from "./types-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { humanizeSupplierError } from "./humanize-gw.ts"
import { TURN_MAX_RETRIES } from "./constants-gateway.ts"
import { boundSet } from "./events-translate.ts"
import { workflowBilling } from "./workflow-gw.ts"
import { armErrorStallTimer } from "./timers-gw.ts"
// 2026-10-04 W：上游错误人话一律简体（书写体镜像已拆）。
// TODO(整合 Wave3): timers 同波 W13 在建 timers-gw.ts（armAckTimer/armHeartbeatTimer/... ），落地后换成真 import（bun build 硬查 named import）。
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
  // 2026-09-02：用户中止（MessageAbortedError / Tool execution aborted）不是错误——
  // 此前每个被杀工具都弹一条红色「已按你的要求中止本轮」notice（一次中止 3-4 连弹），
  // MessageAbortedError 还会误布错误停滞哨（中止后又弹「上游刚才报错了」）。
  // 中止的 UI 收尾由 turn.done 表达；这里只留日志，不发帧、不记上游错、不布哨。
  if (code === "MessageAbortedError" || /abort/i.test(message)) return
  // 2026-08-31：上游模型错误（TLS 断链/输出审核 400/欠费 403 等）记入 flag，
  // idle 收尾走 failover 换模重投；tool_error 是工具拒绝、Aborted 是用户打断，
  // 都不是渠道问题，不记。
  // 0919 语义补充：failover 消费该 flag 后置 null，但重试轮再犯时这里会再记——
  // 重试耗尽的诚实收尾（isDeadAccountError 分流）依赖「最后一次」的留存。
  if (code !== "tool_error" && code !== "MessageAbortedError") state.turnUpstreamError = message
  // S5a：供应商/上游错误人话化——原文 message 保留，映射命中时加 human_message。
  const human = humanizeSupplierError(message)
    // 2026-08-27 代理池轮换：LLM 上游的 RegionError/FreeUsageLimit 是瞬态错误
  // （轮换 IP 命中被地区屏蔽/限流的节点），下一次请求大概率换节点就好了。
  // 归零 turnTextChars 让 session.idle 的抖动重试路径自动重发 prompt。
  if (/not available in your country|RegionError|FreeUsageLimit|Rate limit exceeded/i.test(message)) {
    if ((state.turnTextChars ?? 0) === 0 && state.lastPromptBody && (state.turnRetries ?? 0) < TURN_MAX_RETRIES) {
      state.turnTextChars = 0 // 保持零文本，抖动重试会接手
    }
  }
  // 修复3a（2026-09-19）：per-turn 同文去重——一个 turn 的 failover 链每跳一次
  // 就有一条 session.error，同文（humanize 后的 human_message，无则 message）
  // 重复直发曾让用户一轮收 5-6 条红帧（事故实锤）。本 turn 已发过同文 → 只记
  // log 不发帧；turnUpstreamError 已在上面照常记（failover 逻辑依赖它，不受影响）。
  // 去重仅作用帧发送；abort 路径在函数开头已早退，此处天然不触及。
  const dedupKey = human || message
  const emitted = state.turnEmittedErrors ?? []
  // 重试预算内＝failover 必然在 idle 接手（条件与 opencode-event-handler failover 块同构：
  // 非 tool_error、未中止、重试次数未用满）→ 丑错帧不下发，改由重试排队处播「重试中 (x/N)」进度行。
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
  // R4-A S3①：上游/LLM 错误（非工具拒绝）后布停滞哨——R4 实锤 APIError 后
  // turn 空转 5 分钟零告警。tool_error 是工具被拒，turn 照常走，不布哨。
  if (code !== "tool_error") armErrorStallTimer(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// S6（2026-08-27）：异步心跳汇报制——「承诺逐条汇报」的兑现层。
// 三件事全在 gateway 做（agent 模型靠不住，闸门自己开口）：
//   1) 节点终态 60s 内主动汇报（成功含花费；失败含中文短句与退款事实）
//   2) 用户消息 30s 无回应先发短 ack
//   3) 质询类消息未答覆期间冻结视频类工作流自动开跑（agent 回覆完才放行）
// 汇报帧走 message 通道：事件名 message.delta + turn.done，前端现有
// reducer 直接渲染成 agent 消息——零前端改动的最小破坏实现。

/** S6 汇报专用：以 agent 口吻经 message 通道发一条完整短讯（delta + turn.done）。 */
export function emitAgentNotice(state: SessionState, text: string): void {
  if (!text) return
  // R4-A S8：本轮已有主动汇报 → turn 收尾兜底汇报让位。
  state.turnNoticeSent = true
  emitToSession(state, "message.delta", { text })
  emitToSession(state, "turn.done", {})
}

/**
 * 规格1：节点终态汇报。workflow-service 每个节点落终态后都会 emit
 * canvas.node.updated（success/error）；在 index.ts 端挂钩子（不动
 * workflow-service 的 emit 契约）：终态帧 → 节点元资讯 + 资金事实 → 60s
 * 立即汇报（实测为同步紧跟，远小于 60s 预算）。资金事实来源：
 *   - 花费：终态帧自带 cost_coins（成功路径上游 poll 结果）
 *   - 退款：工作流视频失败路径无退款凭证可查——诚实说「退款状态查不到，
 *     已产生的扣款以平台帐单为准」，绝不口头宣称已退（I 罪状反义词）。
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
  // 去重：同一节点同一终态只汇报一次（rerun 会先置 running 清键，可再触发）。
  if (!state.nodeTerminalReported) state.nodeTerminalReported = new Set()
  const key = `${nodeId}:${status}`
  if (state.nodeTerminalReported.has(key)) return
  state.nodeTerminalReported.add(key)
  boundSet(state.nodeTerminalReported, 400)

  // 节点显示名：标题不可得时用 node_id 尾段（role-序号）。
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
  // 失败：中文短句优先（S5a human_message），否则错误原文；资金话术只引用
  // billing 真值（修 2）——实测实录节点失败后 confirm approved 25.001/75.001 币
  // 零 refund，旧文案「本次失败未产生成功扣款」无帐本依据（欺君）。有批准额
  // 且已退款留痕 → 如实讲退款；无批准额 → 如实讲未走批量扣费。
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
