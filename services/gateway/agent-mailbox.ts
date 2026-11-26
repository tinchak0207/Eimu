// 持久 agent mailbox：移植 Claude Code 2.1.302 的 TeammateMailbox 语义。
// 约束：
// - 与 sessions 共用 SESSIONS_DB_PATH；模块 import 不开库，所有导出函数显式取连接。
// - 广播（to:"*"）已移除；收件人必须是 main 或已登记成员名。
// - msg_id 幂等作用域 = (session_id, msg_id)：跨会话同名互不干扰；同会话重复投递
//   必须 to/type/text 完全一致，否则 409 msg_id_conflict（不静默成功）。
// - drain 照 cIe：已读行一律物理剪除，未读且未交付的行保留。
// - 事务一律 BEGIN IMMEDIATE + 3 次退避重试：drain/send 与其它进程并发时不让
//   SQLITE_BUSY 冒到 HTTP 层。
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import type { Task } from "./task-board"
import { MESSAGE_TYPES, MAX_TEXT_BYTES, MAX_TEXT_CHARS, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES, MAX_MSG_ID_CHARS, MAX_MSG_ID_BYTES, MAX_TEAM_CHARS, MAX_TEAM_BYTES, MAX_AGENT_CHARS, MAX_AGENT_BYTES, RESERVED_AGENT_NAMES, MailboxValidationError, MailboxTeamConflictError, MailboxRecipientError, MailboxConflictError, type AgentMessage, type AgentMessageType, type MessageRow, type MailboxAgent, type MailboxTeamState, type SendMessageInput, type SendMessageResult, type ReadMessagesOptions, type TeamRow, type TeamMemberRow, type RegisterTeamOptions } from "./agent-mailbox-types"
import { db, withImmediate, primaryTeam, teamMembers, decodeMessage, cleanupDrainedMessages } from "./agent-mailbox-store"
import { requireString, optionalString, singleLine, validateAgentName, isAddressableAgentName, parseTimestamp, validateFrame, validateTeamName } from "./agent-mailbox-validate"

const DEFAULT_LEAD = "team-lead"
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
export { MESSAGE_TYPES, MailboxValidationError, MailboxTeamConflictError, MailboxRecipientError, MailboxConflictError } from "./agent-mailbox-types"
export type { AgentMessageType, AgentMessage, MailboxAgent, MailboxTeamState, SendMessageInput, SendMessageResult, ReadMessagesOptions, TeamRow, TeamMemberRow, RegisterTeamOptions } from "./agent-mailbox-types"
export { validateAgentName, isAddressableAgentName } from "./agent-mailbox-validate"
