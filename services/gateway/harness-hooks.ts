/**
 * harness-hooks.ts — Claude Code 2.1.302 hook 总线的 Eimu 落地。
 *
 * 约束（照 CC 2.1.302 m0318 原始实现）：
 * - 33 个事件名保留；首期只接 11 个（PreToolUse/PostToolUse/Stop/SessionStart/
 *   UserPromptSubmit/PreCompact/PostCompact/TaskCreated/TaskCompleted/SubagentStart/
 *   SubagentStop）。
 * - 配置 HARNESS_HOOKS_PATH（默认 /opt/agent-harness/state/hooks.json）：
 *   {hooks:{<event>:[{matcher?,hooks:[{type:"command"|"http",command?|url?,headers?,timeout?}]}]}}
 * - command 用 `bash -lc`，stdin 写 JSON；http 用 fetch；默认超时 60000ms；并行执行。
 * - 输出按 CC 契约截断：reason/stopReason 2000、additionalContext 8000、
 *   systemMessage 4000、单行 200。
 * - 错误不阻断主流程，但写进 errors/results。
 */
import { readdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "Setup",
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
  "Elicitation",
  "ElicitationResult",
  "PreModelSwitch",
  "PostModelSwitch",
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 首期只接这十一个；其余事件名保留但未接。 */
export const ENABLED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
  // 2026-10-18 接线：每轮用户消息都要触发（原清单遗漏，属死配置）。
  "UserPromptSubmit",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "SubagentStart",
  "SubagentStop",
] as const

export type EnabledHookEvent = (typeof ENABLED_HOOK_EVENTS)[number]

export const DEFAULT_HOOKS_PATH = "/opt/agent-harness/state/hooks.json"
export const DEFAULT_HOOK_TIMEOUT_MS = 60000
/** 单个 hook 的硬上限：任何配置/调用参数都不能超过 10 分钟。 */
export const MAX_HOOK_TIMEOUT_MS = 600000
/** 对话内 hook（SessionStart/UserPromptSubmit/Stop）的默认预算；非法配置回退此值。 */
export const DEFAULT_HOOK_PROMPT_TIMEOUT_MS = 5000

export const HOOK_OUTPUT_LIMITS = Object.freeze({
  reason: 2000,
  stopReason: 2000,
  systemMessage: 4000,
  additionalContext: 8000,
  line: 200,
  reasonLines: 20,
  systemMessageLines: 20,
  additionalContextLines: 200,
})

export interface HookCommandAction {
  type: "command"
  command: string
  timeout?: number
}

export interface HookHttpAction {
  type: "http"
  url: string
  headers?: Record<string, string>
  timeout?: number
}

export type HookAction = HookCommandAction | HookHttpAction

export interface HookMatcher {
  matcher?: string | null
  hooks: HookAction[]
}

export type HooksConfig = {
  hooks: Partial<Record<HookEvent, HookMatcher[]>>
}

export interface HookExecutionResult {
  type: "command" | "http"
  command?: string
  url?: string
  ok: boolean
  blocked: boolean
  exitCode?: number
  decision?: "approve" | "block"
  reason?: string
  additionalContext?: string
  systemMessage?: string
  hookSpecificOutput?: Record<string, unknown>
  stdout?: string
  stderr?: string
  error?: string
  /** 非致命问题（例如 hookSpecificOutput 事件名不匹配被丢弃）。 */
  warnings?: string[]
  /** 约束（P2-10）：超时/中止是否已发生；孙进程无法回收时 errors 会写明。 */
  timedOut?: boolean
  durationMs: number
}

export interface HookRunResult {
  event: string
  supported: boolean
  blocked: boolean
  decision?: "approve" | "block"
  reason?: string
  additionalContext?: string
  systemMessage?: string
  hookSpecificOutput?: Record<string, unknown>
  results: HookExecutionResult[]
  errors: string[]
  /** 任一行超时（P2-10）：调用方据此避免把「超时」误判成「明确放行」。 */
  timedOut?: boolean
  /** 非致命问题；同时以 `warning: ...` 形式并入 errors，便于旧调用方看到。 */
  warnings?: string[]
}

export interface RunHooksOptions {
  config?: HooksConfig
  configPath?: string
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
}

