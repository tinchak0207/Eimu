/**
 * harness-hooks.ts — Claude Code 2.1.302 hook 总线的 Eimu 落地。
 *
 * 约束（照 CC 2.1.302 m0318 原始实现）：
 * - 33 个事件名保留；首期只接 10 个（PreToolUse/PostToolUse/Stop/SessionStart/
 *   PreCompact/PostCompact/TaskCreated/TaskCompleted/SubagentStart/SubagentStop）。
 * - 配置 HARNESS_HOOKS_PATH（默认 /opt/agent-harness/state/hooks.json）：
 *   {hooks:{<event>:[{matcher?,hooks:[{type:"command"|"http",command?|url?,headers?,timeout?}]}]}}
 * - command 用 `bash -lc`，stdin 写 JSON；http 用 fetch；默认超时 60000ms；并行执行。
 * - 输出按 CC 契约截断：reason/stopReason 2000、additionalContext 8000、
 *   systemMessage 4000、单行 200。
 * - 错误不阻断主流程，但写进 errors/results。
 */
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

/** 首期只接这十个；其余事件名保留但未接。 */
export const ENABLED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
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
  matcher?: string | string[] | null
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function positiveTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
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
      const matcher =
        typeof matcherValue.matcher === "string" || Array.isArray(matcherValue.matcher)
          ? (matcherValue.matcher as string | string[])
          : undefined
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

async function readHooksConfig(configPath: string): Promise<{ config: HooksConfig; errors: string[] }> {
  try {
    const text = await Bun.file(configPath).text()
    if (text.trim().length === 0) return { config: { hooks: {} }, errors: [] }
    return normalizeConfig(JSON.parse(text))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { config: { hooks: {} }, errors: [] }
    return { config: { hooks: {} }, errors: [`failed to read hooks config ${configPath}: ${(error as Error).message}`] }
  }
}

export async function loadHooksConfig(configPath = process.env.HARNESS_HOOKS_PATH || DEFAULT_HOOKS_PATH): Promise<HooksConfig> {
  return (await readHooksConfig(configPath)).config
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

function matcherMatches(matcher: string | string[] | null | undefined, query: string | undefined): boolean {
  if (matcher === undefined || matcher === null) return true
  const patterns = Array.isArray(matcher) ? matcher : [matcher]
  if (patterns.length === 0) return true
  if (patterns.every((pattern) => pattern === "" || pattern === "*")) return true
  // 约束：matcher 指定了但事件没有可匹配值 → 不执行（fail-closed）。
  if (query === undefined) return false
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(query)) return true
    } catch {
      // 约束：坏正则不执行该 matcher。
    }
  }
  return false
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
}

function parseActionOutput(stdoutRaw: string, stderrRaw: string, exitCode: number, timedOut: boolean, timeoutMs: number): ParsedActionOutput {
  const stdout = truncateHookOutput(stdoutRaw, 4000, 100)
  const stderr = truncateHookOutput(stderrRaw, 4000, 100)
  if (timedOut) {
    return {
      ok: false,
      blocked: false,
      exitCode,
      stdout,
      stderr,
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

  const hookSpecificOutput = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : undefined
  const permissionDecision = asString(hookSpecificOutput?.permissionDecision)
  const jsonDecision = asString(json.decision)
  const blockDecision = jsonDecision === "block" || permissionDecision === "deny" || json.continue === false
  const exitBlocked = exitCode === 2
  const reasonSource = asString(json.reason) ?? asString(json.stopReason) ?? (exitBlocked ? stderrRaw.trim() || stdoutRaw.trim() : undefined)
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

async function runCommandAction(
  action: HookCommandAction,
  event: string,
  input: Record<string, unknown>,
  opts: RunHooksOptions,
): Promise<HookExecutionResult> {
  const started = Date.now()
  const timeoutMs = action.timeout ?? opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const cwd = opts.cwd ?? process.env.HARNESS_WORKSPACE ?? process.cwd()
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

  let proc: ReturnType<typeof Bun.spawn> | null = null
  try {
    proc = Bun.spawn(["bash", "-lc", action.command], {
      cwd,
      env: {
        ...process.env,
        ...opts.env,
        ...eventEnv(event, input),
        CLAUDE_PROJECT_DIR: cwd,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
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
    const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited])
    const parsed = parseActionOutput(stdoutRaw, stderrRaw, exitCode, timedOut, timeoutMs)
    return {
      type: "command",
      command: action.command,
      ...parsed,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    try {
      proc?.kill()
    } catch {
      // 约束：kill 失败不掩盖原始错误。
    }
    const message = timedOut ? `hook timed out after ${timeoutMs}ms` : (error as Error).message
    return {
      type: "command",
      command: action.command,
      ok: false,
      blocked: false,
      error: message,
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
  const timeoutMs = action.timeout ?? opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
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
    const parsed = parseActionOutput(body, "", 0, timedOut, timeoutMs)
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
    const loaded = await readHooksConfig(opts.configPath ?? process.env.HARNESS_HOOKS_PATH ?? DEFAULT_HOOKS_PATH)
    config = loaded.config
    result.errors.push(...loaded.errors)
  }

  const query = matcherQuery(event, input)
  const tasks: Array<Promise<HookExecutionResult>> = []
  for (const matcher of config.hooks[event] ?? []) {
    if (!matcherMatches(matcher.matcher, query)) continue
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

  for (const entry of results) {
    if (entry.error !== undefined) {
      result.errors.push(`${entry.command ?? entry.url ?? entry.type}: ${entry.error}`)
    }
  }
  return result
}
