import { jsonError } from "./gw-lib.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentMailboxMemberName, subagentParentState } from "./subagent.ts"
import {
  MailboxConflictError,
  MailboxRecipientError,
  MailboxTeamConflictError,
  MailboxValidationError,
  getTeamState,
  markRead,
  readMessages,
  registerTeamWithMembers,
  resolveRecipient,
  sendMessage,
  type TeamMemberInput,
} from "./agent-mailbox.ts"

// POST /internal/mailbox/{send,read,mark-read,agents,team}。
// 身份模型（P0）：
// - from/self **一律由服务端按 session 推导**，工具自报的 from 不参与写入；
//   body.from 与推导结果不同 → 403 forged_from（明确拒绝，不静默忽略）。
// - 子会话（opencode subagent session）→ 派遣时登记的成员名（run.name / label）。
// - 主会话 → 该团队 lead（默认 team-lead）。
// - read/mark-read/drain 只作用于调用者自己的邮箱；指定他人邮箱 → 403。
// - 机器 critic / goal evaluator 不登记，明确不可寻址（403 unaddressable_agent）。
// 约束：
// - loopback 鉴权由 router 上游的 /internal/* 闸门负责；这不是身份鉴权。
// - HARNESS_INTERNAL_TOKEN 设置时所有 mailbox 请求都强制校验 X-Internal-Token。
// - HARNESS_MAILBOX_TRUSTED_FROM 设置时校验服务端推导出的发件人名是否在名单内。
// - 子会话 id 一律收敛到父会话，mailbox 的持久键始终是父 session_id。
// - 收件人只有 main 与已登记成员名；广播在 agent-mailbox 内被拒。
// - 一个会话只允许一个主团队；第二个团队必须 switch:true（迁移成员/消息）否则 409。

const PREFIX = "/internal/mailbox/"

