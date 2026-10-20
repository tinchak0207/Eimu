import type { CronFields, CronJitterConfig, CronScheduleInput, FieldSpec } from "./scheduled-crons-types"

// ── 5 字段解析 ──────────────────────────────────────────────────────────────

const FIELD_SPECS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
]

/** 单字段解析：*、* /n、a-b、a-b/n、逗号列表；DoW 7 归一为 0。非法回 null。 */
export function parseCronField(expression: string, spec: FieldSpec): number[] | null {
  const values = new Set<number>()
  for (const part of expression.split(",")) {
    const star = part.match(/^\*(?:\/(\d+))?$/)
    if (star) {
      const step = star[1] ? Number.parseInt(star[1], 10) : 1
      if (step < 1) return null
      for (let value = spec.min; value <= spec.max; value += step) values.add(value)
      continue
    }
    const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (range) {
      const start = Number.parseInt(range[1], 10)
      const end = Number.parseInt(range[2], 10)
      const step = range[3] ? Number.parseInt(range[3], 10) : 1
      // 仅 day-of-week 接受 7 作为周日的别名。
      const isDow = spec.min === 0 && spec.max === 6
      const upper = isDow ? 7 : spec.max
      if (start > end || step < 1 || start < spec.min || end > upper) return null
      for (let value = start; value <= end; value += step) values.add(isDow && value === 7 ? 0 : value)
      continue
    }
    if (/^\d+$/.test(part)) {
      let value = Number.parseInt(part, 10)
      if (spec.min === 0 && spec.max === 6 && value === 7) value = 0
      if (value < spec.min || value > spec.max) return null
      values.add(value)
      continue
    }
    return null
  }
  if (values.size === 0) return null
  return Array.from(values).sort((a, b) => a - b)
}

/** tq：5 字段入口。字段数不是 5 或任一字段非法 → null。 */
export function parseCronExpression(expression: string): CronFields | null {
  const parts = String(expression ?? "").trim().split(/\s+/)
  if (parts.length !== 5) return null
  const parsed: number[][] = []
  for (let index = 0; index < 5; index += 1) {
    const field = parseCronField(parts[index], FIELD_SPECS[index])
    if (!field) return null
    parsed.push(field)
  }
  return {
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  }
}

// ── 下次触发（本地时区，搜索上限 527040 分钟）──────────────────────────────

const MAX_SEARCH_MINUTES = 527040
const MINUTE_MS = 60_000

function isInvalidLocalTime(date: Date): boolean {
  // 夏令时跳变产生的「不存在的本地时刻」：setMinutes 进去再取出来会变。
  const probe = new Date(date.getTime())
  probe.setMinutes(probe.getMinutes())
  return probe.getTime() !== date.getTime()
}

/**
 * CHt：从 after 之后的下一分钟开始找下一次匹配。
 * oneShot=true 时逐分钟推进（会绕开 DST 缺口），recurring 按时/日/月跳跃。
 */
export function nextCronFire(fields: CronFields, after: Date, options: { oneShot?: boolean } = {}): Date | null {
  const oneShot = options.oneShot === true
  const minutes = new Set(fields.minute)
  const hours = new Set(fields.hour)
  const daysOfMonth = new Set(fields.dayOfMonth)
  const months = new Set(fields.month)
  const daysOfWeek = new Set(fields.dayOfWeek)
  const everyDayOfMonth = fields.dayOfMonth.length === 31
  const everyDayOfWeek = fields.dayOfWeek.length === 7
  // DoM 与 DoW 都被限定时取 OR；只限定一个时只看那个。
  const dayMatches = (date: Date): boolean => {
    if (everyDayOfMonth && everyDayOfWeek) return true
    if (everyDayOfMonth) return daysOfWeek.has(date.getDay())
    if (everyDayOfWeek) return daysOfMonth.has(date.getDate())
    return daysOfMonth.has(date.getDate()) || daysOfWeek.has(date.getDay())
  }

  const cursor = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS)
  if (Number.isNaN(cursor.getTime())) return null

  for (let step = 0; step < MAX_SEARCH_MINUTES; step += 1) {
    if (isInvalidLocalTime(cursor)) {
      if (oneShot && months.has(cursor.getMonth() + 1) && dayMatches(cursor) && hours.has(cursor.getHours()) && minutes.has(cursor.getMinutes())) return cursor
      cursor.setTime(cursor.getTime() + MINUTE_MS)
      continue
    }
    if (!months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!hours.has(cursor.getHours()) || !minutes.has(cursor.getMinutes())) {
      if (oneShot) cursor.setTime(cursor.getTime() + MINUTE_MS)
      else if (!hours.has(cursor.getHours())) cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      else cursor.setMinutes(cursor.getMinutes() + 1)
      continue
    }
    return cursor
  }
  return null
}

