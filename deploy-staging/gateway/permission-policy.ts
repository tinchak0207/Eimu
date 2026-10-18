// permission-policy.ts — 权限求值内核：模式、三桶规则、provenance、模式转移守卫、写路径安全。
//
// 约束：
// - 求值以纯计算为主；写路径的 symlink/realpath 事实由网关进程自己 lstat/realpath
//   （不信任调用方传参），其余 I/O 一律不做。
// - 求值序固定：safetyCheck（bypass 不可绕）→ deny → ask → allow，各桶取首命中。
// - 不引入新依赖；路径一律按 posix 语义处理，Windows 反斜线先正规化。
// - bypassPermissions 只存在于内部；对外模式集合见 EXTERNAL_MODES。

import { lstatSync, realpathSync } from "node:fs"
import { posix } from "node:path"

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

export interface PolicyStateSnapshot {
  sessionId: string
  tenant: string
  mode: PermissionMode
  prePlanMode?: PermissionMode
  autoModeActive: boolean
  bypassAvailable: boolean
  bypassDisabled: boolean
  autoModeAvailable: boolean
  restricted: boolean
  additionalDirectories: string[]
  rules: RuleBuckets
  strippedDangerousRules?: Partial<Record<ProvenanceSource, string[]>>
  updatedAt: number
}

interface InternalPolicyState {
  sessionId: string
  tenant: string
  mode: PermissionMode
  prePlanMode?: PermissionMode
  autoModeActive: boolean
  bypassAvailable: boolean
  bypassDisabled: boolean
  autoModeAvailable: boolean
  restricted: boolean
  additionalDirectories: Set<string>
  rules: RuleBuckets
  strippedDangerousRules?: Partial<Record<ProvenanceSource, string[]>>
  updatedAt: number
}

const states = new Map<string, InternalPolicyState>()
/** state Map 容量上限：tenant/session 由调用方给，属本地信任边界，但仍须防无界增长。 */
const MAX_POLICY_STATES = 500

function stateKey(sessionId: string, tenant: string): string {
  return `${tenant || "default"}\u0000${sessionId || "default"}`
}

function emptyBuckets(): RuleBuckets {
  return { allow: {}, ask: {}, deny: {} }
}

function bucketClone(bucket: Partial<Record<ProvenanceSource, string[]>>): Partial<Record<ProvenanceSource, string[]>> {
  const out: Partial<Record<ProvenanceSource, string[]>> = {}
  for (const source of PROVENANCE_SOURCES) {
    const rules = bucket[source]
    if (rules && rules.length > 0) out[source] = [...rules]
  }
  return out
}

function cloneBuckets(rules: RuleBuckets): RuleBuckets {
  return {
    allow: bucketClone(rules.allow),
    ask: bucketClone(rules.ask),
    deny: bucketClone(rules.deny),
  }
}

function listRules(
  bucket: Partial<Record<ProvenanceSource, string[]>>,
  source: ProvenanceSource,
): string[] {
  return bucket[source] ?? []
}

function getState(sessionId: string, tenant: string): InternalPolicyState {
  const key = stateKey(sessionId, tenant)
  let state = states.get(key)
  if (state) {
    // LRU：命中即移到队尾。
    states.delete(key)
    states.set(key, state)
    return state
  }
  state = {
    sessionId: sessionId || "default",
    tenant: tenant || "default",
    mode: "default",
    autoModeActive: false,
    // 可信启动配置：只有进程环境显式放行且服务端状态才可能为 true。
    bypassAvailable: bypassPermissionsEnvAllowed(),
    bypassDisabled: false,
    autoModeAvailable: process.env.AGENT_AUTO_MODE_AVAILABLE !== "0",
    restricted: false,
    additionalDirectories: new Set(),
    rules: emptyBuckets(),
    updatedAt: Date.now(),
  }
  states.set(key, state)
  if (states.size > MAX_POLICY_STATES) {
    for (const oldest of states.keys()) {
      if (oldest === key) continue
      states.delete(oldest)
      break
    }
  }
  return state
}

/** 返回快照副本；调用方改动不影响内核状态。 */
export function getPolicyState(sessionId: string, tenant = "default"): PolicyStateSnapshot {
  const state = getState(sessionId, tenant)
  return {
    sessionId: state.sessionId,
    tenant: state.tenant,
    mode: state.mode,
    ...(state.prePlanMode ? { prePlanMode: state.prePlanMode } : {}),
    autoModeActive: state.autoModeActive,
    bypassAvailable: state.bypassAvailable,
    bypassDisabled: state.bypassDisabled,
    autoModeAvailable: state.autoModeAvailable,
    restricted: state.restricted,
    additionalDirectories: [...state.additionalDirectories],
    rules: cloneBuckets(state.rules),
    ...(state.strippedDangerousRules
      ? { strippedDangerousRules: bucketClone(state.strippedDangerousRules) }
      : {}),
    updatedAt: state.updatedAt,
  }
}

/** 清空某会话的政策状态（进程内）。 */
export function resetPolicyState(sessionId: string, tenant = "default"): void {
  states.delete(stateKey(sessionId, tenant))
}

// ── 模式转移守卫 ───────────────────────────────────────────────────────────

export interface ModeGuardContext {
  restricted?: boolean
  /** 设置档或运行配置显式禁用 bypass。 */
  bypassDisabled?: boolean
  /** 会话是否以专用旗标（--dangerously-skip-permissions）启动。 */
  isBypassPermissionsModeAvailable?: boolean
  /** auto 模式闸门；缺省视为可用。 */
  autoModeAvailable?: boolean
}

export interface ModeGuardResult {
  ok: boolean
  mode?: PermissionMode
  code?: string
  error?: string
}

/** 校验模式转移；bypass 必须同时满足：未受限、未禁用、以专用旗标启动。 */
export function guardModeTransition(next: unknown, context: ModeGuardContext = {}): ModeGuardResult {
  if (!isPermissionMode(next)) {
    return { ok: false, code: "invalid_mode", error: `unknown permission mode: ${String(next)}` }
  }
  if (next === "bypassPermissions") {
    // 唯一可信来源：进程启动环境。请求体/调用方不能授权 bypass。
    if (!bypassPermissionsEnvAllowed()) {
      return {
        ok: false,
        code: "bypass_not_launched",
        error: "bypassPermissions requires the gateway process to be launched with AGENT_ALLOW_BYPASS_PERMISSIONS=1",
      }
    }
    if (context.restricted) {
      return { ok: false, code: "bypass_restricted", error: "bypassPermissions is not available in restricted mode" }
    }
    if (context.bypassDisabled) {
      return { ok: false, code: "bypass_disabled", error: "bypassPermissions is disabled by settings or configuration" }
    }
    if (context.isBypassPermissionsModeAvailable !== true) {
      return {
        ok: false,
        code: "bypass_not_launched",
        error: "bypassPermissions requires the session to be launched with its dedicated flag",
      }
    }
  }
  if (next === "auto" && context.autoModeAvailable === false) {
    return { ok: false, code: "auto_mode_unavailable", error: "auto mode is not available" }
  }
  return { ok: true, mode: next }
}