export function isHookEvent(event: string): event is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(event)
}

export function isEnabledHookEvent(event: string): event is EnabledHookEvent {
  return (ENABLED_HOOK_EVENTS as readonly string[]).includes(event)
}

/**
 * 约束（P1-6/P3-14）：hook 注入的 additionalContext/systemMessage 是资料不是指令。
 * 插件与网关消费前必须先过本函数：转义可伪造章节的行首 `#`（含 `> #`、`1. #`、
 * `- #` 变体）与围栏字符。导出给 opencode 插件 import（插件侧修改由 H 代理执行）。
 */
const GW_CREDENTIAL_LIKE_RE = /⟦\s*gw\s*:[^⟧]*⟧/gi

export function escapeInjectedData(text: string): string {
  if (!text) return text
  return String(text)
    .replace(GW_CREDENTIAL_LIKE_RE, "⟪已移除的凭证样式文本⟫")
    .replace(/\\?⟦/g, "\\⟦")
    .replace(/\\?⟧/g, "\\⟧")
    .replace(/\\?【/g, "\\【")
    .replace(/\\?】/g, "\\】")
    .replace(/^([ \t]*(?:(?:>[ \t]*)|(?:(?:[-*+•]|\d+[.)])[ \t]+))*)#/gm, "$1\\#")
}

/**
 * 约束（P2-12）：HARNESS_HOOK_PROMPT_TIMEOUT_MS 非法（空/非数字/≤0）回退 5s；
 * messages-gw 现为 `parseInt(...) || 5000`，会把负数当有效预算。调用方应改用本函数
 * （H 代理修改点，见交付报告）。
 */
export function resolvePromptHookTimeoutMs(raw = process.env.HARNESS_HOOK_PROMPT_TIMEOUT_MS): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_HOOK_PROMPT_TIMEOUT_MS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HOOK_PROMPT_TIMEOUT_MS
  return Math.min(MAX_HOOK_TIMEOUT_MS, Math.floor(parsed))
}

/**
 * 约束（P2-12）：空字符串 / 纯空白 = 未配置（用默认路径，不报 config_missing）；
 * 只有显式给出非空路径且文件不存在才是 config_missing。
 */
export function resolveHooksConfigPath(explicit?: string): { path: string; explicit: boolean } {
  const raw = explicit ?? process.env.HARNESS_HOOKS_PATH
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (trimmed.length === 0) return { path: DEFAULT_HOOKS_PATH, explicit: false }
  return { path: trimmed, explicit: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function positiveTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(MAX_HOOK_TIMEOUT_MS, Math.floor(value))
}

function effectiveTimeout(...candidates: Array<number | undefined>): number {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.min(MAX_HOOK_TIMEOUT_MS, Math.floor(value))
    }
  }
  return DEFAULT_HOOK_TIMEOUT_MS
}

function normalizeAction(value: unknown): HookAction | null {
  if (!isRecord(value)) return null
  const type = value.type
  const timeout = positiveTimeout(value.timeout)
  if (type === "command") {
    const command = asString(value.command)
    if (!command || command.trim().length === 0) return null
    return { type: "command", command, ...(timeout !== undefined ? { timeout } : {}) }
  }
  if (type === "http") {
    const url = asString(value.url)
    if (!url || !/^https?:\/\//i.test(url)) return null
    const headers: Record<string, string> = {}
    if (isRecord(value.headers)) {
      for (const [key, headerValue] of Object.entries(value.headers)) {
        if (typeof headerValue === "string") headers[key] = headerValue
      }
    }
    return {
      type: "http",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
  }
  return null
}

function normalizeConfig(value: unknown): { config: HooksConfig; errors: string[] } {
  const config: HooksConfig = { hooks: {} }
  const errors: string[] = []
  if (!isRecord(value) || !isRecord(value.hooks)) {
    return { config, errors: ["hooks config must be an object with a hooks field"] }
  }
  for (const [event, matchers] of Object.entries(value.hooks)) {
    if (!isHookEvent(event)) {
      errors.push(`unknown hook event: ${event}`)
      continue
    }
    if (!Array.isArray(matchers)) {
      errors.push(`hooks for ${event} must be an array`)
      continue
    }
    const normalized: HookMatcher[] = []
    for (const matcherValue of matchers) {
      if (!isRecord(matcherValue) || !Array.isArray(matcherValue.hooks)) {
        errors.push(`matcher for ${event} must be an object with a hooks array`)
        continue
      }
      // 约束（P1-7）：matcher 必须是 string。非 string 记 error 并跳过该 hook；
      // 坏正则同样记 error 并跳过，绝不退化成 match-all。
      let matcher: string | undefined
      if (matcherValue.matcher !== undefined && matcherValue.matcher !== null) {
        if (typeof matcherValue.matcher !== "string") {
          errors.push(`matcher for ${event} must be a string`)
          continue
        }
        try {
          new RegExp(matcherValue.matcher)
          matcher = matcherValue.matcher
        } catch (error) {
          errors.push(`invalid matcher regex for ${event}: ${(error as Error).message}`)
          continue
        }
      }
      const actions: HookAction[] = []
      for (const actionValue of matcherValue.hooks) {
        const action = normalizeAction(actionValue)
        if (action === null) {
          errors.push(`invalid hook action for ${event}`)
          continue
        }
        actions.push(action)
      }
      if (actions.length > 0) {
        normalized.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: actions })
      }
    }
    if (normalized.length > 0) config.hooks[event] = normalized
  }
  return { config, errors }
}

