import { Database } from "bun:sqlite"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import type { CronFireTask, CronRow, CreateCronInput, CreateCronResult, DurableScheduledTask, ScheduledTaskLock } from "./scheduled-crons-types"
import { DEFAULT_CRON_JITTER, ONE_SHOT_CATCHUP_WINDOW_MS, computeNextFire, parseCronExpression } from "./scheduled-crons-parse"

// ── durable 文件（scheduled_tasks.json）与锁 ───────────────────────────────

interface DurableFile {
  tasks: DurableScheduledTask[]
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

export async function mutateDurableTasks(
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

let connection: Database | undefined
let initialized = false
export let cronInitError: Error | null = null

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

export function db(): Database {
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

export function toTask(row: CronRow): CronFireTask {
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
      // SELECT * 的真实行必带这两列（CronRow 的跨进程投递认领位）；回退行同形。
      firing: null,
      firing_at: null,
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
