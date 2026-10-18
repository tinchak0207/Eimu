import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import type { Task } from "./task-board"

// 持久 agent mailbox：移植 Claude Code 2.1.302 的 TeammateMailbox 语义。
// 约束：
// - 与 sessions 共用 SESSIONS_DB_PATH；模块 import 不开库，所有导出函数显式取连接。
// - 广播（to:"*"）已移除；收件人必须是 main 或已登记成员名。
// - msg_id 幂等作用域 = (session_id, msg_id)：跨会话同名互不干扰；同会话重复投递
//   必须 to/type/text 完全一致，否则 409 msg_id_conflict（不静默成功）。
// - drain 照 cIe：已读行一律物理剪除，未读且未交付的行保留。
// - 事务一律 BEGIN IMMEDIATE + 3 次退避重试：drain/send 与其它进程并发时不让
//   SQLITE_BUSY 冒到 HTTP 层。

export const MESSAGE_TYPES = [
  "message",
  "idle_notification",
  "task_assignment",
  "task_completed",
  "teammate_terminated",
  "plan_approval_request",
  "plan_approval_response",
  "permission_request",
  "permission_response",
  "sandbox_permission_request",
  "sandbox_permission_response",
] as const

export type AgentMessageType = (typeof MESSAGE_TYPES)[number]

export type AgentMessage = {
  id: number
  msg_id: string
  session_id: string
  team: string | null
  from: string
  to: string
  type: AgentMessageType
  text: string
  summary: string | null
  color: string | null
  read: boolean
  timestamp: string
  created_at: number
}

export type MailboxAgent = {
  name: string
  role: "lead" | "member"
  agent_type: string | null
  team: string | null
}

export type MailboxTeamState = {
  session_id: string
  team: string | null
  lead: string
  agents: MailboxAgent[]
  addressable: string[]
}

export type SendMessageInput = {
  sessionId: string
  from: string
  to: string
  text: string
  /** 省略＝服务端取 now（重试时不参与幂等比较，避免服务端时间漂移造成假冲突）。 */
  timestamp?: string
  type?: string
  summary?: string
  color?: string
  team?: string | null
  msg_id?: string
}

export type SendMessageResult = {
  msg_id: string
  to: string
  team: string | null
  duplicate: boolean
  /** false = 本次没有新落库（幂等短路），调用方不得把它当成交付成功。 */
  delivered: boolean
}

export type ReadMessagesOptions = {
  after?: number
  limit?: number
  drain?: boolean
}

export type TeamRow = {
  team: string
  session_id: string
  lead_agent: string
  created_at: number
}

export type TeamMemberRow = {
  team: string
  agent: string
  agent_type: string | null
  joined_at: number
}

export class MailboxValidationError extends Error {
  readonly code = "mailbox_validation"
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = "MailboxValidationError"
    this.field = field
  }
}

/** 同一会话已有主团队且与请求团队不同（需要显式 switch:true 才能迁移）。 */
export class MailboxTeamConflictError extends Error {
  readonly code = "team_conflict"
  readonly currentTeam: string

  constructor(message: string, currentTeam: string) {
    super(message)
    this.name = "MailboxTeamConflictError"
    this.currentTeam = currentTeam
  }
}

export class MailboxRecipientError extends Error {
  readonly code = "unknown_recipient"
  readonly candidates: string[]

  constructor(message: string, candidates: string[]) {
    const suffix = candidates.length > 0 ? `; candidates: ${candidates.join(", ")}` : "; no addressable agents"
    super(`${message}${suffix}`)
    this.name = "MailboxRecipientError"
    this.candidates = candidates
  }
}

/** 同一 (session_id, msg_id) 的重复投递内容不一致：调用方必须按 409 处理，不得当成功。 */
export class MailboxConflictError extends Error {
  readonly code = "msg_id_conflict"

  constructor(message: string) {
    super(message)
    this.name = "MailboxConflictError"
  }
}

// 输入上限：UTF-16 字符数与 UTF-8 字节数双限（两者必须一致生效）。
const MAX_TEXT_BYTES = 100 * 1024
const MAX_TEXT_CHARS = 100 * 1024
const MAX_SUMMARY_CHARS = 2000
const MAX_SUMMARY_BYTES = MAX_SUMMARY_CHARS * 4
const MAX_MSG_ID_CHARS = 128
const MAX_MSG_ID_BYTES = MAX_MSG_ID_CHARS * 4
const MAX_TEAM_CHARS = 64
const MAX_TEAM_BYTES = MAX_TEAM_CHARS * 4
const MAX_AGENT_CHARS = 64
const MAX_AGENT_BYTES = MAX_AGENT_CHARS * 4

// P2 名册卫生：这些形态不是可寻址成员名（main 是 lead 的别名，不是可注册成员）。
const RESERVED_AGENT_NAMES = new Set(["main", "user", "system"])

// drain 后的 tombstone 保留窗口：超过 7 天物理清理（唯一键保留期内保证幂等）。
const DRAIN_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

