import { Database } from "bun:sqlite"
// CC 2.1.302 TaskCreated/TaskCompleted hook（2026-10-18 接线）。
// fire-and-forget：hook 失败只进日志，绝不影响任务板操作。
import { runHooksWithBudget } from "./hooks-http.ts"

// 持久任务板：移植 Claude Code 的 TaskCreate/TaskUpdate/TaskList 语义。
// 与 sessions 共用同一持久目录（SESSIONS_DB_PATH），独立表 agent_tasks。
//
// 依赖双写（对齐 CC qHt）：A.blocks 含 B ⇔ B.blockedBy 含 A。
// 删除任务（对齐 CC VHt）：遍历全表清除对它的 blocks/blockedBy 引用。
// 并发：所有读写统一走 BEGIN IMMEDIATE 事务 + 3 次指数退避重试，避免
// 「read 后 upgrade 写」在并发 update 下撞 database is locked。

export type TaskStatus = "pending" | "in_progress" | "completed"

export type Task = {
  id: number
  sessionId: string
  subject: string
  description: string
  activeForm: string | null
  status: TaskStatus
  owner: string | null
  blocks: number[]
  blockedBy: number[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export type TaskSummary = {
  id: number
  subject: string
  status: TaskStatus
  owner: string | null
  blockedBy: number[]
}

export type TaskUpdatePatch = {
  status?: string
  subject?: string
  description?: string
  activeForm?: string | null
  owner?: string | null
  metadata?: Record<string, unknown>
  addBlocks?: number[]
  addBlockedBy?: number[]
  removeBlocks?: number[]
  removeBlockedBy?: number[]
}

export type UpdateTaskResult =
  | { success: false; error: string }
  | {
      success: true
      taskId: number
      updatedFields: string[]
      statusChange?: { from: TaskStatus; to: TaskStatus | "deleted" }
      task?: Task
    }

type TaskRow = {
  id: number
  session_id: string
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string
  created_at: number
  updated_at: number
}

/** 任务字段上限（字符数，按 UTF-16 长度计）。 */
export const TASK_SUBJECT_MAX_CHARS = 200
export const TASK_DESCRIPTION_MAX_CHARS = 8000

/** 入参非法（HTTP 层映射 400）。 */
export class TaskValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = "TaskValidationError"
    this.field = field
  }
}

let connection: Database | undefined
function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    active_form TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    owner TEXT,
    blocks TEXT NOT NULL DEFAULT '[]',
    blocked_by TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_tasks_session_status ON agent_tasks(session_id,status);`)
  connection = next
  return next
}

const TASK_STATUSES: readonly string[] = ["pending", "in_progress", "completed"]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseIdArray(raw: string): number[] {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number" && Number.isInteger(id)) : []
  } catch {
    return []
  }
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return isPlainRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function decodeTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    subject: row.subject,
    description: row.description,
    activeForm: row.active_form,
    status: row.status as TaskStatus,
    owner: row.owner,
    blocks: parseIdArray(row.blocks),
    blockedBy: parseIdArray(row.blocked_by),
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

const TX_RETRY_DELAYS_MS = [20, 60, 150]

/**
 * 统一事务入口：BEGIN IMMEDIATE（一开始就拿写锁，避免读锁升级死锁）。
 * 遇 SQLITE_BUSY/LOCKED 时按 20/60/150ms 指数退避重试 3 次。
 */
function withTransaction<T>(fn: () => T): T {
  const database = db()
  for (let attempt = 0; ; attempt += 1) {
    try {
      database.exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        database.exec("COMMIT")
        return result
      } catch (error) {
        try {
          database.exec("ROLLBACK")
        } catch {
          /* already rolled back */
        }
        throw error
      }
    } catch (error) {
      if (attempt >= TX_RETRY_DELAYS_MS.length || !isBusyError(error)) throw error
      sleepSync(TX_RETRY_DELAYS_MS[attempt])
    }
  }
}

function readRow(sessionId: string, taskId: number): TaskRow | null {
  return (db().query("SELECT * FROM agent_tasks WHERE session_id=? AND id=?").get(sessionId, taskId) as TaskRow | null) ?? null
}

function readAllRows(sessionId: string): TaskRow[] {
  return db().query("SELECT * FROM agent_tasks WHERE session_id=? ORDER BY id ASC").all(sessionId) as TaskRow[]
}

function dedupeIds(ids: number[]): number[] {
  return [...new Set(ids)]
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function validateIdArray(value: number[] | undefined, field: string): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    return `${field} must be an array of positive integer task ids`
  }
  return null
}

function requireTextLength(field: string, value: string, max: number): void {
  if (value.length > max) throw new TaskValidationError(field, `${field} must be at most ${max} characters (got ${value.length})`)
}

/** 收集 blockedBy 图的环（跨全表）；返回环路径或 null。 */
function findDependencyCycle(tasks: Map<number, Task>): number[] | null {
  const visiting = new Set<number>()
  const done = new Set<number>()
  const path: number[] = []

  const visit = (id: number): number[] | null => {
    if (done.has(id)) return null
    if (visiting.has(id)) {
      const start = path.indexOf(id)
      return [...path.slice(start >= 0 ? start : 0), id]
    }
    const task = tasks.get(id)
    if (!task) return null
    visiting.add(id)
    path.push(id)
    for (const dependencyId of task.blockedBy) {
      if (!tasks.has(dependencyId)) continue
      const cycle = visit(dependencyId)
      if (cycle) return cycle
    }
    path.pop()
    visiting.delete(id)
    done.add(id)
    return null
  }

  for (const id of tasks.keys()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

function formatCycle(cycle: number[]): string {
  return cycle.map((id) => `#${id}`).join(" -> ")
}

