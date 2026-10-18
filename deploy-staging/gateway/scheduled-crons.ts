// 定时任务（CronCreate/CronList/CronDelete）移植自 Claude Code 2.1.302。
// 行为取证：m0378 tq/CHt/J5/Ntn/awo/Eut、m2083 调度循环与锁、m0381 工具提示词。
//
// 约束：
// - 5 字段一律按本机本地时区计算，不引第三方 cron 库。
// - 非 durable 任务只在本次进程生命周期内存在；durable 任务另落 scheduled_tasks.json。
// - 模块 import 时不启动任何定时器；ticker 只能由 startCronTicker() 显式启动。
// - 表与 session_wakeups 同库同源（SESSIONS_DB_PATH）。
import { Database } from "bun:sqlite"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"

// ── 5 字段解析 ──────────────────────────────────────────────────────────────

export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

interface FieldSpec {
  min: number
  max: number
}

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

export interface CronJitterConfig {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
  cacheLeadMs: number
}

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
const CRON_CLAIM_TTL_MS = 10 * 60_000

/** P2：同一会话一次 tick 最多触发的任务数；其余留到下一拍，避免一次齐发。 */
const CRON_MAX_PER_SESSION_PER_TICK = 1

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

export interface CronScheduleInput {
  id: string | number
  cron: string
  recurring: boolean
  createdAt: number
  lastFiredAt?: number | null
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

// ── durable 文件（scheduled_tasks.json）与锁 ───────────────────────────────

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

interface DurableFile {
  tasks: DurableScheduledTask[]
}

export interface ScheduledTaskLock {
  sessionId: string
  pid: number
  acquiredAt: number
}

const LOCK_RETRY_INTERVAL_MS = 100
const LOCK_RETRY_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 60_000

/** HARNESS_STATE 是 durable 文件的唯一根；默认与 sessions.db 同目录。 */
export function cronStateDir(): string {
  return process.env.HARNESS_STATE?.trim() || "/opt/agent-harness/state"
}

export function scheduledTasksPath(stateDir?: string): string {
  return join(stateDir?.trim() || cronStateDir(), "scheduled_tasks.json")
}

export function scheduledTasksLockPath(stateDir?: string): string {
  return join(stateDir?.trim() || cronStateDir(), "scheduled_tasks.lock")
}

function stagingDir(stateDir: string): string {
  return join(stateDir, ".staging")
}

function assertSafeDir(dir: string, root: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlinked scheduled tasks directory: ${dir}`)
  const real = realpathSync(dir)
  const realRoot = realpathSync(root)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`scheduled tasks directory escapes state root: ${dir}`)
  }
}

function assertSafeFile(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`refusing symlinked scheduled tasks file: ${file}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/** C4：损坏 JSON 不静默当 [] 覆盖；原文件先改名备份，再由调用方拒绝启动 ticker。 */
export class CorruptScheduledTasksFileError extends Error {
  readonly code = "corrupt_durable_file"
  readonly backupPath: string
  constructor(message: string, backupPath: string) {
    super(message)
    this.name = "CorruptScheduledTasksFileError"
    this.backupPath = backupPath
  }
}

function quarantineCorruptFile(file: string, reason: string): string {
  const backup = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, backup)
  } catch (error) {
    console.error(`[gateway] failed to quarantine corrupt scheduled tasks file ${file}:`, error)
    return ""
  }
  console.error(`[gateway] scheduled_tasks.json is corrupt (${reason}); original moved to ${backup}`)
  return backup
}

function readJsonFile(file: string): DurableFile | null {
  let raw: string
  try {
    assertSafeFile(file)
    raw = readFileSync(file, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be a JSON object")
    }
    const tasks = (parsed as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) throw new Error("tasks must be an array")
    return { tasks: tasks as DurableScheduledTask[] }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const backup = quarantineCorruptFile(file, reason)
    throw new CorruptScheduledTasksFileError(
      `scheduled_tasks.json is corrupt (${reason}); original moved to ${backup || "(quarantine failed)"}`,
      backup,
    )
  }
}