type MessageRow = {
  id: number
  msg_id: string
  session_id: string
  team: string | null
  from_agent: string
  to_agent: string
  type: string
  text: string
  summary: string | null
  color: string | null
  read: number
  created_at: number
}

let connection: Database | undefined

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    team TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'message',
    text TEXT NOT NULL,
    summary TEXT,
    color TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(session_id,msg_id));
    CREATE TABLE IF NOT EXISTS agent_teams (
      team TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      lead_agent TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_team_members (
      team TEXT NOT NULL,
      agent TEXT NOT NULL,
      agent_type TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(team,agent));
    CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(session_id,to_agent,read);`)
  migrateMsgIdScope(next)
  ensureTombstoneColumn(next)
  connection = next
  return next
}

/**
 * read=2 是 drain tombstone（不再物理删行）：唯一键在保留窗口内继续保证
 * 同一 msg_id 重试不重投。老库补 delivered_at 列；无该列时旧语义仍然成立。
 */
function ensureTombstoneColumn(conn: Database): void {
  const columns = conn.query("PRAGMA table_info(agent_messages)").all() as Array<{ name?: string }>
  if (!columns.some((column) => column.name === "delivered_at")) {
    conn.exec("ALTER TABLE agent_messages ADD COLUMN delivered_at INTEGER")
  }
  conn.exec(
    "CREATE INDEX IF NOT EXISTS agent_messages_drained ON agent_messages(read, delivered_at);" +
      "CREATE INDEX IF NOT EXISTS agent_messages_agent_inbox ON agent_messages(session_id,to_agent,read,id);",
  )
  cleanupDrainedMessages(conn)
}

/** 清理策略：drain tombstone 超过 7 天物理删除（只在开库/写入时跑，成本 O(过期行数)）。 */
function cleanupDrainedMessages(conn: Database): void {
  const cutoff = Date.now() - DRAIN_TOMBSTONE_RETENTION_MS
  conn.query("DELETE FROM agent_messages WHERE read=2 AND delivered_at IS NOT NULL AND delivered_at < ?").run(cutoff)
}

/**
 * H1 迁移：旧表是 msg_id 全局 UNIQUE；新语义是 (session_id,msg_id) 唯一。
 * SQLite 不能就地改约束，只能在 IMMEDIATE 事务里重建表（保留 id 与全部行）。
 * 多进程同时启动时事务串行化，第二个进程在事务内重读 schema 后直接跳过。
 */
function migrateMsgIdScope(conn: Database): void {
  const readSql = (): string => {
    const row = conn
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_messages'")
      .get() as { sql?: string } | null
    return typeof row?.sql === "string" ? row.sql : ""
  }
  const current = readSql()
  if (!current || /unique\s*\(\s*session_id\s*,\s*msg_id\s*\)/i.test(current)) return
  conn.exec("BEGIN IMMEDIATE")
  try {
    if (/unique\s*\(\s*session_id\s*,\s*msg_id\s*\)/i.test(readSql())) {
      conn.exec("COMMIT")
      return
    }
    conn.exec(`DROP TABLE IF EXISTS agent_messages_legacy;
      ALTER TABLE agent_messages RENAME TO agent_messages_legacy;
      CREATE TABLE agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        team TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        text TEXT NOT NULL,
        summary TEXT,
        color TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(session_id,msg_id));
      INSERT INTO agent_messages(id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at)
        SELECT id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at FROM agent_messages_legacy;
      DROP TABLE agent_messages_legacy;
      CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(session_id,to_agent,read);`)
    conn.exec("COMMIT")
    console.warn("[gateway] mailbox: migrated agent_messages to UNIQUE(session_id,msg_id)")
  } catch (e) {
    try {
      conn.exec("ROLLBACK")
    } catch {
      // 已经回滚或连接已失效：保留原始错误。
    }
    throw e
  }
}

// ── 事务：BEGIN IMMEDIATE + 3 次退避重试（M3）─────────────────────────────
const BUSY_RETRY_DELAYS_MS = [25, 75, 150]

function sleepSync(ms: number): void {
  // bun:sqlite 是同步 API；这里也用同步睡眠，避免事务跨 await 变成多线程竞争。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms)
}

function isBusyError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return /SQLITE_BUSY|database (?:table )?is locked/i.test(text)
}

/** 立即事务（写锁一开始就拿到），SQLITE_BUSY 最多重试 3 次。 */
function withImmediate<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      db().exec("BEGIN IMMEDIATE")
    } catch (e) {
      if (attempt < BUSY_RETRY_DELAYS_MS.length && isBusyError(e)) {
        sleepSync(BUSY_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
    try {
      const result = fn()
      db().exec("COMMIT")
      return result
    } catch (e) {
      try {
        db().exec("ROLLBACK")
      } catch {
        // 事务可能已被 SQLite 自动回滚。
      }
      if (attempt < BUSY_RETRY_DELAYS_MS.length && isBusyError(e)) {
        sleepSync(BUSY_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
  }
}

const DEFAULT_LEAD = "team-lead"

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ANSI/控制字符/NUL、C1、bidi 控制符：邮件正文、摘要与所有标识符一律拒绝。
// （ESC 含在 C0 区间内；允许的换行/制表符由 opts.allowWhitespace 显式放行。）
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const FORBIDDEN_BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function assertSafeText(value: string, field: string, allowWhitespace = false): void {
  const control = allowWhitespace
    ? value.replace(/[\t\n\r]/g, "").match(FORBIDDEN_CONTROL_RE)
    : value.match(FORBIDDEN_CONTROL_RE)
  if (control) {
    throw new MailboxValidationError(
      field,
      `contains forbidden control character U+${control[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    )
  }
  if (FORBIDDEN_BIDI_RE.test(value)) throw new MailboxValidationError(field, "contains forbidden bidi control character")
  if (LONE_SURROGATE_RE.test(value)) throw new MailboxValidationError(field, "contains a lone UTF-16 surrogate")
}

