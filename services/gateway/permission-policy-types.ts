
// ── 模式 ───────────────────────────────────────────────────────────────────

export const ALL_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const

export type PermissionMode = (typeof ALL_MODES)[number]

/** 对外暴露的模式；bypassPermissions 不在其中。 */
export const EXTERNAL_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"] as const

export type ExternalPermissionMode = (typeof EXTERNAL_MODES)[number]

const MODE_SET: ReadonlySet<string> = new Set(ALL_MODES)
const EXTERNAL_MODE_SET: ReadonlySet<string> = new Set(EXTERNAL_MODES)

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && MODE_SET.has(value)
}

/** HTTP 面只接受对外模式：bypassPermissions 只能由可信启动配置在进程内产生。 */
export function isExternalPermissionMode(value: unknown): value is ExternalPermissionMode {
  return typeof value === "string" && EXTERNAL_MODE_SET.has(value)
}

/** bypass 的唯一可信来源：进程启动环境。 */
export function bypassPermissionsEnvAllowed(): boolean {
  return process.env.AGENT_ALLOW_BYPASS_PERMISSIONS === "1"
}

// ── provenance ─────────────────────────────────────────────────────────────

/** 11 个规则来源。 */
export const PROVENANCE_SOURCES = [
  "cliArg",
  "command",
  "session",
  "toolsNarrowing",
  "mcpServerPolicy",
  "hostCredential",
  "userSettings",
  "policySettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
] as const

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCE_SOURCES)

export function isProvenanceSource(value: unknown): value is ProvenanceSource {
  return typeof value === "string" && PROVENANCE_SET.has(value)
}

/**
 * 规则扫描顺序（Claude Code 实际 LU 顺序）：设置档先于运行时来源。
 * 每个桶内按此序取首命中；deny 桶整体先于 ask/allow。
 */
export const RULE_SOURCE_ORDER = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
  "toolsNarrowing",
  "mcpServerPolicy",
  "hostCredential",
] as const satisfies readonly ProvenanceSource[]

/** 规则可写入的目的地；bypassPermissions 模式永不下发到这些目的地。 */
export const RULE_DESTINATIONS = [
  "session",
  "localSettings",
  "userSettings",
  "projectSettings",
] as const

export type RuleDestination = (typeof RULE_DESTINATIONS)[number]

const DESTINATION_SET: ReadonlySet<string> = new Set(RULE_DESTINATIONS)

export function isRuleDestination(value: unknown): value is RuleDestination {
  return typeof value === "string" && DESTINATION_SET.has(value)
}

// ── 规则语法 ───────────────────────────────────────────────────────────────

export type Behavior = "allow" | "ask" | "deny"
export type RuleBehavior = Behavior

export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

/** 规则字符串 → 结构化规则；畸形（括号不配对、空工具名）返回 null。 */
export function parseRule(text: unknown): PermissionRule | null {
  if (typeof text !== "string") return null
  const raw = text.trim()
  if (!raw) return null
  const open = firstUnescaped(raw, "(")
  const close = lastUnescaped(raw, ")")
  if (open === -1 && close === -1) return { toolName: raw }
  if (open === -1 || close <= open || close !== raw.length - 1) return null
  const toolName = raw.slice(0, open).trim()
  if (!toolName || /[()]/.test(toolName)) return null
  const content = unescapeRuleContent(raw.slice(open + 1, close))
  if (content === "" || content === "*") return { toolName }
  return { toolName, ruleContent: content }
}

/** 结构化规则 → 规范字符串。 */
export function formatRule(rule: PermissionRule): string {
  if (!rule.ruleContent) return rule.toolName
  return `${rule.toolName}(${escapeRuleContent(rule.ruleContent)})`
}

/** 规范化任意规则输入；无效返回 null。 */
export function canonicalRule(text: unknown): string | null {
  const parsed = parseRule(text)
  return parsed ? formatRule(parsed) : null
}

function firstUnescaped(text: string, needle: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== needle) continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++
    if (backslashes % 2 === 0) return i
  }
  return -1
}

function lastUnescaped(text: string, needle: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== needle) continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++
    if (backslashes % 2 === 0) return i
  }
  return -1
}

function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

function unescapeRuleContent(content: string): string {
  return content.replace(/\\\)/g, ")").replace(/\\\(/g, "(").replace(/\\\\/g, "\\")
}

// ── 决策结构 ───────────────────────────────────────────────────────────────

export type DecisionReasonType =
  | "rule"
  | "mode"
  | "safetyCheck"
  | "classifier"
  | "hook"
  | "sandboxOverride"
  | "workingDir"
  | "other"

export type DenyAuditSource = "deny_glob" | "path_gate" | "sandbox_unavailable" | "unknown"

/**
 * reason 同时携带 source/type/rule：source 为 provenance（或 safetyCheck/mode），
 * rule 为命中规则原文。auditSource 是既有 appendDenyAudit 的 4 值类别。
 */
export interface PermissionReason {
  type: DecisionReasonType
  reason?: string
  rule?: string
  source?: ProvenanceSource | "safetyCheck" | "mode"
  ruleBehavior?: Behavior
  mode?: PermissionMode
  path?: string
  classifier?: string
  /** 被模式转换取代的原决策，例如 bypass 把 ask 改为 allow。 */
  replacedBehavior?: Behavior
  /** 既有 deny 稽核的来源类别；deny 决策必填。 */
  auditSource?: DenyAuditSource
}

export interface PermissionSuggestion {
  type: "addRules"
  rules: PermissionRule[]
  behavior: Behavior
  destination: "session"
}

export interface PermissionDecision {
  behavior: Behavior
  reason: PermissionReason
  suggestions?: PermissionSuggestion[]
}

// ── 状态 ───────────────────────────────────────────────────────────────────

export type RuleBuckets = Record<Behavior, Partial<Record<ProvenanceSource, string[]>>>

export interface AutoAllowAuditEntry {
  ts: number
  tool: string
}

export interface PolicyStateSnapshot {
  sessionId: string
  tenant: string
  mode: PermissionMode
  prePlanMode?: PermissionMode
  /** 会话显式 setMode 的模式；优先于 deriveMode 的自动推导（plan 状态除外）。 */
  explicitMode?: PermissionMode
  autoModeActive: boolean
  bypassAvailable: boolean
  bypassDisabled: boolean
  autoModeAvailable: boolean
  restricted: boolean
  additionalDirectories: string[]
  rules: RuleBuckets
  strippedDangerousRules?: Partial<Record<ProvenanceSource, string[]>>
  /** auto 模式无规则命中时自动放行的审计环（最多 50 条）。 */
  autoAllowAudit: AutoAllowAuditEntry[]
  updatedAt: number
}

export interface InternalPolicyState {
  durableRevision: number
  sessionId: string
  tenant: string
  mode: PermissionMode
  prePlanMode?: PermissionMode
  explicitMode?: PermissionMode
  autoModeActive: boolean
  bypassAvailable: boolean
  bypassDisabled: boolean
  autoModeAvailable: boolean
  restricted: boolean
  additionalDirectories: Set<string>
  rules: RuleBuckets
  strippedDangerousRules?: Partial<Record<ProvenanceSource, string[]>>
  autoAllowAudit: AutoAllowAuditEntry[]
  updatedAt: number
}
