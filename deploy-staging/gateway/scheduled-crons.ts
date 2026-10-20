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


export type { CronFields, CronJitterConfig, CronScheduleInput, DurableScheduledTask, ScheduledTaskLock, CronRow, CronFireTask, CreateCronInput, CreateCronResult, CronTickerOptions, CronTickerHandle } from "./scheduled-crons-types"
export { parseCronField, parseCronExpression, nextCronFire, DEFAULT_CRON_JITTER, ONE_SHOT_CATCHUP_WINDOW_MS, cronJitterFraction, nextRecurringFire, nextOneShotFire, computeNextFire, shouldExpireCron } from "./scheduled-crons-parse"
export { cronStateDir, scheduledTasksPath, scheduledTasksLockPath, CorruptScheduledTasksFileError, acquireScheduledTasksLock, readDurableScheduledTasks, getCronInitError, rehydrateDurableCrons, createCron, listCrons, getCron, deleteCron } from "./scheduled-crons-store"
export { currentCronFireSink, currentCronTicker, tickCrons, startCronTicker } from "./scheduled-crons-ticker"
