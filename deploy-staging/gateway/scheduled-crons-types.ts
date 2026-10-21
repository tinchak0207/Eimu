export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

export interface FieldSpec {
  min: number
  max: number
}

export interface CronJitterConfig {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
  cacheLeadMs: number
}

export interface CronScheduleInput {
  id: string | number
  cron: string
  recurring: boolean
  createdAt: number
  lastFiredAt?: number | null
}

export interface DurableScheduledTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
  permanent?: boolean
  createdBySessionId?: string
  createdByPid?: number
  createdInProject?: string
}

export interface ScheduledTaskLock {
  sessionId: string
  pid: number
  acquiredAt: number
}

export interface CronRow {
  id: number
  session_id: string
  cron: string
  prompt: string
  recurring: number
  durable: number
  permanent: number
  last_fired_at: number | null
  next_fire_at: number | null
  created_at: number
  status: string
  pid: number | null
  /** P2：跨进程投递认领标记（1=已有进程在投递）。 */
  firing: number | null
  firing_at: number | null
}

export interface CronFireTask {
  id: number
  sessionId: string
  cron: string
  prompt: string
  recurring: boolean
  durable: boolean
  permanent: boolean
  lastFiredAt: number | null
  nextFireAt: number | null
  createdAt: number
}

export interface CreateCronInput {
  sessionId: string
  cron: string
  prompt: string
  recurring?: boolean
  durable?: boolean
  permanent?: boolean
  stateDir?: string
}

export interface CreateCronResult extends CronFireTask {
  nextFireAtMs: number | null
}

export interface CronTickerOptions {
  /** 只有该会话空闲时才 fire；缺省视为空闲。 */
  isIdle?: (sessionId: string) => boolean
  fire: (task: CronFireTask) => void | Promise<void>
  intervalMs?: number
  stateDir?: string
  onError?: (error: unknown) => void
}

export interface CronTickerHandle {
  stop: () => void
  tick: () => Promise<CronFireTask[]>
}
