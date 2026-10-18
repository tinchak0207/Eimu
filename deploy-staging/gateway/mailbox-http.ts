import { jsonError } from "./gw-lib.ts"
import { resolveSession } from "./sessions-core.ts"
import { subagentParentState } from "./subagent.ts"
import {
  MailboxConflictError,
  MailboxRecipientError,
  MailboxValidationError,
  addTeamMember,
  getTeamState,
  markRead,
  readMessages,
  registerTeam,
  resolveRecipient,
  sendMessage,
} from "./agent-mailbox.ts"

// POST /internal/mailbox/{send,read,mark-read,agents,team}。
// 约束：
// - loopback 鉴权由 router 上游的 /internal/* 闸门负责，这里不重复；这不是身份鉴权，
//   只是本机信任边界（共享主机＋共享文件系统是平台级缺口）。
// - H3：HARNESS_MAILBOX_TRUSTED_FROM 设置时（逗号分隔名单）强制校验 from；不设置时
//   不假装有鉴权，只保留 loopback 边界。
// - 子会话 id 一律收敛到父会话，mailbox 的持久键始终是父 session_id。
// - 收件人只有 main 与已登记成员名；广播在 agent-mailbox 内被拒。

const PREFIX = "/internal/mailbox/"

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
  if (e instanceof MailboxConflictError) {
    return jsonError(409, e.message, "conflict", e.code)
  }
  if (e instanceof MailboxRecipientError) {
    return Response.json(
      { ok: false, error: { message: e.message, type: "not_found", code: e.code }, candidates: e.candidates },
      { status: 404 },
    )
  }
  return jsonError(500, e instanceof Error ? e.message : String(e), "server_error", "mailbox_error")
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
  const sessionId = canonicalMailboxSessionId(rawSessionId)

  try {
    switch (pathname.slice(PREFIX.length)) {
      case "send": {
        const from = optionalRecordString(body, "from", "from_agent")
        const to = optionalRecordString(body, "to", "to_agent")
        if (!from) return jsonError(400, "from is required", "bad_request", "bad_request")
        if (!to) return jsonError(400, "to is required", "bad_request", "bad_request")
        if (typeof body.text !== "string") return jsonError(400, "text is required", "bad_request", "bad_request")
        // H3：仅当显式配置了可信 from 名单时才强制校验；未配置 ≠ 有鉴权。
        const allow = trustedFrom()
        if (allow && !allow.has(from)) {
          return jsonError(403, `from "${from}" is not in HARNESS_MAILBOX_TRUSTED_FROM`, "forbidden", "untrusted_from")
        }
        let timestamp: string
        if (body.timestamp === undefined || body.timestamp === null) {
          timestamp = new Date().toISOString()
        } else if (typeof body.timestamp !== "string") {
          return jsonError(400, "timestamp must be an ISO-8601 string", "bad_request", "bad_request")
        } else if (!body.timestamp.trim()) {
          timestamp = new Date().toISOString()
        } else {
          // 非法时间戳由 sendMessage 抛 400，不再静默改成 now。
          timestamp = body.timestamp.trim()
        }
        const result = sendMessage({
          sessionId,
          from,
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
        return Response.json({ ok: true, success: true, ...result })
      }
      case "read": {
        const agent = optionalRecordString(body, "agent", "to") ?? getTeamState(sessionId).lead
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
        const messages = readMessages(sessionId, agent, {
          after: body.after as number | undefined,
          limit: body.limit as number | undefined,
          drain: body.drain as boolean | undefined,
        })
        return Response.json({ ok: true, messages, count: messages.length })
      }
      case "mark-read": {
        const agent = optionalRecordString(body, "agent", "to") ?? getTeamState(sessionId).lead
        const msgIds = body.msg_ids ?? body.msgIds
        if (!Array.isArray(msgIds)) return jsonError(400, "msg_ids is required", "bad_request", "bad_request")
        const marked = markRead(
          sessionId,
          agent,
          msgIds.filter((id): id is string => typeof id === "string"),
        )
        return Response.json({ ok: true, marked })
      }
      case "agents":
        return Response.json({ ok: true, ...getTeamState(sessionId) })
      case "team": {
        const team = optionalRecordString(body, "team")
        if (!team) return Response.json({ ok: true, ...getTeamState(sessionId) })
        const current = getTeamState(sessionId)
        const lead = optionalRecordString(body, "lead_agent", "leadAgent") ?? current.lead
        // M4：lead 变更需要内部 token（未配置时退化为 loopback 信任边界并记录）。
        if (lead !== current.lead && !authorizeLeadChange(req)) {
          return jsonError(403, "changing team lead requires a valid X-Internal-Token", "forbidden", "lead_change_forbidden")
        }
        registerTeam(sessionId, team, lead)
        if (Array.isArray(body.members)) {
          for (const member of body.members) {
            if (typeof member === "string" && member.trim()) {
              addTeamMember(team, member.trim())
            } else if (isPlainRecord(member) && typeof member.agent === "string" && member.agent.trim()) {
              const agentType =
                typeof member.agent_type === "string"
                  ? member.agent_type
                  : typeof member.agentType === "string"
                    ? member.agentType
                    : null
              addTeamMember(team, member.agent.trim(), agentType)
            }
          }
        }
        return Response.json({ ok: true, ...getTeamState(sessionId) })
      }
      default:
        return jsonError(404, "unknown mailbox route", "not_found", "not_found")
    }
  } catch (e) {
    return mailboxError(e)
  }
}

// 供后续任务板集成代理直接调用（保持单一导出面，不另造 HTTP 客户端）。
export { resolveRecipient, sendTaskAssignment } from "./agent-mailbox.ts"