function insertTask(
  sessionId: string,
  subject: string,
  description: string,
  activeForm: string | null,
  metadata: Record<string, unknown>,
): number {
  const now = Date.now()
  const info = db()
    .query(`INSERT INTO agent_tasks(session_id,subject,description,active_form,status,owner,blocks,blocked_by,metadata,created_at,updated_at)
      VALUES(?,?,?,?,'pending',NULL,'[]','[]',?,?,?)`)
    .run(sessionId, subject, description, activeForm, JSON.stringify(metadata), now, now)
  return Number(info.lastInsertRowid)
}

function fireTaskHook(
  event: "TaskCreated" | "TaskCompleted",
  sessionId: string,
  task: { id: number; subject: string; description?: string; status?: string },
): void {
  void runHooksWithBudget(
    event,
    {
      hook_event_name: event,
      session_id: sessionId,
      task_id: String(task.id),
      subject: task.subject,
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.status !== undefined ? { status: task.status } : {}),
    },
    { timeoutMs: 60_000 },
  ).catch((e) => {
    console.warn(`[gateway] hooks ${event} failed session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
  })
}

export function createTask(
  sessionId: string,
  input: { subject: string; description: string; activeForm?: string | null; metadata?: Record<string, unknown> },
): { task: { id: number; subject: string } } {
  const subject = typeof input.subject === "string" ? input.subject.trim() : ""
  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (!subject || !description) throw new TaskValidationError("subject", "subject and description are required")
  requireTextLength("subject", subject, TASK_SUBJECT_MAX_CHARS)
  requireTextLength("description", description, TASK_DESCRIPTION_MAX_CHARS)
  const activeForm = typeof input.activeForm === "string" ? input.activeForm : null
  const metadata = isPlainRecord(input.metadata) ? input.metadata : {}
  const id = withTransaction(() => insertTask(sessionId, subject, description, activeForm, metadata))
  // 落库成功后触发；不 await，任务创建响应不等待 hook。
  fireTaskHook("TaskCreated", sessionId, { id, subject, description, status: "pending" })
  return { task: { id, subject } }
}

export function getTask(sessionId: string, taskId: number): Task | undefined {
  if (!Number.isInteger(taskId) || taskId <= 0) return undefined
  return withTransaction(() => {
    const row = readRow(sessionId, taskId)
    return row ? decodeTask(row) : undefined
  })
}

/**
 * 依赖编辑 + 字段更新（单事务）。
 * - addBlocks/addBlockedBy 双写对端；removeBlocks/removeBlockedBy 对称解除。
 * - 会成环的编辑整笔拒绝。
 * - 只有真正变化的字段进 updatedFields；空 patch 不 bump updated_at。
 */
export function updateTask(sessionId: string, taskId: number, patch: TaskUpdatePatch): UpdateTaskResult {
  if (!Number.isInteger(taskId) || taskId <= 0) return { success: false, error: "Task not found" }
  if (patch.status !== undefined && !TASK_STATUSES.includes(patch.status) && patch.status !== "deleted") {
    return { success: false, error: `invalid status: ${patch.status}` }
  }
  const idError =
    validateIdArray(patch.addBlocks, "addBlocks") ??
    validateIdArray(patch.addBlockedBy, "addBlockedBy") ??
    validateIdArray(patch.removeBlocks, "removeBlocks") ??
    validateIdArray(patch.removeBlockedBy, "removeBlockedBy")
  if (idError) return { success: false, error: idError }
  if (patch.subject !== undefined) {
    if (typeof patch.subject !== "string" || !patch.subject.trim()) return { success: false, error: "subject must be a non-empty string" }
    if (patch.subject.trim().length > TASK_SUBJECT_MAX_CHARS) {
      return { success: false, error: `subject must be at most ${TASK_SUBJECT_MAX_CHARS} characters` }
    }
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string" || !patch.description.trim()) {
      return { success: false, error: "description must be a non-empty string" }
    }
    if (patch.description.trim().length > TASK_DESCRIPTION_MAX_CHARS) {
      return { success: false, error: `description must be at most ${TASK_DESCRIPTION_MAX_CHARS} characters` }
    }
  }
  if (patch.activeForm !== undefined && patch.activeForm !== null && typeof patch.activeForm !== "string") {
    return { success: false, error: "activeForm must be a string or null" }
  }
  if (patch.owner !== undefined && patch.owner !== null && typeof patch.owner !== "string") {
    return { success: false, error: "owner must be a string or null" }
  }
  if (patch.metadata !== undefined && !isPlainRecord(patch.metadata)) {
    return { success: false, error: "metadata must be an object" }
  }

  return withTransaction((): UpdateTaskResult => {
    const rows = readAllRows(sessionId)
    const origin = new Map<number, Task>()
    const view = new Map<number, Task>()
    for (const row of rows) {
      const task = decodeTask(row)
      origin.set(task.id, task)
      view.set(task.id, {
        ...task,
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
        metadata: { ...task.metadata },
      })
    }
    const task = view.get(taskId)
    const original = origin.get(taskId)
    if (!task || !original) return { success: false, error: "Task not found" }

    if (patch.status === "deleted") {
      db().query("DELETE FROM agent_tasks WHERE session_id=? AND id=?").run(sessionId, taskId)
      // CC VHt：删除后遍历全表，清掉所有对它的 blocks/blockedBy 引用。
      const now = Date.now()
      for (const other of view.values()) {
        if (other.id === taskId) continue
        const blocks = other.blocks.filter((id) => id !== taskId)
        const blockedBy = other.blockedBy.filter((id) => id !== taskId)
        if (sameIds(blocks, other.blocks) && sameIds(blockedBy, other.blockedBy)) continue
        db()
          .query("UPDATE agent_tasks SET blocks=?, blocked_by=?, updated_at=? WHERE session_id=? AND id=?")
          .run(JSON.stringify(blocks), JSON.stringify(blockedBy), now, sessionId, other.id)
      }
      return { success: true, taskId, updatedFields: ["deleted"], statusChange: { from: original.status, to: "deleted" } }
    }

    const applyDependencyEdits = (
      add: number[] | undefined,
      remove: number[] | undefined,
      ownField: "blocks" | "blockedBy",
      otherField: "blocks" | "blockedBy",
    ): string | null => {
      const counterpartField = otherField
      for (const dependencyId of dedupeIds(remove ?? [])) {
        task[ownField] = task[ownField].filter((id) => id !== dependencyId)
        const counterpart = view.get(dependencyId)
        if (counterpart) counterpart[counterpartField] = counterpart[counterpartField].filter((id) => id !== taskId)
      }
      for (const dependencyId of dedupeIds(add ?? [])) {
        if (dependencyId === taskId) return `task #${taskId} cannot depend on itself`
        const counterpart = view.get(dependencyId)
        if (!counterpart) return `task #${dependencyId} not found`
        if (!task[ownField].includes(dependencyId)) task[ownField].push(dependencyId)
        if (!counterpart[counterpartField].includes(taskId)) counterpart[counterpartField].push(taskId)
      }
      return null
    }

    const dependencyError =
      applyDependencyEdits(undefined, patch.removeBlocks, "blocks", "blockedBy") ??
      applyDependencyEdits(undefined, patch.removeBlockedBy, "blockedBy", "blocks") ??
      applyDependencyEdits(patch.addBlocks, undefined, "blocks", "blockedBy") ??
      applyDependencyEdits(patch.addBlockedBy, undefined, "blockedBy", "blocks")
    if (dependencyError) return { success: false, error: dependencyError }

    const dependencyEdited = [
      patch.addBlocks,
      patch.addBlockedBy,
      patch.removeBlocks,
      patch.removeBlockedBy,
    ].some((ids) => ids !== undefined && ids.length > 0)
    if (dependencyEdited) {
      // 环检测：blockedBy 图上任何环都拒绝整笔编辑。
      const cycle = findDependencyCycle(view)
      if (cycle) return { success: false, error: `dependency cycle rejected: ${formatCycle(cycle)}` }
    }

    if (patch.status === "completed" && original.status !== "completed") {
      // 只把「仍存在且未完成」的依赖视为阻塞；已删除/已完成的不再阻塞。
      const blockers = task.blockedBy.filter((id) => {
        const dependency = view.get(id)
        return dependency !== undefined && dependency.status !== "completed"
      })
      if (blockers.length > 0) {
        return { success: false, error: `blocked by ${blockers.map((id) => `#${id}`).join(", ")}` }
      }
    }

    if (patch.status !== undefined) task.status = patch.status as TaskStatus
    if (patch.subject !== undefined) task.subject = patch.subject.trim()
    if (patch.description !== undefined) task.description = patch.description.trim()
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm
    if (patch.owner !== undefined) task.owner = patch.owner
    if (patch.metadata !== undefined) {
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === null) delete task.metadata[key]
        else task.metadata[key] = value
      }
    }

    const updatedFields = writeChangedRow(sessionId, original, task)

    // 对端只写实际变化的依赖数组。
    for (const next of view.values()) {
      if (next.id === taskId) continue
      const before = origin.get(next.id)
      if (!before) continue
      const blocksChanged = !sameIds(next.blocks, before.blocks)
      const blockedByChanged = !sameIds(next.blockedBy, before.blockedBy)
      if (!blocksChanged && !blockedByChanged) continue
      db()
        .query("UPDATE agent_tasks SET blocks=?, blocked_by=?, updated_at=? WHERE session_id=? AND id=?")
        .run(JSON.stringify(next.blocks), JSON.stringify(next.blockedBy), Date.now(), sessionId, next.id)
    }

    if (updatedFields.length === 0) {
      // 空 patch（或所有字段都是原值）：不 bump updated_at，updatedFields 为空。
      return { success: true, taskId, updatedFields: [], task }
    }

    const statusChange =
      task.status !== original.status ? { from: original.status, to: task.status } : undefined
    // status 变为 completed 且落库成功 → TaskCompleted。空 patch（updatedFields=[]）
    // 上面已 return；此处 statusChange 存在即代表确实写了新状态。
    if (statusChange?.to === "completed") {
      fireTaskHook("TaskCompleted", sessionId, {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
      })
    }
    return {
      success: true,
      taskId,
      updatedFields,
      ...(statusChange ? { statusChange } : {}),
      task,
    }
  })
}