/** 危险 allow 规则：可在 auto 模式下绕过分类器的任意执行面。
 * 归一化 `Bash(python:*)`、`Bash(python*)`、`Bash(python *)` 为同一危险形态。 */
export function isDangerousAllowRule(ruleText: string): boolean {
  const rule = parseRule(ruleText)
  if (!rule) return true
  const tool = rule.toolName.toLowerCase()
  if (!SHELL_LIKE_TOOLS.has(tool)) return false
  const content = rule.ruleContent
  if (content === undefined || /^[\s*]+$/.test(content)) return true
  const normalized = content.trim()
  // 只有通配到「可执行档本身」的规则才危险：python:* / python* / python *。
  if (!/\*$/.test(normalized)) return false
  const head = normalized.replace(/:\*$/, "").replace(/\*$/, "").trim()
  const first = head.split(/\s+/)[0]?.toLowerCase().replace(/:$/, "") ?? ""
  return DANGEROUS_EXEC_PREFIXES.has(first)
}

const SHELL_LIKE_TOOLS = new Set(["bash", "powershell", "shell", "exec", "run_py", "runpy", "python", "python3"])

const DANGEROUS_EXEC_PREFIXES = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "php",
  "lua",
  "npx",
  "bunx",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "bash",
  "sh",
  "zsh",
  "fish",
  "ssh",
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
  "curl",
  "wget",
  "kubectl",
  "aws",
  "gcloud",
  "gsutil",
])

function stripDangerousAllowRules(state: InternalPolicyState): void {
  const stripped: Partial<Record<ProvenanceSource, string[]>> = {}
  for (const source of PROVENANCE_SOURCES) {
    const kept: string[] = []
    for (const rule of listRules(state.rules.allow, source)) {
      if (isDangerousAllowRule(rule)) {
        ;(stripped[source] ??= []).push(rule)
      } else {
        kept.push(rule)
      }
    }
    if (kept.length !== listRules(state.rules.allow, source).length) {
      state.rules.allow[source] = kept
    }
  }
  if (Object.keys(stripped).length > 0) {
    state.strippedDangerousRules = {
      ...(state.strippedDangerousRules ?? {}),
      ...stripped,
    }
  }
}

function restoreDangerousAllowRules(state: InternalPolicyState): void {
  const stripped = state.strippedDangerousRules
  if (!stripped) return
  for (const source of PROVENANCE_SOURCES) {
    const rules = stripped[source]
    if (!rules || rules.length === 0) continue
    const current = new Set(listRules(state.rules.allow, source))
    for (const rule of rules) current.add(rule)
    state.rules.allow[source] = [...current]
  }
  state.strippedDangerousRules = undefined
}

/** 应用模式转移副作用：plan 记录 prePlanMode；auto 剥离并可还原危险 allow 规则。 */
function applyModeTransition(state: InternalPolicyState, next: PermissionMode): void {
  const from = state.mode
  if (from === next) return

  if (next === "plan" && from !== "plan") {
    state.prePlanMode = from
  }
  if (from === "plan" && next !== "plan") {
    state.prePlanMode = undefined
  }

  if (next === "auto" && from !== "auto") {
    stripDangerousAllowRules(state)
    state.autoModeActive = true
  } else if (from === "auto" && next !== "auto") {
    restoreDangerousAllowRules(state)
    state.autoModeActive = false
  }

  state.mode = next
  state.updatedAt = Date.now()
}

// ── 规则更新 ───────────────────────────────────────────────────────────────

export type RuleAction =
  | "setMode"
  | "addRules"
  | "replaceRules"
  | "removeRules"
  | "addDirectories"
  | "removeDirectories"

export interface UpdateRulesInput {
  sessionId?: string
  tenant?: string
  destination?: string
  action: RuleAction
  rules?: string[]
  mode?: PermissionMode
  behavior?: Behavior
  directories?: string[]
  /** 仅供 setMode 的守卫判定。 */
  restricted?: boolean
  /** 仅允许 latch true（不可由请求体解除）。 */
  bypassDisabled?: boolean
  /** @deprecated 请求体不可授权 bypass；保留字段仅为兼容旧调用方，内部忽略。 */
  isBypassPermissionsModeAvailable?: boolean
  /** @deprecated 请求体不可关闭 auto 模式；保留字段仅为兼容旧调用方，内部忽略。 */
  autoModeAvailable?: boolean
  /** replaceRules 清空 deny 桶时必须显式声明。 */
  clear?: boolean
  /** 清空 deny 桶所需的进程级 token。 */
  clearToken?: string
}

export interface UpdateRulesResult {
  ok: boolean
  code?: string
  error?: string
  state?: PolicyStateSnapshot
  changed?: number
}

const UPDATABLE_ACTIONS: ReadonlySet<string> = new Set([
  "setMode",
  "addRules",
  "replaceRules",
  "removeRules",
  "addDirectories",
  "removeDirectories",
])

