import type { CronFireTask, CronRow, CronTickerHandle, CronTickerOptions } from "./scheduled-crons-types"
import { db, toTask, mutateDurableTasks, cronStateDir, rehydrateDurableCrons, cronInitError } from "./scheduled-crons-store"
import { CRON_CLAIM_TTL_MS, CRON_MAX_PER_SESSION_PER_TICK, ONE_SHOT_CATCHUP_WINDOW_MS, computeNextFire, shouldExpireCron } from "./scheduled-crons-parse"

// ── 调度 ticker ────────────────────────────────────────────────────────────

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
        // 偶发失败不写 status=unknown（那会让周期任务再也排不进 active 扫描）。
        // 周期任务保持 active 并按 cron 排下一次；一次性，或明确 not_submitted 且不可重试，才标 failed。
        const refusal = error as { code?: unknown; retryable?: unknown }
        const notSubmitted = refusal?.code === "not_submitted"
        const hardFail = !task.recurring || (notSubmitted && refusal.retryable !== true)
        if (!hardFail) {
          const computed = computeNextFire({ ...task, lastFiredAt: now })
          const next = Math.max(computed ?? now + 60_000, now + 1)
          db()
            .query("UPDATE scheduled_crons SET status='active', next_fire_at=?, firing=0, firing_at=NULL WHERE id=? AND status='active'")
            .run(next, task.id)
        } else {
          db()
            .query("UPDATE scheduled_crons SET status='failed', firing=0, firing_at=NULL WHERE id=? AND status='active'")
            .run(task.id)
        }
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