function requireString(
  value: unknown,
  field: string,
  opts: { allowEmpty?: boolean; maxLength?: number; maxBytes?: number; allowWhitespace?: boolean } = {},
): string {
  if (typeof value !== "string") throw new MailboxValidationError(field, "must be a string")
  assertSafeText(value, field, opts.allowWhitespace === true)
  const trimmed = value.trim()
  if (!opts.allowEmpty && !trimmed) throw new MailboxValidationError(field, "must not be empty")
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    throw new MailboxValidationError(field, `must be at most ${opts.maxLength} UTF-16 characters`)
  }
  if (opts.maxBytes !== undefined && Buffer.byteLength(value, "utf8") > opts.maxBytes) {
    throw new MailboxValidationError(field, `must be at most ${opts.maxBytes} bytes`)
  }
  return opts.allowEmpty ? value : trimmed
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new MailboxValidationError(field, "must be a string")
  return value
}

function singleLine(value: string, field: string): void {
  if (/[\n\r]/u.test(value)) throw new MailboxValidationError(field, "must be a single line")
}

/** 可寻址成员名：拒绝广播/别名/保留名与 @ 形态，双长度上限。 */
export function validateAgentName(value: unknown, field = "agent"): string {
  const clean = requireString(value, field, { maxLength: MAX_AGENT_CHARS, maxBytes: MAX_AGENT_BYTES })
  singleLine(clean, field)
  if (clean === "*" || clean === "@" || clean.includes("*") || clean.includes("@")) {
    throw new MailboxValidationError(field, 'must be a bare agent name (broadcast "*" and "@" forms are not addressable)')
  }
  if (RESERVED_AGENT_NAMES.has(clean.toLowerCase())) {
    throw new MailboxValidationError(field, `"${clean}" is reserved; use "main" only as a recipient alias`)
  }
  return clean
}

export function isAddressableAgentName(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    validateAgentName(value)
    return true
  } catch {
    return false
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  if ([4, 6, 9, 11].includes(month)) return 30
  return 31
}

/**
 * ISO-8601 严格校验：Date.parse 会把 2 月 30 日静默滚到 3 月 2 日，
 * 所以先逐段校验日历合法性（含闰年）与时区偏移范围。
 */
function parseTimestamp(value: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) throw new MailboxValidationError("timestamp", "must be an ISO-8601 timestamp")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12) throw new MailboxValidationError("timestamp", "has an invalid month")
  if (day < 1 || day > daysInMonth(year, month)) throw new MailboxValidationError("timestamp", "is not a valid calendar date")
  if (hour > 23 || minute > 59 || second > 59) throw new MailboxValidationError("timestamp", "has an invalid time of day")
  if (match[7] !== undefined) {
    const offsetHour = Number(match[7])
    const offsetMinute = Number(match[8])
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new MailboxValidationError("timestamp", "has an invalid timezone offset")
    }
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new MailboxValidationError("timestamp", "is not a valid date")
  return parsed
}