/** 规则更新状态机；destination 只允许 session/localSettings/userSettings/projectSettings。 */
export function updateRules(input: UpdateRulesInput): UpdateRulesResult {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "invalid_update", error: "update must be an object" }
  }
  if (!UPDATABLE_ACTIONS.has(input.action)) {
    return { ok: false, code: "invalid_action", error: `unknown action: ${String(input.action)}` }
  }

  const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : "default"
  const tenant = typeof input.tenant === "string" && input.tenant ? input.tenant : "default"
  const state = getState(sessionId, tenant)

  // restricted / bypassDisabled 只能 latch true：context 或请求体都不能解除。
  if (input.restricted === true) state.restricted = true
  if (input.bypassDisabled === true) state.bypassDisabled = true

  if (input.action === "setMode") {
    const guard = guardModeTransition(input.mode, {
      restricted: state.restricted,
      bypassDisabled: state.bypassDisabled,
      // 服务端状态（进程环境初始化），不读请求体。
      isBypassPermissionsModeAvailable: state.bypassAvailable,
      autoModeAvailable: state.autoModeAvailable,
    })
    if (!guard.ok) return { ok: false, code: guard.code, error: guard.error }

    // bypassPermissions 永不落盘：有 destination 时只允许 session，且不写任何规则桶。
    if (guard.mode === "bypassPermissions" && input.destination !== undefined && input.destination !== "session") {
      return {
        ok: false,
        code: "bypass_not_persisted",
        error: "bypassPermissions is session-only and cannot be written to a settings destination",
      }
    }

    applyModeTransition(state, guard.mode)
    return { ok: true, state: getPolicyState(sessionId, tenant), changed: 1 }
  }

  if (!isRuleDestination(input.destination)) {
    return {
      ok: false,
      code: "invalid_destination",
      error: `destination must be one of: ${RULE_DESTINATIONS.join(", ")}`,
    }
  }
  const destination = input.destination

  if (input.action === "addDirectories" || input.action === "removeDirectories") {
    const directories = Array.isArray(input.directories)
      ? input.directories.filter((d): d is string => typeof d === "string" && d.trim().length > 0).map((d) => d.trim())
      : []
    if (directories.length === 0) {
      return { ok: false, code: "invalid_directories", error: "directories must contain at least one path" }
    }
    let changed = 0
    for (const directory of directories) {
      if (input.action === "addDirectories") {
        if (!state.additionalDirectories.has(directory)) {
          state.additionalDirectories.add(directory)
          changed++
        }
      } else if (state.additionalDirectories.delete(directory)) {
        changed++
      }
    }
    state.updatedAt = Date.now()
    return { ok: true, state: getPolicyState(sessionId, tenant), changed }
  }

  const behavior = input.behavior ?? "allow"
  if (behavior !== "allow" && behavior !== "ask" && behavior !== "deny") {
    return { ok: false, code: "invalid_behavior", error: "behavior must be allow, ask or deny" }
  }
  if (!Array.isArray(input.rules)) {
    return { ok: false, code: "invalid_rules", error: "rules must be an array of rule strings" }
  }
  const rules: string[] = []
  for (const raw of input.rules) {
    const canonical = canonicalRule(raw)
    if (!canonical) {
      return { ok: false, code: "invalid_rule", error: `invalid rule: ${redactRuleForLog(raw)}` }
    }
    rules.push(canonical)
  }

  const bucket = state.rules[behavior]
  const existing = listRules(bucket, destination)
  if (input.action === "addRules") {
    let changed = 0
    const set = new Set(existing)
    for (const rule of rules) {
      if (!set.has(rule)) {
        set.add(rule)
        changed++
      }
    }
    bucket[destination] = [...set]
    // H3：auto 模式下新加入的 allow 规则同样立即剥离危险形态。
    if (behavior === "allow" && state.mode === "auto") stripDangerousAllowRules(state)
    state.updatedAt = Date.now()
    return { ok: true, state: getPolicyState(sessionId, tenant), changed }
  }
  if (input.action === "replaceRules") {
    // 空数组不得静默清空 deny：必须显式 clear:true 且带进程级 token。
    if (behavior === "deny" && rules.length === 0) {
      const expected = process.env.AGENT_PERMISSION_CLEAR_TOKEN ?? ""
      if (input.clear !== true || !expected || input.clearToken !== expected) {
        return {
          ok: false,
          code: "clear_forbidden",
          error: "refusing to empty the deny bucket without clear:true and a valid clearToken",
        }
      }
    }
    bucket[destination] = [...new Set(rules)]
    if (behavior === "allow" && state.mode === "auto") stripDangerousAllowRules(state)
    state.updatedAt = Date.now()
    return { ok: true, state: getPolicyState(sessionId, tenant), changed: rules.length }
  }

  const remove = new Set(rules)
  const next = existing.filter((rule) => !remove.has(rule))
  const changed = existing.length - next.length
  bucket[destination] = next
  state.updatedAt = Date.now()
  return { ok: true, state: getPolicyState(sessionId, tenant), changed }
}

// ── 路径安全（safetyCheck，bypass 不可绕） ─────────────────────────────────

export type PathSafetyKind =
  | "safe"
  | "invalid_path"
  | "suspicious_windows_path"
  | "symlink"
  | "settings_file"
  | "shell_rc"
  | "env_file"
  | "control_directory"

export interface PathSafetyResult {
  safe: boolean
  behavior: Behavior
  kind: PathSafetyKind
  reason: PermissionReason
}

const CONTROL_DIR_SEGMENTS = new Set([
  ".git",
  ".claude",
  ".ssh",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
])

const SHELL_RC_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".kshrc",
  ".envrc",
  ".cshrc",
  ".tcshrc",
  ".config/fish/config.fish",
])

const SETTINGS_BASENAMES = new Set([
  "settings.json",
  "settings.local.json",
  "managed-settings.json",
])

function normalizePathString(path: string): string {
  return path.replace(/\\/g, "/")
}

function pathSegments(path: string): string[] {
  return normalizePathString(path)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function basenameOf(path: string): string {
  const segments = pathSegments(path)
  return (segments[segments.length - 1] ?? "").toLowerCase()
}

function lower(path: string): string {
  return normalizePathString(path).toLowerCase()
}

function isSettingsFile(path: string): boolean {
  const normalized = lower(path).replace(/\/+$/, "")
  const base = basenameOf(normalized)
  const segments = pathSegments(normalized)
  // M1：.claude/settings*.json 一律需确认（含 settings.local.json / settings.foo.json）。
  if (segments.includes(".claude") && /^settings[^/]*\.json$/.test(base)) return true
  if (SETTINGS_BASENAMES.has(base)) {
    if (base !== "settings.json" && base !== "settings.local.json") return true
    return segments.includes(".claude")
  }
  return /\/managed-settings\.d\//.test(`/${normalized}/`)
}

function isShellRc(path: string): boolean {
  const normalized = lower(path)
  const base = basenameOf(normalized)
  if (SHELL_RC_BASENAMES.has(base)) return true
  return normalized.endsWith("/.config/fish/config.fish")
}

function isEnvFile(path: string): boolean {
  return /^\.env(?:$|[.\-_])/.test(basenameOf(path))
}

function hasControlSegment(path: string): boolean {
  const segments = pathSegments(lower(path))
  for (const segment of segments) {
    if (CONTROL_DIR_SEGMENTS.has(segment)) return true
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (segments[i] === ".config" && segments[i + 1] === "git") return true
  }
  return false
}

function isSuspiciousWindowsPath(path: string): boolean {
  const normalized = normalizePathString(path)
  if (normalized.startsWith("//?/") || normalized.startsWith("//./")) return true
  if (/^[a-zA-Z]:/.test(normalized) && !/^[a-zA-Z]:\//.test(normalized)) return true
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") continue
    if (/[. ]$/.test(segment)) return true
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) return true
  }
  return false
}

/**
 * 写路径安全判定。mode 只影响回传 reason 的模式标注，不改变安全结论：
 * safetyCheck 在 default/bypassPermissions 下完全一致。
 */