async function readHooksConfig(
  configPath: string,
  explicit: boolean,
): Promise<{ config: HooksConfig; errors: string[] }> {
  try {
    const text = await Bun.file(configPath).text()
    if (text.trim().length === 0) return { config: { hooks: {} }, errors: [] }
    return normalizeConfig(JSON.parse(text))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 约束（P1-8）：显式配置的路径不存在时给出 config_missing；只有默认路径
    // 缺失才视为「没有配置 hook」。拼错路径不得静默关掉整条 hook 总线。
    if (code === "ENOENT") {
      return {
        config: { hooks: {} },
        errors: explicit ? [`config_missing: hooks config not found: ${configPath}`] : [],
      }
    }
    return { config: { hooks: {} }, errors: [`failed to read hooks config ${configPath}: ${(error as Error).message}`] }
  }
}

export async function loadHooksConfig(configPath?: string): Promise<HooksConfig> {
  const resolved = resolveHooksConfigPath(configPath)
  return (await readHooksConfig(resolved.path, resolved.explicit)).config
}

function matcherQuery(event: string, input: Record<string, unknown>): string | undefined {
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
      return asString(input.tool_name)
    case "SessionStart":
      return asString(input.source)
    case "PreCompact":
    case "PostCompact":
      return asString(input.trigger)
    case "SubagentStart":
    case "SubagentStop":
      return asString(input.agent_type) ?? asString(input.agent_id)
    case "TaskCreated":
    case "TaskCompleted":
      return asString(input.task_id) ?? asString(input.subject)
    default:
      return undefined
  }
}

interface MatcherResult {
  matched: boolean
  error?: string
}

function matcherMatches(matcher: unknown, query: string | undefined): MatcherResult {
  if (matcher === undefined || matcher === null) return { matched: true }
  // 约束（P1-7）：matcher 必须是 string；数组或其它类型一律报错并跳过，
  // 不得因为「无法解析」而退化成 match-all。
  if (typeof matcher !== "string") {
    return { matched: false, error: "matcher must be a string" }
  }
  if (matcher === "" || matcher === "*") return { matched: true }
  let re: RegExp
  try {
    re = new RegExp(matcher)
  } catch (error) {
    return { matched: false, error: `invalid matcher regex: ${(error as Error).message}` }
  }
  // 约束：matcher 指定了但事件没有可匹配值 → 不执行（fail-closed）。
  if (query === undefined) return { matched: false }
  return { matched: re.test(query) }
}

function chars(text: string): string[] {
  return Array.from(text)
}