function validateFrame(type: AgentMessageType, text: string): void {
  if (type === "message") return
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    throw new MailboxValidationError("text", `type ${type} requires a JSON frame`)
  }
  if (!isPlainRecord(frame)) throw new MailboxValidationError("text", `type ${type} requires a JSON object frame`)
  if (frame.type !== type) throw new MailboxValidationError("text.type", `must equal "${type}"`)

  const need = (field: string): unknown => {
    if (frame[field] === undefined || frame[field] === null) {
      throw new MailboxValidationError(`text.${field}`, `is required by ${type}`)
    }
    return frame[field]
  }
  const needString = (field: string): string => requireString(need(field), `text.${field}`)
  const needBool = (field: string): boolean => {
    const value = need(field)
    if (typeof value !== "boolean") throw new MailboxValidationError(`text.${field}`, "must be a boolean")
    return value
  }
  const optionalFrameString = (field: string): void => {
    if (frame[field] !== undefined && frame[field] !== null && typeof frame[field] !== "string") {
      throw new MailboxValidationError(`text.${field}`, "must be a string")
    }
  }
  // M5：taskId 只接受非空 string 或正整数 number；其它形状一律 400。
  const needTaskId = (): void => {
    const value = need("taskId")
    const valid =
      (typeof value === "string" && value.trim().length > 0) ||
      (typeof value === "number" && Number.isInteger(value) && value > 0)
    if (!valid) throw new MailboxValidationError("text.taskId", "must be a non-empty string or a positive integer")
  }

  switch (type) {
    case "idle_notification": {
      if (frame.idleReason !== undefined) {
        if (!["available", "interrupted", "failed"].includes(String(frame.idleReason))) {
          throw new MailboxValidationError("text.idleReason", "must be available, interrupted or failed")
        }
      }
      if (frame.completedStatus !== undefined) {
        if (!["resolved", "blocked", "failed"].includes(String(frame.completedStatus))) {
          throw new MailboxValidationError("text.completedStatus", "must be resolved, blocked or failed")
        }
      }
      optionalFrameString("summary")
      optionalFrameString("completedTaskId")
      optionalFrameString("failureReason")
      optionalFrameString("result")
      return
    }
    case "task_assignment": {
      needTaskId()
      needString("subject")
      needString("description")
      needString("assignedBy")
      return
    }
    case "task_completed": {
      needTaskId()
      needString("taskSubject")
      return
    }
    case "teammate_terminated": {
      needString("message")
      return
    }
    case "plan_approval_request": {
      needString("requestId")
      optionalFrameString("planFilePath")
      optionalFrameString("planContent")
      return
    }
    case "plan_approval_response": {
      needString("requestId")
      needBool("approved")
      optionalFrameString("feedback")
      return
    }
    case "permission_request": {
      needString("request_id")
      needString("tool_name")
      optionalFrameString("agent_id")
      optionalFrameString("tool_use_id")
      optionalFrameString("description")
      if (frame.permission_suggestions !== undefined && !Array.isArray(frame.permission_suggestions)) {
        throw new MailboxValidationError("text.permission_suggestions", "must be an array")
      }
      return
    }
    case "permission_response": {
      needString("request_id")
      const subtype = needString("subtype")
      if (subtype !== "success" && subtype !== "error") {
        throw new MailboxValidationError("text.subtype", "must be success or error")
      }
      optionalFrameString("tool_use_id")
      if (subtype === "error") needString("error")
      else if (frame.response !== undefined && !isPlainRecord(frame.response)) {
        throw new MailboxValidationError("text.response", "must be an object")
      }
      return
    }
    case "sandbox_permission_request": {
      needString("requestId")
      const hasHost = typeof frame.host === "string" && frame.host.length > 0
      const hostPattern = isPlainRecord(frame.hostPattern) ? frame.hostPattern.host : undefined
      if (!hasHost && !(typeof hostPattern === "string" && hostPattern.length > 0)) {
        throw new MailboxValidationError("text.host", "is required (or text.hostPattern.host)")
      }
      optionalFrameString("workerId")
      optionalFrameString("workerName")
      optionalFrameString("workerColor")
      return
    }
    case "sandbox_permission_response": {
      needString("requestId")
      needString("host")
      needBool("allow")
      return
    }
    default:
      throw new MailboxValidationError("type", `unsupported message type "${type}"`)
  }
}

function decodeMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    msg_id: row.msg_id,
    session_id: row.session_id,
    team: row.team,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type as AgentMessageType,
    text: row.text,
    summary: row.summary,
    color: row.color,
    read: row.read === 1,
    timestamp: new Date(row.created_at).toISOString(),
    created_at: row.created_at,
  }
}

function primaryTeam(sessionId: string): TeamRow | null {
  return (
    (db()
      .query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE session_id=? ORDER BY created_at ASC, team ASC LIMIT 1")
      .get(sessionId) as TeamRow | null) ?? null
  )
}

function teamMembers(team: string): TeamMemberRow[] {
  return db()
    .query("SELECT team,agent,agent_type,joined_at FROM agent_team_members WHERE team=? ORDER BY joined_at ASC, agent ASC")
    .all(team) as TeamMemberRow[]
}

export function leadOf(sessionId: string): string {
  return primaryTeam(sessionId)?.lead_agent || DEFAULT_LEAD
}

export function getTeamState(sessionId: string): MailboxTeamState {
  const team = primaryTeam(sessionId)
  const rawMembers = team ? teamMembers(team.team) : []
  // P2：名册只列可寻址成员（历史脏数据里的 "*"／"@"／"main"／空白名不出现）。
  const members = rawMembers.filter((member) => isAddressableAgentName(member.agent))
  const lead = isAddressableAgentName(team?.lead_agent) ? (team as TeamRow).lead_agent : DEFAULT_LEAD
  const agents: MailboxAgent[] = [
    { name: lead, role: "lead", agent_type: null, team: team?.team ?? null },
    ...members
      .filter((member) => member.agent !== lead)
      .map((member) => ({
        name: member.agent,
        role: "member" as const,
        agent_type: member.agent_type,
        team: member.team,
      })),
  ]
  return {
    session_id: sessionId,
    team: team?.team ?? null,
    lead,
    agents,
    addressable: [...new Set([lead, ...members.map((member) => member.agent), "main"])],
  }
}

type RegisterTeamOptions = { switch?: boolean }