export function checkPathSafety(
  path: unknown,
  mode: PermissionMode = "default",
  options: { symlink?: boolean } = {},
): PathSafetyResult {
  const result = (behavior: Behavior, kind: PathSafetyKind, reason: string): PathSafetyResult => ({
    safe: behavior === "allow",
    behavior,
    kind,
    reason: {
      type: "safetyCheck",
      reason,
      kind,
      mode,
      path: typeof path === "string" ? path : undefined,
      auditSource: "path_gate",
    } as PermissionReason & { kind: PathSafetyKind },
  })

  if (typeof path !== "string" || path.trim().length === 0) {
    return result("deny", "invalid_path", "write path is missing or empty")
  }
  const normalized = normalizePathString(path.trim())

  if (options.symlink) {
    return result("deny", "symlink", "write target is a symbolic link; write to the link target instead")
  }
  if (isSuspiciousWindowsPath(normalized)) {
    return result("deny", "suspicious_windows_path", "write path contains a suspicious Windows path pattern")
  }
  if (isSettingsFile(normalized)) {
    return result("ask", "settings_file", "write target is a permission/settings file and always requires confirmation")
  }
  if (isShellRc(normalized)) {
    return result("deny", "shell_rc", "write target is a shell startup file and can execute code")
  }
  if (isEnvFile(normalized)) {
    return result("ask", "env_file", "write target is an environment/secret file")
  }
  if (hasControlSegment(normalized)) {
    return result("deny", "control_directory", "write target is inside a control/config directory")
  }
  return result("allow", "safe", "write path passed safety checks")
}

// ── 求值上下文与工具分类 ───────────────────────────────────────────────────

export interface PermissionContext {
  mode?: PermissionMode
  cwd?: string
  home?: string
  /** 设置档所在目录；规则中单斜线前缀相对此目录。 */
  settingsDir?: string
  restricted?: boolean
  bypassDisabled?: boolean
  isBypassPermissionsModeAvailable?: boolean
  autoModeAvailable?: boolean
  dangerouslyDisableSandboxAllowed?: boolean
  additionalDirectories?: string[]
  /** 注入行内规则（同 session 来源），用于无状态求值。 */
  rules?: Partial<Record<Behavior, string[]>>
  /** 原始路径 → realpath；不提供则只用原始路径。 */
  realpath?: (path: string) => string | undefined
  /** symlink 写入判定；仅写工具使用。 */
  isSymlink?: (path: string) => boolean
  /** 工具是否只读；缺省用内置集合。 */
  isReadOnlyTool?: (tool: string) => boolean
  /** 路径比较是否大小写不敏感；缺省按平台。 */
  caseInsensitivePath?: boolean
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "list",
  "list_dir",
  "ls",
  "glob",
  "grep",
  "stat",
  "lsp",
  "read_image",
  "vision_analyze",
  "webfetch",
  "web_fetch",
  "fetch",
  "websearch",
  "web_search",
  "todo_read",
  "todo_status",
  "task_status",
  "subagent_status",
  "workflow_status",
  "image_get_result",
  "video_result_fetch",
])

/** HTTP 面（permission-http）需要的只读判定：与 evaluate 内部缺省语义同源。 */
export function isReadOnlyTool(tool: string): boolean {
  if (typeof tool !== "string" || !tool.trim()) return false
  return READ_ONLY_TOOLS.has(tool.trim().toLowerCase())
}

const EDIT_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
  "notebook_edit",
  "str_replace",
  "create_file",
  "delete_file",
  "move_file",
])

const PATH_ARG_KEYS: Record<string, string[]> = {
  read: ["filePath", "file_path", "path"],
  read_file: ["filePath", "file_path", "path"],
  write: ["filePath", "file_path", "path"],
  write_file: ["filePath", "file_path", "path"],
  edit: ["filePath", "file_path", "path"],
  multiedit: ["filePath", "file_path", "path"],
  patch: ["filePath", "file_path", "path"],
  notebook_edit: ["notebook_path", "notebookPath"],
  list: ["path"],
  list_dir: ["path"],
  ls: ["path"],
  glob: ["path"],
  grep: ["path"],
  stat: ["path"],
  lsp: ["filePath", "file_path", "path"],
  read_image: ["image_path", "imagePath"],
  run_py: ["stdin_path", "stdinPath"],
  music_gen: ["source_audio", "sourceAudio"],
}

function effectivePathCaseInsensitive(context: PermissionContext): boolean {
  if (typeof context.caseInsensitivePath === "boolean") return context.caseInsensitivePath
  return process.platform === "win32" || process.platform === "darwin"
}

function isReadOnly(tool: string, context: PermissionContext): boolean {
  if (context.isReadOnlyTool) return context.isReadOnlyTool(tool) === true
  return READ_ONLY_TOOLS.has(tool.toLowerCase())
}

/** 对内/对外共用的只读工具判定（HTTP 响应回传，供插件使用）。 */
export function isReadOnlyTool(tool: string): boolean {
  return typeof tool === "string" && READ_ONLY_TOOLS.has(tool.toLowerCase())
}

function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool.toLowerCase())
}

function contextCwd(context: PermissionContext): string {
  return context.cwd && context.cwd.trim() ? context.cwd : process.cwd()
}

function contextHome(context: PermissionContext): string {
  return context.home && context.home.trim() ? context.home : process.env.HOME || "/root"
}

function contextSettingsDir(context: PermissionContext): string {
  return context.settingsDir && context.settingsDir.trim() ? context.settingsDir : contextCwd(context)
}

function looksLikePath(value: string): boolean {
  if (!value || value.length > 4096) return false
  if (/^[A-Za-z0-9+/=]{512,}$/.test(value)) return false
  return value.startsWith("/") || value.startsWith("~") || value.startsWith(".") || /^[A-Za-z]:[\\/]/.test(value)
}

function pathsFromTool(tool: string, input: Record<string, unknown>): string[] {
  const name = tool.toLowerCase()
  if (name === "apply_patch" || name === "patch") {
    const paths = new Set<string>()
    const patchText =
      typeof input.patchText === "string"
        ? input.patchText
        : typeof input.patch_text === "string"
          ? input.patch_text
          : typeof input.input === "string"
            ? input.input
            : ""
    for (const match of patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
      const path = match[1]?.trim()
      if (path) paths.add(path)
    }
    for (const match of patchText.matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm)) {
      const path = match[1]?.trim()
      if (path) paths.add(path)
    }
    const keys = PATH_ARG_KEYS[name] ?? []
    for (const key of keys) {
      const value = input[key]
      if (typeof value === "string" && value) paths.add(value)
    }
    return [...paths]
  }

  const keys = PATH_ARG_KEYS[name] ?? []
  const paths: string[] = []
  for (const key of keys) {
    const value = input[key]
    if (typeof value !== "string" || !value) continue
    if (name === "music_gen" && !looksLikePath(value)) continue
    paths.push(value)
  }
  return paths
}

// ── 路径规则 ───────────────────────────────────────────────────────────────

