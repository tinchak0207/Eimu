// SessionWakeup（自调度唤醒）持久层与 ticker。
//
// 语义取证自 Claude Code 2.1.302 的 ScheduleWakeup：
// - delaySeconds 运行时钳制到 [60, 3600]；
// - reason 是一句给用户看的短说明；
// - prompt 唤醒时原样送入会话（/loop 输入）；
// - stop=true 取消该会话全部待触发唤醒（忽略其他字段）；
// - noop=true 表示本次检查无变化：连续 noop 折叠成一行并累计 noop_streak。
//
// 约束：
// - 模块 import 时不得启动任何定时器；ticker 只能由 startWakeupTicker() 显式启动。
// - 与 job-store.ts 同一条真源（SESSIONS_DB_PATH），WAL + CREATE TABLE IF NOT EXISTS。
// - ticker 单实例、幂等、.unref()，进程退出可被干净回收。
// - 本档只落库与调度；真正把 prompt 送进会话的 wake 函数由集成方注入。
import { Database } from "bun:sqlite"

export const WAKEUP_MIN_DELAY_SECONDS = 60
export const WAKEUP_MAX_DELAY_SECONDS = 3600
const WAKEUP_TICK_BATCH = 50
const WAKEUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const WAKEUP_RETENTION_PER_SESSION = 200
const WAKEUP_PRUNE_EVERY_TICKS = 60

export type WakeupStatus = "scheduled" | "firing" | "fired" | "failed" | "cancelled"

export interface WakeupInput {
  delaySeconds: number
  reason?: string
  prompt: string
  noop?: boolean
}

export interface WakeupRow {
  id: number
  session_id: string
  fire_at: number
  prompt: string
  reason: string | null
  noop_streak: number
  status: WakeupStatus | string
  created_at: number
  fired_at: number | null
  pid: number | null
}

export interface ScheduleWakeupResult {
  scheduled: true
  id: number
  fire_at: number
  delaySeconds: number
  noop_streak: number
}

let connection: Database | undefined

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ensureColumn(handle: Database, table: string, column: string, declaration: string): void {
  const columns = handle.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
}

/**
 * W1：启动回滚只动「没有 owner / owner 已死 / 本进程重启前」的 firing 行。
 * 仍存活的其它 gateway 进程正在投递的行绝不回滚（多进程共库时不被互踩）。
 */