function validateTeamName(value: unknown): string {
  const clean = requireString(value, "team", { maxLength: MAX_TEAM_CHARS, maxBytes: MAX_TEAM_BYTES })
  singleLine(clean, "team")
  return clean
}

/** 调用方必须已在 withImmediate 事务内。单一主团队不变量在此处强制。 */
function registerTeamTx(
  cleanSession: string,
  cleanTeam: string,
  cleanLead: string,
  options: RegisterTeamOptions,
): TeamRow {
  const byName = db()
    .query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE team=?")
    .get(cleanTeam) as TeamRow | null
  if (byName && byName.session_id !== cleanSession) {
    throw new MailboxValidationError("team", "is already bound to another session")
  }
  const existing = primaryTeam(cleanSession)
  if (existing && existing.team !== cleanTeam && options.switch !== true) {
    throw new MailboxTeamConflictError(
      `session already has team "${existing.team}"; pass switch:true to migrate members and messages to "${cleanTeam}"`,
      existing.team,
    )
  }
  // 把所有历史团队（含 legacy 多团队）折叠进 cleanTeam：成员/消息迁移后删旧行，
  // 保证一个会话只有一个主团队，不会出现第二团队静默孤儿。
  const staleTeams = (
    db().query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE session_id=? AND team<>?").all(
      cleanSession,
      cleanTeam,
    ) as TeamRow[]
  )
  if (staleTeams.length > 0 && options.switch !== true) {
    throw new MailboxTeamConflictError(
      `session already has team "${staleTeams[0].team}"; pass switch:true to migrate members and messages`,
      staleTeams[0].team,
    )
  }
  const previousLead = existing?.lead_agent ?? byName?.lead_agent ?? null
  for (const stale of staleTeams) {
    db()
      .query(
        "INSERT OR IGNORE INTO agent_team_members(team,agent,agent_type,joined_at) " +
          "SELECT ?,agent,agent_type,joined_at FROM agent_team_members WHERE team=?",
      )
      .run(cleanTeam, stale.team)
    db().query("UPDATE agent_messages SET team=? WHERE session_id=? AND team=?").run(cleanTeam, cleanSession, stale.team)
    db().query("DELETE FROM agent_team_members WHERE team=?").run(stale.team)
    db().query("DELETE FROM agent_teams WHERE team=?").run(stale.team)
  }
  db()
    .query(
      "INSERT INTO agent_teams(team,session_id,lead_agent,created_at) VALUES(?,?,?,?) " +
        "ON CONFLICT(team) DO UPDATE SET lead_agent=excluded.lead_agent",
    )
    .run(cleanTeam, cleanSession, cleanLead, Date.now())
  // M4：lead 轮换时旧 lead 名下未读消息迁移给新 lead（否则新 lead 永远看不到）。
  if (previousLead && previousLead !== cleanLead) {
    const info = db()
      .query("UPDATE agent_messages SET to_agent=? WHERE session_id=? AND to_agent=? AND read=0")
      .run(cleanLead, cleanSession, previousLead)
    const moved = Number(info.changes)
    if (moved > 0) {
      console.log(`[gateway] mailbox: lead rotation ${previousLead} -> ${cleanLead} moved ${moved} unread message(s)`)
    }
  }
  return (
    (db()
      .query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE session_id=? ORDER BY created_at ASC, team ASC LIMIT 1")
      .get(cleanSession) as TeamRow | null) ?? {
      team: cleanTeam,
      session_id: cleanSession,
      lead_agent: cleanLead,
      created_at: Date.now(),
    }
  )
}

export function registerTeam(
  sessionId: string,
  team: string,
  leadAgent: string,
  options: RegisterTeamOptions = {},
): TeamRow {
  const cleanSession = requireString(sessionId, "session_id")
  const cleanTeam = validateTeamName(team)
  const cleanLead = validateAgentName(leadAgent, "lead_agent")
  return withImmediate(() => registerTeamTx(cleanSession, cleanTeam, cleanLead, options))
}

/** 调用方必须已在事务内。 */
function addTeamMemberTx(cleanTeam: string, cleanAgent: string, agentType?: string | null): TeamMemberRow {
  const exists = db().query("SELECT team FROM agent_teams WHERE team=?").get(cleanTeam)
  if (!exists) throw new MailboxValidationError("team", `unknown team "${cleanTeam}"`)
  db()
    .query(
      "INSERT INTO agent_team_members(team,agent,agent_type,joined_at) VALUES(?,?,?,?) " +
        "ON CONFLICT(team,agent) DO UPDATE SET agent_type=COALESCE(excluded.agent_type,agent_team_members.agent_type)",
    )
    .run(cleanTeam, cleanAgent, agentType || null, Date.now())
  return db()
    .query("SELECT team,agent,agent_type,joined_at FROM agent_team_members WHERE team=? AND agent=?")
    .get(cleanTeam, cleanAgent) as TeamMemberRow
}

export function addTeamMember(team: string, agent: string, agentType?: string | null): TeamMemberRow {
  const cleanTeam = validateTeamName(team)
  const cleanAgent = validateAgentName(agent)
  return withImmediate(() => addTeamMemberTx(cleanTeam, cleanAgent, agentType))
}

