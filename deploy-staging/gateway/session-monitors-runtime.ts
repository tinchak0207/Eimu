import { Database } from "bun:sqlite"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { assertPublicHost } from "./artifact-store"
import { emitToSession } from "./sse-core.ts"
import { resolveSession } from "./sessions-core.ts"
import { dispatchWorkflowWake } from "./workflow-gw.ts"
import { subagentParentState } from "./subagent"
import { MONITOR_MAX_EVENTS_PER_SECOND, MONITOR_LAST_LINES, MONITOR_LINE_MAX_CHARS, MONITOR_BUFFER_MAX_CHARS, MONITOR_KILL_GRACE_MS, MONITOR_RETENTION_MS, MONITOR_RETENTION_PER_SESSION, MONITOR_PRUNE_EVERY_TICKS, MONITOR_MAX_ACTIVE, MONITOR_MAX_PER_SESSION, MonitorPolicyError, normalizeMonitorTimeout } from "./session-monitors-types.ts"
import { assertMonitorCommandAllowed } from "./session-monitors-shell.ts"
import type { MonitorInput, MonitorView, SessionMonitorRow, SessionStateLike } from "./session-monitors-types.ts"
// ── 持久层 ──────────────────────────────────────────────────────────────
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

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS session_monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    description TEXT NOT NULL,
    command TEXT,
    ws_url TEXT,
    timeout_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    event_count INTEGER NOT NULL DEFAULT 0,
    dropped_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_lines TEXT NOT NULL DEFAULT '[]',
    pid INTEGER,
    child_pid INTEGER,
    child_pgid INTEGER,
    truncated_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS session_monitors_session ON session_monitors(session_id, status);`)
  ensureColumn(next, "session_monitors", "pid", "INTEGER")
  ensureColumn(next, "session_monitors", "child_pid", "INTEGER")
  ensureColumn(next, "session_monitors", "child_pgid", "INTEGER")
  ensureColumn(next, "session_monitors", "truncated_count", "INTEGER NOT NULL DEFAULT 0")
  connection = next
  return next
}

function parseLines(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

// ── 进行中的监视句柄 ────────────────────────────────────────────────────
interface ActiveMonitor {
  id: number
  sessionId: string
  description: string
  timeoutMs: number
  startedAt: number
  eventCount: number
  droppedCount: number
  truncatedCount: number
  lastLines: string[]
  stderrTail: string
  windowStart: number
  windowCount: number
  finished: boolean
  childPid: number | null
  childPgid: number | null
  kill: () => void
  timer?: ReturnType<typeof setTimeout>
  state?: SessionStateLike
}

const active = new Map<number, ActiveMonitor>()

function stateFor(handle: ActiveMonitor): SessionStateLike | undefined {
  if (!handle.state) handle.state = resolveSession(handle.sessionId) ?? subagentParentState(handle.sessionId)
  return handle.state
}

function deliver(handle: ActiveMonitor, rawLine: string): void {
  if (handle.finished) return
  const now = Date.now()
  if (now - handle.windowStart >= 1000) {
    handle.windowStart = now
    handle.windowCount = 0
  }
  if (handle.windowCount >= MONITOR_MAX_EVENTS_PER_SECOND) {
    handle.droppedCount += 1
    return
  }
  handle.windowCount += 1
  handle.eventCount += 1

  const line = rawLine.length > MONITOR_LINE_MAX_CHARS ? rawLine.slice(0, MONITOR_LINE_MAX_CHARS) : rawLine
  handle.lastLines.push(line)
  if (handle.lastLines.length > MONITOR_LAST_LINES) {
    handle.lastLines.splice(0, handle.lastLines.length - MONITOR_LAST_LINES)
  }
  const state = stateFor(handle)
  if (!state) return // 会话已不在：事件仍计数，但没有 SSE 出口可推。
  emitToSession(state, "monitor.event", {
    monitor_id: handle.id,
    description: handle.description,
    line,
    seq: handle.eventCount,
  })
}

function expiryMessage(minutes: number, events: number): string {
  const base = `[Monitor expired after ${minutes} minutes with ${events} events delivered. Re-arm it if you still need the watch.]`
  return events === 0 ? `${base} The monitor saw no output; widen the filter if silence was unexpected.` : base
}

function persistCounters(handle: ActiveMonitor, status = "running", endedAt: number | null = null): void {
  db()
    .query(
      "UPDATE session_monitors SET status=?,event_count=?,dropped_count=?,truncated_count=?,ended_at=?,last_lines=? WHERE id=?",
    )
    .run(
      status,
      handle.eventCount,
      handle.droppedCount,
      handle.truncatedCount,
      endedAt,
      JSON.stringify(handle.lastLines),
      handle.id,
    )
}

function emitMonitorFrame(
  sessionId: string,
  monitorId: number,
  description: string,
  eventCount: number,
  droppedCount: number,
  name: string,
  message?: string,
): void {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!state) return
  emitToSession(state, name, {
    monitor_id: monitorId,
    description,
    event_count: eventCount,
    dropped_count: droppedCount,
    ...(message ? { message } : {}),
  })
  // turn.status 是既有的用户可见通知通道（ack/heartbeat 同款），不会结束当前 turn。
  if (message) emitToSession(state, "turn.status", { text: message })
}

/**
 * M6：状态如实记录退出原因——`ended:code` / `ended:signal`（超时才是 expired）。
 * 帧文案带具体 code/signal，不把非零退出与信号都伪装成 expired。
 */
const MONITOR_STDERR_CAP = 4096

function appendMonitorStderr(handle: ActiveMonitor, chunk: string): void {
  if (!chunk) return
  handle.stderrTail = (handle.stderrTail + chunk).slice(-MONITOR_STDERR_CAP)
}

function sessionIdleForMonitorWake(state: { turnMetrics?: unknown; ackTimer?: unknown; lastTurnActiveAt?: number }): boolean {
  return state.turnMetrics == null && state.ackTimer == null && (state.lastTurnActiveAt ?? 0) <= 0
}

function finishMonitor(handle: ActiveMonitor, status: string, detail?: string): void {
  if (handle.finished) return
  handle.finished = true
  active.delete(handle.id)
  if (handle.timer) clearTimeout(handle.timer)
  try {
    handle.kill()
  } catch {
    // 进程/连接可能已自行结束。
  }
  const stderrNote = handle.stderrTail?.trim() ? `\nstderr:\n${handle.stderrTail.trim()}` : ""
  const detailText = [detail, stderrNote].filter(Boolean).join("")
  const endedAt = Date.now()
  persistCounters(handle, status, endedAt)
  const minutes = Math.max(0, Math.round((endedAt - handle.startedAt) / 60_000))
  if (status === "expired") {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.expired",
      `${expiryMessage(minutes, handle.eventCount)}${stderrNote}`,
    )
  } else if (status === "ended" || status.startsWith("ended:")) {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.ended",
      `[Monitor ended: ${detailText || "source closed"}]`,
    )
  } else if (status === "error") {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.error",
      `[Monitor ended with an error: ${detailText || "unknown error"}]`,
    )
  } else {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.stopped",
      stderrNote ? `[Monitor stopped]${stderrNote}` : undefined,
    )
  }
  const parent = resolveSession(handle.sessionId) ?? subagentParentState(handle.sessionId)
  if (parent && sessionIdleForMonitorWake(parent)) {
    const text = `[Monitor Result] ${handle.description} ${status}${detailText ? ` ${detailText}` : ""}`
    void dispatchWorkflowWake(parent, `monitor:${handle.id}`, text, "final").catch((e) => {
      console.error(`[gateway] monitor result wake failed: id=${handle.id}`, e)
    })
  }
  console.log(`[gateway] monitor ${status}: id=${handle.id} session=${handle.sessionId} events=${handle.eventCount} dropped=${handle.droppedCount}`)
}

// ── 采集源 ──────────────────────────────────────────────────────────────
function monitorEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "HOME", "LANG", "TZ"]) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/** M1：detached 让 bash 成为新进程组组长；停止时 SIGTERM 整组，2s 后 SIGKILL 兜底。 */
function killProcessGroup(proc: ReturnType<typeof Bun.spawn>): void {
  const pid = proc.pid
  const termGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // 已退出。
      }
    }
  }
  termGroup("SIGTERM")
  const killer = setTimeout(() => termGroup("SIGKILL"), MONITOR_KILL_GRACE_MS)
  killer.unref?.()
}

/** 按进程组回收（reaper 用：只拿得到 DB 里的 pgid，没有 Bun.spawn 句柄）。 */
function killProcessGroupId(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, signal)
    } catch {
      // ESRCH：组已不存在。
    }
  }
  signalGroup("SIGTERM")
  const killer = setTimeout(() => signalGroup("SIGKILL"), MONITOR_KILL_GRACE_MS)
  killer.unref?.()
}

async function monitorSandbox(sessionId: string): Promise<{ argv: string[]; cwd: string }> {
  // 生产运行时的既有沙箱轮子，绝对路径由部署工作区推导；缺失绝不回落裸 shell。
  const workspace = resolve(process.env.HARNESS_WORKSPACE || "/opt/agent-harness/workspace")
  const modulePath = join(workspace, ".opencode", "lib", "sandbox.ts")
  let sandbox: typeof import("../opencode-runtime/lib/sandbox")
  try { sandbox = await import(pathToFileURL(modulePath).href) }
  catch { throw new MonitorPolicyError("monitor sandbox module unavailable") }
  if (!sandbox.sandboxAvailable() || resolve(sandbox.WORKSPACE) !== workspace) {
    throw new MonitorPolicyError("monitor sandbox unavailable or workspace mismatch")
  }
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!state) throw new MonitorPolicyError("monitor session unavailable")
  // Gateway和运行时是不同UID，监视不占用运行时真实sid的私有.run目录。
  const sandboxSessionId = `monitor:${sessionId}`
  sandbox.setOwner(sandboxSessionId, [state.sessionId])
  sandbox.ensureSessionDirs(sandboxSessionId)
  const cwd = sandbox.sessionRunDir(sandboxSessionId)
  return { argv: sandbox.sandboxPrefix({ sessionID: sandboxSessionId, cwd }), cwd }
}

function spawnCommand(handle: ActiveMonitor, command: string, sandbox: { argv: string[]; cwd: string }): void {
  const proc = Bun.spawn([...sandbox.argv, "--", "/bin/bash", "--noprofile", "--norc", "-c", command], {
    cwd: sandbox.cwd,
    env: monitorEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  handle.kill = () => killProcessGroup(proc)
  // P1：DB 里记的是采集子进程（detached → 自成一个进程组），不是 gateway 自己的 pid。
  // gateway 被 SIGKILL 后，新进程据此 kill(-pgid) 回收孤儿。
  handle.childPid = proc.pid
  handle.childPgid = proc.pid
  try {
    db()
      .query("UPDATE session_monitors SET child_pid=?,child_pgid=? WHERE id=?")
      .run(proc.pid, proc.pid, handle.id)
  } catch (e) {
    killProcessGroup(proc)
    throw new Error(`monitor ${handle.id} failed to record child pid`)
  }

  const stderrDone = (async () => {
    const stderr = proc.stderr
    if (!stderr) return
    const reader = (stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        appendMonitorStderr(handle, decoder.decode(value, { stream: true }))
      }
      appendMonitorStderr(handle, decoder.decode())
    } catch {
      // stderr 读失败不打断 stdout 收档。
    }
  })()

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let overflowed = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // P2：无换行的输出曾把 buffer 撑成无界；超过上限保留尾部并只记一次 output_truncated。
        if (buffer.length > MONITOR_BUFFER_MAX_CHARS) {
          buffer = buffer.slice(-MONITOR_BUFFER_MAX_CHARS)
          if (!overflowed) {
            overflowed = true
            handle.truncatedCount += 1
          }
        }
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          overflowed = false
          if (line.trim()) deliver(handle, line)
          newline = buffer.indexOf("\n")
        }
      }
      buffer += decoder.decode()
      if (buffer.length > MONITOR_BUFFER_MAX_CHARS) {
        buffer = buffer.slice(-MONITOR_BUFFER_MAX_CHARS)
        if (!overflowed) {
          overflowed = true
          handle.truncatedCount += 1
        }
      }
      const tail = buffer.replace(/\r$/, "")
      if (tail.trim()) deliver(handle, tail)
    } catch (e) {
      await stderrDone
      if (!handle.finished) finishMonitor(handle, "error", (e as Error)?.message || String(e))
      return
    }
    await stderrDone
    let code: number | null = null
    try {
      code = await proc.exited
    } catch {
      // 退出码取不到不影响收档。
    }
    const signal = (proc as unknown as { signalCode?: string | null }).signalCode ?? null
    if (!handle.finished) {
      if (signal) {
        finishMonitor(handle, "ended:signal", `process terminated by signal ${signal}`)
      } else {
        const exitCode = code ?? 0
        finishMonitor(handle, "ended:code", `process exited with code ${exitCode}`)
      }
    }
  })()
}

function connectWebSocket(handle: ActiveMonitor, url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("ws must be a valid ws:// or wss:// URL")
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("ws must use ws:// or wss://")
  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch (e) {
    throw new Error(`websocket failed: ${(e as Error)?.message || String(e)}`)
  }
  handle.kill = () => {
    try {
      socket.close()
    } catch {
      // 已关闭。
    }
  }
  socket.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data
    const text =
      typeof data === "string" ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data ?? "")
    for (const line of text.slice(0, MONITOR_BUFFER_MAX_CHARS).split("\n")) if (line.trim()) deliver(handle, line)
  })
  socket.addEventListener("error", () => {
    if (!handle.finished) finishMonitor(handle, "error", "websocket error")
  })
  socket.addEventListener("close", () => {
    if (!handle.finished) finishMonitor(handle, "ended", "websocket closed")
  })
}

// ── 对外 API ────────────────────────────────────────────────────────────
export async function startMonitor(
  sessionId: string,
  input: MonitorInput,
): Promise<{ id: number; status: "running"; timeout_ms: number; description: string }> {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const description = typeof input?.description === "string" ? input.description.trim() : ""
  if (!description) throw new Error("description is required")
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const ws = typeof input.ws === "string" ? input.ws.trim() : ""
  if (Boolean(command) === Boolean(ws)) throw new Error("exactly one of command or ws is required")
  if (command) assertMonitorCommandAllowed(command)
  const timeoutMs = normalizeMonitorTimeout(input.timeout_ms)
  let sandbox: { argv: string[]; cwd: string } | undefined
  if (command) sandbox = await monitorSandbox(sid)
  else {
    let parsed: URL
    try { parsed = new URL(ws) }
    catch { throw new MonitorPolicyError("ws must be a valid ws:// or wss:// URL", "ws_refused") }
    if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.username || parsed.password || ws.length > 4096) {
      throw new MonitorPolicyError("ws must use ws/wss without embedded credentials", "ws_refused")
    }
    try { await assertPublicHost(parsed.hostname) }
    catch { throw new MonitorPolicyError("ws address must resolve only to public IPs", "ws_refused") }
  }

  const startedAt = Date.now()
  const database = db()
  // 同一SQLite事务认领资源槽，防并发HTTP与多进程绕过硬上限。
  const id = database.transaction(() => {
    const counts = database.query("SELECT COUNT(*) AS total,SUM(CASE WHEN session_id=? THEN 1 ELSE 0 END) AS owned FROM session_monitors WHERE status='running'").get(sid) as { total: number; owned: number | null }
    if (counts.total >= MONITOR_MAX_ACTIVE || (counts.owned ?? 0) >= MONITOR_MAX_PER_SESSION) {
      throw new MonitorPolicyError("monitor active limit reached", "monitor_limit")
    }
    return Number(database.query(`INSERT INTO session_monitors(session_id,description,command,ws_url,timeout_ms,status,event_count,dropped_count,truncated_count,started_at,ended_at,last_lines,pid)
      VALUES(?,?,?,?,?,'running',0,0,0,?,NULL,'[]',?)`)
      .run(sid, description.slice(0, 200), command || null, ws || null, timeoutMs, startedAt, process.pid).lastInsertRowid)
  }).immediate()

  const handle: ActiveMonitor = {
    id,
    sessionId: sid,
    description,
    timeoutMs,
    startedAt,
    eventCount: 0,
    droppedCount: 0,
    truncatedCount: 0,
    lastLines: [],
    stderrTail: "",
    windowStart: startedAt,
    windowCount: 0,
    finished: false,
    childPid: null,
    childPgid: null,
    kill: () => {},
  }
  active.set(id, handle)

  try {
    if (command) spawnCommand(handle, command, sandbox!)
    else connectWebSocket(handle, ws)
  } catch (e) {
    active.delete(id)
    handle.finished = true
    persistCounters(handle, "error", Date.now())
    throw new Error(`monitor failed to start: ${(e as Error)?.message || String(e)}`)
  }

  handle.timer = setTimeout(() => finishMonitor(handle, "expired"), timeoutMs)
  handle.timer.unref()
  console.log(`[gateway] monitor started: id=${id} session=${sid} timeout=${timeoutMs}ms source=${command ? "command" : "ws"}`)
  return { id, status: "running", timeout_ms: timeoutMs, description }
}

export function stopMonitor(sessionId: string, id: number): { stopped: boolean; status: string } {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  if (!Number.isInteger(id) || id <= 0) throw new Error("monitor id must be a positive integer")
  const row = db().query("SELECT status FROM session_monitors WHERE id=? AND session_id=?").get(id, sid) as
    | { status: string }
    | null
  if (!row) throw new Error(`monitor ${id} not found for this session`)
  const handle = active.get(id)
  if (handle) finishMonitor(handle, "stopped")
  else if (row.status === "running") {
    db().query("UPDATE session_monitors SET status='stopped',ended_at=? WHERE id=? AND status='running'").run(Date.now(), id)
  }
  return { stopped: row.status === "running", status: row.status === "running" ? "stopped" : row.status }
}

export function listMonitors(sessionId: string): MonitorView[] {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const rows = db().query("SELECT * FROM session_monitors WHERE session_id=? ORDER BY id DESC").all(sid) as SessionMonitorRow[]
  return rows.map((row) => {
    const handle = active.get(row.id)
    return {
      ...row,
      event_count: handle ? handle.eventCount : row.event_count,
      dropped_count: handle ? handle.droppedCount : row.dropped_count,
      last_lines: handle ? [...handle.lastLines] : parseLines(row.last_lines),
    }
  })
}

/** 会话拆除/显式取消时一并收档；返回实际停止的监视数。 */
export function killSessionMonitors(sessionId: string, reason = "stopped"): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  let stopped = 0
  for (const handle of [...active.values()]) {
    if (handle.sessionId !== sid) continue
    finishMonitor(handle, "stopped", reason)
    stopped += 1
  }
  // 只动本进程 owner 的行：另一个存活 gateway 进程对同一 session 的监视不被误杀。
  const res = db()
    .query(
      "UPDATE session_monitors SET status='stopped',ended_at=? WHERE session_id=? AND status='running' AND (pid IS NULL OR pid=?)",
    )
    .run(Date.now(), sid, process.pid)
  return stopped + Number(res.changes)
}

/**
 * M10：保留清理——非 running 且超过 7 天、或每会话超过 200 行。只清终态行。
 */
export function pruneMonitors(now: number = Date.now()): number {
  const handle = db()
  let removed = 0
  const expired = handle
    .query("DELETE FROM session_monitors WHERE status<>'running' AND COALESCE(ended_at,started_at) < ?")
    .run(now - MONITOR_RETENTION_MS)
  removed += Number(expired.changes)
  const sessions = handle
    .query("SELECT session_id FROM session_monitors WHERE status<>'running' GROUP BY session_id HAVING COUNT(*) > ?")
    .all(MONITOR_RETENTION_PER_SESSION) as Array<{ session_id: string }>
  for (const session of sessions) {
    const res = handle
      .query(
        `DELETE FROM session_monitors WHERE session_id=? AND status<>'running'
         AND id NOT IN (
           SELECT id FROM session_monitors WHERE session_id=? AND status<>'running' ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(session.session_id, session.session_id, MONITOR_RETENTION_PER_SESSION)
    removed += Number(res.changes)
  }
  return removed
}