function recoverStaleFiring(handle: Database): void {
  const rows = handle.query("SELECT id,pid FROM session_wakeups WHERE status='firing'").all() as Array<{
    id: number
    pid: number | null
  }>
  for (const row of rows) {
    const owner = typeof row.pid === "number" ? row.pid : null
    // pid=null 是旧版本遗留行，没有 owner 可等；本进程 pid 只可能是重启前遗留。
    const stale = owner === null || owner === process.pid || !pidAlive(owner)
    if (!stale) continue
    handle
      .query("UPDATE session_wakeups SET status='scheduled',pid=NULL WHERE id=? AND status='firing'")
      .run(row.id)
  }
}

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS session_wakeups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    reason TEXT,
    noop_streak INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at INTEGER NOT NULL,
    fired_at INTEGER,
    pid INTEGER
  );
  CREATE INDEX IF NOT EXISTS session_wakeups_due ON session_wakeups(status, fire_at);`)
  ensureColumn(next, "session_wakeups", "pid", "INTEGER")
  ensureColumn(next, "session_wakeups", "fired_at", "INTEGER")
  recoverStaleFiring(next)
  connection = next
  return next
}

/** 运行时钳制：非有限数直接拒绝（工具层会回可读错误），否则落到 [60,3600]。 */
export function clampWakeupDelay(seconds: number): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new Error("delaySeconds must be a finite number")
  return Math.min(WAKEUP_MAX_DELAY_SECONDS, Math.max(WAKEUP_MIN_DELAY_SECONDS, Math.round(seconds)))
}

/**
 * W3：noop streak 只统计连续 noop。
 * 真实唤醒（noop=false）产生的 0 行不把 streak 重置为 1；只有显式取消才终结 streak。
 */
function lastNoopStreak(sessionId: string): number {
  const rows = db()
    .query("SELECT noop_streak,status FROM session_wakeups WHERE session_id=? ORDER BY id DESC LIMIT 100")
    .all(sessionId) as Array<{ noop_streak: number; status: string }>
  for (const row of rows) {
    if (row.status === "cancelled") return 0
    if (typeof row.noop_streak === "number" && row.noop_streak > 0) return row.noop_streak
  }
  return 0
}

/**
 * 排一次唤醒。noop=true 时优先折叠到该会话仍待触发的 noop 行（更新 fire_at/prompt/reason，
 * streak 累加），避免「无事发生」的循环把表撑成流水帐。
 */
export function scheduleWakeup(sessionId: string, input: WakeupInput): ScheduleWakeupResult {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : ""
  if (!prompt) throw new Error("prompt is required")
  const delaySeconds = clampWakeupDelay(input.delaySeconds)
  const fireAt = Date.now() + delaySeconds * 1000
  const reason =
    typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 200) : null
  const noop = input.noop === true
  const handle = db()

  if (noop) {
    const streak = lastNoopStreak(sid) + 1
    const pending = handle
      .query("SELECT id FROM session_wakeups WHERE session_id=? AND status='scheduled' AND noop_streak>0 ORDER BY id DESC LIMIT 1")
      .get(sid) as { id: number } | null
    if (pending) {
      handle
        .query("UPDATE session_wakeups SET fire_at=?, prompt=?, reason=?, noop_streak=? WHERE id=? AND status='scheduled'")
        .run(fireAt, prompt, reason, streak, pending.id)
      return { scheduled: true, id: pending.id, fire_at: fireAt, delaySeconds, noop_streak: streak }
    }
    const inserted = handle
      .query("INSERT INTO session_wakeups(session_id,fire_at,prompt,reason,noop_streak,status,created_at) VALUES(?,?,?,?,?,'scheduled',?)")
      .run(sid, fireAt, prompt, reason, streak, Date.now())
    return { scheduled: true, id: Number(inserted.lastInsertRowid), fire_at: fireAt, delaySeconds, noop_streak: streak }
  }

  const inserted = handle
    .query("INSERT INTO session_wakeups(session_id,fire_at,prompt,reason,noop_streak,status,created_at) VALUES(?,?,?,?,0,'scheduled',?)")
    .run(sid, fireAt, prompt, reason, Date.now())
  return { scheduled: true, id: Number(inserted.lastInsertRowid), fire_at: fireAt, delaySeconds, noop_streak: 0 }
}

/**
 * W2：stop 的停止标记。stopWakeups 会把该会话 scheduled/firing 全部改成 cancelled，
 * 同时记下当时在途的行 id；ticker 在投递前与投递后都查标记，保证 stop 之后不再投递，
 * 已经在 fetch 中的那一笔收尾时也记账为 cancelled 而不是 fired。
 */
const cancelledInFlight = new Set<number>()

/** stop=true：取消该会话所有待触发唤醒（含正在投递中的行，但不强杀已发出的请求）。 */
export function stopWakeups(sessionId: string): { stopped: true; cancelled: number } {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const handle = db()
  const firing = handle
    .query("SELECT id FROM session_wakeups WHERE session_id=? AND status='firing'")
    .all(sid) as Array<{ id: number }>
  for (const row of firing) cancelledInFlight.add(row.id)
  const res = handle
    .query("UPDATE session_wakeups SET status='cancelled',pid=NULL WHERE session_id=? AND status IN ('scheduled','firing')")
    .run(sid)
  return { stopped: true, cancelled: Number(res.changes) }
}

export function listWakeups(sessionId: string): WakeupRow[] {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  return db().query("SELECT * FROM session_wakeups WHERE session_id=? ORDER BY id ASC").all(sid) as WakeupRow[]
}

export function dueWakeups(now: number = Date.now()): WakeupRow[] {
  return db()
    .query("SELECT * FROM session_wakeups WHERE status='scheduled' AND fire_at<=? ORDER BY fire_at ASC LIMIT ?")
    .all(now, WAKEUP_TICK_BATCH) as WakeupRow[]
}

/** 标记一次触发的结果；wake 抛错时由 ticker 传 "failed"（不重试，避免坏 prompt 无限唤醒）。 */
export function markFired(id: number, status: "fired" | "failed" | "cancelled" = "fired"): void {
  db().query("UPDATE session_wakeups SET status=?, fired_at=?, pid=NULL WHERE id=?").run(status, Date.now(), id)
}

/**
 * W7：保留策略。fired/failed/cancelled 行超过 7 天，或每会话超过 200 行，低频率清理。
 * 只清终态行，scheduled/firing 永不被保留策略误删。
 */
export function pruneWakeups(now: number = Date.now()): number {
  const handle = db()
  let removed = 0
  const expired = handle
    .query("DELETE FROM session_wakeups WHERE status IN ('fired','failed','cancelled') AND created_at < ?")
    .run(now - WAKEUP_RETENTION_MS)
  removed += Number(expired.changes)
  const sessions = handle
    .query(
      "SELECT session_id FROM session_wakeups WHERE status IN ('fired','failed','cancelled') GROUP BY session_id HAVING COUNT(*) > ?",
    )
    .all(WAKEUP_RETENTION_PER_SESSION) as Array<{ session_id: string }>
  for (const session of sessions) {
    const res = handle
      .query(
        `DELETE FROM session_wakeups WHERE session_id=? AND status IN ('fired','failed','cancelled')
         AND id NOT IN (
           SELECT id FROM session_wakeups WHERE session_id=? AND status IN ('fired','failed','cancelled')
           ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(session.session_id, session.session_id, WAKEUP_RETENTION_PER_SESSION)
    removed += Number(res.changes)
  }
  return removed
}

