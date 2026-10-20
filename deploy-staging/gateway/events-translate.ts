import type { SessionState } from "./types-gateway.ts"
import { TURN_RETRY_DELAY_MS, IDLE_STEP_ABORT_THRESHOLD, IDLE_STEP_NUDGE } from "./constants-gateway.ts"
import { sessions, markDirty } from "./sessions-core.ts"
import { opencodeFetch, revertDeadTail } from "./opencode-client.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
import { TAIL_PAYLOAD_MARKER, ensureGatewayNonce } from "./messages-gw.ts"
// events-translate.ts —— 自 index.ts 第二阶段 Wave2 抽取：opencode 事件翻译层——eventSessionId/boundMap/boundSet/isAssistantMessage/parseToolOutput、resolveResultUrl、emitImageDone/emitVideoDone/emitAudioDone、自动制画布（canvasUnitId/readGenerateInput/autoCreateCanvasUnit/attachCanvasTask/emitCanvasResult）、toolErrorPayload、bash deny 归因（bashDenyCache）、findUploadsByBasename/resolveInvisibleUploadPaths/deniedOperationLabel、trackTurnNodeTerminal、workflowStartSchemaHint、handleToolPartUpdate、idle-step breaker（finalizeIdleStep/triggerIdleStepBreaker）。
// 原 index.ts 2708–3618 行，逐行原样搬运（仅顶层宣告加 export 前缀）。
// 2026-10-04 W：守卫家族文案（空转止损 nudge／deny 守卫等）书写体镜像已整体拆除——一律简体。
// TODO(整合 Wave2)：以下为「仍住 index.ts 且尚未 export」符号的 declare 占位（stage1 记忆「subagent 占位符法」，bun build 不查名可过）。
// 整合阶段于 index.ts 补 export 后换成真 import、删除全部 declare，即完成桥接：
// import { workflowService, emitQuestionRequest, armWatchdogTimer } from "./index.ts"
// ── P2b（2026-09-11）刀2：空转止损 ──────────────────────────────────
// step 结算：无 tool、无非空正文、无非空 reasoning = 空 step。空 step 连续累计；
// 任一活动归零。达阈值且 turn 活跃 → 中止 + 同轮补一次动作导向 nudge。
export function finalizeIdleStep(state: SessionState): void {
  // 空转补丁：本 step 只有 no-op bash 且无正文 → 视为空 step（即使有 reasoning）
  const noopOnly = !!state.stepNoopTool && !state.stepHasTool && !state.stepHasText
  const empty = noopOnly || (!state.stepHasTool && !state.stepHasText && !state.stepHasReasoning)
  state.stepNoopTool = false
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  if (!empty) {
    state.idleSteps = 0
    return
  }
  state.idleSteps = (state.idleSteps ?? 0) + 1
  if (
    state.idleSteps >= IDLE_STEP_ABORT_THRESHOLD &&
    !state.idleNudgeSent &&
    !state.turnAborted &&
    (state.lastTurnActiveAt ?? 0) > 0 &&
    state.lastPromptBody
  ) {
    triggerIdleStepBreaker(state)
  }
}

/** 撤回失败时只发尾端注入（原用户消息已在历史里），避免历史里出现第二条逐字相同的用户消息。 */
export function minimalNudgeBody(full: { parts: Array<Record<string, unknown>> }): { parts: Array<Record<string, unknown>> } {
  const texts = full.parts.filter((p) => p && p.type === "text" && typeof p.text === "string") as Array<{ type: string; text: string }>
  const last = texts.length > 0 ? texts[texts.length - 1].text : ""
  const at = last.lastIndexOf("---\n【系统注入·尾端】")
  const tail = at >= 0 ? last.slice(at) : last
  return { parts: [{ type: "text", text: tail }] }
}