export function truncateHookOutput(text: string, maxChars: number, maxLines = Number.POSITIVE_INFINITY): string {
  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n").slice(0, Math.max(0, maxLines))
  const shaped = lines
    .map((line) => {
      const clean = line.replace(/\t/g, " ")
      const lineChars = chars(clean)
      return lineChars.length > HOOK_OUTPUT_LIMITS.line
        ? lineChars.slice(0, HOOK_OUTPUT_LIMITS.line - 1).join("") + "…"
        : clean
    })
    .join("\n")
    .replace(/\n+$/g, "")
  const shapedChars = chars(shaped)
  if (shapedChars.length <= maxChars) return shaped
  return shapedChars.slice(0, Math.max(0, maxChars - 1)).join("") + "…"
}

function truncateReason(text: string): string {
  return truncateHookOutput(text, HOOK_OUTPUT_LIMITS.reason, HOOK_OUTPUT_LIMITS.reasonLines)
}

function truncateAdditionalContext(text: string): string {
  return truncateHookOutput(
    text,
    HOOK_OUTPUT_LIMITS.additionalContext,
    HOOK_OUTPUT_LIMITS.additionalContextLines,
  )
}

function truncateSystemMessage(text: string): string {
  return truncateHookOutput(
    text,
    HOOK_OUTPUT_LIMITS.systemMessage,
    HOOK_OUTPUT_LIMITS.systemMessageLines,
  )
}

function parseHookJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const attempts = [trimmed]
  const lastLine = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).pop()
  if (lastLine !== undefined && lastLine !== trimmed) attempts.push(lastLine)
  for (const attempt of attempts) {
    if (!attempt.startsWith("{")) continue
    try {
      const parsed = JSON.parse(attempt)
      if (isRecord(parsed)) return parsed
    } catch {
      // 约束：非 JSON 输出按纯文本处理。
    }
  }
  return null
}

interface ParsedActionOutput {
  ok: boolean
  blocked: boolean
  exitCode?: number
  decision?: "approve" | "block"
  reason?: string
  additionalContext?: string
  systemMessage?: string
  hookSpecificOutput?: Record<string, unknown>
  stdout: string
  stderr: string
  error?: string
  warnings?: string[]
  timedOut?: boolean
}

