// Monitor（事件监视）持久层、子进程/WebSocket 采集与 reaper。
//
// 语义取证自 Claude Code 2.1.302 的 Monitor：
// - description 必填（短句）；
// - timeout_ms 默认 300000，上限 1800000（超过压到上限）；
// - command 与 ws 二选一：命令每行 stdout = 一个事件，进程退出即结束；ws 每帧 = 一个事件；
// - 事件到达时作为会话事件推送（复用 emitToSession），不打断当前 turn，也不是用户发言；
// - 超时/结束注入一条系统通知（见 expiryMessage）；0 事件时附 widen the filter 提示；
// - 同一 monitor 每秒最多 20 条进入会话，超出丢弃并计数（防 firehose）。
//
// 约束：
// - 模块 import 时不得启动任何定时器；reaper 只能由 startMonitorReaper() 显式启动。
// - 与 job-store.ts 同一条真源（SESSIONS_DB_PATH），WAL + CREATE TABLE IF NOT EXISTS。
// - 子进程只用 Bun.spawn（bash -lc），cwd=/opt/agent-harness/workspace（HARNESS_WORKSPACE 可覆写），
//   env 只传 PATH/HOME/LANG/TZ；stdout 按行切分；spawn 时 detached=true，停止时杀整个进程组。
// - 命令安全闸是最小防线，不是沙箱：按 shell 分词逐段检查危险形态（含引号/反引号/$()/管道），
//   真正的权限边界在 Eimu 既有工具闸与宿主隔离。
import { Database } from "bun:sqlite"
import { emitToSession } from "./sse-core.ts"
import { resolveSession, sessions } from "./sessions-core.ts"

export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000
export const MONITOR_MIN_TIMEOUT_MS = 1_000
export const MONITOR_MAX_EVENTS_PER_SECOND = 20
export const MONITOR_LAST_LINES = 50
const MONITOR_LINE_MAX_CHARS = 2_000
const MONITOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MONITOR_RETENTION_PER_SESSION = 200
const MONITOR_PRUNE_EVERY_TICKS = 60
const MONITOR_KILL_GRACE_MS = 2_000

type SessionStateLike = NonNullable<ReturnType<typeof resolveSession>>

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
  pid: number | null
}

export interface MonitorView extends Omit<SessionMonitorRow, "last_lines"> {
  last_lines: string[]
}

export class MonitorPolicyError extends Error {
  constructor(message = "command refused by monitor policy") {
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

// ── 命令安全闸（最小防线）──────────────────────────────────────────────
// 按 shell 词法切分后逐段检查命令位置与危险模式；引号、反引号、$() 都会被展开后再判，
// 因此 `bash -c 'rm -rf /'`、`echo $(rm -rf /)`、`/usr/bin/sudo` 都无法用字串变形绕过。

interface ShellToken {
  value: string
  subs: string[]
  op: boolean
}

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"])
const HARD_DENY = new Set([
  "sudo",
  "doas",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "su",
  "mkfs",
  "eval",
])
const COMMAND_PREFIXES = new Set(["env", "command", "exec", "nohup", "builtin", "time", "xargs"])

function basename(word: string): string {
  const trimmed = word.replace(/\/+$/, "")
  const index = trimmed.lastIndexOf("/")
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** 读取平衡括号内的 $() 内容；返回内容与右括号之后的下标。 */
function readParen(source: string, start: number): { text: string; end: number } {
  let depth = 1
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === "'") {
      index += 1
      while (index < source.length && source[index] !== "'") index += 1
      index += 1
      continue
    }
    if (char === '"') {
      index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1
        index += 1
      }
      index += 1
      continue
    }
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return { text: source.slice(start, index), end: index + 1 }
    }
    index += 1
  }
  return { text: source.slice(start), end: source.length }
}

function readBacktick(source: string, start: number): { text: string; end: number } {
  let index = start
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === "`") return { text: source.slice(start, index), end: index + 1 }
    index += 1
  }
  return { text: source.slice(start), end: source.length }
}

function lexShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let current = ""
  let started = false
  let subs: string[] = []
  let index = 0

  const pushWord = (): void => {
    if (!started) return
    tokens.push({ value: current, subs, op: false })
    current = ""
    subs = []
    started = false
  }
  const pushOp = (op: string): void => {
    pushWord()
    tokens.push({ value: op, subs: [], op: true })
  }

  while (index < source.length) {
    const char = source[index]
    if (char === "'") {
      started = true
      index += 1
      while (index < source.length && source[index] !== "'") {
        current += source[index]
        index += 1
      }
      index += 1
      continue
    }
    if (char === '"') {
      started = true
      index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          current += source[index + 1]
          index += 2
          continue
        }
        if (source[index] === "$" && source[index + 1] === "(") {
          const sub = readParen(source, index + 2)
          subs.push(sub.text)
          current += sub.text
          index = sub.end
          continue
        }
        if (source[index] === "`") {
          const sub = readBacktick(source, index + 1)
          subs.push(sub.text)
          current += sub.text
          index = sub.end
          continue
        }
        current += source[index]
        index += 1
      }
      index += 1
      continue
    }
    if (char === "\\" && index + 1 < source.length) {
      started = true
      current += source[index + 1]
      index += 2
      continue
    }
    if (char === "`") {
      started = true
      const sub = readBacktick(source, index + 1)
      subs.push(sub.text)
      current += sub.text
      index = sub.end
      continue
    }
    if (char === "$" && source[index + 1] === "(") {
      started = true
      const sub = readParen(source, index + 2)
      subs.push(sub.text)
      current += sub.text
      index = sub.end
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
      pushOp(char === "\n" ? ";" : char)
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      pushWord()
      index += 1
      continue
    }
    started = true
    current += char
    index += 1
  }
  pushWord()
  return tokens
}

function checkSegment(words: ShellToken[], pipelineIndex: number, depth: number): void {
  for (const word of words) {
    for (const sub of word.subs) assertCommandInternal(sub, depth + 1)
  }
  const values = words.map((word) => word.value)
  let index = 0
  while (index < values.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index])) index += 1
  while (index < values.length && COMMAND_PREFIXES.has(basename(values[index]))) {
    index += 1
    while (index < values.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index])) index += 1
  }
  if (index >= values.length) return
  const command = basename(values[index])
  const args = values.slice(index + 1)

  // 硬拒绝：命令词出现在任何位置（含 `xargs sudo`）都拒绝。
  for (const value of values) {
    const word = basename(value)
    if (HARD_DENY.has(word) || word.startsWith("mkfs.")) {
      throw new MonitorPolicyError(`command refused by monitor policy (${word})`)
    }
  }

  if (SHELL_NAMES.has(command)) {
    if (args.some((arg) => arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) {
      throw new MonitorPolicyError("command refused by monitor policy (shell -c)")
    }
    if (pipelineIndex > 0) {
      throw new MonitorPolicyError("command refused by monitor policy (pipe into shell)")
    }
  }

  if (command === "dd" && values.some((value) => value.startsWith("of=/dev/"))) {
    throw new MonitorPolicyError("command refused by monitor policy (dd of=/dev/)")
  }

  if (command === "rm") {
    let recursive = false
    let force = false
    for (const arg of args) {
      if (arg === "--recursive") recursive = true
      else if (arg === "--force") force = true
      else if (/^-[A-Za-z]+$/.test(arg)) {
        const flags = arg.slice(1)
        if (/[rR]/.test(flags)) recursive = true
        if (flags.includes("f")) force = true
      }
    }
    if (recursive && force) {
      throw new MonitorPolicyError("command refused by monitor policy (rm recursive+force)")
    }
    if (recursive && args.some((arg) => arg === "/" || arg === "/*" || arg === "//")) {
      throw new MonitorPolicyError("command refused by monitor policy (rm -r /)")
    }
  }
}

function assertCommandInternal(command: string, depth: number): void {
  if (depth > 8) throw new MonitorPolicyError("command refused by monitor policy (nested substitution)")
  const tokens = lexShell(command)
  let segment: ShellToken[] = []
  let pipelineIndex = 0
  const flush = (): void => {
    if (segment.length > 0) checkSegment(segment, pipelineIndex, depth)
    segment = []
  }
  for (const token of tokens) {
    if (!token.op) {
      segment.push(token)
      continue
    }
    if (token.value === "|") {
      flush()
      pipelineIndex += 1
      continue
    }
    flush()
    pipelineIndex = 0
  }
  flush()
}