class MailboxForbiddenError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "MailboxForbiddenError"
    this.code = code
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalRecordString(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/** H2：task-board 与 mailbox 共用同一套 session 归一化（子会话 → 父会话）。 */
export function canonicalMailboxSessionId(sessionId: string): string {
  const state = resolveSession(sessionId) ?? subagentParentState(sessionId)
  return typeof state?.sessionId === "string" && state.sessionId ? state.sessionId : sessionId
}

type MailboxCaller = {
  /** 持久键：父 gateway 会话 id。 */
  sessionId: string
  /** 服务端推导的邮箱名（lead 或登记成员名）。 */
  agent: string
  kind: "lead" | "member"
}

/**
 * P0 身份解析：不信任任何 body.agent/from。
 * - 能 resolveSession → 主会话，身份＝该会话 lead。
 * - 只能 subagentParentState → 子会话，身份＝派遣登记名（未登记/机器内审 → 403）。
 */
function resolveMailboxCaller(rawSessionId: string): MailboxCaller {
  const direct = resolveSession(rawSessionId)
  if (direct) {
    const sessionId = typeof direct.sessionId === "string" && direct.sessionId ? direct.sessionId : rawSessionId
    return { sessionId, agent: getTeamState(sessionId).lead, kind: "lead" }
  }
  const parent = subagentParentState(rawSessionId)
  if (parent && typeof parent.sessionId === "string" && parent.sessionId) {
    const agent = subagentMailboxMemberName(rawSessionId)
    if (!agent) {
      throw new MailboxForbiddenError(
        "unaddressable_agent",
        "this subagent session has no registered mailbox identity (machine critic/goal evaluator or unregistered run)",
      )
    }
    return { sessionId: parent.sessionId, agent, kind: "member" }
  }
  // 解析不到会话：保持原有宽容语义（持久键用原始 id，身份退回 lead）。
  return { sessionId: rawSessionId, agent: getTeamState(rawSessionId).lead, kind: "lead" }
}

function trustedFrom(): Set<string> | null {
  const raw = process.env.HARNESS_MAILBOX_TRUSTED_FROM
  if (typeof raw !== "string" || !raw.trim()) return null
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  return names.length > 0 ? new Set(names) : null
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** HARNESS_INTERNAL_TOKEN 设置时强制校验（工具端会带同名 env 的 header）。 */
function authorizeInternal(req: Request): boolean {
  const expected = process.env.HARNESS_INTERNAL_TOKEN
  if (typeof expected !== "string" || !expected) return true
  const supplied = req.headers.get("x-internal-token") ?? ""
  return tokensEqual(supplied, expected)
}

let warnedLeadChangeTrust = false

/**
 * M4：HTTP 改 lead 需要 X-Internal-Token。仓库没有既有内部 token 机制，故用
 * HARNESS_INTERNAL_TOKEN；未设置时只允许 router 的 loopback 门（并记录一次告警）。
 */
function authorizeLeadChange(req: Request): boolean {
  const expected = process.env.HARNESS_INTERNAL_TOKEN
  if (typeof expected === "string" && expected) {
    const supplied = req.headers.get("x-internal-token") ?? ""
    return tokensEqual(supplied, expected)
  }
  if (!warnedLeadChangeTrust) {
    warnedLeadChangeTrust = true
    console.warn(
      "[gateway] mailbox: HARNESS_INTERNAL_TOKEN unset; lead change allowed only by the /internal/* loopback trust boundary",
    )
  }
  return true
}

function mailboxError(e: unknown): Response {
  if (e instanceof MailboxValidationError) {
    return jsonError(400, e.message, "bad_request", e.code)
  }
  if (e instanceof MailboxTeamConflictError) {
    return Response.json(
      {
        ok: false,
        error: { message: e.message, type: "conflict", code: e.code },
        current_team: e.currentTeam,
      },
      { status: 409 },
    )
  }
  if (e instanceof MailboxConflictError) {
    return jsonError(409, e.message, "conflict", e.code)
  }
  if (e instanceof MailboxForbiddenError) {
    return jsonError(403, e.message, "forbidden", e.code)
  }
  if (e instanceof MailboxRecipientError) {
    return Response.json(
      { ok: false, error: { message: e.message, type: "not_found", code: e.code }, candidates: e.candidates },
      { status: 404 },
    )
  }
  return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "mailbox_error")
}

/** 校验调用者只能操作自己的邮箱；main 是 lead 的别名。 */
function assertOwnMailbox(caller: MailboxCaller, requested: string | undefined): void {
  if (!requested) return
  const normalized = requested === "main" ? getTeamState(caller.sessionId).lead : requested
  if (normalized !== caller.agent) {
    throw new MailboxForbiddenError(
      "forbidden_mailbox",
      `agent "${requested}" is not the caller identity "${caller.agent}"; read/mark-read only the caller's own mailbox`,
    )
  }
}

export async function handleMailbox(req: Request, pathname: string): Promise<Response> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (!isPlainRecord(parsed)) return jsonError(400, "json body must be an object", "bad_request", "bad_request")
  const body = parsed
  const rawSessionId = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!rawSessionId) return jsonError(400, "session_id is required", "bad_request", "bad_request")

  if (!authorizeInternal(req)) {
    return jsonError(403, "a valid X-Internal-Token is required", "forbidden", "internal_token_required")
  }

  try {
    const caller = resolveMailboxCaller(rawSessionId)
    const sessionId = caller.sessionId
    switch (pathname.slice(PREFIX.length)) {
      case "send": {
        const claimedFrom = optionalRecordString(body, "from", "from_agent")
        // P0：from 由服务端推导；显式不同＝冒充，直接 403（"main" 仅对 main 会话等价）。
        if (claimedFrom && claimedFrom !== caller.agent) {
          const alias = claimedFrom === "main" && caller.kind === "lead"
          if (!alias) {
            throw new MailboxForbiddenError(
              "forged_from",
              `from "${claimedFrom}" does not match the server-resolved identity "${caller.agent}"`,
            )
          }
        }
        const allow = trustedFrom()
        if (allow && !allow.has(caller.agent)) {
          return jsonError(
            403,
            `from "${caller.agent}" is not in HARNESS_MAILBOX_TRUSTED_FROM`,
            "forbidden",
            "untrusted_from",
          )
        }
        const to = optionalRecordString(body, "to", "to_agent")
        if (!to) return jsonError(400, "to is required", "bad_request", "bad_request")
        if (typeof body.text !== "string") return jsonError(400, "text is required", "bad_request", "bad_request")
        let timestamp: string | undefined
        if (body.timestamp === undefined || body.timestamp === null) {
          timestamp = undefined
        } else if (typeof body.timestamp !== "string") {
          return jsonError(400, "timestamp must be an ISO-8601 string", "bad_request", "bad_request")
        } else if (!body.timestamp.trim()) {
          timestamp = undefined
        } else {
          // 非法时间戳由 sendMessage 抛 400，不再静默改成 now。
          timestamp = body.timestamp.trim()
        }
        const result = sendMessage({
          sessionId,
          from: caller.agent,
          to,
          text: body.text,
          timestamp,
          type: typeof body.type === "string" ? body.type : undefined,
          summary: typeof body.summary === "string" ? body.summary : undefined,
          color: typeof body.color === "string" ? body.color : undefined,
          team: typeof body.team === "string" ? body.team : undefined,
          msg_id: typeof body.msg_id === "string" ? body.msg_id : undefined,
        })
        // delivered=false 表示幂等短路（同一 msg_id 已存在），不是本次新交付。
        return Response.json({ ok: true, success: true, from: caller.agent, ...result })
      }
      case "read": {
        const requestedAgent = optionalRecordString(body, "agent", "to")
        assertOwnMailbox(caller, requestedAgent)
        // 严格类型：不再把 "true"/"10" 这类字符串静默当成未设置。
        if (body.after !== undefined && (typeof body.after !== "number" || !Number.isInteger(body.after) || body.after < 0)) {
          return jsonError(400, "after must be a non-negative integer", "bad_request", "bad_request")
        }
        if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit))) {
          return jsonError(400, "limit must be an integer", "bad_request", "bad_request")
        }
        if (body.drain !== undefined && typeof body.drain !== "boolean") {
          return jsonError(400, "drain must be a boolean", "bad_request", "bad_request")
        }
        const messages = readMessages(sessionId, caller.agent, {
          after: body.after as number | undefined,
          limit: body.limit as number | undefined,
          drain: body.drain as boolean | undefined,
        })
        return Response.json({ ok: true, agent: caller.agent, messages, count: messages.length })
      }
      case "mark-read": {
        const requestedAgent = optionalRecordString(body, "agent", "to")
        assertOwnMailbox(caller, requestedAgent)
        const msgIds = body.msg_ids ?? body.msgIds
        if (!Array.isArray(msgIds)) return jsonError(400, "msg_ids is required", "bad_request", "bad_request")
        const marked = markRead(sessionId, caller.agent, msgIds)
        return Response.json({ ok: true, agent: caller.agent, marked })
      }
      case "agents":
        return Response.json({ ok: true, self: caller.agent, ...getTeamState(sessionId) })
      case "team": {
        const team = optionalRecordString(body, "team")
        if (!team) return Response.json({ ok: true, ...getTeamState(sessionId) })
        if (body.switch !== undefined && typeof body.switch !== "boolean") {
          return jsonError(400, "switch must be a boolean", "bad_request", "bad_request")
        }
        const current = getTeamState(sessionId)
        const lead = optionalRecordString(body, "lead_agent", "leadAgent") ?? current.lead
        // M4：lead 变更需要内部 token（未配置时退化为 loopback 信任边界并记录）。
        if (lead !== current.lead && !authorizeLeadChange(req)) {
          return jsonError(403, "changing team lead requires a valid X-Internal-Token", "forbidden", "lead_change_forbidden")
        }
        // P1：先整批解析/校验，registerTeamWithMembers 在单一事务里落库（任一非法整批不写）。
        const members: TeamMemberInput[] = []
        if (body.members !== undefined) {
          if (!Array.isArray(body.members)) return jsonError(400, "members must be an array", "bad_request", "bad_request")
          for (const member of body.members) {
            if (typeof member === "string") {
              members.push({ agent: member })
            } else if (isPlainRecord(member) && typeof member.agent === "string") {
              const agentType =
                typeof member.agent_type === "string"
                  ? member.agent_type
                  : typeof member.agentType === "string"
                    ? member.agentType
                    : null
              members.push({ agent: member.agent, agentType })
            } else {
              return jsonError(400, "each member must be a string or {agent, agent_type}", "bad_request", "bad_request")
            }
          }
        }
        const state = registerTeamWithMembers(sessionId, team, lead, members, { switch: body.switch === true })
        // P1：返回真实团队（迁移后会话唯一主团队）。
        return Response.json({ ok: true, ...state })
      }
      default:
        return jsonError(404, "unknown mailbox route", "not_found", "not_found")
    }
  } catch (e) {
    return mailboxError(e)
  }
}

// 供后续任务板集成代理直接调用（保持单一导出面，不另造 HTTP 客户端）。
export { resolveRecipient } from "./agent-mailbox.ts"