/** 把主任务相对原始行的真实差异落库，返回变化字段（CC 命名：blocks/blockedBy）。 */
function writeChangedRow(sessionId: string, before: Task, next: Task): string[] {
  const assignments: string[] = []
  const values: Array<string | number | null> = []
  const changed: string[] = []
  if (next.status !== before.status) {
    assignments.push("status=?")
    values.push(next.status)
    changed.push("status")
  }
  if (next.subject !== before.subject) {
    assignments.push("subject=?")
    values.push(next.subject)
    changed.push("subject")
  }
  if (next.description !== before.description) {
    assignments.push("description=?")
    values.push(next.description)
    changed.push("description")
  }
  if (next.activeForm !== before.activeForm) {
    assignments.push("active_form=?")
    values.push(next.activeForm)
    changed.push("activeForm")
  }
  if (next.owner !== before.owner) {
    assignments.push("owner=?")
    values.push(next.owner)
    changed.push("owner")
  }
  if (JSON.stringify(next.metadata) !== JSON.stringify(before.metadata)) {
    assignments.push("metadata=?")
    values.push(JSON.stringify(next.metadata))
    changed.push("metadata")
  }
  if (!sameIds(next.blocks, before.blocks)) {
    assignments.push("blocks=?")
    values.push(JSON.stringify(next.blocks))
    changed.push("blocks")
  }
  if (!sameIds(next.blockedBy, before.blockedBy)) {
    assignments.push("blocked_by=?")
    values.push(JSON.stringify(next.blockedBy))
    changed.push("blockedBy")
  }
  if (changed.length === 0) return []
  assignments.push("updated_at=?")
  values.push(Date.now())
  values.push(sessionId, next.id)
  db().query(`UPDATE agent_tasks SET ${assignments.join(", ")} WHERE session_id=? AND id=?`).run(...values)
  return changed
}

export function listTasks(sessionId: string): TaskSummary[] {
  return withTransaction(() => {
    const rows = readAllRows(sessionId)
    const decoded = new Map<number, Task>()
    for (const row of rows) {
      const task = decodeTask(row)
      decoded.set(task.id, task)
    }
    const summaries: TaskSummary[] = []
    for (const task of decoded.values()) {
      // CC 在 list 中隐藏 metadata._internal 的任务。
      if (isPlainRecord(task.metadata) && task.metadata._internal) continue
      // blockedBy 只显示「仍存在且未完成」的依赖。
      const blockedBy = task.blockedBy.filter((id) => {
        const dependency = decoded.get(id)
        return dependency !== undefined && dependency.status !== "completed"
      })
      summaries.push({
        id: task.id,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
        blockedBy,
      })
    }
    return summaries
  })
}

// 仅供测试/运维，不要在面向模型的工具里暴露。
export function resetTaskBoardForSession(sessionId: string): number {
  return withTransaction(() => {
    const info = db().query("DELETE FROM agent_tasks WHERE session_id=?").run(sessionId)
    return Number(info.changes)
  })
}
