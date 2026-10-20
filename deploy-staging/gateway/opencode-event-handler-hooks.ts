import type { OrphanToolUse } from "./error-classify.ts"
import { emitToSession } from "./sse-core.ts"
import { markDirty } from "./sessions-core.ts"
import { clearAckTimer } from "./timers-gw.ts"
import { flushOtherPartTails } from "./outbound-sanitize.ts"
import { emitRunningSubagentsStatus } from "./subagent"
import { boundMap } from "./events-translate.ts"
import type { SessionState } from "./types-gateway.ts"
// TODO(来自 events-translate.ts): eventSessionId(index.ts 2715)/handleToolPartUpdate(index.ts 3309)
//   —— W7 并行在建 events-translate.ts，建成后改真 import。

// TODO(整合 Wave2): 以下为仍住 index.ts 且尚未 export 的符号 declare 占位
// （bun build 只转译不查名，建得过；index.ts 补 export 或符号迁出后替换为真 import）。

// R9-B（2026-09-30）：其他 part 扣住的尾行（无尾换行的单行旁白）当场吐出，
// 保持「旁白 → 工具/下一段」时序；否则会被压到 session.idle 才补播（SSE 9888–9894）。
export function emitOtherPartTails(state: SessionState, exceptPid?: string): void {
  const text = flushOtherPartTails(state.partStripState, exceptPid)
  if (text) {
    emitToSession(state, "message.delta", { text }, { strippable: true })
    state.lastUserVisibleAt = Date.now()
  }
}

/**
 * 回合真正收尾的唯一出口：清 in-flight 打点，再发 turn.done。
 *
 * 2026-10-02 steer 误判修复：`lastTurnActiveAt` 是 steer 受理闸（steer-gw.turnInFlight）
 * 判「现在有没有可引导的回合」的唯一依据，语义必须是「上游真的有一个在途回合」。
 * 旧版把它挂在 session.idle 一到就清，但 idle **不等于**回合结束：下面 failover／jitter
 * 两台重试机在同一轮内会再送一次 prompt_async，且刻意**不发 turn.done**（前端维持
 * 进行中）。打点先被清、重投腿又不补 ⇒ 整条重投轮的 steer 全被回 409 no_active_turn，
 * 使用者在「进行中」的回合里追加的引导一律被判「引导未能送达（未生效）」。
 * 所以清点与 turn.done 绑死成同一个出口（三个落点全走本函数），重投腿自然跳过。
 */
export function emitTurnDone(state: SessionState): void {
  state.lastTurnActiveAt = 0
  markDirty(state)
  emitToSession(state, "turn.done", {})
  // F3（2026-10-10）：turn.done 清前端 turnStatus；若仍有在途 async 子代理，立刻回填
  // 进度行，避免 await 窗真空（复用 turn.status，禁止 message.delta 污染正文）。
  emitRunningSubagentsStatus(state.sessionId)
}

let flushPendingSubagentWakes: ((sessionId: string) => void) | null = null

export function setPendingSubagentWakeFlusher(fn: (sessionId: string) => void): void {
  flushPendingSubagentWakes = fn
}

export function flushQueuedSubagentWakes(state: SessionState): void {
  try {
    flushPendingSubagentWakes?.(state.sessionId)
  } catch (e) {
    console.error("[gateway] flush pending subagent wakes failed:", e)
  }
}

export function closeTurnAndFlushWakes(state: SessionState): void {
  emitTurnDone(state)
  clearAckTimer(state)
  flushQueuedSubagentWakes(state)
}

// ── 2026-10-02 能力片：孤儿 tool_use 追踪（设计取自 Claude Code yieldMissingToolResultBlocks
// ——换模型时替未收到结果的 tool_use 补 is_error，未复制程式码）──────────────
// 纯读观测：记录每个 session 目前 in-flight 的工具调用；工具 completed/error 即摘除。
// turn 因上游错误中断时，残留在表里的就是「孤儿」——换模型重投时注入 is_error 语义补注，
// 让接手模型知道这些工具没跑完。只写本模组私有 Map，不新增任何前端帧（使用者不可见）。
const inFlightToolsBySession = new Map<string, Map<string, OrphanToolUse>>()
const IN_FLIGHT_TOOLS_CAP = 64
export function noteToolInFlight(state: SessionState, part: any): void {
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
/** 取出并清空该 session 的孤儿候选（failover 消费一次；正常 turn 结束亦清，防泄漏）。 */
export function takeInFlightTools(state: SessionState): OrphanToolUse[] {
  const m = inFlightToolsBySession.get(state.sessionId)
  if (!m || m.size === 0) return []
  const out = [...m.values()]
  m.clear()
  return out
}
export function clearInFlightTools(state: SessionState): void {
  inFlightToolsBySession.delete(state.sessionId)
}
