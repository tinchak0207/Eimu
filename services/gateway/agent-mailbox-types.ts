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
export const MAX_TEXT_BYTES = 100 * 1024
export const MAX_TEXT_CHARS = 100 * 1024
export const MAX_SUMMARY_CHARS = 2000
export const MAX_SUMMARY_BYTES = MAX_SUMMARY_CHARS * 4
export const MAX_MSG_ID_CHARS = 128
export const MAX_MSG_ID_BYTES = MAX_MSG_ID_CHARS * 4
export const MAX_TEAM_CHARS = 64
export const MAX_TEAM_BYTES = MAX_TEAM_CHARS * 4
export const MAX_AGENT_CHARS = 64
export const MAX_AGENT_BYTES = MAX_AGENT_CHARS * 4

// P2 名册卫生：这些形态不是可寻址成员名（main 是 lead 的别名，不是可注册成员）。
export const RESERVED_AGENT_NAMES = new Set(["main", "user", "system"])

// drain 后的 tombstone 保留窗口：超过 7 天物理清理（唯一键保留期内保证幂等）。
export const DRAIN_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type MessageRow = {
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
export type RegisterTeamOptions = { switch?: boolean }
