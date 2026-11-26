import { MailboxValidationError, MAX_AGENT_CHARS, MAX_AGENT_BYTES, MAX_TEAM_CHARS, MAX_TEAM_BYTES, RESERVED_AGENT_NAMES, type AgentMessageType } from "./agent-mailbox-types"
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

export function requireString(
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

export function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new MailboxValidationError(field, "must be a string")
  return value
}

export function singleLine(value: string, field: string): void {
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
export function parseTimestamp(value: string): number {
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

export function validateFrame(type: AgentMessageType, text: string): void {
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
export function validateTeamName(value: unknown): string {
  const clean = requireString(value, "team", { maxLength: MAX_TEAM_CHARS, maxBytes: MAX_TEAM_BYTES })
  singleLine(clean, "team")
  return clean
}