function parseActionOutput(
  stdoutRaw: string,
  stderrRaw: string,
  exitCode: number,
  timedOut: boolean,
  timeoutMs: number,
  event: string,
): ParsedActionOutput {
  const stdout = truncateHookOutput(stdoutRaw, 4000, 100)
  const stderr = truncateHookOutput(stderrRaw, 4000, 100)
  if (timedOut) {
    return {
      ok: false,
      blocked: false,
      exitCode,
      stdout,
      stderr,
      timedOut: true,
      error: `hook timed out after ${timeoutMs}ms`,
    }
  }

  const json = parseHookJson(stdoutRaw)
  if (json === null) {
    const blocked = exitCode === 2
    return {
      ok: exitCode === 0,
      blocked,
      exitCode,
      ...(blocked ? { reason: truncateReason(stderrRaw.trim() || stdoutRaw.trim() || "hook exited with code 2") } : {}),
      stdout,
      stderr,
      ...(exitCode === 0 ? {} : { error: `hook exited with code ${exitCode}` }),
    }
  }

  const warnings: string[] = []
  let hookSpecificOutput = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : undefined
  // 约束（P0-4）：hookSpecificOutput 必须声明与当前事件一致的 hookEventName；
  // 不一致（含缺失）时丢弃该字段并发警告，绝不把别的事件输出套到本事件上。
  if (hookSpecificOutput !== undefined && hookSpecificOutput.hookEventName !== event) {
    warnings.push(
      `hookSpecificOutput_event_mismatch: expected ${event}, got ${String(hookSpecificOutput.hookEventName)}`,
    )
    hookSpecificOutput = undefined
  }
  const permissionDecision = asString(hookSpecificOutput?.permissionDecision)
  const jsonDecision = asString(json.decision)
  const blockDecision = jsonDecision === "block" || permissionDecision === "deny" || json.continue === false
  const exitBlocked = exitCode === 2
  // 约束（P2-11）：CC 的拒绝理由在 permissionDecisionReason，必须映射到 reason
  // 回给调用方；不能只认 reason/stopReason 而丢掉拒绝原因。
  const permissionDecisionReason =
    asString(hookSpecificOutput?.permissionDecisionReason) ?? asString(json.permissionDecisionReason)
  const reasonSource =
    permissionDecisionReason ??
    asString(json.reason) ??
    asString(json.stopReason) ??
    (exitBlocked ? stderrRaw.trim() || stdoutRaw.trim() : undefined)
  const additionalContextSource =
    asString(hookSpecificOutput?.additionalContext) ?? asString(json.additionalContext)
  const systemMessageSource = asString(json.systemMessage)

  return {
    ok: exitCode === 0,
    blocked: blockDecision || exitBlocked,
    exitCode,
    ...(blockDecision ? { decision: "block" as const } : jsonDecision === "approve" ? { decision: "approve" as const } : {}),
    ...(reasonSource !== undefined && reasonSource.length > 0 ? { reason: truncateReason(reasonSource) } : {}),
    ...(additionalContextSource !== undefined && additionalContextSource.length > 0
      ? { additionalContext: truncateAdditionalContext(additionalContextSource) }
      : {}),
    ...(systemMessageSource !== undefined && systemMessageSource.length > 0
      ? { systemMessage: truncateSystemMessage(systemMessageSource) }
      : {}),
    ...(hookSpecificOutput !== undefined ? { hookSpecificOutput } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    stdout,
    stderr,
    ...(exitCode === 0 ? {} : { error: `hook exited with code ${exitCode}` }),
  }
}

function eventEnv(event: string, input: Record<string, unknown>): Record<string, string> {
  const sessionId = asString(input.session_id)
  return {
    HARNESS_HOOK_EVENT: event,
    ...(sessionId !== undefined ? { HARNESS_SESSION_ID: sessionId, CLAUDE_CODE_SESSION_ID: sessionId } : {}),
  }
}

interface ProcRow {
  pid: number
  ppid: number
  pgrp: number
  sid: number
}

/** 读 /proc/<pid>/stat：comm 可能含空格/括号，按最后一个 ')' 切字段。 */
function readProcTable(): ProcRow[] {
  const rows: ProcRow[] = []
  let names: string[]
  try {
    names = readdirSync("/proc")
  } catch {
    return rows
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    let text: string
    try {
      text = readFileSync(`/proc/${name}/stat`, "utf8")
    } catch {
      continue
    }
    const close = text.lastIndexOf(")")
    if (close < 0) continue
    const fields = text.slice(close + 2).split(" ")
    const ppid = Number(fields[1])
    const pgrp = Number(fields[2])
    const sid = Number(fields[3])
    if (!Number.isFinite(ppid) || !Number.isFinite(pgrp) || !Number.isFinite(sid)) continue
    rows.push({ pid, ppid, pgrp, sid })
  }
  return rows
}

/**
 * 约束（P2-10）：`setsid` 会让孙进程换 session/pgid，单靠 pgrp/sid 追不到。
 * 每次 hook 运行注入唯一环境令牌，按 /proc/<pid>/environ 命中同一令牌的进程，
 * 即使已 reparent 到 init 也能回收。
 */
function findProcessesByRunToken(token: string): number[] {
  const marker = `HARNESS_HOOK_RUN_TOKEN=${token}`
  const pids: number[] = []
  let names: string[]
  try {
    names = readdirSync("/proc")
  } catch {
    return pids
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    let environ: string
    try {
      environ = readFileSync(`/proc/${name}/environ`, "utf8")
    } catch {
      continue
    }
    if (environ.split("\0").includes(marker)) pids.push(pid)
  }
  return pids
}

/**
 * 约束（P2-10）：先杀进程组，再按运行令牌 + /proc 的 pgrp/sid/ppid 递归收集后代
 * 并 SIGKILL；返回回收统计，调用方立刻返回 `timedOut`，不等孙进程释放管道。
 */
function killProcessTree(rootPid: number, runToken?: string): { killed: number; unreaped: number } {
  try {
    process.kill(-rootPid, "SIGKILL")
  } catch {
    // 进程组可能已不存在。
  }
  try {
    process.kill(rootPid, "SIGKILL")
  } catch {
    // 主进程可能已退出。
  }
  const table = readProcTable()
  const children = new Map<number, number[]>()
  for (const row of table) {
    const list = children.get(row.ppid)
    if (list !== undefined) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const targets = new Set<number>()
  const queue: number[] = [rootPid]
  if (runToken !== undefined && runToken.length > 0) {
    for (const pid of findProcessesByRunToken(runToken)) {
      if (targets.has(pid)) continue
      targets.add(pid)
      queue.push(pid)
    }
  }
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const row of table) {
      if (targets.has(row.pid)) continue
      if (row.pgrp === pid || row.sid === pid || row.ppid === pid) {
        targets.add(row.pid)
        queue.push(row.pid)
      }
    }
    for (const child of children.get(pid) ?? []) {
      if (targets.has(child)) continue
      targets.add(child)
      queue.push(child)
    }
  }
  let killed = 0
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL")
      killed += 1
    } catch (error) {
      // ESRCH = 已经退出，视为已回收。
      if ((error as NodeJS.ErrnoException).code === "ESRCH") killed += 1
    }
  }
  return { killed, unreaped: Math.max(0, targets.size - killed) }
}

