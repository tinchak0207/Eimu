// 從 outbound-sanitize.ts 拆出（2026-09-21）：emitSanitizedDelta 出口——依賴
// sse-core/metrics-gw/events-translate（間接鏈到 persistence 的 bun:sqlite），
// 與純剝離邏輯分家後，純邏輯檔可在 node:test 直跑。行為零變化（逐字搬遷）。
// 橋接依賴說明（仍住 index.ts 的符號）：
//  - emitToSession：index.ts 已 export，真 import。
//  - markTurnFirst / boundMap：index.ts 尚未 export（2026-09-19 實錘 bun build 報
//    No matching export），以 declare 佔位（第一階段 pricing-gateway 同法，bun build
//    只轉譯不查名，建得過）；index.ts 補 export 後替換為正式 import。
import type { SessionState } from "./types-gateway.ts"
import { PART_TEXT_TRACK_CAP } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { markTurnFirst } from "./metrics-gw.ts"
import { boundMap } from "./events-translate.ts"
import { stripOutboundFeed, shouldT2sForUserScript, sessionUserScript, type PartStripState } from "./outbound-sanitize.ts"

// R9-B（2026-09-30）：會話用戶書寫體（黏性）改由 outbound-sanitize.ts 提供
// （2026-10-04 T2：移出以便守衛文案共用同一黏性判準）。此處只剩 TODO 註記。
// TODO(index.ts 接線): markTurnFirst(index.ts ≈4441)/boundMap(index.ts ≈2720) 補 export 後改真 import

/** 統一出口：經剝離器後發 message.delta（無安全文本時靜默）。 */
export function emitSanitizedDelta(state: SessionState, partId: string | undefined, chunk: string): void {
  // Phase 0 觀測：模型正文 delta 抵達 = t_first_text（本輪只記第一次；此函數是
  // 兩條正文路徑（delta / part.updated 補發後綴）的唯一交匯點）。
  markTurnFirst(state, "text")
  const pid = typeof partId === "string" && partId ? partId : "_turn"
  let st = state.partStripState.get(pid)
  if (!st) {
    // R9-B：繁體用戶會話的 part 不做 R5-C 繁→簡（簡體/未判定照舊）。
    st = { pending: "", suppress: false, fence: false, sawEnglish: false, t2s: shouldT2sForUserScript(sessionUserScript(state)) }
    state.partStripState.set(pid, st)
    boundMap(state.partStripState, PART_TEXT_TRACK_CAP)
  }
  const safe = stripOutboundFeed(st, chunk)
  // S1：英文正文被壓制時，以一幀中文提示替代（每 turn 一次，不刷屏）。
  // 2026-10-04 T2 語言鏡像：提示文案依會話黏性書寫體出對應版本（複用 sessionUserScript）。
  if (st.sawEnglish && !state.englishNoticeSent) {
    state.englishNoticeSent = true
    emitToSession(state, "turn.status", {
      text:
        sessionUserScript(state) === "hant"
          ? "已自動略去一段英文內部思考，中文回覆不受影響"
          : "已自动略去一段英文内部思考，中文回复不受影响",
    })
  }
  if (safe) {
    emitToSession(state, "message.delta", { text: safe }, { strippable: true })
    // R8-B 工單 #5：模型正文到達 = 用戶可見輸出刷新（靜默通知判定依據）。
    state.lastUserVisibleAt = Date.now()
  }
}