function normalizeAbsolute(path: string): string {
  const normalized = posix.normalize(normalizePathString(path))
  return normalized === "." ? "" : normalized
}

/** 展开规则路径前缀：// 根、~/ 家目录、/ 设置档目录、其他相对 cwd。 */
export function expandRulePath(pattern: string, context: PermissionContext): string {
  const raw = normalizePathString(pattern.trim())
  if (raw.startsWith("//")) return normalizeAbsolute(`/${raw.slice(2)}`)
  if (raw === "~" || raw.startsWith("~/")) {
    return normalizeAbsolute(posix.join(contextHome(context), raw.slice(raw === "~" ? 1 : 2)))
  }
  if (raw.startsWith("/")) return normalizeAbsolute(posix.join(contextSettingsDir(context), raw.slice(1)))
  return normalizeAbsolute(posix.join(contextCwd(context), raw))
}

function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?"
          i += 2
        } else {
          source += ".*"
          i += 1
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += char.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
  }
  return new RegExp(`${source}$`)
}

function matchPathGlob(pattern: string, candidate: string, caseInsensitive: boolean): boolean {
  let normalizedPattern = normalizeAbsolute(pattern)
  const normalizedCandidate = normalizeAbsolute(candidate)
  if (!normalizedPattern || !normalizedCandidate) return false

  // `/**` 含子目录，也含目录本身。
  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3)
    const prefix = caseInsensitive ? base.toLowerCase() : base
    const value = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate
    if (value === prefix || value.startsWith(`${prefix}/`)) return true
    return globToRegExp(normalizedPattern).test(normalizedCandidate)
  }

  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
    const left = caseInsensitive ? normalizedPattern.toLowerCase() : normalizedPattern
    const right = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate
    return left === right
  }
  return globToRegExp(normalizedPattern).test(normalizedCandidate)
}

function candidatePathSpellings(rawPath: string, context: PermissionContext): string[] {
  const cwd = contextCwd(context)
  let raw = normalizePathString(rawPath)
  // H2：候选侧与规则侧一致展开 home；`~/x` 与 `/home/x` 同判。
  if (raw === "~" || raw.startsWith("~/")) {
    raw = posix.join(contextHome(context), raw.slice(raw === "~" ? 1 : 2))
  }
  const absolute = raw.startsWith("/") ? normalizeAbsolute(raw) : normalizeAbsolute(posix.join(cwd, raw))
  const out = new Set<string>()
  out.add(absolute)
  let resolved: string | undefined
  try {
    resolved = context.realpath?.(rawPath) ?? context.realpath?.(absolute)
  } catch {
    resolved = undefined
  }
  if (typeof resolved === "string" && resolved.trim()) {
    const res = normalizePathString(resolved)
    out.add(res.startsWith("/") ? normalizeAbsolute(res) : normalizeAbsolute(posix.join(cwd, res)))
  }
  return [...out]
}

function pathRuleMatches(content: string, rawPath: string, context: PermissionContext): boolean {
  const caseInsensitive = effectivePathCaseInsensitive(context)
  const pattern = expandRulePath(content, context)
  for (const candidate of candidatePathSpellings(rawPath, context)) {
    if (matchPathGlob(pattern, candidate, caseInsensitive)) return true
  }
  return false
}

function withinAnyRoot(rawPath: string, context: PermissionContext): boolean {
  const roots = [contextCwd(context), ...(context.additionalDirectories ?? [])]
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => normalizeAbsolute(root))
  const caseInsensitive = effectivePathCaseInsensitive(context)
  for (const candidate of candidatePathSpellings(rawPath, context)) {
    const value = caseInsensitive ? candidate.toLowerCase() : candidate
    for (const root of roots) {
      const rootValue = caseInsensitive ? root.toLowerCase() : root
      if (value === rootValue || value.startsWith(`${rootValue}/`)) return true
    }
  }
  return false
}

// ── 规则匹配 ───────────────────────────────────────────────────────────────

const BASH_FAMILY = new Set(["bash", "powershell", "shell", "exec", "run_py", "runpy"])

function squashCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

function textGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "s")
}

const COMPOUND_COMMAND_RE = /[;&|\n`]|\$\(/

/**
 * H1：把复合命令拆成简单命令，供 deny 逐段匹配。
 * 覆盖 `;`、`&&`、`||`、`|`、换行、反引号、`$()`（含嵌套括号，最多 4 层）。
 */
export function splitSimpleCommands(command: string, depth = 0): string[] {
  if (typeof command !== "string" || !command.trim()) return []
  const pieces: string[] = []
  let rest = ""
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === "`") {
      const end = command.indexOf("`", i + 1)
      if (end === -1) {
        rest += command.slice(i)
        break
      }
      pieces.push(command.slice(i + 1, end))
      rest += " "
      i = end + 1
      continue
    }
    if (ch === "$" && command[i + 1] === "(") {
      let level = 1
      let j = i + 2
      for (; j < command.length && level > 0; j++) {
        if (command[j] === "(") level++
        else if (command[j] === ")") level--
      }
      const body = command.slice(i + 2, level === 0 ? j - 1 : command.length)
      pieces.push(body)
      rest += " "
      i = j
      continue
    }
    rest += ch
    i++
  }
  for (const part of rest.split(/\|\||&&|[;|\n\r]+/)) {
    const trimmed = part.trim()
    if (trimmed) pieces.push(trimmed)
  }
  const out: string[] = []
  for (const piece of pieces) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    // 反引号/命令替换内容本身也可能是复合命令：递归拆一层。
    if (depth < 4 && (/[;|\n]/.test(trimmed) || trimmed.includes("$(") || trimmed.includes("`"))) {
      const nested = splitSimpleCommands(trimmed, depth + 1)
      if (nested.length > 0) {
        out.push(...nested)
        continue
      }
    }
    out.push(trimmed)
  }
  return out
}

function matchBashContent(content: string, command: string): boolean {
  const value = squashCommand(command)
  let pattern = squashCommand(content)
  if (/^[\s*]+$/.test(pattern)) return true
  // 前缀放行不得跨过 shell 控制符：`git status -s && rm -rf /` 不是 `git status *`。
  const compound = COMPOUND_COMMAND_RE.test(command) || COMPOUND_COMMAND_RE.test(value)
  if (compound && !COMPOUND_COMMAND_RE.test(pattern)) return false

  let prefixMode = false
  if (pattern.endsWith(":*")) {
    pattern = pattern.slice(0, -2)
    prefixMode = true
  }
  if (pattern.endsWith("*")) {
    pattern = pattern.slice(0, -1).trimEnd()
    prefixMode = true
  }
  if (prefixMode) {
    if (!pattern) return true
    if (value === pattern) return true
    if (value.startsWith(`${pattern} `) || value.startsWith(`${pattern}\t`)) return true
    if (pattern.includes("*") || pattern.includes("?")) return textGlobToRegExp(pattern).test(value)
    return false
  }
  if (pattern.includes("*") || pattern.includes("?")) return textGlobToRegExp(pattern).test(value)
  return value === pattern
}