export function removeTeamMember(team: string, agent: string): number {
  const cleanTeam = validateTeamName(team)
  const cleanAgent = validateAgentName(agent)
  return withImmediate(() => {
    const info = db().query("DELETE FROM agent_team_members WHERE team=? AND agent=?").run(cleanTeam, cleanAgent)
    return Number(info.changes)
  })
}

export type TeamMemberInput = { agent: string; agentType?: string | null }

/**
 * P1 原子批量登记：先校验整批（任一非法即整批不落库），再在单一事务里写团队＋成员。
 * 用于 POST /internal/mailbox/team（不再逐条调用 addTeamMember 形成半批状态）。
 */
export function registerTeamWithMembers(
  sessionId: string,
  team: string,
  leadAgent: string,
  members: TeamMemberInput[],
  options: RegisterTeamOptions = {},
): MailboxTeamState {
  const cleanSession = requireString(sessionId, "session_id")
  const cleanTeam = validateTeamName(team)
  const cleanLead = validateAgentName(leadAgent, "lead_agent")
  const validated: TeamMemberInput[] = []
  const seen = new Set<string>()
  for (const member of members) {
    const agent = validateAgentName(member.agent)
    if (agent === cleanLead || seen.has(agent)) continue
    seen.add(agent)
    validated.push({ agent, agentType: member.agentType ?? null })
  }
  withImmediate(() => {
    registerTeamTx(cleanSession, cleanTeam, cleanLead, options)
    for (const member of validated) addTeamMemberTx(cleanTeam, member.agent, member.agentType ?? null)
  })
  return getTeamState(cleanSession)
}

/**
 * 派遣接线（subagent.ts 调用）：把 worker 登记进父会话的团队，让 mailbox_agents
 * 能列出它。team 省略时沿用父会话已登记的团队；没有团队则建一个会话级团队，
 * lead 默认 team-lead。uniquePerRun：同名成员已存在时用 `name#shortRun`，
 * 旧成员名下的未读消息不自动继承（消息仍留在旧名邮箱，物理隔离）。
 */
export function registerTeamMember(
  sessionId: string,
  team: string | null | undefined,
  agent: string,
  agentType?: string | null,
  options: { runId?: string; uniquePerRun?: boolean; replaceStale?: boolean } = {},
): TeamMemberRow {
  const cleanSession = requireString(sessionId, "session_id")
  const cleanAgent = validateAgentName(agent)
  return withImmediate(() => {
    const existing = primaryTeam(cleanSession)
    const explicitTeam = typeof team === "string" ? team.trim() : ""
    const teamName = explicitTeam || existing?.team || `team-${cleanSession}`.slice(0, MAX_TEAM_CHARS)
    const lead = existing?.lead_agent || DEFAULT_LEAD
    registerTeamTx(cleanSession, teamName, lead, {
      switch: Boolean(explicitTeam && existing && explicitTeam !== existing.team) ? false : true,
    })
    let finalAgent = cleanAgent
    if (options.uniquePerRun === true && cleanAgent !== lead) {
      const taken = db()
        .query("SELECT agent FROM agent_team_members WHERE team=? AND agent=?")
        .get(teamName, cleanAgent) as { agent: string } | null
      if (taken) {
        const suffix = `#${(options.runId ?? randomUUID()).slice(0, 8)}`
        finalAgent = `${cleanAgent.slice(0, Math.max(1, MAX_AGENT_CHARS - suffix.length))}${suffix}`
        // 旧 run 已结束才允许摘除旧名（replaceStale）；仍有活 run 时保留其可寻址性。
        if (options.replaceStale === true) {
          db().query("DELETE FROM agent_team_members WHERE team=? AND agent=?").run(teamName, cleanAgent)
        }
      }
    }
    return addTeamMemberTx(teamName, finalAgent, agentType ?? null)
  })
}

export function resolveRecipient(
  sessionId: string,
  to: string,
): { name: string; role: "lead" | "member"; agent_type: string | null; team: string | null } {
  const cleanSession = requireString(sessionId, "session_id")
  const target = requireString(to, "to", { maxLength: MAX_AGENT_CHARS, maxBytes: MAX_AGENT_BYTES })
  singleLine(target, "to")
  const team = primaryTeam(cleanSession)
  const lead = team?.lead_agent || DEFAULT_LEAD
  const members = (team ? teamMembers(team.team) : []).filter((row) => isAddressableAgentName(row.agent))
  if (target === "main") {
    return { name: lead, role: "lead", agent_type: null, team: team?.team ?? null }
  }
  if (target === "*") {
    throw new MailboxValidationError("to", 'broadcast (to: "*") is not supported; send one message per recipient')
  }
  if (target === "@" || target.includes("@") || target.includes("*")) {
    throw new MailboxValidationError("to", "must be a bare agent name")
  }
  if (RESERVED_AGENT_NAMES.has(target.toLowerCase())) {
    throw new MailboxValidationError("to", `"${target}" is reserved and not addressable`)
  }
  const member = members.find((row) => row.agent === target)
  if (member) {
    return {
      name: member.agent,
      role: member.agent === lead ? "lead" : "member",
      agent_type: member.agent_type,
      team: member.team,
    }
  }
  if (target === lead) {
    return { name: lead, role: "lead", agent_type: null, team: team?.team ?? null }
  }
  const candidates = [...new Set([lead, ...members.map((row) => row.agent)])]
  throw new MailboxRecipientError(`unknown recipient "${target}"`, candidates)
}