// ── 抖动（J5 / Ntn / awo / Eut）────────────────────────────────────────────
export const DEFAULT_CRON_JITTER: CronJitterConfig = {
  recurringFrac: 0.5,
  recurringCapMs: 1_800_000,
  oneShotMaxMs: 90_000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 604_800_000,
  cacheLeadMs: 15_000,
}

const CACHE_LEAD_CRON = /^\*\/\d+ \* \* \* \*$/
const CACHE_LEAD_MIN_PERIOD_MS = 300_000

/** C7：一次性任务的补发窗口；超出窗口的过去时刻视为 expired，不静默顺延。 */
export const ONE_SHOT_CATCHUP_WINDOW_MS = 5 * 60_000

/** P2：跨进程投递认领的 stale 上限（进程崩溃后最多占用这么久）。 */
export const CRON_CLAIM_TTL_MS = 10 * 60_000

/** P2：同一会话一次 tick 最多触发的任务数；其余留到下一拍，避免一次齐发。 */
export const CRON_MAX_PER_SESSION_PER_TICK = 1

/** FNV-1a 32bit：给 jitter 一个稳定的非零散列（自增小 id 不再恒得 0）。 */
function hash32(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 由任务 id 得到稳定的 [0,1) 抖动系数（32bit 散列，`0 * * * *` 也不会恒为 0）。 */
export function cronJitterFraction(id: string | number): number {
  return hash32(String(id)) / 4_294_967_296
}

/** Ntn：recurring 的下一次触发（最多晚周期的 50%，封顶 30 分钟）。 */
export function nextRecurringFire(
  cron: string,
  afterMs: number,
  id: string | number,
  config: CronJitterConfig = DEFAULT_CRON_JITTER,
): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const first = nextCronFire(fields, new Date(afterMs))
  if (!first) return null
  const second = nextCronFire(fields, first)
  if (!second) return first.getTime()
  const period = second.getTime() - first.getTime()
  const cacheLead =
    CACHE_LEAD_CRON.test(cron) &&
    config.cacheLeadMs > 0 &&
    config.cacheLeadMs < period &&
    period >= CACHE_LEAD_MIN_PERIOD_MS &&
    period - config.cacheLeadMs < CACHE_LEAD_MIN_PERIOD_MS
  if (cacheLead) {
    // C14：next = max(now+1, fire-cacheLead)，且 fire 必须是「严格晚于基准、留足 cacheLead」
    // 的下一个边界。若简单用 afterMs+period-cacheLead，在上一拍提前 15s 触发时会算出
    // 285s 这种已经等于/早于当前时刻的值，形成 +1ms 连发或 285s 漂移。
    let fire = first.getTime()
    let candidate = fire - config.cacheLeadMs
    while (candidate <= afterMs) {
      const later = nextCronFire(fields, new Date(fire))
      if (!later) return null
      fire = later.getTime()
      candidate = fire - config.cacheLeadMs
    }
    return Math.max(afterMs + 1, candidate)
  }
  const delay = Math.min(cronJitterFraction(id) * config.recurringFrac * period, config.recurringCapMs)
  return Math.round(first.getTime() + delay)
}

/** awo：一次性任务落在 :00/:30 时最多提前 90s，且不早于创建时刻。 */
export function nextOneShotFire(
  cron: string,
  createdAtMs: number,
  id: string | number,
  config: CronJitterConfig = DEFAULT_CRON_JITTER,
): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const fire = nextCronFire(fields, new Date(createdAtMs), { oneShot: true })
  if (!fire) return null
  if (new Date(fire).getMinutes() % config.oneShotMinuteMod !== 0) return fire.getTime()
  const early =
    config.oneShotFloorMs + cronJitterFraction(id) * (config.oneShotMaxMs - config.oneShotFloorMs)
  return Math.round(Math.max(fire.getTime() - early, createdAtMs))
}
/** Eut：按任务形态算下一次（recurring 用 lastFiredAt ?? createdAt 为基准）。 */
export function computeNextFire(task: CronScheduleInput, config: CronJitterConfig = DEFAULT_CRON_JITTER): number | null {
  if (task.recurring) {
    return nextRecurringFire(task.cron, task.lastFiredAt ?? task.createdAt, task.id, config)
  }
  return nextOneShotFire(task.cron, task.createdAt, task.id, config)
}

/** recurring 任务创建满 7 天后过期；permanent 永不过期。 */
export function shouldExpireCron(
  task: { recurring: boolean; permanent: boolean; createdAt: number },
  now: number,
  config: CronJitterConfig = DEFAULT_CRON_JITTER,
): boolean {
  if (!task.recurring || task.permanent) return false
  return now - task.createdAt >= config.recurringMaxAgeMs
}