function matchWebFetchContent(content: string, input: Record<string, unknown>): boolean {
  const rawUrl =
    typeof input.url === "string"
      ? input.url
      : typeof input.target === "string"
        ? input.target
        : typeof input.uri === "string"
          ? input.uri
          : ""
  if (!rawUrl) return false
  let host = ""
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    host = rawUrl.toLowerCase()
  }

  const spec = content.trim()
  if (spec.startsWith("domain:")) {
    const domain = spec.slice("domain:".length).trim().toLowerCase().replace(/\.$/, "")
    if (!domain) return false
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2)
      return host !== suffix && host.endsWith(`.${suffix}`)
    }
    return host === domain || host.endsWith(`.${domain}`)
  }
  if (spec.includes("*")) return textGlobToRegExp(spec).test(rawUrl)
  return rawUrl === spec || rawUrl.startsWith(`${spec.replace(/\/+$/, "")}/`)
}

function scalarInputValues(input: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length <= 4096) values.push(value)
    else if (typeof value === "number" || typeof value === "boolean") values.push(String(value))
  }
  return values
}

function matchGenericContent(content: string, input: Record<string, unknown>): boolean {
  const values = scalarInputValues(input)
  for (const value of values) {
    if (value === content) return true
    if (content.includes("*") || content.includes("?")) {
      if (textGlobToRegExp(content).test(value)) return true
    }
  }
  return false
}

function isMcpTool(tool: string): boolean {
  return tool.toLowerCase().startsWith("mcp__")
}

function matchToolName(ruleToolName: string, tool: string): boolean {
  const left = ruleToolName.toLowerCase()
  const right = tool.toLowerCase()
  if (!left.includes("*")) {
    if (left === right) return true
    // 裸 mcp__server 覆盖该 server 下所有工具。
    if (!left.startsWith("mcp__")) return false
    return right.startsWith(`${left}__`)
  }
  return textGlobToRegExp(left).test(right)
}

/** 单条规则是否命中该工具调用。
 * behavior 传入时用于区分匹配策略：deny 按每个简单命令逐段匹配；allow/ask 仍禁跨复合命令。 */
export function ruleMatches(
  rule: PermissionRule,
  tool: string,
  input: Record<string, unknown>,
  context: PermissionContext = {},
  behavior?: Behavior,
): boolean {
  if (!matchToolName(rule.toolName, tool)) return false
  if (rule.ruleContent === undefined) return true

  const name = tool.toLowerCase()
  const content = rule.ruleContent

  if (BASH_FAMILY.has(name)) {
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.code === "string"
          ? input.code
          : typeof input.script === "string"
            ? input.script
            : ""
    if (!command) return false
    if (behavior === "deny") {
      // H1：任一段简单命令命中 deny 即拒；避免 `git status && rm -rf /` 逃逸。
      return splitSimpleCommands(command).some((segment) => matchBashContent(content, segment))
    }
    return matchBashContent(content, command)
  }

  if (PATH_ARG_KEYS[name]) {
    const paths = pathsFromTool(tool, input)
    if (paths.length === 0) return false
    return paths.some((path) => pathRuleMatches(content, path, context))
  }

  if (name === "webfetch" || name === "web_fetch" || name === "fetch" || name === "websearch" || name === "web_search") {
    return matchWebFetchContent(content, input)
  }

  if (isMcpTool(tool)) {
    return matchGenericContent(content, input)
  }

  return matchGenericContent(content, input)
}

// ── safetyCheck ────────────────────────────────────────────────────────────

const SANDBOX_DISABLE_PARAM = "dangerouslyDisableSandbox"

/** 默认必须从工具 schema 删除的危险参数。 */
export const HIDDEN_SCHEMA_PARAMS = [SANDBOX_DISABLE_PARAM] as const

/** 仅当显式允许时才保留危险参数；默认返回删掉该键的副本。 */
export function stripSandboxDisableParam(
  input: Record<string, unknown>,
  allowed = false,
): Record<string, unknown> {
  if (allowed) return { ...input }
  const copy = { ...input }
  delete copy[SANDBOX_DISABLE_PARAM]
  return copy
}

interface ShellWriteTarget {
  /** 已按 cwd 归一的绝对路径；动态目标保留原文。 */
  path: string
  dynamic: boolean
}