export function sendMessage(input: SendMessageInput): SendMessageResult {
  const sessionId = requireString(input.sessionId, "session_id")
  const from = validateAgentName(input.from, "from")
  const text = requireString(input.text, "text", {
    allowEmpty: true,
    allowWhitespace: true,
    maxBytes: MAX_TEXT_BYTES,
    maxLength: MAX_TEXT_CHARS,
  })
  if (!text.trim()) throw new MailboxValidationError("text", "must not be blank")
  const to = requireString(input.to, "to", { maxLength: MAX_AGENT_CHARS, maxBytes: MAX_AGENT_BYTES })
  singleLine(to, "to")
  const timestampExplicit =
    input.timestamp !== undefined && input.timestamp !== null && String(input.timestamp).trim() !== ""
  const timestamp = timestampExplicit ? requireString(input.timestamp, "timestamp") : new Date().toISOString()
  const createdAt = parseTimestamp(timestamp)
  const type = (input.type === undefined ? "message" : requireString(input.type, "type")) as AgentMessageType
  if (!MESSAGE_TYPES.includes(type)) {
    throw new MailboxValidationError("type", `must be one of ${MESSAGE_TYPES.join(", ")}`)
  }
  validateFrame(type, text)
  const summary =
    input.summary === undefined || input.summary === null
      ? null
      : requireString(input.summary, "summary", {
          allowEmpty: true,
          allowWhitespace: true,
          maxLength: MAX_SUMMARY_CHARS,
          maxBytes: MAX_SUMMARY_BYTES,
        })
  const color = optionalString(input.color, "color")
  const msgId =
    input.msg_id === undefined
      ? `msg_${randomUUID()}`
      : requireString(input.msg_id, "msg_id", { maxLength: MAX_MSG_ID_CHARS, maxBytes: MAX_MSG_ID_BYTES })
  singleLine(msgId, "msg_id")
  const teamOverride =
    input.team === undefined || input.team === null
      ? null
      : requireString(input.team, "team", { maxLength: MAX_TEAM_CHARS, maxBytes: MAX_TEAM_BYTES })
  if (teamOverride) singleLine(teamOverride, "team")

  return withImmediate((): SendMessageResult => {
    cleanupDrainedMessages(db())
    const expectedTeam = teamOverride ?? primaryTeam(sessionId)?.team ?? null
    // P1：比较字段加入 from/timestamp/team/summary——内容不同的同 msg_id 一律 409。
    type Existing = {
      msg_id: string
      from_agent: string
      to_agent: string
      type: string
      text: string
      summary: string | null
      team: string | null
      created_at: number
    }
    const existing = db()
      .query(
        "SELECT msg_id,from_agent,to_agent,type,text,summary,team,created_at " +
          "FROM agent_messages WHERE session_id=? AND msg_id=?",
      )
      .get(sessionId, msgId) as Existing | null
    const conflictIfChanged = (row: Existing, expectedTo: string): void => {
      const changed: string[] = []
      if (row.from_agent !== from) changed.push("from")
      if (row.to_agent !== expectedTo) changed.push("to")
      if (row.type !== type) changed.push("type")
      if (row.text !== text) changed.push("text")
      if ((row.summary ?? null) !== (summary ?? null)) changed.push("summary")
      if ((row.team ?? null) !== (expectedTeam ?? null)) changed.push("team")
      // 只有调用方显式给 timestamp 时才比较；服务端 now 不参与（否则幂等重试必假冲突）。
      if (timestampExplicit && row.created_at !== createdAt) changed.push("timestamp")
      if (changed.length > 0) {
        throw new MailboxConflictError(
          `msg_id "${msgId}" already exists in session "${sessionId}" with different ${changed.join("/")}`,
        )
      }
    }
    if (existing) {
      const expectedTo = to === "main" ? leadOf(sessionId) : to
      conflictIfChanged(existing, expectedTo)
      return { msg_id: existing.msg_id, to: existing.to_agent, team: existing.team, duplicate: true, delivered: false }
    }
    const resolved = resolveRecipient(sessionId, to)
    try {
      db()
        .query(
          "INSERT INTO agent_messages(msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at) " +
            "VALUES(?,?,?,?,?,?,?,?,?,0,?)",
        )
        .run(msgId, sessionId, expectedTeam, from, resolved.name, type, text, summary, color, createdAt)
    } catch (e) {
      // 并发竞态：另一进程刚插了同一 (session_id,msg_id)。按同一套冲突语义收口，
      // 不把 UNIQUE 约束错误冒成 500。
      const message = e instanceof Error ? e.message : String(e)
      if (/UNIQUE constraint failed/i.test(message)) {
        const raced = db()
          .query(
            "SELECT msg_id,from_agent,to_agent,type,text,summary,team,created_at " +
              "FROM agent_messages WHERE session_id=? AND msg_id=?",
          )
          .get(sessionId, msgId) as Existing | null
        if (raced) {
          conflictIfChanged(raced, resolved.name)
          return { msg_id: raced.msg_id, to: raced.to_agent, team: raced.team, duplicate: true, delivered: false }
        }
      }
      throw e
    }
    return { msg_id: msgId, to: resolved.name, team: expectedTeam, duplicate: false, delivered: true }
  })
}