async function runCommandAction(
  action: HookCommandAction,
  event: string,
  input: Record<string, unknown>,
  opts: RunHooksOptions,
): Promise<HookExecutionResult> {
  const started = Date.now()
  const timeoutMs = effectiveTimeout(action.timeout, opts.timeoutMs)
  const cwd = opts.cwd ?? process.env.HARNESS_WORKSPACE ?? process.cwd()
  // 约束（P2-10）：运行令牌随环境继承，setsid/双 fork 的后代也能被追回。
  const runToken = randomUUID()
  let timedOut = false
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true })
  }

  let proc: ReturnType<typeof Bun.spawn> | null = null
  const abortPromise = new Promise<"aborted">((resolveAbort) => {
    if (controller.signal.aborted) resolveAbort("aborted")
    else controller.signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true })
  })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  // 约束（P1-6/P2-10）：超时/中止杀整个进程组并扫描 /proc 回收 setsid 孙进程；
  // 立刻返回，不等孙进程释放 stdout（否则 `bash -lc 'setsid sleep 300'` 会挂住）。
  let reapNote = ""
  const killTree = () => {
    if (proc === null) return
    const reap = killProcessTree(proc.pid, runToken)
    if (reap.unreaped > 0) {
      reapNote = ` (${reap.unreaped} descendant process(es) could not be reaped)`
    }
  }

  try {
    proc = Bun.spawn(["bash", "-lc", action.command], {
      cwd,
      env: {
        ...process.env,
        ...opts.env,
        ...eventEnv(event, input),
        HARNESS_HOOK_RUN_TOKEN: runToken,
        CLAUDE_PROJECT_DIR: cwd,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // 创建独立进程组：超时才能一次杀掉 bash 及其子进程/孙进程。
      detached: true,
    })
    const stdin = proc.stdin
    if (stdin !== undefined && stdin !== null && typeof stdin !== "number") {
      try {
        stdin.write(JSON.stringify(input))
        stdin.end()
      } catch {
        // 约束：进程早期退出时写入失败属正常，交给 exitCode 判定。
      }
    }
    const stdoutPromise = proc.stdout && typeof proc.stdout !== "number"
      ? new Response(proc.stdout).text()
      : Promise.resolve("")
    const stderrPromise = proc.stderr && typeof proc.stderr !== "number"
      ? new Response(proc.stderr).text()
      : Promise.resolve("")
    const work = Promise.all([stdoutPromise, stderrPromise, proc.exited]).then(
      ([stdoutRaw, stderrRaw, exitCode]) =>
        ({ kind: "done" as const, stdoutRaw, stderrRaw, exitCode }),
    )
    // 超时 promise 不等待 work；work 之后可能才 reject（管道被 kill），吞掉即可。
    work.catch(() => undefined)
    const outcome = await Promise.race([work, abortPromise])
    if (outcome === "aborted") {
      killTree()
      return {
        type: "command",
        command: action.command,
        ok: false,
        blocked: false,
        timedOut,
        error: (timedOut ? `hook timed out after ${timeoutMs}ms` : "hook aborted") + reapNote,
        durationMs: Date.now() - started,
      }
    }
    const parsed = parseActionOutput(outcome.stdoutRaw, outcome.stderrRaw, outcome.exitCode, timedOut, timeoutMs, event)
    return {
      type: "command",
      command: action.command,
      ...parsed,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    killTree()
    const message = timedOut ? `hook timed out after ${timeoutMs}ms` : (error as Error).message
    return {
      type: "command",
      command: action.command,
      ok: false,
      blocked: false,
      timedOut,
      error: message + reapNote,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort)
  }
}

async function runHttpAction(
  action: HookHttpAction,
  event: string,
  input: Record<string, unknown>,
  opts: RunHooksOptions,
): Promise<HookExecutionResult> {
  const started = Date.now()
  const timeoutMs = effectiveTimeout(action.timeout, opts.timeoutMs)
  let timedOut = false
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(action.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Hook-Event": event,
        ...action.headers,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) {
      return {
        type: "http",
        url: action.url,
        ok: false,
        blocked: false,
        stdout: truncateHookOutput(body, 4000, 100),
        error: `HTTP ${response.status}`,
        durationMs: Date.now() - started,
      }
    }
    const parsed = parseActionOutput(body, "", 0, timedOut, timeoutMs, event)
    return {
      type: "http",
      url: action.url,
      ...parsed,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      type: "http",
      url: action.url,
      ok: false,
      blocked: false,
      timedOut,
      error: timedOut ? `hook timed out after ${timeoutMs}ms` : (error as Error).message,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort)
  }
}

