import { loadHarnessSecurityState, saveHarnessSecurityState, deleteHarnessSecurityState } from "./persistence"
import { Behavior, InternalPolicyState, PROVENANCE_SOURCES, PermissionMode, PolicyStateSnapshot, ProvenanceSource, RULE_DESTINATIONS, RuleBuckets, bypassPermissionsEnvAllowed, canonicalRule, isExternalPermissionMode, isPermissionMode, isRuleDestination, parseRule } from "./permission-policy-types"
import { redactRuleForLog } from "./permission-policy-audit"

const MAX_AUTO_ALLOW_AUDIT = 50

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

export function listRules(
  bucket: Partial<Record<ProvenanceSource, string[]>>,
  source: ProvenanceSource,
): string[] {
  return bucket[source] ?? []
}

export function getState(sessionId: string, tenant: string): InternalPolicyState {
  const key = stateKey(sessionId, tenant)
  const saved = loadHarnessSecurityState("permission", key)
  let state = states.get(key)
  if (state && state.durableRevision === (saved?.revision ?? 0)) {
    // LRU：命中即移到队尾。
    states.delete(key)
    states.set(key, state)
    return state
  }
  state = {
    durableRevision: 0,
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
    autoAllowAudit: [],
    updatedAt: Date.now(),
  }
  if (saved) {
    const raw = saved.data as Partial<PolicyStateSnapshot> | null
    if (!raw || raw.sessionId !== state.sessionId || raw.tenant !== state.tenant ||
        !isExternalPermissionMode(raw.mode) ||
        (raw.prePlanMode !== undefined && !isExternalPermissionMode(raw.prePlanMode)) ||
        (raw.explicitMode !== undefined && !isExternalPermissionMode(raw.explicitMode)) ||
        typeof raw.restricted !== "boolean" || typeof raw.bypassDisabled !== "boolean" ||
        !Array.isArray(raw.additionalDirectories) || !raw.additionalDirectories.every((d) => typeof d === "string") ||
        !validSavedBuckets(raw.rules) ||
        (raw.strippedDangerousRules !== undefined && !validSavedBuckets({ allow: raw.strippedDangerousRules, ask: {}, deny: {} }))) {
      throw new Error("harness_permission_state_invalid")
    }
    state = { ...state, durableRevision: saved.revision, mode: raw.mode,
      prePlanMode: raw.prePlanMode, explicitMode: raw.explicitMode,
      autoModeActive: raw.mode === "auto", restricted: raw.restricted,
      bypassDisabled: raw.bypassDisabled, additionalDirectories: new Set(raw.additionalDirectories),
      rules: cloneBuckets(raw.rules!), strippedDangerousRules: raw.strippedDangerousRules,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now() }
  }
  states.set(key, state)
  if (states.size > MAX_POLICY_STATES) {
    // 所有限制均已持久化；缓存淘汰不会移除任何规则或 latch。
    for (const oldest of states.keys()) {
      if (oldest === key) continue
      const candidate = states.get(oldest)
      if (candidate?.mode === "bypassPermissions") continue
      states.delete(oldest)
      break
    }
    // 全部受保护时宁可超上限也不丢 latch。
  }
  return state
}

function validSavedBuckets(value: unknown): value is RuleBuckets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return (["allow", "ask", "deny"] as const).every((behavior) => {
    const bucket = (value as RuleBuckets)[behavior]
    return bucket && typeof bucket === "object" && !Array.isArray(bucket) &&
      Object.entries(bucket).every(([source, rules]) => PROVENANCE_SOURCES.includes(source as ProvenanceSource) &&
        Array.isArray(rules) && rules.every((rule) => typeof rule === "string"))
  })
}

export function persistPolicyState(state: InternalPolicyState): void {
  const key = stateKey(state.sessionId, state.tenant)
  try {
    // bypass 只活在当前进程，重启后回落普通模式；限制和规则仍完整保存。
    state.durableRevision = saveHarnessSecurityState("permission", key, {
      ...state, durableRevision: undefined, additionalDirectories: [...state.additionalDirectories],
      mode: state.mode === "bypassPermissions" ? "default" : state.mode,
      prePlanMode: state.prePlanMode === "bypassPermissions" ? "default" : state.prePlanMode,
      explicitMode: state.explicitMode === "bypassPermissions" ? undefined : state.explicitMode,
    }, state.durableRevision)
  } catch (error) {
    states.delete(key)
    throw error
  }
}

export function recordAutoAllow(state: InternalPolicyState, tool: string): void {
  state.autoAllowAudit.push({ ts: Date.now(), tool })
  if (state.autoAllowAudit.length > MAX_AUTO_ALLOW_AUDIT) {
    state.autoAllowAudit.splice(0, state.autoAllowAudit.length - MAX_AUTO_ALLOW_AUDIT)
  }
  state.updatedAt = Date.now()
}