function resolveShellPath(raw: string, cwd: string, home: string): string {
  const value = raw.trim().replace(/^["']|["']$/g, "").replace(/\\ /g, " ")
  if (value === "~" || value.startsWith("~/")) {
    return normalizeAbsolute(posix.join(home, value.slice(1)))
  }
  if (value.startsWith("/")) return normalizeAbsolute(value)
  return normalizeAbsolute(posix.join(cwd, value))
}

/** H4：把 bash 命令按 shell 控制符拆段，跟踪 `cd X` 后各段的实际 cwd。 */
function splitShellSequence(command: string): string[] {
  return command
    .replace(/`/g, "\n")
    // 不把 `>|` / `>>|` 的竖线当管道拆开。
    .split(/\|\||&&|[;\n\r]+|(?<![>])\|/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function shellWriteTargetsIn(segment: string): string[] {
  const targets = new Set<string>()
  // 覆盖 `>|`、`>>|`（noclobber override 不能绕过写路径闸）。
  for (const match of segment.matchAll(/(?:^|[^&>])(?:>>?\|?)\s*("?)([^\s;&|>]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }
  for (const match of segment.matchAll(/(?:^|\s)&(?:\|?)>>?\|?\s*("?)([^\s;&|>]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }
  for (const match of segment.matchAll(/\btee\s+(?:-a\s+)?("?)([^\s;&|]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }
  for (const match of segment.matchAll(
    /\bsed\s+-[a-zA-Z]*i[a-zA-Z]*(?:\s+(?:-[^\s]+\s+)*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+("?)([^\s;&|]+)\1/g,
  )) {
    if (match[2]) targets.add(match[2])
  }
  for (const match of segment.matchAll(/\b(?:cp|mv|install)\s+(?:-[^\s]+\s+)*("?)([^\s;&|]+)\1\s+("?)([^\s;&|]+)\3/g)) {
    if (match[4]) targets.add(match[4])
  }
  for (const match of segment.matchAll(/\brm\s+(?:-[^\s]+\s+)*("?)([^\s;&|]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }
  for (const match of segment.matchAll(/\bdd\s+[^;&|]*\bof=("?)([^\s;&|]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }
  return [...targets]
}

function bashWriteTargets(command: string, cwd: string, home: string): ShellWriteTarget[] {
  const targets: ShellWriteTarget[] = []
  let current: string | null = cwd
  for (const segment of splitShellSequence(command)) {
    const cdMatch = /^cd(?:\s+--)?\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))$/.exec(segment)
    if (cdMatch) {
      const rawDir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? ""
      current = /[$`]/.test(rawDir) ? null : resolveShellPath(rawDir, cwd, home)
      continue
    }
    for (const raw of shellWriteTargetsIn(segment)) {
      const relative = !raw.startsWith("/") && !raw.startsWith("~")
      const dynamic = /[$`]/.test(raw) || (current === null && relative)
      targets.push(dynamic ? { path: raw, dynamic: true } : { path: resolveShellPath(raw, current ?? cwd, home), dynamic: false })
    }
  }
  return targets
}

/** 动态目标的字面量仍可能指向敏感路径：含这些片段的动态写入一律 deny。 */
function isSensitiveWriteText(text: string): boolean {
  const normalized = lower(text)
  const base = basenameOf(normalized)
  return (
    SHELL_RC_BASENAMES.has(base) ||
    isSettingsFile(normalized) ||
    isEnvFile(normalized) ||
    normalized.includes("/.ssh") ||
    normalized.includes("/.claude") ||
    normalized.includes("/.git/")
  )
}

/** symlink 事实由网关进程自己 lstat，不接受调用方传参。 */
function gatewayIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** 写路径的 realpath 也由网关自己解析；调用方注入只作补充。 */
function gatewayRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** 编辑工具的相对路径按 cwd 归一；`~/` 展开 home。 */
function resolveSafetyPath(raw: string, context: PermissionContext): string {
  return resolveShellPath(raw, contextCwd(context), contextHome(context))
}

function safetyDecision(
  kind: string,
  reason: string,
  behavior: Behavior,
  extra: Partial<PermissionReason> = {},
): PermissionDecision {
  return {
    behavior,
    reason: {
      type: "safetyCheck",
      reason,
      kind,
      source: "safetyCheck",
      auditSource: kind === "sandboxOverride" ? "sandbox_unavailable" : "path_gate",
      ...extra,
    } as PermissionReason & { kind: string },
  }
}

function safetyCheck(
  tool: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  mode: PermissionMode,
): PermissionDecision | null {
  // M2：键存在即视为尝试绕过，不认可 `"true"` / 1 / false 之类写法。
  if (Object.prototype.hasOwnProperty.call(input, SANDBOX_DISABLE_PARAM)) {
    if (context.dangerouslyDisableSandboxAllowed !== true || context.restricted) {
      return safetyDecision(
        "sandboxOverride",
        "dangerouslyDisableSandbox is not permitted; the parameter is removed from the schema by default",
        "ask",
        { mode },
      )
    }
  }

  const name = tool.toLowerCase()
  const paths = pathsFromTool(tool, input)
  const cwd = contextCwd(context)
  const home = contextHome(context)

  if (BASH_FAMILY.has(name)) {
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.code === "string"
          ? input.code
          : ""
    if (!command) return null

    // heredoc 的落点无法静态判定：保守回 ask。
    if (/<<-?\s*['"]?[A-Za-z_\\]/.test(command)) {
      return safetyDecision(
        "heredocTarget",
        "heredoc write target cannot be statically determined; confirm before running",
        "ask",
        { mode },
      )
    }

    for (const target of bashWriteTargets(command, cwd, home)) {
      if (target.dynamic) {
        const sensitive = isSensitiveWriteText(target.path)
        return safetyDecision(
          sensitive ? "shell_rc" : "dynamicWriteTarget",
          sensitive
            ? "write target uses a variable/command substitution and points at a sensitive path"
            : "write target uses a variable or command substitution and cannot be statically verified",
          sensitive ? "deny" : "ask",
          { path: target.path, mode },
        )
      }
      const direct = checkPathSafety(target.path, mode, { symlink: gatewayIsSymlink(target.path) })
      if (!direct.safe) {
        return safetyDecision(direct.kind, direct.reason.reason ?? "unsafe write path", direct.behavior, {
          path: target.path,
          mode,
        })
      }
      const resolved = gatewayRealpath(target.path)
      if (resolved && resolved !== target.path) {
        const viaLink = checkPathSafety(resolved, mode, { symlink: gatewayIsSymlink(resolved) })
        if (!viaLink.safe) {
          return safetyDecision(viaLink.kind, viaLink.reason.reason ?? "unsafe write path", viaLink.behavior, {
            path: target.path,
            mode,
          })
        }
      }
    }
    return null
  }

  if (!isEditTool(tool)) return null

  for (const raw of paths) {
    const dynamic = /[$`]/.test(raw)
    if (dynamic) {
      const sensitive = isSensitiveWriteText(raw)
      return safetyDecision(
        sensitive ? "shell_rc" : "dynamicWriteTarget",
        sensitive
          ? "write target uses a variable/command substitution and points at a sensitive path"
          : "write target uses a variable or command substitution and cannot be statically verified",
        sensitive ? "deny" : "ask",
        { path: raw, mode },
      )
    }
    const abs = resolveSafetyPath(raw, context)
    const direct = checkPathSafety(abs, mode, { symlink: gatewayIsSymlink(abs) })
    if (!direct.safe) {
      return safetyDecision(direct.kind, direct.reason.reason ?? "unsafe write path", direct.behavior, {
        path: abs,
        mode,
      })
    }
    const resolved = gatewayRealpath(abs) ?? context.realpath?.(abs) ?? context.realpath?.(raw)
    if (resolved && resolved !== abs) {
      const viaLink = checkPathSafety(resolved, mode, { symlink: gatewayIsSymlink(resolved) })
      if (!viaLink.safe) {
        return safetyDecision(
          viaLink.kind,
          viaLink.reason.reason ?? "write target resolves to an unsafe path",
          viaLink.behavior,
          { path: abs, mode },
        )
      }
    }
  }
  return null
}

// ── 求值 ───────────────────────────────────────────────────────────────────

interface RuleHit {
  rule: string
  source: ProvenanceSource
}

function injectedRules(
  bucket: Behavior,
  context: PermissionContext,
): PermissionRule[] {
  const raw = context.rules?.[bucket]
  if (!Array.isArray(raw)) return []
  const out: PermissionRule[] = []
  for (const item of raw) {
    const parsed = parseRule(item)
    if (parsed) out.push(parsed)
  }
  return out
}

function firstRuleHit(
  bucket: Behavior,
  state: InternalPolicyState,
  context: PermissionContext,
  tool: string,
  input: Record<string, unknown>,
  skipDangerous = false,
): RuleHit | null {
  for (const source of RULE_SOURCE_ORDER) {
    const rules = listRules(state.rules[bucket], source)
    for (const ruleText of rules) {
      if (skipDangerous && isDangerousAllowRule(ruleText)) continue
      const rule = parseRule(ruleText)
      if (rule && ruleMatches(rule, tool, input, context, bucket)) {
        return { rule: formatRule(rule), source }
      }
    }
    if (source === "session") {
      for (const rule of injectedRules(bucket, context)) {
        if (skipDangerous && isDangerousAllowRule(formatRule(rule))) continue
        if (ruleMatches(rule, tool, input, context, bucket)) {
          return { rule: formatRule(rule), source }
        }
      }
    }
  }
  return null
}

function ruleDecision(hit: RuleHit, behavior: Behavior): PermissionDecision {
  return {
    behavior,
    reason: {
      type: "rule",
      rule: hit.rule,
      source: hit.source,
      ruleBehavior: behavior,
      ...(behavior === "deny" ? { auditSource: "deny_glob" as const } : {}),
    },
  }
}

function allowSuggestion(tool: string, matchedRule?: string): PermissionSuggestion {
  const rule = matchedRule ? parseRule(matchedRule) : { toolName: tool }
  return {
    type: "addRules",
    rules: [rule ?? { toolName: tool }],
    behavior: "allow",
    destination: "session",
  }
}

function modeDecision(
  mode: PermissionMode,
  tool: string,
  input: Record<string, unknown>,
  context: PermissionContext,
): PermissionDecision {
  const readOnly = isReadOnly(tool, context)

  if (mode === "bypassPermissions") {
    return {
      behavior: "allow",
      reason: { type: "mode", mode, source: "mode", reason: "bypassPermissions allows the call" },
    }
  }

  if (mode === "dontAsk") {
    return {
      behavior: "deny",
      reason: { type: "mode", mode, source: "mode", reason: "dontAsk denies calls that are not explicitly allowed" },
    }
  }

  if (mode === "plan") {
    if (readOnly) {
      return {
        behavior: "allow",
        reason: { type: "mode", mode, source: "mode", reason: "plan mode allows read-only calls" },
      }
    }
    return {
      behavior: "ask",
      reason: { type: "mode", mode, source: "mode", reason: "plan mode holds write or side-effecting calls" },
      suggestions: [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }],
    }
  }

  if (mode === "acceptEdits") {
    if (isEditTool(tool)) {
      const paths = pathsFromTool(tool, input)
      if (paths.length === 0) {
        return {
          behavior: "allow",
          reason: { type: "mode", mode, source: "mode", reason: "acceptEdits allows edits" },
        }
      }
      if (paths.every((path) => withinAnyRoot(path, context))) {
        return {
          behavior: "allow",
          reason: { type: "mode", mode, source: "mode", reason: "acceptEdits allows edits inside the working directories" },
        }
      }
      return {
        behavior: "ask",
        reason: {
          type: "workingDir",
          mode,
          source: "mode",
          reason: "edit target is outside the working directories",
          path: paths[0],
        },
        suggestions: [allowSuggestion(tool)],
      }
    }
    return {
      behavior: "ask",
      reason: { type: "mode", mode, source: "mode", reason: "acceptEdits only auto-allows edit tools" },
      suggestions: [allowSuggestion(tool)],
    }
  }

  if (mode === "auto") {
    return {
      behavior: "ask",
      reason: {
        type: "classifier",
        mode,
        source: "mode",
        classifier: "unavailable",
        reason: "auto mode has no classifier wired; the call is held for confirmation",
      },
      suggestions: [allowSuggestion(tool)],
    }
  }

  return {
    behavior: "ask",
    reason: { type: "mode", mode, source: "mode", reason: "default mode requires confirmation" },
    suggestions: [allowSuggestion(tool)],
  }
}