export function assertMonitorCommandAllowed(command: string): void {
  if (typeof command !== "string" || !command.trim()) {
    throw new MonitorPolicyError("command refused by monitor policy (empty command)")
  }
  assertCommandInternal(command, 0)
}

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
    pid INTEGER
  );
  CREATE INDEX IF NOT EXISTS session_monitors_session ON session_monitors(session_id, status);`)
  ensureColumn(next, "session_monitors", "pid", "INTEGER")
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
  lastLines: string[]
  windowStart: number
  windowCount: number
  finished: boolean
  kill: () => void
  timer?: ReturnType<typeof setTimeout>
  state?: SessionStateLike
}

const active = new Map<number, ActiveMonitor>()

function stateFor(handle: ActiveMonitor): SessionStateLike | undefined {
  if (!handle.state) handle.state = resolveSession(handle.sessionId)
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
    .query("UPDATE session_monitors SET status=?,event_count=?,dropped_count=?,ended_at=?,last_lines=? WHERE id=?")
    .run(status, handle.eventCount, handle.droppedCount, endedAt, JSON.stringify(handle.lastLines), handle.id)
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
  const state = resolveSession(sessionId)
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
      expiryMessage(minutes, handle.eventCount),
    )
  } else if (status === "ended" || status.startsWith("ended:")) {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.ended",
      `[Monitor ended: ${detail || "source closed"}]`,
    )
  } else if (status === "error") {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.error",
      `[Monitor ended with an error: ${detail || "unknown error"}]`,
    )
  } else {
    emitMonitorFrame(handle.sessionId, handle.id, handle.description, handle.eventCount, handle.droppedCount, "monitor.stopped")
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

function spawnCommand(handle: ActiveMonitor, command: string): void {
  const cwd = process.env.HARNESS_WORKSPACE || "/opt/agent-harness/workspace"
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    env: monitorEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  })
  handle.kill = () => killProcessGroup(proc)

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (line.trim()) deliver(handle, line)
          newline = buffer.indexOf("\n")
        }
      }
      buffer += decoder.decode()
      const tail = buffer.replace(/\r$/, "")
      if (tail.trim()) deliver(handle, tail)
    } catch (e) {
      if (!handle.finished) finishMonitor(handle, "error", (e as Error)?.message || String(e))
    }
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
    for (const line of text.split("\n")) if (line.trim()) deliver(handle, line)
  })
  socket.addEventListener("error", () => {
    if (!handle.finished) finishMonitor(handle, "error", "websocket error")
  })
  socket.addEventListener("close", () => {
    if (!handle.finished) finishMonitor(handle, "ended", "websocket closed")
  })
}

// ── 对外 API ────────────────────────────────────────────────────────────
export function startMonitor(
  sessionId: string,
  input: MonitorInput,
): { id: number; status: "running"; timeout_ms: number; description: string } {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const description = typeof input?.description === "string" ? input.description.trim() : ""
  if (!description) throw new Error("description is required")
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const ws = typeof input.ws === "string" ? input.ws.trim() : ""
  if (Boolean(command) === Boolean(ws)) throw new Error("exactly one of command or ws is required")
  if (command) assertMonitorCommandAllowed(command)
  const timeoutMs = normalizeMonitorTimeout(input.timeout_ms)

  const startedAt = Date.now()
  const inserted = db()
    .query(`INSERT INTO session_monitors(session_id,description,command,ws_url,timeout_ms,status,event_count,dropped_count,started_at,ended_at,last_lines,pid)
      VALUES(?,?,?,?,?,'running',0,0,?,NULL,'[]',?)`)
    .run(sid, description.slice(0, 200), command || null, ws || null, timeoutMs, startedAt, process.pid)
  const id = Number(inserted.lastInsertRowid)

  const handle: ActiveMonitor = {
    id,
    sessionId: sid,
    description,
    timeoutMs,
    startedAt,
    eventCount: 0,
    droppedCount: 0,
    lastLines: [],
    windowStart: startedAt,
    windowCount: 0,
    finished: false,
    kill: () => {},
  }
  active.set(id, handle)

  try {
    if (command) spawnCommand(handle, command)
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
export function killSessionMonitors(sessionId: string): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  let stopped = 0
  for (const handle of [...active.values()]) {
    if (handle.sessionId !== sid) continue
    finishMonitor(handle, "stopped")
    stopped += 1
  }
  const res = db().query("UPDATE session_monitors SET status='stopped',ended_at=? WHERE session_id=? AND status='running'").run(Date.now(), sid)
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
      for (const handle of [...active.values()]) {
        // 会话已被 teardown/DELETE：监视不得继续占用子进程，整组收档。
        // 只看内存表：绝不能在这里 resolveSession——DB 懒加载会把已 teardown 的会话复活。
        if (!sessions.has(handle.sessionId)) {
          finishMonitor(handle, "stopped", "session gone")
          continue
        }
        persistCounters(handle, "running", null)
        if (now - handle.startedAt >= handle.timeoutMs) finishMonitor(handle, "expired")
      }
      const orphans = db()
        .query("SELECT id,session_id,description,event_count,dropped_count,started_at,pid FROM session_monitors WHERE status='running'")
        .all() as Array<{
        id: number
        session_id: string
        description: string
        event_count: number
        dropped_count: number
        started_at: number
        pid: number | null
      }>
      for (const row of orphans) {
        if (active.has(row.id)) continue
        // M3：owner 仍存活的行不碰（可能是另一个 gateway 进程的监视）。
        if (typeof row.pid === "number" && pidAlive(row.pid)) continue
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
