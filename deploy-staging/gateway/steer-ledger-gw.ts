// steer-ledger-gw.ts —— REQ-D2b steer 命令身份层的网关接线（生产侧唯一实例）。
//
// 职责只有两件（纯语义在 steer-identity.ts，SQLite 存取在 persistence.ts）：
//   1. 把 persistence.ts 的 SteerLedgerStore 缝接成**进程级唯一**的 ledger 实例——
//      steer 身份只有一条持久化通道（sessions.db 的 steer_commands 表），
//      第二个实例就等于第二份真相。
//   2. 重启恢复（recoverSteerCommandsOnRevive）：会话从 DB 恢复时，把所有未终结命令
//      落 uncertain（**永不自动重发**），并回传要上报的诚实状态帧给呼叫端 emit。
//
// 为什么 emit 不写在本档：本档被 sessions-core.ts import（恢复点在 hydrate），
// 而 sse-core.ts 又 import sessions-core（markDirty）——若本档再 import sse-core，
// 就多出一条 sessions-core → 本档 → sse-core → sessions-core 的新环。
// 所以本档只回传「要发什么帧」，emit 由呼叫端（sessions-core 已持有 emitToSession）做。
import { steerCommandStore } from "./persistence.ts"
import { createSteerLedger, steerWireStatus, type SteerCommand, type SteerLedger } from "./steer-identity.ts"
import type { SessionState } from "./types-gateway.ts"

/** 进程级唯一 ledger（生产侧）。测试要换替身就自己 createSteerLedger(fakeStore)。 */
export const steerLedger: SteerLedger = createSteerLedger(steerCommandStore)

/** 一条命令要上报的状态帧（id + data），供呼叫端 emitToSession(state, "steer.status", data)。 */
export interface SteerStatusFrame {
  steerId: string
  data: Record<string, unknown>
}

/** 命令 → 上屏状态帧（本体与别名 id 都发：别名徽章同样需要终态，否则永停排队中）。 */
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
 * 重启恢复（hydrate 时呼叫一次；幂等——恢复后全部记录已终态，第二次是零动作）。
 *
 * 为什么把「未终结」一律落 uncertain 而不是 failed 或重新投递：
 *   * 重新投递＝把同一条指引送第二次（pending/uncertain 永不自动重发，这正是本刀要禁的）；
 *   * failed＝「确知没送到」是假话——投递可能已经到了上游、只是网关没等到确认；
 *   * uncertain＝唯一诚实的答案：不知道，且不再送。UI 显示「未确认·未重送」。
 * 回传要上报的帧（呼叫端 emit；空阵列＝零动作，无 steer 的会话与改动前逐位等价）。
 */
export function recoverSteerCommandsOnRevive(state: SessionState): SteerStatusFrame[] {
  const flipped = steerLedger.recoverSession(state.sessionId, Date.now())
  if (flipped.length === 0) return []
  console.log(
    `[gateway] steer ledger recovery: ${flipped.length} unconfirmed command(s) → uncertain session=${state.sessionId} (never auto-resent)`,
  )
  return flipped.flatMap((cmd) => steerCommandFrames(cmd))
}
