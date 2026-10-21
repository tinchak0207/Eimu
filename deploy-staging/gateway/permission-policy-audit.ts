import { DenyAuditSource, PermissionDecision, PermissionReason } from "./permission-policy-types"

// ── 与既有 deny 审计兼容 ──────────────────────────────────────────────────

export interface DenyAuditRecordLike {
  ts: string
  session_id: string
  call_id: string
  tool: string
  operation: string
  source: DenyAuditSource
  pattern: string | null
  reason: string
  hint: string | null
}

function denySourceOf(reason: PermissionReason | undefined): DenyAuditSource {
  if (!reason) return "unknown"
  if (reason.type === "rule") return "deny_glob"
  if (reason.type === "safetyCheck") {
    return reason.path ? "path_gate" : "deny_glob"
  }
  if (reason.type === "sandboxOverride") return "sandbox_unavailable"
  return "unknown"
}

/**
 * 决策 → appendDenyAudit 可直接消费的记录。只在 behavior=deny 时由调用方使用。
 * source 映射到既有 4 值联合，避免改动 events-translate.ts 的类型。
 */
export function toDenyAuditRecord(args: {
  sessionId: string
  callId: string
  tool: string
  operation: string
  decision: PermissionDecision
  hint?: string | null
  now?: Date
}): DenyAuditRecordLike {
  const { reason } = args.decision
  return {
    ts: (args.now ?? new Date()).toISOString(),
    session_id: args.sessionId,
    call_id: args.callId,
    tool: args.tool,
    operation: args.operation,
    source: reason.auditSource ?? denySourceOf(reason),
    pattern: reason.rule ?? reason.path ?? null,
    reason: reason.reason ?? reason.type,
    hint: args.hint ?? null,
  }
}

// ── 日志脱敏 ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization\s*:\s*Bearer)\s+[^\s,;)\]}]+/gi, "$1 [REDACTED]"],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)\]}]+)/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]"],
  [/(:\/\/[^/\s:@]+):([^/\s@]+)@/g, "$1:[REDACTED]@"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
]

/** 规则日志脱敏：剥离常见凭证形态，超长截断。 */
export function redactRuleForLog(rule: unknown): string {
  if (typeof rule !== "string") return "[unprintable]"
  let value = rule
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement)
  }
  const chars = Array.from(value)
  if (chars.length > 200) return `${chars.slice(0, 200).join("")}…`
  return value
}