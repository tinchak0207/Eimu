// 从 outbound-sanitize.ts 拆出（2026-09-21）：emitSanitizedDelta 出口——依赖
// sse-core/metrics-gw/events-translate（间接链到 persistence 的 bun:sqlite），
// 与纯剥离逻辑分家后，纯逻辑档可在 node:test 直跑。行为零变化（逐字搬迁）。
// 桥接依赖说明（仍住 index.ts 的符号）：
//  - emitToSession：index.ts 已 export，真 import。
//  - markTurnFirst / boundMap：index.ts 尚未 export（2026-09-19 实锤 bun build 报
//    No matching export），以 declare 占位（第一阶段 pricing-gateway 同法，bun build
//    只转译不查名，建得过）；index.ts 补 export 后替换为正式 import。
import type { SessionState } from "./types-gateway.ts"
import { PART_TEXT_TRACK_CAP } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { boundMap } from "./events-translate.ts"
import { stripOutboundFeed, type PartStripState } from "./outbound-sanitize.ts"

// TODO(index.ts 接线): markTurnFirst(index.ts ≈4441)/boundMap(index.ts ≈2720) 补 export 后改真 import

/** 统一出口：经剥离器后发 message.delta（无安全文本时静默）。 */
export function emitSanitizedDelta(state: SessionState, partId: string | undefined, chunk: string): void {
  // Phase 0 观测：模型正文 delta 抵达 = t_first_text（本轮只记第一次；此函数是
  // 两条正文路径（delta / part.updated 补发后缀）的唯一交汇点）。
  markTurnFirst(state, "text")
  const pid = typeof partId === "string" && partId ? partId : "_turn"
  let st = state.partStripState.get(pid)
  if (!st) {
    st = { pending: "", suppress: false, fence: false, sawEnglish: false }
    state.partStripState.set(pid, st)
    boundMap(state.partStripState, PART_TEXT_TRACK_CAP)
  }
  const safe = stripOutboundFeed(st, chunk)
  // S1：英文正文被压制时，以一帧中文提示替代（每 turn 一次，不刷屏）。出口一律简体。
  if (st.sawEnglish && !state.englishNoticeSent) {
    state.englishNoticeSent = true
    emitToSession(state, "turn.status", {
      text: "已自动略去一段英文内部思考，中文回复不受影响",
    })
  }
  if (safe) {
    emitToSession(state, "message.delta", { text: safe }, { strippable: true })
    // R8-B 工单 #5：模型正文到达 = 用户可见输出刷新（静默通知判定依据）。
    state.lastUserVisibleAt = Date.now()
  }
}