/**
 * 求值序：safetyCheck → deny → ask → allow（各桶首命中）→ 模式兜底。
 * ask 命中在 dontAsk 下转 deny；在 bypassPermissions 下转 allow（safetyCheck 已先挡）。
 * plan 对非只读调用保留 ask 闸门，allow 规则不能越过。
 */
export function evaluateToolPermission(args: {
  sessionId: string
  tenant?: string
  tool: string
  input?: Record<string, unknown> | null
  context?: PermissionContext
}): PermissionDecision {
  const sessionId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : "default"
  const tenant = typeof args.tenant === "string" && args.tenant ? args.tenant : "default"
  const context = args.context ?? {}
  const input = args.input && typeof args.input === "object" ? args.input : {}
  const tool = typeof args.tool === "string" && args.tool ? args.tool : "unknown"
  const state = getState(sessionId, tenant)

  // restricted 只能 latch true：context 不得解除。
  if (context.restricted === true) state.restricted = true
  if (context.bypassDisabled === true) state.bypassDisabled = true

  // C2：context.mode 只认对外模式；bypassPermissions 一律忽略（只能来自可信状态）。
  const requestedMode = context.mode && isExternalPermissionMode(context.mode) ? context.mode : undefined
  const mode = requestedMode ?? state.mode

  // 1. safetyCheck：先于所有规则与模式，bypassPermissions 不可绕。
  const safety = safetyCheck(tool, input, context, mode)
  if (safety) return safety

  // 2. deny 桶（全体来源，首命中）。
  const denyHit = firstRuleHit("deny", state, context, tool, input)
  if (denyHit) return ruleDecision(denyHit, "deny")

  // 3. ask 桶（首命中）；dontAsk 转 deny，bypass 转 allow。
  const askHit = firstRuleHit("ask", state, context, tool, input)
  if (askHit) {
    if (mode === "dontAsk") return ruleDecision(askHit, "deny")
    if (mode === "bypassPermissions") {
      return {
        behavior: "allow",
        reason: {
          type: "mode",
          mode,
          source: "mode",
          rule: askHit.rule,
          ruleBehavior: "ask",
          replacedBehavior: "ask",
          reason: "bypassPermissions converts an ask rule to allow",
        },
      }
    }
    const decision = ruleDecision(askHit, "ask")
    decision.suggestions = [allowSuggestion(tool, askHit.rule)]
    return decision
  }

  // 4. allow 桶（首命中）。plan 对非只读调用保留 ask。
  const allowHit = firstRuleHit("allow", state, context, tool, input, mode === "auto")
  if (allowHit) {
    if (mode === "plan" && !isReadOnly(tool, context)) {
      return {
        behavior: "ask",
        reason: {
          type: "mode",
          mode,
          source: "mode",
          rule: allowHit.rule,
          reason: "plan mode holds non-read-only calls even when an allow rule matches",
        },
        suggestions: [allowSuggestion(tool, allowHit.rule)],
      }
    }
    return ruleDecision(allowHit, "allow")
  }

  // 5. 模式兜底。
  return modeDecision(mode, tool, input, context)
}

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