/** 原子写：先写 .staging 临时文件，fsync 后 rename 覆盖。 */
function writeJsonAtomic(file: string, value: DurableFile, stateDir: string): void {
  // 路径检查的 root 必须来自 HARNESS_STATE 真源，不能用被检查目录自己当 root（那样越界检查恒成立）。
  assertSafeDir(stateDir, cronStateDir())
  assertSafeFile(file)
  const staging = stagingDir(stateDir)
  assertSafeDir(staging, cronStateDir())
  const temp = join(staging, `.scheduled_tasks.${process.pid}.${randomUUID()}.tmp`)
  assertSafeFile(temp)
  const fd = openSync(temp, "wx", 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件已被移走/删除：无需处理。
    }
    throw error
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLock(lockPath: string): ScheduledTaskLock | null {
  try {
    assertSafeFile(lockPath)
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<ScheduledTaskLock>
    if (
      typeof parsed.sessionId !== "string" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return null
    }
    return { sessionId: parsed.sessionId, pid: parsed.pid as number, acquiredAt: parsed.acquiredAt }
  } catch {
    return null
  }
}

function tryCreateLock(lockPath: string, info: ScheduledTaskLock, stateDir: string): boolean {
  assertSafeDir(dirname(lockPath), stateDir)
  assertSafeFile(lockPath)
  try {
    const fd = openSync(lockPath, "wx", 0o600)
    try {
      writeSync(fd, JSON.stringify(info))
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

/**
 * 获取 durable 文件锁。锁内容 {sessionId,pid,acquiredAt}；
 * 持有进程已死或超过 LOCK_STALE_MS 视为 stale，回收后重试；总重试 5s。
 */
export async function acquireScheduledTasksLock(
  sessionId: string,
  options: { stateDir?: string; timeoutMs?: number; staleMs?: number } = {},
): Promise<{ acquired: true; release: () => void } | { acquired: false; heldBy: ScheduledTaskLock | null }> {
  const stateDir = options.stateDir?.trim() || cronStateDir()
  const lockPath = scheduledTasksLockPath(stateDir)
  const info: ScheduledTaskLock = { sessionId, pid: process.pid, acquiredAt: Date.now() }
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_RETRY_TIMEOUT_MS)
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  for (;;) {
    if (tryCreateLock(lockPath, info, stateDir)) {
      return {
        acquired: true,
        release: () => {
          const current = readLock(lockPath)
          if (current && current.sessionId === info.sessionId && current.pid === info.pid) {
            try {
              unlinkSync(lockPath)
            } catch {
              // 锁已被回收：release 幂等。
            }
          }
        },
      }
    }
    const heldBy = readLock(lockPath)
    const stale = !heldBy || !pidAlive(heldBy.pid) || Date.now() - heldBy.acquiredAt >= staleMs
    if (stale) {
      try {
        unlinkSync(lockPath)
      } catch {
        // 竞态下他人已回收：继续抢锁。
      }
      continue
    }
    if (Date.now() >= deadline) return { acquired: false, heldBy }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_INTERVAL_MS))
  }
}

export function readDurableScheduledTasks(stateDir?: string): DurableScheduledTask[] {
  const dir = stateDir?.trim() || cronStateDir()
  // 读前复核目录本身不是 symlink，且 realpath 仍在 HARNESS_STATE 根内。
  assertSafeDir(dir, cronStateDir())
  const file = scheduledTasksPath(dir)
  // C4：损坏文件会抛 CorruptScheduledTasksFileError（并已改名备份），绝不返回 [] 让上层覆盖。
  const parsed = readJsonFile(file)
  if (!parsed) return []
  const tasks: DurableScheduledTask[] = []
  for (const task of parsed.tasks) {
    if (!task || typeof task.id !== "string" || typeof task.cron !== "string" || typeof task.prompt !== "string") continue
    if (typeof task.createdAt !== "number" || !parseCronExpression(task.cron)) continue
    tasks.push(task)
  }
  return tasks
}

async function mutateDurableTasks(
  sessionId: string,
  stateDir: string,
  mutate: (tasks: DurableScheduledTask[]) => void,
): Promise<boolean> {
  const lock = await acquireScheduledTasksLock(sessionId, { stateDir })
  if (!lock.acquired) return false
  try {
    const file = scheduledTasksPath(stateDir)
    const current = readJsonFile(file) ?? { tasks: [] }
    const tasks = Array.isArray(current.tasks) ? current.tasks.slice() : []
    mutate(tasks)
    writeJsonAtomic(file, { tasks }, stateDir)
    return true
  } finally {
    lock.release()
  }
}

// ── SQLite 表 ──────────────────────────────────────────────────────────────

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

let connection: Database | undefined
let initialized = false
let cronInitError: Error | null = null

/**
 * C4：启动期间 durable 文件损坏等错误在此留档，startCronTicker 据此拒绝启动。
 * 未初始化时先触发一次 db()（懒加载），否则 HTTP 层在 ticker 之前调用会读到 null、
 * 把损坏状态误报成 200；错误在此统一由 db() 内部捕获进 cronInitError。
 */
export function getCronInitError(): Error | null {
  if (!initialized) db()
  return cronInitError
}

function ensureColumn(handle: Database, table: string, column: string, declaration: string): void {
  const columns = handle.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
}

/**
 * C1：非 durable 行只属于创建它的进程。启动时只能清「无 pid（旧版遗留）/ 本进程 /
 * owner 已死」的行；别的存活 gateway 进程的行绝不清。
 */
function cleanupNonDurableRows(handle: Database): number {
  const rows = handle.query("SELECT id,pid FROM scheduled_crons WHERE durable=0").all() as Array<{
    id: number
    pid: number | null
  }>
  let removed = 0
  for (const row of rows) {
    const owner = typeof row.pid === "number" ? row.pid : null
    if (owner !== null && owner !== process.pid && pidAlive(owner)) continue
    const res = handle.query("DELETE FROM scheduled_crons WHERE id=? AND durable=0").run(row.id)
    removed += Number(res.changes)
  }
  return removed
}

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS scheduled_crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    recurring INTEGER NOT NULL,
    durable INTEGER NOT NULL,
    permanent INTEGER NOT NULL DEFAULT 0,
    last_fired_at INTEGER,
    next_fire_at INTEGER,
    created_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    pid INTEGER,
    firing INTEGER NOT NULL DEFAULT 0,
    firing_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS scheduled_crons_due ON scheduled_crons(status,next_fire_at);
  CREATE INDEX IF NOT EXISTS scheduled_crons_session ON scheduled_crons(session_id,status);`)
  ensureColumn(next, "scheduled_crons", "pid", "INTEGER")
  ensureColumn(next, "scheduled_crons", "firing", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(next, "scheduled_crons", "firing_at", "INTEGER")
  // 非 durable 任务只活在本进程；只清本进程/已死 owner 的行（C1）。
  cleanupNonDurableRows(next)
  connection = next
  if (!initialized) {
    initialized = true
    try {
      rehydrateDurableCrons()
    } catch (error) {
      cronInitError = error instanceof Error ? error : new Error(String(error))
      console.error("[gateway] cron durable rehydrate failed; ticker will not start:", cronInitError.message)
    }
  }
  return next
}

function toTask(row: CronRow): CronFireTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    cron: row.cron,
    prompt: row.prompt,
    recurring: row.recurring === 1,
    durable: row.durable === 1,
    permanent: row.permanent === 1,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
  }
}

/** 启动时把 durable 文件回灌进表（文件是跨重启真源，表是本进程索引）。 */
export function rehydrateDurableCrons(stateDir?: string): number {
  const tasks = readDurableScheduledTasks(stateDir)
  if (tasks.length === 0) return 0
  const handle = connection ?? db()
  const now = Date.now()
  let restored = 0
  for (const task of tasks) {
    const numericId = Number.parseInt(task.id, 10)
    if (!Number.isInteger(numericId) || numericId <= 0) continue
    // P1：一次性任务必须显式写 recurring:false；旧版缺字段被当成 recurring=true。
    // 缺字段一律按一次性处理（task.recurring === true 才周期）。
    const recurring = task.recurring === true
    // P3：7 天过期在「从 durable 文件恢复」这一创建路径上就判定，不等下一次 tick。
    if (recurring && task.permanent !== true && now - task.createdAt >= DEFAULT_CRON_JITTER.recurringMaxAgeMs) {
      console.error(`[gateway] durable recurring cron ${task.id} expired before rehydrate (created ${new Date(task.createdAt).toISOString()})`)
      continue
    }
    const next = computeNextFire({
      id: numericId,
      cron: task.cron,
      recurring,
      createdAt: task.createdAt,
      lastFiredAt: typeof task.lastFiredAt === "number" ? task.lastFiredAt : null,
    })
    if (!recurring) {
      // C7：一次性任务的下一次已经落在补发窗口之外 → 报错 expired，绝不静默 +1 年。
      if (next === null || next < now - ONE_SHOT_CATCHUP_WINDOW_MS) {
        console.error(
          `[gateway] durable one-shot cron ${task.id} expired: next=${next === null ? "none" : new Date(next).toISOString()} (not restored)`,
        )
        continue
      }
    } else if (next === null) {
      console.error(`[gateway] durable recurring cron ${task.id} has no next occurrence (not restored)`)
      continue
    }
    handle
      .query(`INSERT INTO scheduled_crons(id,session_id,cron,prompt,recurring,durable,permanent,last_fired_at,next_fire_at,created_at,status,pid)
        VALUES(?,?,?,?,?,1,?,?,?,?,'active',NULL)
        ON CONFLICT(id) DO UPDATE SET
          cron=excluded.cron,
          prompt=excluded.prompt,
          recurring=excluded.recurring,
          permanent=excluded.permanent,
          last_fired_at=COALESCE(excluded.last_fired_at,scheduled_crons.last_fired_at),
          next_fire_at=excluded.next_fire_at
        WHERE scheduled_crons.status='active'
          AND (scheduled_crons.last_fired_at IS NULL OR excluded.last_fired_at>=scheduled_crons.last_fired_at)`)
      .run(
        numericId,
        task.createdBySessionId || "durable",
        task.cron,
        task.prompt,
        recurring ? 1 : 0,
        task.permanent === true ? 1 : 0,
        typeof task.lastFiredAt === "number" ? task.lastFiredAt : null,
        next,
        task.createdAt,
      )
    restored += 1
  }
  return restored
}

export async function createCron(input: CreateCronInput): Promise<CreateCronResult> {
  const sessionId = input.sessionId?.trim()
  const cron = input.cron?.trim()
  const prompt = input.prompt?.trim()
  if (!sessionId) throw new Error("sessionId is required")
  if (!cron) throw new Error("cron is required")
  if (!prompt) throw new Error("prompt is required")
  if (!parseCronExpression(cron)) throw new Error(`invalid cron expression: ${cron}`)
  const recurring = input.recurring !== false
  const durable = input.durable === true
  const permanent = input.permanent === true
  const createdAt = Date.now()
  const handle = db()
  // C2：INSERT ... RETURNING 避免「插入成功但随后的 SELECT 取到 null」直接崩溃。
  const inserted = handle
    .query(`INSERT INTO scheduled_crons(session_id,cron,prompt,recurring,durable,permanent,last_fired_at,next_fire_at,created_at,status,pid)
      VALUES(?,?,?,?,?,?,NULL,NULL,?,'active',?)
      RETURNING *`)
    .get(sessionId, cron, prompt, recurring ? 1 : 0, durable ? 1 : 0, permanent ? 1 : 0, createdAt, process.pid) as
    | CronRow
    | null
  const id = inserted?.id ?? Number((handle.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id)
  if (!Number.isInteger(id) || id <= 0) throw new Error("cron insert did not return a row id")
  const next = computeNextFire({ id, cron, recurring, createdAt, lastFiredAt: null })
  if (recurring) {
    // P2/P3：算不出下一次（如 2 月 31 日）→ 永不触发，创建时就拒绝；
    // 非 permanent 周期任务 7 天后过期，若首次触发晚于过期点，也不可能触发 → 同样拒绝。
    if (next === null) {
      handle.query("DELETE FROM scheduled_crons WHERE id=?").run(id)
      throw new Error(`never_fires: cron has no future occurrence: ${cron}`)
    }
    if (!permanent && next > createdAt + DEFAULT_CRON_JITTER.recurringMaxAgeMs) {
      handle.query("DELETE FROM scheduled_crons WHERE id=?").run(id)
      throw new Error(
        `never_fires: recurring cron expires before its first fire (next=${new Date(next).toISOString()}): ${cron}`,
      )
    }
  }
  if (!recurring && (next === null || next < createdAt - ONE_SHOT_CATCHUP_WINDOW_MS)) {
    // C7：一次性任务算不出未来触发（或已过补发窗口）→ 明确 expired，不静默顺延一年。
    handle.query("DELETE FROM scheduled_crons WHERE id=?").run(id)
    throw new Error(`expired: one-shot cron has no future occurrence: ${cron}`)
  }
  handle.query("UPDATE scheduled_crons SET next_fire_at=? WHERE id=?").run(next, id)
  const selected = handle.query("SELECT * FROM scheduled_crons WHERE id=?").get(id) as CronRow | null
  // C2 回退：即便 SELECT 仍取不到，也用 RETURNING 的行 + 刚算出的 next 组装结果，不崩。
  const row: CronRow =
    selected ??
    (inserted ? { ...inserted, next_fire_at: next } : {
      id,
      session_id: sessionId,
      cron,
      prompt,
      recurring: recurring ? 1 : 0,
      durable: durable ? 1 : 0,
      permanent: permanent ? 1 : 0,
      last_fired_at: null,
      next_fire_at: next,
      created_at: createdAt,
      status: "active",
      pid: process.pid,
    })
  if (durable) {
    const durableTask: DurableScheduledTask = {
      id: String(id),
      cron,
      prompt,
      createdAt,
      // P1：显式写 recurring（含 false）。缺失字段在旧版 rehydrate 里被当成 recurring。
      recurring,
      ...(permanent ? { permanent: true } : {}),
      createdBySessionId: sessionId,
      createdByPid: process.pid,
    }
    try {
      const ok = await mutateDurableTasks(sessionId, input.stateDir?.trim() || cronStateDir(), (tasks) => {
        const filtered = tasks.filter((task) => task.id !== durableTask.id)
        filtered.push(durableTask)
        tasks.splice(0, tasks.length, ...filtered)
      })
      if (!ok) throw new Error("could not acquire scheduled_tasks.json lock")
    } catch (error) {
      // C10/C3：durable 落盘（含 symlink 检查）失败必须回滚 DB 行，不能留下半条任务。
      handle.query("DELETE FROM scheduled_crons WHERE id=?").run(id)
      throw error
    }
  }
  return { ...toTask(row), nextFireAtMs: next }
}

export function listCrons(sessionId: string, options: { includeInactive?: boolean } = {}): CronRow[] {
  const sid = sessionId?.trim()
  if (!sid) throw new Error("sessionId is required")
  const sql = options.includeInactive
    ? "SELECT * FROM scheduled_crons WHERE session_id=? ORDER BY id ASC"
    : "SELECT * FROM scheduled_crons WHERE session_id=? AND status IN ('active','unknown','failed') ORDER BY id ASC"
  return db().query(sql).all(sid) as CronRow[]
}

export function getCron(id: number): CronRow | null {
  return (db().query("SELECT * FROM scheduled_crons WHERE id=?").get(id) as CronRow | null) ?? null
}

export async function deleteCron(
  sessionId: string,
  id: number,
  options: { stateDir?: string } = {},
): Promise<boolean> {
  const sid = sessionId?.trim()
  if (!sid) throw new Error("sessionId is required")
  const row = (db().query("SELECT * FROM scheduled_crons WHERE id=? AND session_id=?").get(id, sid) as CronRow | null) ?? null
  if (!row) return false
  // C3：durable 任务必须先把文件锁拿到并真正写入成功；持锁失败返回 false，且 DB 行保持不动。
  if (row.durable === 1) {
    const ok = await mutateDurableTasks(sid, options.stateDir?.trim() || cronStateDir(), (tasks) => {
      const index = tasks.findIndex((task) => Number.parseInt(task.id, 10) === id)
      if (index >= 0) tasks.splice(index, 1)
    })
    if (!ok) return false
  }
  const res = db().query("DELETE FROM scheduled_crons WHERE id=? AND session_id=?").run(id, sid)
  return Number(res.changes) > 0
}

// ── 调度 ticker ────────────────────────────────────────────────────────────

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

let ticking = false
let activeFireSink: ((task: CronFireTask) => void | Promise<void>) | null = null
let activeTicker: CronTickerHandle | null = null

export function currentCronFireSink(): ((task: CronFireTask) => void | Promise<void>) | null {
  return activeFireSink
}

/** 手动 tick 也必须复用宿主注入的空闲判断，不能由 HTTP 参数伪造。 */
export function currentCronTicker(): CronTickerHandle | null {
  return activeTicker
}

/** 处理一批到期任务：先 fire，再按 recurring/一次性/过期决定下一格。 */
export async function tickCrons(options: CronTickerOptions): Promise<CronFireTask[]> {
  if (ticking) return []
  ticking = true
  try {
    const now = Date.now()
    // 在途认领过期代表投递结果未知；不能释放后盲目重发同一轮。
    db()
      .query("UPDATE scheduled_crons SET status='unknown',firing=0,firing_at=NULL WHERE status='active' AND firing=1 AND (firing_at IS NULL OR firing_at<?)")
      .run(now - CRON_CLAIM_TTL_MS)
    // C5：先按「会话是否空闲」过滤，再对空闲会话取 LIMIT 行。
    // 直接 LIMIT 50 再逐行跳过 busy，会让 50 条 busy 行饿死后面真正 idle 的会话。
    let rows: CronRow[]
    if (options.isIdle) {
      const dueSessions = db()
        .query(
          "SELECT DISTINCT session_id FROM scheduled_crons WHERE status='active' AND next_fire_at IS NOT NULL AND next_fire_at<=?",
        )
        .all(now) as Array<{ session_id: string }>
      const idleSessions = dueSessions
        .map((entry) => entry.session_id)
        .filter((sessionId) => options.isIdle!(sessionId))
      if (idleSessions.length === 0) return []
      const placeholders = idleSessions.map(() => "?").join(",")
      rows = db()
        .query(
          `SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY next_fire_at,id) AS session_rank
           FROM scheduled_crons WHERE status='active' AND firing=0 AND next_fire_at IS NOT NULL AND next_fire_at<=?
           AND session_id IN (${placeholders})) WHERE session_rank=1 ORDER BY next_fire_at ASC LIMIT 50`,
        )
        .all(now, ...idleSessions) as CronRow[]
    } else {
      rows = db()
        .query(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY next_fire_at,id) AS session_rank
          FROM scheduled_crons WHERE status='active' AND firing=0 AND next_fire_at IS NOT NULL AND next_fire_at<=?)
          WHERE session_rank=1 ORDER BY next_fire_at ASC LIMIT 50`)
        .all(now) as CronRow[]
    }
    const fired: CronFireTask[] = []
    const perSession = new Map<string, number>()
    let throttled = 0
    for (const row of rows) {
      const task = toTask(row)
      // 前一会话的异步投递期间，后面的会话可能已经接收用户新回合。
      // 认领与提交之间不 await，必须在此使用实时空闲状态。
      if (options.isIdle && !options.isIdle(task.sessionId)) continue
      // P2：每会话每 tick 限 1 条；其余保持 active 且 next_fire_at 仍在过去，留到下一拍。
      if ((perSession.get(task.sessionId) ?? 0) >= CRON_MAX_PER_SESSION_PER_TICK) {
        throttled += 1
        continue
      }
      // P2：原子认领——两个 gateway 进程同时 tick 时，只有 UPDATE 影响 1 行的那个投递。
      const claimed = db()
        .query("UPDATE scheduled_crons SET firing=1,firing_at=? WHERE id=? AND status='active' AND firing=0")
        .run(now, task.id)
      if (Number(claimed.changes) !== 1) continue
      // C7：一次性任务已过补发窗口（进程停机很久）→ 报错 expired，不再补发。
      if (!task.recurring && row.next_fire_at !== null && row.next_fire_at < now - ONE_SHOT_CATCHUP_WINDOW_MS) {
        console.error(`[gateway] one-shot cron ${task.id} expired before delivery (fire_at=${row.next_fire_at})`)
        db().query("UPDATE scheduled_crons SET status='expired',firing=0,firing_at=NULL WHERE id=?").run(task.id)
        if (task.durable) {
          await mutateDurableTasks(task.sessionId, options.stateDir?.trim() || cronStateDir(), (tasks) => {
            const index = tasks.findIndex((entry) => Number.parseInt(entry.id, 10) === task.id)
            if (index >= 0) tasks.splice(index, 1)
          }).catch((error) => options.onError?.(error))
        }
        continue
      }
      try {
        await options.fire(task)
      } catch (error) {
        options.onError?.(error)
        // 超时/断线可能发生在对方已接收之后；保留投递身份，不能重试同一轮或伪报 fired。
        const refusal = error as { code?: unknown; retryable?: unknown }
        const status = refusal?.code === "not_submitted"
          ? refusal.retryable === true ? "active" : "failed"
          : "unknown"
        db().query("UPDATE scheduled_crons SET status=?,firing=0,firing_at=NULL WHERE id=? AND status='active'").run(status, task.id)
        continue
      }
      fired.push(task)
      perSession.set(task.sessionId, (perSession.get(task.sessionId) ?? 0) + 1)
      const expired = shouldExpireCron(
        { recurring: task.recurring, permanent: task.permanent, createdAt: task.createdAt },
        now,
      )
      if (task.recurring && !expired) {
        const computed = computeNextFire({ ...task, lastFiredAt: now })
        // C14：next 永不落回过去（计算值与 now+1 取大），避免同一行每拍重放。
        const next = computed === null ? null : Math.max(computed, now + 1)
        if (next === null) {
          db()
            .query("UPDATE scheduled_crons SET last_fired_at=?, status='expired', firing=0, firing_at=NULL WHERE id=?")
            .run(now, task.id)
        } else {
          db()
            .query("UPDATE scheduled_crons SET last_fired_at=?, next_fire_at=?, firing=0, firing_at=NULL WHERE id=?")
            .run(now, next, task.id)
        }
        if (task.durable) {
          await mutateDurableTasks(task.sessionId, options.stateDir?.trim() || cronStateDir(), (tasks) => {
            const durable = tasks.find((entry) => Number.parseInt(entry.id, 10) === task.id)
            if (durable) durable.lastFiredAt = now
          })
        }
      } else {
        // 先留耐久终态。文件落盘失败或进程崩溃时，rehydrate 不能将已投递任务复活。
        db().query("UPDATE scheduled_crons SET last_fired_at=?, status=?,firing=0,firing_at=NULL WHERE id=?")
          .run(now, expired ? "expired" : "fired", task.id)
        if (task.durable) {
          await mutateDurableTasks(task.sessionId, options.stateDir?.trim() || cronStateDir(), (tasks) => {
            const index = tasks.findIndex((entry) => Number.parseInt(entry.id, 10) === task.id)
            if (index >= 0) tasks.splice(index, 1)
          })
        }
        if (!task.durable && !expired) db().query("DELETE FROM scheduled_crons WHERE id=? AND status='fired'").run(task.id)
      }
    }
    if (throttled > 0) {
      console.log(`[gateway] cron throttled: ${throttled} due task(s) deferred to next tick (max ${CRON_MAX_PER_SESSION_PER_TICK}/session/tick)`)
    }
    return fired
  } finally {
    ticking = false
  }
}

/** 1s tick；只在会话空闲时 fire。由集成方注入 isIdle/fire。 */
export function startCronTicker(options: CronTickerOptions): CronTickerHandle {
  // C4：durable 文件损坏时拒绝启动 ticker（不拿空表继续跑，也不覆盖原文件）。
  db()
  if (cronInitError) throw cronInitError
  if (activeTicker) activeTicker.stop()
  activeFireSink = options.fire
  rehydrateDurableCrons(options.stateDir)
  const intervalMs = Math.max(250, options.intervalMs ?? 1000)
  const run = () => {
    void tickCrons(options).catch((error) => options.onError?.(error))
  }
  const timer = setInterval(run, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const handle: CronTickerHandle = {
    stop: () => {
      clearInterval(timer)
      if (activeTicker === handle) {
        activeTicker = null
        if (activeFireSink === options.fire) activeFireSink = null
      }
    },
    tick: () => tickCrons(options),
  }
  activeTicker = handle
  return handle
}
