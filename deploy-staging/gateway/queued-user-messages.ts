// queued-user-messages.ts —— 2026-11-13：回合在途时用户普通消息的排队（入队／出队／排空／投递缝）。
//
// 缺陷事实（真会话 2/2 复现）：同一会话连续投两条普通消息，第二条直接把 state.turnGen++
// 并再次 prompt_async；opencode 会中止正在生成的 assistant 消息，第一条消息的回覆归零
// （opencode 历史里该 assistant 消息 parts=0，用户看到空白气泡），且状态已被下一轮接管，
// 网关不会再发任何诚实提示。
//
// 本模组只做「收下并保住原始 body」＋「回合收尾排空一条」。投递一律复用既有受理链
// handleSendMessage（记忆注入／计时／闸门／压缩让位全套语义原样生效），由组合根 index.ts
// 注入投递缝（写法同 setSteerTurnDeliverer）。刻意不在这里 import messages-gw，
// 避免 hooks → queued → admission → hooks 的循环依赖。
//
// 持久化现状（如实记录，不假装做了）：队列挂在 SessionState.pendingUserMessages，
// 入队／出队都会 markDirty 交防抖落盘，但 persistence.ts 的 PERSISTED_DATA_KEYS 是显式
// 白名单，本栏位尚未列入（persistence-io.ts 不在本次改动白名单内）。因此进程重启后
// 队列会丢：已受理但未排空的消息不会重投。这是已知残余缺口。
import type { SessionState, QueuedUserMessage } from "./types-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { markDirty } from "./sessions-core.ts"

/** 队列上限（条）。超出回 429，绝不静默丢弃已受理的消息。 */
export const USER_MESSAGE_QUEUE_MAX = 8

/** 投递结果：accepted＝已受理；retryable＝失败后值不值得重试
 *  （5xx／网络不可达＝true，4xx＝false——确定性拒绝重试一百次也不会成功）。 */
export type QueuedUserMessageDelivery = { accepted: boolean; retryable: boolean }

export type QueuedUserMessageDeliverer = (state: SessionState, body: Record<string, unknown>) => Promise<QueuedUserMessageDelivery>

let deliverQueuedUserMessage: QueuedUserMessageDeliverer | null = null

export function setQueuedUserMessageDeliverer(fn: QueuedUserMessageDeliverer): void {
  deliverQueuedUserMessage = fn
}

/**
 * 正在排空的会话集合（防同一会话重入）。
 * 排空期间 handleSendMessage 若同步走到 emitTurnDone，不能再排空第二条——
 * 一次回合收尾只放行一条，其余等下一个回合收尾。
 */
const drainingSessions = new Set<string>()

/** 投递失败提示的节流（每会话最多每分钟一帧，见 requeueAfterFailedDelivery）。 */
const failureNoticeAt = new Map<string, number>()
const FAILURE_NOTICE_INTERVAL_MS = 60_000

/** 用户排队消息是否正在投递中（子代理唤醒 flush 据此让位，见 opencode-event-handler-hooks）。 */
export function isDrainingUserMessageQueue(state: SessionState): boolean {
  return drainingSessions.has(state.sessionId)
}

/** 队列读写的唯一入口（缺席＝空队列，避免每个呼叫点都 ?? []）。 */
export function userMessageQueue(state: SessionState): QueuedUserMessage[] {
  if (!Array.isArray(state.pendingUserMessages)) state.pendingUserMessages = []
  return state.pendingUserMessages
}

export function queuedUserMessageCount(state: SessionState): number {
  return userMessageQueue(state).length
}

/** 只读判定：不清写队列容器（周期性兜底每 5 秒扫全部会话，不为空会话分配阵列）。 */
export function hasQueuedUserMessages(state: SessionState): boolean {
  return Array.isArray(state.pendingUserMessages) && state.pendingUserMessages.length > 0
}

/**
 * 用户叫停（work_control=cancel）时清空排队消息，返回清掉的条数。
 * 0 条时不动任何状态；否则 markDirty。resume 不清（停止是放弃，恢复不是）。
 */
export function clearQueuedUserMessages(state: SessionState): number {
  if (!hasQueuedUserMessages(state)) return 0
  const dropped = state.pendingUserMessages?.length ?? 0
  if (state.pendingUserMessages) state.pendingUserMessages.length = 0
  markDirty(state)
  return dropped
}

/**
 * 入队一条原始 JSON body（原样保存，保住 content／attachments／canvas_state／
 * session_directive 等全部栏位，不是只存 content）。
 * 返回排队位（从 1 起）；队列已满返回 null（呼叫端回 429）。
 */
export function enqueueUserMessage(state: SessionState, body: Record<string, unknown>): number | null {
  const queue = userMessageQueue(state)
  if (queue.length >= USER_MESSAGE_QUEUE_MAX) return null
  queue.push({ body, enqueuedAt: Date.now() })
  markDirty(state)
  return queue.length
}

