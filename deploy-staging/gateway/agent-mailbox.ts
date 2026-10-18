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
  timestamp: string
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

// 输入上限（与 spec 一致）：text 按 UTF-8 字节数，其余按字符数。
const MAX_TEXT_BYTES = 100 * 1024
const MAX_SUMMARY_CHARS = 2000
const MAX_MSG_ID_CHARS = 128
const MAX_TEAM_CHARS = 64
const MAX_AGENT_CHARS = 64

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
  connection = next
  return next
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

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const DEFAULT_LEAD = "team-lead"

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(
  value: unknown,
  field: string,
  opts: { allowEmpty?: boolean; maxLength?: number; maxBytes?: number } = {},
): string {
  if (typeof value !== "string") throw new MailboxValidationError(field, "must be a string")
  const trimmed = value.trim()
  if (!opts.allowEmpty && !trimmed) throw new MailboxValidationError(field, "must not be empty")
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    throw new MailboxValidationError(field, `must be at most ${opts.maxLength} characters`)
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

function parseTimestamp(value: string): number {
  if (!TIMESTAMP_RE.test(value)) throw new MailboxValidationError("timestamp", "must be an ISO-8601 timestamp")
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

function leadOf(sessionId: string): string {
  return primaryTeam(sessionId)?.lead_agent || DEFAULT_LEAD
}

export function getTeamState(sessionId: string): MailboxTeamState {
  const team = primaryTeam(sessionId)
  const members = team ? teamMembers(team.team) : []
  const lead = team?.lead_agent || DEFAULT_LEAD
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

export function registerTeam(sessionId: string, team: string, leadAgent: string): TeamRow {
  const cleanSession = requireString(sessionId, "session_id")
  const cleanTeam = requireString(team, "team", { maxLength: MAX_TEAM_CHARS })
  const cleanLead = requireString(leadAgent, "lead_agent", { maxLength: MAX_AGENT_CHARS })
  singleLine(cleanTeam, "team")
  singleLine(cleanLead, "lead_agent")
  return withImmediate((): TeamRow => {
    const existing = db()
      .query("SELECT team,session_id,lead_agent,created_at FROM agent_teams WHERE team=?")
      .get(cleanTeam) as TeamRow | null
    if (existing && existing.session_id !== cleanSession) {
      throw new MailboxValidationError("team", "is already bound to another session")
    }
    db()
      .query(
        "INSERT INTO agent_teams(team,session_id,lead_agent,created_at) VALUES(?,?,?,?) " +
          "ON CONFLICT(team) DO UPDATE SET lead_agent=excluded.lead_agent",
      )
      .run(cleanTeam, cleanSession, cleanLead, Date.now())
    // M4：lead 轮换时旧 lead 名下未读消息迁移给新 lead（否则新 lead 永远看不到）。
    if (existing && existing.lead_agent !== cleanLead) {
      const info = db()
        .query("UPDATE agent_messages SET to_agent=? WHERE session_id=? AND to_agent=? AND read=0")
        .run(cleanLead, cleanSession, existing.lead_agent)
      const moved = Number(info.changes)
      if (moved > 0) {
        console.log(
          `[gateway] mailbox: lead rotation ${existing.lead_agent} -> ${cleanLead} moved ${moved} unread message(s)`,
        )
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
  })
}

export function addTeamMember(team: string, agent: string, agentType?: string | null): TeamMemberRow {
  const cleanTeam = requireString(team, "team", { maxLength: MAX_TEAM_CHARS })
  const cleanAgent = requireString(agent, "agent", { maxLength: MAX_AGENT_CHARS })
  singleLine(cleanAgent, "agent")
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

/**
 * 派遣接线（subagent.ts 调用）：把 worker 登记进父会话的团队，让 mailbox_agents
 * 能列出它。team 省略时沿用父会话已登记的团队；没有团队则建一个会话级团队，
 * lead 默认 team-lead。该函数不参与编排，仅登记可寻址成员。
 */
export function registerTeamMember(
  sessionId: string,
  team: string | null | undefined,
  agent: string,
  agentType?: string | null,
): TeamMemberRow {
  const cleanSession = requireString(sessionId, "session_id")
  const cleanAgent = requireString(agent, "agent", { maxLength: MAX_AGENT_CHARS })
  singleLine(cleanAgent, "agent")
  const existing = primaryTeam(cleanSession)
  const explicitTeam = typeof team === "string" ? team.trim() : ""
  const teamName = explicitTeam || existing?.team || `team-${cleanSession}`.slice(0, MAX_TEAM_CHARS)
  registerTeam(cleanSession, teamName, existing?.lead_agent || DEFAULT_LEAD)
  return addTeamMember(teamName, cleanAgent, agentType ?? null)
}

export function resolveRecipient(
  sessionId: string,
  to: string,
): { name: string; role: "lead" | "member"; agent_type: string | null; team: string | null } {
  const cleanSession = requireString(sessionId, "session_id")
  const target = requireString(to, "to")
  singleLine(target, "to")
  if (target === "*") {
    throw new MailboxValidationError("to", 'broadcast (to: "*") is not supported; send one message per recipient')
  }
  if (target.includes("@")) {
    throw new MailboxValidationError("to", "must be a bare agent name")
  }
  const team = primaryTeam(cleanSession)
  const lead = team?.lead_agent || DEFAULT_LEAD
  const members = team ? teamMembers(team.team) : []
  if (target === "main") {
    return { name: lead, role: "lead", agent_type: null, team: team?.team ?? null }
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
  const from = requireString(input.from, "from", { maxLength: MAX_AGENT_CHARS })
  const text = requireString(input.text, "text", { allowEmpty: true, maxBytes: MAX_TEXT_BYTES })
  if (!text.trim()) throw new MailboxValidationError("text", "must not be blank")
  singleLine(from, "from")
  const to = requireString(input.to, "to")
  singleLine(to, "to")
  const timestamp = requireString(input.timestamp, "timestamp")
  const createdAt = parseTimestamp(timestamp)
  const type = (input.type === undefined ? "message" : requireString(input.type, "type")) as AgentMessageType
  if (!MESSAGE_TYPES.includes(type)) {
    throw new MailboxValidationError("type", `must be one of ${MESSAGE_TYPES.join(", ")}`)
  }
  validateFrame(type, text)
  const summary =
    input.summary === undefined || input.summary === null
      ? null
      : requireString(input.summary, "summary", { allowEmpty: true, maxLength: MAX_SUMMARY_CHARS })
  const color = optionalString(input.color, "color")
  const msgId =
    input.msg_id === undefined
      ? `msg_${randomUUID()}`
      : requireString(input.msg_id, "msg_id", { maxLength: MAX_MSG_ID_CHARS })
  singleLine(msgId, "msg_id")
  const teamOverride =
    input.team === undefined || input.team === null
      ? null
      : requireString(input.team, "team", { maxLength: MAX_TEAM_CHARS })
  if (teamOverride) singleLine(teamOverride, "team")

  return withImmediate((): SendMessageResult => {
    // 幂等短路先于收件人解析：重试同一 msg_id 不因团队变更而失败。
    // 但同一 (session_id,msg_id) 的 to/type/text 必须完全一致，否则 409 而不是静默成功。
    const existing = db()
      .query("SELECT msg_id,to_agent,type,text,team FROM agent_messages WHERE session_id=? AND msg_id=?")
      .get(sessionId, msgId) as { msg_id: string; to_agent: string; type: string; text: string; team: string | null } | null
    if (existing) {
      const expectedTo = to === "main" ? leadOf(sessionId) : to
      if (existing.to_agent !== expectedTo || existing.type !== type || existing.text !== text) {
        throw new MailboxConflictError(
          `msg_id "${msgId}" already exists in session "${sessionId}" with different to/type/text`,
        )
      }
      return { msg_id: existing.msg_id, to: existing.to_agent, team: existing.team, duplicate: true, delivered: false }
    }
    const resolved = resolveRecipient(sessionId, to)
    const team = teamOverride ?? primaryTeam(sessionId)?.team ?? null
    try {
      db()
        .query(
          "INSERT INTO agent_messages(msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at) " +
            "VALUES(?,?,?,?,?,?,?,?,?,0,?)",
        )
        .run(msgId, sessionId, team, from, resolved.name, type, text, summary, color, createdAt)
    } catch (e) {
      // 并发竞态：另一进程刚插了同一 (session_id,msg_id)。按同一套冲突语义收口，
      // 不把 UNIQUE 约束错误冒成 500。
      const message = e instanceof Error ? e.message : String(e)
      if (/UNIQUE constraint failed/i.test(message)) {
        const raced = db()
          .query("SELECT msg_id,to_agent,type,text,team FROM agent_messages WHERE session_id=? AND msg_id=?")
          .get(sessionId, msgId) as
          | { msg_id: string; to_agent: string; type: string; text: string; team: string | null }
          | null
        if (raced) {
          if (raced.to_agent !== resolved.name || raced.type !== type || raced.text !== text) {
            throw new MailboxConflictError(
              `msg_id "${msgId}" already exists in session "${sessionId}" with different to/type/text`,
            )
          }
          return { msg_id: raced.msg_id, to: raced.to_agent, team: raced.team, duplicate: true, delivered: false }
        }
      }
      throw e
    }
    return { msg_id: msgId, to: resolved.name, team, duplicate: false, delivered: true }
  })
}

export function readMessages(sessionId: string, agent: string, options: ReadMessagesOptions = {}): AgentMessage[] {
  const cleanSession = requireString(sessionId, "session_id")
  // H3：读的 agent 必须是该会话团队里的可寻址成员（main 归一化为 lead），否则 404。
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
    // M2：after 游标与排序同源——统一按 id 升序，不再混入 read/created_at。
    const rows = db()
      .query(
        "SELECT id,msg_id,session_id,team,from_agent,to_agent,type,text,summary,color,read,created_at " +
          "FROM agent_messages WHERE session_id=? AND to_agent=? AND id>? " +
          "ORDER BY id ASC LIMIT ?",
      )
      .all(cleanSession, target, after ?? 0, limit) as MessageRow[]
    if (drain) {
      // 约束：照 cIe——已读行全部剪除，本次交付行（含未读）也剪除；未交付的未读保留。
      db().query("DELETE FROM agent_messages WHERE session_id=? AND to_agent=? AND read=1").run(cleanSession, target)
      if (rows.length > 0) {
        const ids = rows.map((row) => row.id)
        db()
          .query(`DELETE FROM agent_messages WHERE id IN (${ids.map(() => "?").join(",")})`)
          .run(...ids)
      }
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
  const ids = [...new Set(msgIds.map((id) => requireString(id, "msg_ids[]")))]
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
  assignedBy = DEFAULT_LEAD,
): SendMessageResult {
  const timestamp = new Date().toISOString()
  const frame = {
    type: "task_assignment",
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    assignedBy,
    timestamp,
  }
  return sendMessage({
    sessionId,
    from: assignedBy,
    to,
    text: JSON.stringify(frame),
    timestamp,
    type: "task_assignment",
  })
}