export function readMessages(sessionId: string, agent: string, options: ReadMessagesOptions = {}): AgentMessage[] {
  const cleanSession = requireString(sessionId, "session_id")
  // H3：读的 agent 必须是该会话团队里的可寻址成员（main 归一化为 lead），否则 404。
  // HTTP 端只传服务端推导的调用者身份；这里仍保留 recipient 解析作为纵深防御。
  const target = resolveRecipient(cleanSession, agent).name
  const limit = options.limit === undefined ? 50 : options.limit
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new MailboxValidationError("limit", "must be an integer between 1 and 500")
  }
  const after = options.after
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
    throw new MailboxValidationError("after", "must be a non-negative message id")
  }
  if (options.drain !== undefined && typeof options.drain !== "boolean") {
    throw new MailboxValidationError("drain", "must be a boolean")
  }
  const drain = options.drain === true

  return withImmediate((): AgentMessage[] => {
    // P2：明确实现「未读优先、同级最旧优先」。after 仍是 id 游标（同一排序内生效）。
    // read=2 是 drain tombstone，不再投递。
    const rows = db()
      .query(
        "SELECT id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at " +
          "FROM agent_messages WHERE session_id=? AND to_agent=? AND read<>2 AND id>? " +
          "ORDER BY CASE WHEN read=0 THEN 0 ELSE 1 END ASC, id ASC LIMIT ?",
      )
      .all(cleanSession, target, after ?? 0, limit) as MessageRow[]
    if (drain) {
      // P1：不物理删除——已读行与本次交付行统一打 tombstone（read=2, delivered_at），
      // 唯一键保留＝同一 msg_id 重试不再重投；未交付的未读行原样保留。
      const now = Date.now()
      db()
        .query("UPDATE agent_messages SET read=2, delivered_at=? WHERE session_id=? AND to_agent=? AND read=1")
        .run(now, cleanSession, target)
      if (rows.length > 0) {
        const ids = rows.map((row) => row.id)
        db()
          .query(`UPDATE agent_messages SET read=2, delivered_at=? WHERE id IN (${ids.map(() => "?").join(",")}) AND read<>2`)
          .run(now, ...ids)
      }
      cleanupDrainedMessages(db())
    }
    return rows.map(decodeMessage)
  })
}

export function markRead(sessionId: string, agent: string, msgIds: string[]): number {
  const cleanSession = requireString(sessionId, "session_id")
  // 与 read 同一边界：未知 agent 不得静默标记 0 条。
  const target = resolveRecipient(cleanSession, agent).name
  if (!Array.isArray(msgIds) || msgIds.length === 0) {
    throw new MailboxValidationError("msg_ids", "must be a non-empty array")
  }
  // P2：全非法（非字符串/空白）→ 400（与工具描述一致），混合批次只处理合法项。
  const ids = [
    ...new Set(
      msgIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => requireString(id, "msg_ids[]", { maxLength: MAX_MSG_ID_CHARS, maxBytes: MAX_MSG_ID_BYTES })),
    ),
  ]
  if (ids.length === 0) {
    throw new MailboxValidationError("msg_ids", "must contain at least one non-empty string")
  }
  let marked = 0
  withImmediate(() => {
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      const info = db()
        .query(
          `UPDATE agent_messages SET read=1 WHERE session_id=? AND to_agent=? AND read=0 AND msg_id IN (${chunk
            .map(() => "?")
            .join(",")})`,
        )
        .run(cleanSession, target, ...chunk)
      marked += Number(info.changes)
    }
  })
  return marked
}

/**
 * 任务板联动：TaskUpdate 成功后可调用本函数把 task_assignment 帧投给认领者。
 * 只读 task-board 的 Task 类型，不改它。
 */
export function sendTaskAssignment(
  sessionId: string,
  to: string,
  task: Pick<Task, "id" | "subject" | "description">,
  assignedBy?: string,
  options: { msgId?: string; timestamp?: string } = {},
): SendMessageResult {
  // P1：from 用该会话真实 lead（不再硬编码 team-lead）；调用方可显式覆盖。
  const sender = assignedBy ?? leadOf(sessionId)
  const timestamp = options.timestamp ?? new Date().toISOString()
  const frame = {
    type: "task_assignment",
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    assignedBy: sender,
    timestamp,
  }
  return sendMessage({
    sessionId,
    from: sender,
    to,
    text: JSON.stringify(frame),
    timestamp,
    type: "task_assignment",
    msg_id: options.msgId,
  })
}
