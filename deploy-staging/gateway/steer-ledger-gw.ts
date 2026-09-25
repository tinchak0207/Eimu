// steer-ledger-gw.ts —— REQ-D2b steer 命令身份層的網關接線（生產側唯一實例）。
//
// 職責只有兩件（純語義在 steer-identity.ts，SQLite 存取在 persistence.ts）：
//   1. 把 persistence.ts 的 SteerLedgerStore 縫接成**進程級唯一**的 ledger 實例——
//      steer 身份只有一條持久化通道（sessions.db 的 steer_commands 表），
//      第二個實例就等於第二份真相。
//   2. 重啟恢復（recoverSteerCommandsOnRevive）：會話從 DB 恢復時，把所有未終結命令
//      落 uncertain（**永不自動重發**），並回傳要上報的誠實狀態幀給呼叫端 emit。
//
// 為什麼 emit 不寫在本檔：本檔被 sessions-core.ts import（恢復點在 hydrate），
// 而 sse-core.ts 又 import sessions-core（markDirty）——若本檔再 import sse-core，
// 就多出一條 sessions-core → 本檔 → sse-core → sessions-core 的新環。
// 所以本檔只回傳「要發什麼幀」，emit 由呼叫端（sessions-core 已持有 emitToSession）做。
import { steerCommandStore } from "./persistence.ts"
import { createSteerLedger, steerWireStatus, type SteerCommand, type SteerLedger } from "./steer-identity.ts"
import type { SessionState } from "./types-gateway.ts"

/** 進程級唯一 ledger（生產側）。測試要換替身就自己 createSteerLedger(fakeStore)。 */
export const steerLedger: SteerLedger = createSteerLedger(steerCommandStore)

/** 一條命令要上報的狀態幀（id + data），供呼叫端 emitToSession(state, "steer.status", data)。 */
export interface SteerStatusFrame {
  steerId: string
  data: Record<string, unknown>
}

/** 命令 → 上屏狀態幀（本體與別名 id 都發：別名徽章同樣需要終態，否則永停排隊中）。 */
export function steerCommandFrames(command: SteerCommand, reason?: string): SteerStatusFrame[] {
  const wire = steerWireStatus(command.state)
  const effectiveReason = reason ?? command.reason
  const ids = [command.steerId, ...command.aliasIds]
  return ids.map((steerId) => ({
    steerId,
    data: {
      steer_id: steerId,
      status: wire,
      ...(typeof effectiveReason === "string" ? { reason: effectiveReason } : {}),
    },
  }))
}

/**
 * 重啟恢復（hydrate 時呼叫一次；冪等——恢復後全部記錄已終態，第二次是零動作）。
 *
 * 為什麼把「未終結」一律落 uncertain 而不是 failed 或重新投遞：
 *   * 重新投遞＝把同一條指引送第二次（pending/uncertain 永不自動重發，這正是本刀要禁的）；
 *   * failed＝「確知沒送到」是假話——投遞可能已經到了上游、只是網關沒等到確認；
 *   * uncertain＝唯一誠實的答案：不知道，且不再送。UI 顯示「未確認·未重送」。
 * 回傳要上報的幀（呼叫端 emit；空陣列＝零動作，無 steer 的會話與改動前逐位等價）。
 */
export function recoverSteerCommandsOnRevive(state: SessionState): SteerStatusFrame[] {
  const flipped = steerLedger.recoverSession(state.sessionId, Date.now())
  if (flipped.length === 0) return []
  console.log(
    `[gateway] steer ledger recovery: ${flipped.length} unconfirmed command(s) → uncertain session=${state.sessionId} (never auto-resent)`,
  )
  return flipped.flatMap((cmd) => steerCommandFrames(cmd))
}