export type WakeupFn = (sessionId: string, prompt: string) => void | Promise<void>

interface WakeupTicker {
  timer: ReturnType<typeof setInterval>
  stop: () => void
  intervalMs: number
  wake: WakeupFn
}

let ticker: WakeupTicker | null = null

/**
 * 启动全局唤醒 ticker（单实例）。wake 由集成方注入（复用既有 prompt_async 唤醒轮子）。
 * 返回 stop()：清定时器并允许再次启动；重复调用不会叠加第二个定时器，
 * 也不会静默替换已有的 wake sink（W4：保持第一次注入的轮子，只提示）。
 */
export function startWakeupTicker(opts: { intervalMs?: number; wake: WakeupFn }): () => void {
  if (typeof opts?.wake !== "function") throw new Error("startWakeupTicker requires a wake function")
  if (ticker) {
    if (ticker.wake !== opts.wake) {
      console.warn("[gateway] startWakeupTicker called again with a different wake sink; keeping the existing ticker")
    }
    return ticker.stop
  }
  const intervalMs = Math.max(250, Math.floor(opts.intervalMs ?? 5000))
  let ticking = false
  let tickCount = 0

  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      for (const row of dueWakeups(Date.now())) {
        // W2：认领后立刻重查，stop 可能在 dueWakeups 与认领之间发生。
        const claimed = db()
          .query("UPDATE session_wakeups SET status='firing',pid=? WHERE id=? AND status='scheduled'")
          .run(process.pid, row.id)
        if (Number(claimed.changes) !== 1) continue
        const fresh = db()
          .query("SELECT status,prompt FROM session_wakeups WHERE id=?")
          .get(row.id) as { status: string; prompt: string } | null
        if (!fresh || fresh.status !== "firing" || cancelledInFlight.has(row.id)) {
          markFired(row.id, "cancelled")
          cancelledInFlight.delete(row.id)
          continue
        }
        try {
          await opts.wake(row.session_id, fresh.prompt)
          if (cancelledInFlight.has(row.id)) {
            // W2：投递途中被 stop；请求已发出，但记账必须是 cancelled，后续不再触发。
            markFired(row.id, "cancelled")
            console.log(`[gateway] wakeup cancelled in-flight: id=${row.id} session=${row.session_id}`)
          } else {
            markFired(row.id, "fired")
            console.log(`[gateway] wakeup fired: id=${row.id} session=${row.session_id} streak=${row.noop_streak}`)
          }
        } catch (e) {
          // W6：单行失败写 failed，ticker 继续处理下一行。
          if (cancelledInFlight.has(row.id)) markFired(row.id, "cancelled")
          else markFired(row.id, "failed")
          console.error(`[gateway] wakeup failed: id=${row.id} session=${row.session_id}:`, e)
        } finally {
          cancelledInFlight.delete(row.id)
        }
      }
      tickCount += 1
      if (tickCount % WAKEUP_PRUNE_EVERY_TICKS === 0) pruneWakeups()
    } catch (e) {
      console.error("[gateway] wakeup ticker error:", e)
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref()

  const stop = (): void => {
    clearInterval(timer)
    if (ticker?.timer === timer) ticker = null
  }
  ticker = { timer, stop, intervalMs, wake: opts.wake }
  void tick() // 重启后已到期的行不必再等一拍
  return stop
}
