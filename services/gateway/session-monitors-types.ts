import { resolveSession } from "./sessions-core.ts"
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000
export const MONITOR_MIN_TIMEOUT_MS = 1_000
export const MONITOR_MAX_EVENTS_PER_SECOND = 20
export const MONITOR_LAST_LINES = 50
export const MONITOR_MAX_PER_SESSION = 4
export const MONITOR_MAX_ACTIVE = 32
export const MONITOR_LINE_MAX_CHARS = 2_000
/** P2：无换行输出（如 tail 跟随的二进制流）缓冲上限；超出保留尾部。 */
export const MONITOR_BUFFER_MAX_CHARS = 64 * 1024
export const MONITOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const MONITOR_RETENTION_PER_SESSION = 200
export const MONITOR_PRUNE_EVERY_TICKS = 60
export const MONITOR_KILL_GRACE_MS = 2_000

export type SessionStateLike = NonNullable<ReturnType<typeof resolveSession>>

export interface MonitorInput {
  description: string
  timeout_ms?: number
  command?: string
  ws?: string
}

export interface SessionMonitorRow {
  id: number
  session_id: string
  description: string
  command: string | null
  ws_url: string | null
  timeout_ms: number
  status: string
  event_count: number
  dropped_count: number
  started_at: number
  ended_at: number | null
  last_lines: string
  /** owner gateway 的 pid（用于判定另一个 gateway 进程仍持有该监视）。 */
  pid: number | null
  /** 采集子进程 pid（ws 监视为空）。 */
  child_pid: number | null
  /** 采集子进程组 id（detached spawn → 等于 child_pid）。 */
  child_pgid: number | null
  truncated_count: number
}

export interface MonitorView extends Omit<SessionMonitorRow, "last_lines"> {
  last_lines: string[]
}

export class MonitorPolicyError extends Error {
  constructor(message = "command refused by monitor policy", readonly code = "command_refused") {
    super(message)
    this.name = "MonitorPolicyError"
  }
}

/**
 * M7：timeout_ms 只有缺省时才回默认；显式传入非有限数一律拒绝（由 HTTP 层转 400），
 * 不静默吞成默认值。
 */
export function normalizeMonitorTimeout(ms: unknown): number {
  if (ms === undefined || ms === null) return MONITOR_DEFAULT_TIMEOUT_MS
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new Error("timeout_ms must be a finite number")
  }
  return Math.max(MONITOR_MIN_TIMEOUT_MS, Math.min(MONITOR_MAX_TIMEOUT_MS, Math.floor(ms)))
}