export async function runHooks(
  event: string,
  input: Record<string, unknown>,
  opts: RunHooksOptions = {},
): Promise<HookRunResult> {
  const result: HookRunResult = { event, supported: false, blocked: false, results: [], errors: [] }
  if (!isEnabledHookEvent(event)) return result
  result.supported = true

  let config = opts.config
  if (config === undefined) {
    const resolved = resolveHooksConfigPath(opts.configPath)
    const loaded = await readHooksConfig(resolved.path, resolved.explicit)
    config = loaded.config
    result.errors.push(...loaded.errors)
  }

  const query = matcherQuery(event, input)
  const tasks: Array<Promise<HookExecutionResult>> = []
  for (const matcher of config.hooks[event] ?? []) {
    const match = matcherMatches(matcher.matcher, query)
    if (match.error !== undefined) {
      result.errors.push(`${event}: ${match.error}`)
      continue
    }
    if (!match.matched) continue
    for (const action of matcher.hooks) {
      tasks.push(
        action.type === "command"
          ? runCommandAction(action, event, input, opts)
          : runHttpAction(action, event, input, opts),
      )
    }
  }
  if (tasks.length === 0) return result

  // 约束：并行执行；单个 hook 的失败只记录，不中断其他 hook。
  const results = await Promise.all(tasks)
  result.results = results
  if (results.some((entry) => entry.timedOut === true)) result.timedOut = true

  const blockedEntries = results.filter((entry) => entry.blocked)
  result.blocked = blockedEntries.length > 0
  if (result.blocked) result.decision = "block"
  else if (results.some((entry) => entry.decision === "approve")) result.decision = "approve"

  const reasons = blockedEntries
    .map((entry) => entry.reason ?? entry.error)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  if (reasons.length > 0) result.reason = truncateReason(reasons.join("\n"))

  const contexts = results
    .map((entry) => entry.additionalContext)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  if (contexts.length > 0) result.additionalContext = truncateAdditionalContext(contexts.join("\n\n"))

  const systemMessages = results
    .map((entry) => entry.systemMessage)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  if (systemMessages.length > 0) result.systemMessage = truncateSystemMessage(systemMessages.join("\n"))

  const firstSpecific = results.find((entry) => entry.hookSpecificOutput !== undefined)?.hookSpecificOutput
  if (firstSpecific !== undefined) result.hookSpecificOutput = firstSpecific

  const warnings: string[] = []
  for (const entry of results) {
    if (entry.error !== undefined) {
      result.errors.push(`${entry.command ?? entry.url ?? entry.type}: ${entry.error}`)
    }
    for (const warning of entry.warnings ?? []) {
      warnings.push(`${entry.command ?? entry.url ?? entry.type}: ${warning}`)
    }
  }
  if (warnings.length > 0) {
    result.warnings = warnings
    for (const warning of warnings) result.errors.push(`warning: ${warning}`)
  }
  return result
}