export function triggerIdleStepBreaker(
  state: SessionState,
  nudgeText: string = IDLE_STEP_NUDGE,
): void {
  const body = state.lastPromptBody
  if (!body) return
  state.idleNudgeSent = true
  const gen = state.turnGen ?? 0
  // 内部 nudge 不再新增独立 part，而是接到最后一个 text part 的文本尾端、以既有
  // TAIL_PAYLOAD_MARKER 分隔：模型上下文内容不变（标记与 nudge 仍在同一 part 内、
  // 仍在模型眼前），显示读通道（slimHistoryMessages 的 stripTailInjectedPayload）
  // 会自动截掉标记之后的内容，历史端点不再把内部提示写进用户气泡。
  // 尾端块带本会话凭证 ⟦gw:<nonce>⟧，与 appendSystemPayloadToTurnTail 同形状：
  // 真注入件恒带凭证，显示读通道据此区分「真网关注入」与「用户自写的同形标记」。
  const tailBlock = `${TAIL_PAYLOAD_MARKER}⟦gw:${ensureGatewayNonce(state)}⟧ `
  const parts = body.parts.map((pt) => ({ ...pt }))
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined
  if (last && "text" in last && last.type === "text" && typeof last.text === "string") {
    last.text = `${last.text}${tailBlock}${nudgeText}`
  } else {
    parts.push({ type: "text", text: `${tailBlock}${nudgeText}` })
  }
  const nudgeBody = { ...body, parts }
  console.warn(
    `[gateway] idle-step breaker: ${IDLE_STEP_ABORT_THRESHOLD} empty steps (or reasoning-cap), abort+nudge — session=${state.sessionId} gen=${gen}`,
  )
  // ① 中止当前 turn（与用户中止同一后端路径）。
  void opencodeFetch(`/session/${state.opencodeSessionId}/abort`, {
    method: "POST",
    timeoutMs: 5000,
  }).catch(() => {})
  state.turnAborted = true
  // D2-1b（2026-09-23）：来源＝系统（内部断路器），不是用户叫停。排队中的 steer
  // 只能被「用户停止」丢弃（停止优先的权威定义见 steer-core.abortIsUserStop）——
  // 这里只是换一种方式把同一轮续跑（下面补 nudge 重投），用户的指引仍然有效。
  state.turnAbortSource = "system"
  stripStaleTurnTextFromReplay(state)
  // 中止轮的 session.idle 不得再触发抖动/failover 二次重投：retryQueued 占位。
  // 本轮的重投就是下面的 nudge；再空转保持占位 = 不循环，让它自然失败。
  state.retryQueued = true
  // ② 同一 turn 周期仅一次：原样重发最后一条用户消息，尾端附动作导向提示。
  setTimeout(async () => {
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen) return
    try {
      // 2026-10-01 去重：空 step 轮零产出 → 撤掉原 user 讯息，nudgeBody（原文＋提示）只留一条。
      // 撤回失败（该轮已有产出，原用户消息必须留在历史）→ 只发尾端最小 nudge，禁止重发原文。
      const reverted = await revertDeadTail(cur.opencodeSessionId)
      const toSend = reverted ? nudgeBody : minimalNudgeBody(nudgeBody)
      const res = await opencodeFetch(`/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(toSend),
        timeoutMs: 10000,
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      cur.turnAborted = false
      cur.turnAbortSource = undefined // 续跑同轮：中止来源随中止状态一并清（下一轮／下一次中止重设）
      cur.idleSteps = 0
      cur.stepOpen = false
      cur.stepHasTool = false
      cur.stepHasText = false
      cur.stepHasReasoning = false
      cur.turnTextChars = 0
      cur.turnToolStarted = false
      cur.lastTurnActiveAt = Date.now()
      stripStaleTurnTextFromReplay(cur)
      armWatchdogTimer(cur)
      console.log(`[gateway] idle-step breaker: nudge resend dispatched — session=${cur.sessionId}`)
    } catch (e) {
      console.error(`[gateway] idle-step breaker: nudge resend failed:`, e)
      cur.turnAborted = false
      cur.turnAbortSource = undefined
      // 2026-10-02 steer 误判修复：nudge 没发出去＝本轮真的结束了，清 in-flight 打点。
      // 必须与 turn.done 同点——idle 不再清了（见 opencode-event-handler.emitTurnDone），
      // 这里漏清会留下「假在途」：之后的引导被受理闸放行、收进队列，却再也等不到投递。
      cur.lastTurnActiveAt = 0
      markDirty(cur)
      emitToSession(cur, "turn.done", {})
    }
  }, TURN_RETRY_DELAY_MS)
}
export { eventSessionId, boundMap, boundSet, isAssistantMessage, parseToolOutput, collectToolOutputMediaUrls } from "./events-translate-core.ts"
export { resolveResultUrl, emitImageDone, registerSessionArtifact, emitVideoDone, emitAudioDone } from "./events-translate-emit.ts"
export { canvasUnitId, summarizeCanvasTitle, readGenerateInput, autoCreateCanvasUnit, attachCanvasTask, emitCanvasResult } from "./events-translate-canvas.ts"
export { bashDenyCache, parseBashDenyPatterns, loadBashDenyPatterns, denyGlobToRegExp, denyHintFor, bashDenyAttribution, classifyDenySource, bashDenyProvenance, DENY_AUDIT_PATH, appendDenyAudit, detectShadowedBashDenyRules, logShadowedBashDenyRules } from "./events-translate-deny.ts"
export { toolErrorPayload, findUploadsByBasename, ABS_PATH_RE, resolveInvisibleUploadPaths, deniedOperationLabel, trackTurnNodeTerminal, workflowStartSchemaHint, handleToolPartUpdate } from "./events-translate-tools.ts"
export type { AudioDoneMeta, DenySource, DenyProvenance, DenyAuditRecord, ShadowedRule } from "./events-translate-types.ts"