/**
 * 回合收尾时排空一条：取出队首原始 body，交给注入的投递缝（生产＝handleSendMessage）。
 * 队列还有下一条时不动——等下一个回合收尾再排，保持「一回合一条」。
 *
 * 调用点两个：
 *   ① emitTurnDone 清掉 lastTurnActiveAt 之后、子代理唤醒 flush 之前（主路径）；
 *   ② timers-gw 的 5 秒兜底 tick（仓库另有多处终局出口绕过 emitTurnDone，只清打点
 *      或手发 turn.done，本轮死在那里时排队消息否则会永久滞留）。
 * 这里有在途回合（lastTurnActiveAt > 0）就不排，避免与正在跑的回合抢同一 opencode 会话；
 * drainingSessions 保证两个调用点不会重入。
 */
export function drainOneQueuedUserMessage(state: SessionState): void {
  if (!deliverQueuedUserMessage) return
  if (drainingSessions.has(state.sessionId)) return
  if ((state.lastTurnActiveAt ?? 0) > 0) return
  const queue = userMessageQueue(state)
  if (queue.length === 0) return
  const next = queue.shift()
  if (!next) return
  drainingSessions.add(state.sessionId)
  markDirty(state)
  const deliver = deliverQueuedUserMessage
  const genBefore = state.turnGen ?? 0
  void deliver(state, next.body)
    .then((result) => {
      if (result.accepted) return
      if (result.retryable) requeueAfterFailedDelivery(state, next, genBefore)
      else dropRejectedQueuedMessage(state, next, genBefore)
    })
    .catch((e: unknown) => {
      // 抛异常＝网络/进程层不可达，按可重试处理（放回队首等下一轮）。
      console.error(`[gateway] queued user message delivery threw: session=${state.sessionId}:`, e)
      requeueAfterFailedDelivery(state, next, genBefore)
    })
    .finally(() => {
      drainingSessions.delete(state.sessionId)
    })
}

/**
 * 投递失败：放回队首（保持原序，不吞消息），并清掉本次尝试留下的 in-flight 打点。
 * 本次尝试进函数前 lastTurnActiveAt 必为 0（见 drain 的守卫），所以此刻仍非零只可能是
 * 受理链走到 turn 起点打完点、prompt_async 却失败（上游没接）。不清掉会让排队消息
 * 永远等不到「回合收尾」而卡死；清了也不会影响真实回合（上游确实没有在跑）。
 * 清之前确认 turnGen 恰好只推进了本次一次：若投递这期间有真实用户消息另起了回合
 * （turnGen 再次推进），那个回合在上游真的在跑，绝不能清它的在途标记。
 */
function requeueAfterFailedDelivery(state: SessionState, item: QueuedUserMessage, genBefore: number): void {
  const queue = userMessageQueue(state)
  queue.unshift(item)
  if ((state.lastTurnActiveAt ?? 0) > 0 && (state.turnGen ?? 0) === genBefore + 1) state.lastTurnActiveAt = 0
  markDirty(state)
  // 兜底 tick 每 5 秒会重试一次（上游长时间不可达时会连续失败），提示同一句话最多每分钟一次，
  // 避免刷屏；失败本身照旧逐次落日志。
  const now = Date.now()
  if (now - (failureNoticeAt.get(state.sessionId) ?? 0) >= FAILURE_NOTICE_INTERVAL_MS) {
    failureNoticeAt.set(state.sessionId, now)
    emitToSession(state, "turn.status", {
      text: `排队中的消息投递失败，已保留在第 1 位，下一个回合结束后自动重试`,
    })
  }
  console.warn(`[gateway] queued user message delivery failed, requeued at head: session=${state.sessionId}`)
}

/**
 * 确定性拒绝（4xx：注入闸拦截、会话已不存在等）：重试不会改变结果，不再放回队首，
 * 也不静默吞掉——发一帧如实说明，用户知道需要重新发送。
 * 5xx／网络失败仍走 requeueAfterFailedDelivery（兜底 tick 会继续重试）。
 */
function dropRejectedQueuedMessage(state: SessionState, item: QueuedUserMessage, genBefore: number): void {
  // 与失败重放同款：只有本次尝试确实推进过一次 turnGen、且没被别的回合接管时才清打点。
  if ((state.lastTurnActiveAt ?? 0) > 0 && (state.turnGen ?? 0) === genBefore + 1) state.lastTurnActiveAt = 0
  markDirty(state)
  emitToSession(state, "turn.status", {
    text: `排队中的消息未能投递（请求被拒绝），已从队列移除，需要时请重新发送`,
  })
  console.warn(
    `[gateway] queued user message rejected (non-retryable), dropped: session=${state.sessionId} chars=${JSON.stringify(item.body).length}`,
  )
}