interface MonitorReaper {
  timer: ReturnType<typeof setInterval>
  stop: () => void
}

let reaper: MonitorReaper | null = null

/**
 * 会话存活判定：与其它 /internal 路由同一解析链。
 * - gateway 会话：resolveSession 含 gateway id / opencode id / DB 懒加载；
 * - 子代理会话：subagentParentState 回溯父会话。
 * 旧实现用 `sessions.has(id)`，而 sessions 的键是 gateway UUID —— 用 opencode id
 * 或子会话 id 创建的 monitor 会被每一拍当成「会话已消失」秒杀（P1）。
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sessionAlive(sessionId: string): boolean {
  try {
    return Boolean(resolveSession(sessionId) ?? subagentParentState(sessionId))
  } catch (e) {
    // 解析链异常（DB/宿主）时不误杀正在工作的监视。
    console.error("[gateway] monitor session liveness check failed:", e)
    return true
  }
}

/**
 * 启动全局 reaper（单实例、幂等、.unref()）：刷计数、按墙钟判超时，
 * 收档进程重启后失去内存句柄且 owner pid 已死的 running 行（M3：活跃进程的行绝不动），
 * 并在会话已拆除时杀整个监视进程组（M2 的接线点，无需改 sessions-core）。
 */
export function startMonitorReaper(opts: { intervalMs?: number } = {}): () => void {
  if (reaper) return reaper.stop
  const intervalMs = Math.max(1_000, Math.floor(opts.intervalMs ?? 10_000))
  let tickCount = 0

  const tick = (): void => {
    try {
      const now = Date.now()
      const goneSessions = new Set<string>()
      for (const handle of [...active.values()]) {
        // 会话已被 teardown/DELETE：监视不得继续占用子进程，整组收档。
        if (!sessionAlive(handle.sessionId)) {
          goneSessions.add(handle.sessionId)
          continue
        }
        persistCounters(handle, "running", null)
        if (now - handle.startedAt >= handle.timeoutMs) finishMonitor(handle, "expired")
      }
      // P1：killSessionMonitors 接到会话消失检测，不再是从未被呼叫的死码。
      for (const sid of goneSessions) {
        try {
          const killed = killSessionMonitors(sid, "session gone")
          console.log(`[gateway] monitor session gone: session=${sid} stopped=${killed}`)
        } catch (e) {
          console.error(`[gateway] killSessionMonitors failed for ${sid}:`, e)
        }
      }
      const orphans = db()
        .query(
          "SELECT id,session_id,description,event_count,dropped_count,started_at,pid,child_pid,child_pgid FROM session_monitors WHERE status='running'",
        )
        .all() as Array<{
        id: number
        session_id: string
        description: string
        event_count: number
        dropped_count: number
        started_at: number
        pid: number | null
        child_pid: number | null
        child_pgid: number | null
      }>
      for (const row of orphans) {
        if (active.has(row.id)) continue
        // M3：另一个存活 gateway 进程持有的行不碰；本进程 pid 的遗留行按孤儿处理
        //（pid 复用无法区分，宁可回收采集子进程也不留下孤儿）。
        if (typeof row.pid === "number" && row.pid !== process.pid && pidAlive(row.pid)) continue
        // P1：owner 已死 → 用 DB 里的采集子进程组 id 回收整组（不是 gateway pid）。
        if (typeof row.child_pgid === "number" && row.child_pgid > 1) {
          if (groupAlive(row.child_pgid)) {
            killProcessGroupId(row.child_pgid)
            console.log(
              `[gateway] monitor orphan reaped: id=${row.id} owner=${row.pid ?? "none"} pgid=${row.child_pgid}`,
            )
          }
        }
        db().query("UPDATE session_monitors SET status='expired',ended_at=? WHERE id=? AND status='running'").run(now, row.id)
        const minutes = Math.max(0, Math.round((now - row.started_at) / 60_000))
        emitMonitorFrame(
          row.session_id,
          row.id,
          row.description,
          row.event_count,
          row.dropped_count,
          "monitor.expired",
          expiryMessage(minutes, row.event_count),
        )
      }
      tickCount += 1
      if (tickCount % MONITOR_PRUNE_EVERY_TICKS === 0) pruneMonitors(now)
    } catch (e) {
      console.error("[gateway] monitor reaper error:", e)
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref()
  const stop = (): void => {
    clearInterval(timer)
    if (reaper?.timer === timer) reaper = null
  }
  reaper = { timer, stop }
  tick()
  return stop
}