/** 返回快照副本；调用方改动不影响内核状态。 */
export function getPolicyState(sessionId: string, tenant = "default"): PolicyStateSnapshot {
  const state = getState(sessionId, tenant)
  return {
    sessionId: state.sessionId,
    tenant: state.tenant,
    mode: state.mode,
    ...(state.prePlanMode ? { prePlanMode: state.prePlanMode } : {}),
    ...(state.explicitMode ? { explicitMode: state.explicitMode } : {}),
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
    autoAllowAudit: [...state.autoAllowAudit],
    updatedAt: state.updatedAt,
  }
}

/** 可信生命周期清理：同时移除持久状态，不能用于缓存淘汰。 */
export function resetPolicyState(sessionId: string, tenant = "default"): void {
  deleteHarnessSecurityState("permission", stateKey(sessionId, tenant))
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
 * 归一化 `Bash(python:*)`、`Bash(python*)`、`Bash(python *)`、`Bash(./python*)`、
 * `Bash(/usr/bin/python*)`、`Bash(FOO=1 python*)`、`Bash(cd /tmp && python*)` 为同一危险形态。 */
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
  const head = dangerousCommandHead(normalized)
  return DANGEROUS_EXEC_PREFIXES.has(head) || /^python\d*(?:\.\d+)*$/.test(head)
}

/** 取规则前缀最后一个简单命令的可执行档名（剥离 env 赋值、路径、目录切换与引号）。 */
function dangerousCommandHead(content: string): string {
  let head = content.trim().replace(/:\*$/, "").replace(/\*+$/, "").trim()
  const segments = head
    .split(/\|\||&&|[;|\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  head = segments[segments.length - 1] ?? head
  const words = head.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++
  // 常见包装器：command/env/sudo 后面的才是真实可执行档。
  while (index < words.length && /^(?:command|env|sudo|nohup|timeout)$/i.test(words[index])) {
    index++
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || /^-/.test(words[index]))) index++
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++
  }
  let word = words[index] ?? ""
  word = word.replace(/["']/g, "").replace(/\\(?![\\\s])/g, "")
  if (word.includes("/")) word = word.slice(word.lastIndexOf("/") + 1)
  return word.toLowerCase()
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
  /**
   * 内部计划模式转移（enter/exit）标记：只改运行模式，不改「会话显式 setMode」。
   * HTTP /rules 不传此字段。
   */
  fromPlanTransition?: boolean
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
  if ((input.restricted === true && !state.restricted) || (input.bypassDisabled === true && !state.bypassDisabled)) {
    if (input.restricted === true) state.restricted = true
    if (input.bypassDisabled === true) state.bypassDisabled = true
    persistPolicyState(state)
  }

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
    // 会话显式 setMode 是 deriveMode 的最高优先真源；计划模式的内部转移不覆写它。
    if (!input.fromPlanTransition && guard.mode !== "bypassPermissions") {
      state.explicitMode = guard.mode
    }
    persistPolicyState(state)
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
    persistPolicyState(state)
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
    persistPolicyState(state)
    return { ok: true, state: getPolicyState(sessionId, tenant), changed }
  }
  if (input.action === "replaceRules") {
    // deny 桶只能由带进程级 token 的显式操作收缩：空数组不是唯一入口，
    // 非空 replace 删掉既有 deny 规则同样要 token。
    const next = [...new Set(rules)]
    const nextSet = new Set(next)
    const removesDenyRule =
      behavior === "deny" && (next.length === 0 || existing.some((rule) => !nextSet.has(rule)))
    // 清空整个 deny 桶仍要求 clear:true；非空收缩只要求 token。
    if (removesDenyRule && !hasDenyClearToken(input, next.length === 0)) {
      return {
        ok: false,
        code: "clear_forbidden",
        error: "refusing to remove deny rules without clear:true and a valid clearToken",
      }
    }
    bucket[destination] = next
    if (behavior === "allow" && state.mode === "auto") stripDangerousAllowRules(state)
    state.updatedAt = Date.now()
    persistPolicyState(state)
    return { ok: true, state: getPolicyState(sessionId, tenant), changed: rules.length }
  }

  const remove = new Set(rules)
  const next = existing.filter((rule) => !remove.has(rule))
  const changed = existing.length - next.length
  if (behavior === "deny" && changed > 0 && !hasDenyClearToken(input)) {
    return {
      ok: false,
      code: "clear_forbidden",
      error: "refusing to remove deny rules without clear:true and a valid clearToken",
    }
  }
  bucket[destination] = next
  state.updatedAt = Date.now()
  persistPolicyState(state)
  return { ok: true, state: getPolicyState(sessionId, tenant), changed }
}

/** deny 桶收缩的唯一授权：与进程环境一致的 token；清空整桶时另需 clear:true。 */
function hasDenyClearToken(input: UpdateRulesInput, emptying = false): boolean {
  const expected = process.env.AGENT_PERMISSION_CLEAR_TOKEN ?? ""
  if (expected.length === 0 || input.clearToken !== expected) return false
  return emptying ? input.clear === true : true
}
