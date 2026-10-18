// Monitor（事件监视）持久层、子进程/WebSocket 采集与 reaper。
//
// 语义取证自 Claude Code 2.1.302 的 Monitor：
// - description 必填（短句）；
// - timeout_ms 默认 300000，上限 1800000（超过压到上限）；
// - command 与 ws 二选一：命令每行 stdout = 一个事件，进程退出即结束；ws 每帧 = 一个事件；
// - 事件到达时作为会话事件推送（复用 emitToSession），不打断当前 turn，也不是用户发言；
// - 超时/结束注入一条系统通知（见 expiryMessage）；0 事件时附 widen the filter 提示；
// - 同一 monitor 每秒最多 20 条进入会话，超出丢弃并计数（防 firehose）。
//
// 约束：
// - 模块 import 时不得启动任何定时器；reaper 只能由 startMonitorReaper() 显式启动。
// - 与 job-store.ts 同一条真源（SESSIONS_DB_PATH），WAL + CREATE TABLE IF NOT EXISTS。
// - 子进程只用 Bun.spawn（bash -lc），cwd=/opt/agent-harness/workspace（HARNESS_WORKSPACE 可覆写），
//   env 只传 PATH/HOME/LANG/TZ；stdout 按行切分；spawn 时 detached=true，停止时杀整个进程组。
// - 命令安全闸是最小防线，不是沙箱：按 shell 分词逐段检查危险形态（含引号/反引号/$()/管道），
//   真正的权限边界在 Eimu 既有工具闸与宿主隔离。
import { Database } from "bun:sqlite"
import { emitToSession } from "./sse-core.ts"
import { resolveSession } from "./sessions-core.ts"
// 子代理会话不在主 sessions 表；monitor 的 session_id 可能是子会话的 opencode id，
// 存活判定必须与其它 /internal 路由同源：resolveSession ?? subagentParentState。
import { subagentParentState } from "./subagent"

export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000
export const MONITOR_MIN_TIMEOUT_MS = 1_000
export const MONITOR_MAX_EVENTS_PER_SECOND = 20
export const MONITOR_LAST_LINES = 50
const MONITOR_LINE_MAX_CHARS = 2_000
/** P2：无换行输出（如 tail 跟随的二进制流）缓冲上限；超出保留尾部。 */
const MONITOR_BUFFER_MAX_CHARS = 64 * 1024
const MONITOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MONITOR_RETENTION_PER_SESSION = 200
const MONITOR_PRUNE_EVERY_TICKS = 60
const MONITOR_KILL_GRACE_MS = 2_000

type SessionStateLike = NonNullable<ReturnType<typeof resolveSession>>

export interface MonitorInput {
  description: string
  timeout_ms?: number
  command?: string
  ws?: string
}

export interface SessionMonitorRow {
  id: number
  session_id: string
  description: string
  command: string | null
  ws_url: string | null
  timeout_ms: number
  status: string
  event_count: number
  dropped_count: number
  started_at: number
  ended_at: number | null
  last_lines: string
  /** owner gateway 的 pid（用于判定另一个 gateway 进程仍持有该监视）。 */
  pid: number | null
  /** 采集子进程 pid（ws 监视为空）。 */
  child_pid: number | null
  /** 采集子进程组 id（detached spawn → 等于 child_pid）。 */
  child_pgid: number | null
  truncated_count: number
}

export interface MonitorView extends Omit<SessionMonitorRow, "last_lines"> {
  last_lines: string[]
}

export class MonitorPolicyError extends Error {
  constructor(message = "command refused by monitor policy") {
    super(message)
    this.name = "MonitorPolicyError"
  }
}

/**
 * M7：timeout_ms 只有缺省时才回默认；显式传入非有限数一律拒绝（由 HTTP 层转 400），
 * 不静默吞成默认值。
 */
export function normalizeMonitorTimeout(ms: unknown): number {
  if (ms === undefined || ms === null) return MONITOR_DEFAULT_TIMEOUT_MS
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new Error("timeout_ms must be a finite number")
  }
  return Math.max(MONITOR_MIN_TIMEOUT_MS, Math.min(MONITOR_MAX_TIMEOUT_MS, Math.floor(ms)))
}

// ── 命令安全闸（最小防线）──────────────────────────────────────────────
// 链路：shell 词法切分 → 展开（引号 / $'...' ANSI-C / $( ) / 反引号 / 花括号）
// → 命令位归一（basename）→ 包装器展开（env/nice/ionice/timeout/setsid/xargs/...）
// → 逐命令检查解释器与破坏性参数。
// 只检查「命令位」与解释器的 -c / script 参数：`echo eval`、`grep 'sudo'` 不误杀。
// 这不是沙箱；真正的权限边界在既有工具闸与宿主隔离。

interface ShellToken {
  value: string
  subs: string[]
  op: boolean
  redirect?: string
}

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"])
const HARD_DENY = new Set([
  "sudo",
  "doas",
  "su",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "mkfs",
  "eval",
  "source",
  "pkill",
  "killall",
  "truncate",
  "shred",
  "wipefs",
])
const WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "builtin",
  "time",
  "xargs",
  "nice",
  "ionice",
  "timeout",
  "setsid",
  "stdbuf",
  "busybox",
  "chronic",
])
const DEVICE_WRITE_COMMANDS = new Set(["cp", "mv", "install", "rsync", "dd", "cat", "tee", "tar"])
const DEVICE_SOURCE = /^(?:if=|of=)?\/dev\/(?:zero|random|urandom|full|mem)$/
const INTERPRETER_EVAL: Record<string, RegExp> = {
  python: /^-c/,
  python3: /^-c/,
  pypy3: /^-c/,
  node: /^(-e|--eval|-p|--print)/,
  nodejs: /^(-e|--eval|-p|--print)/,
  perl: /^-e/,
  ruby: /^-e/,
  php: /^-r/,
  bun: /^(-e|--eval)/,
  deno: /^(-e|--eval)/,
}

function basename(word: string): string {
  const trimmed = word.replace(/\/+$/, "")
  const index = trimmed.lastIndexOf("/")
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** $'...' 的 ANSI-C 转义解码：\xHH、\uHHHH、\0NNN、\n\t\r\\\'\" 等。 */
function decodeAnsiC(raw: string): string {
  let out = ""
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== "\\") {
      out += char
      continue
    }
    const next = raw[index + 1]
    if (next === undefined) break
    index += 1
    switch (next) {
      case "n":
        out += "\n"
        break
      case "t":
        out += "\t"
        break
      case "r":
        out += "\r"
        break
      case "a":
        out += "\x07"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "v":
        out += "\v"
        break
      case "\\":
        out += "\\"
        break
      case "'":
        out += "'"
        break
      case '"':
        out += '"'
        break
      case "x": {
        const hex = raw.slice(index + 1, index + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16))
          index += 2
        } else {
          out += "x"
        }
        break
      }
      case "u": {
        const hex = raw.slice(index + 1, index + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16))
          index += 4
        } else {
          out += "u"
        }
        break
      }
      case "0": {
        const octal = raw.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? ""
        out += String.fromCharCode(Number.parseInt(octal || "0", 8))
        index += octal.length
        break
      }
      default:
        out += next
    }
  }
  return out
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const char of body) {
    if (char === "{") depth += 1
    if (char === "}") depth -= 1
    if (char === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** 花括号展开（至少一层，上限 32 个候选）：`s{udo,}` → sudo / s。 */
function expandBraces(word: string, depth = 0): string[] {
  if (depth > 3) return [word]
  const open = word.indexOf("{")
  if (open < 0) return [word]
  let level = 0
  let close = -1
  for (let index = open; index < word.length; index += 1) {
    if (word[index] === "{") level += 1
    else if (word[index] === "}") {
      level -= 1
      if (level === 0) {
        close = index
        break
      }
    }
  }
  if (close < 0) return [word]
  const prefix = word.slice(0, open)
  const body = word.slice(open + 1, close)
  const suffix = word.slice(close + 1)
  const parts = splitTopLevelCommas(body)
  if (parts.length < 2) return [word] // {a} 不是展开
  const out: string[] = []
  for (const part of parts) {
    for (const expanded of expandBraces(prefix + part + suffix, depth + 1)) out.push(expanded)
    if (out.length >= 32) break
  }
  return out.slice(0, 32)
}

/** 读取平衡括号内的 $() 内容；返回内容与右括号之后的下标。 */
function readParen(source: string, start: number): { text: string; end: number } {
  let depth = 1
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === "'") {
      index += 1
      while (index < source.length && source[index] !== "'") index += 1
      index += 1
      continue
    }
    if (char === '"') {
      index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1
        index += 1
      }
      index += 1
      continue
    }
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return { text: source.slice(start, index), end: index + 1 }
    }
    index += 1
  }
  return { text: source.slice(start), end: source.length }
}

function readBacktick(source: string, start: number): { text: string; end: number } {
  let index = start
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === "`") return { text: source.slice(start, index), end: index + 1 }
    index += 1
  }
  return { text: source.slice(start), end: source.length }
}

function readAnsiC(source: string, start: number): { text: string; end: number } {
  let index = start
  let raw = ""
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      raw += source[index]
      raw += source[index + 1]
      index += 2
      continue
    }
    if (source[index] === "'") return { text: decodeAnsiC(raw), end: index + 1 }
    raw += source[index]
    index += 1
  }
  return { text: decodeAnsiC(raw), end: source.length }
}

function lexShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let current = ""
  let started = false
  let subs: string[] = []
  let index = 0

  const pushWord = (): void => {
    if (!started) return
    tokens.push({ value: current, subs, op: false })
    current = ""
    subs = []
    started = false
  }
  const pushOp = (op: string, redirect?: string): void => {
    pushWord()
    tokens.push(redirect ? { value: op, subs: [], op: true, redirect } : { value: op, subs: [], op: true })
  }

  while (index < source.length) {
    const char = source[index]
    if (char === "'") {
      started = true
      index += 1
      while (index < source.length && source[index] !== "'") {
        current += source[index]
        index += 1
      }
      index += 1
      continue
    }
    if (char === '"') {
      started = true
      index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          // 双引号内反斜杠只对 $ ` " \ 换行 生效；其余（如 \x73）保留给内层解释器解析。
          const next = source[index + 1]
          if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") current += next
          else current += `\\${next}`
          index += 2
          continue
        }
        if (source[index] === "$" && source[index + 1] === "(") {
          const sub = readParen(source, index + 2)
          subs.push(sub.text)
          current += sub.text
          index = sub.end
          continue
        }
        if (source[index] === "`") {
          const sub = readBacktick(source, index + 1)
          subs.push(sub.text)
          current += sub.text
          index = sub.end
          continue
        }
        current += source[index]
        index += 1
      }
      index += 1
      continue
    }
    if (char === "$" && source[index + 1] === "'") {
      started = true
      const sub = readAnsiC(source, index + 2)
      current += sub.text
      index = sub.end
      continue
    }
    if (char === "\\" && index + 1 < source.length) {
      started = true
      current += source[index + 1]
      index += 2
      continue
    }
    if (char === "`") {
      started = true
      const sub = readBacktick(source, index + 1)
      subs.push(sub.text)
      current += sub.text
      index = sub.end
      continue
    }
    if (char === "$" && source[index + 1] === "(") {
      started = true
      const sub = readParen(source, index + 2)
      subs.push(sub.text)
      current += sub.text
      index = sub.end
      continue
    }
    if (char === "<" || char === ">") {
      let op = char
      if (source[index + 1] === char) {
        op += char
        index += 1
        if (char === "<" && source[index + 1] === "<") {
          op += "<"
          index += 1
        }
      } else if (source[index + 1] === "&" || (char === ">" && source[index + 1] === "|")) {
        op += source[index + 1]
        index += 1
      }
      pushOp(op, op)
      index += 1
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
      pushOp(char === "\n" ? ";" : char)
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      pushWord()
      index += 1
      continue
    }
    started = true
    current += char
    index += 1
  }
  pushWord()
  return tokens
}

type WrapperStep = { kind: "next"; index: number } | { kind: "inline"; text: string } | { kind: "end" }

const XARGS_VALUE_FLAGS = new Set(["-n", "-L", "-I", "-P", "-s", "-E", "-d", "-a", "-e"])

/** 跳过选项：返回第一个非选项（命令位）下标；`--` 后直接返回下一词。 */
function skipOpts(values: string[], start: number, withValue: Set<string>): number {
  let index = start
  while (index < values.length) {
    const value = values[index]
    if (value === "--") return index + 1
    if (value.startsWith("-") && value !== "-") {
      const eq = value.indexOf("=")
      const flag = eq >= 0 ? value.slice(0, eq) : value
      index += withValue.has(flag) ? 2 : 1
      continue
    }
    return index
  }
  return index
}

/** 包装器展开：返回被包装命令的下标 / 内联脚本 / 无后续命令。 */
function wrapperStep(name: string, values: string[], index: number, subsAt: boolean[] = []): WrapperStep {
  const rest = index + 1
  switch (name) {
    case "env": {
      let at = rest
      while (at < values.length) {
        const value = values[at]
        if (value === "-S" || value === "--split-string") {
          if (subsAt[at + 1]) refuse("env -S from substitution")
          return { kind: "inline", text: values[at + 1] ?? "" }
        }
        if (value.startsWith("--split-string=")) return { kind: "inline", text: value.slice("--split-string=".length) }
        if (value === "--") {
          at += 1
          break
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          at += 1
          continue
        }
        if (value.startsWith("-") && value !== "-") {
          at += value === "-u" || value === "-C" || value === "--unset" || value === "--chdir" ? 2 : 1
          continue
        }
        break
      }
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "timeout": {
      const at = skipOpts(values, rest, new Set(["-s", "--signal", "-k", "--kill-after"])) + 1 // duration
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "nice": {
      const at = skipOpts(values, rest, new Set(["-n", "--adjustment"]))
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "ionice": {
      let at = rest
      while (at < values.length && values[at].startsWith("-")) {
        const value = values[at]
        at += value === "-p" || value === "-P" || value === "-c" || value === "-n" || value === "-t" ? 2 : 1
      }
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "xargs": {
      let at = rest
      while (at < values.length) {
        const value = values[at]
        if (value === "--") {
          at += 1
          break
        }
        if (!value.startsWith("-") || value === "-") break
        const flag = value.includes("=") ? value.slice(0, value.indexOf("=")) : value
        at += XARGS_VALUE_FLAGS.has(flag) ? 2 : 1
      }
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "command": {
      if (values[rest] === "-v" || values[rest] === "-V") return { kind: "end" }
      const at = skipOpts(values, rest, new Set())
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "exec": {
      const at = skipOpts(values, rest, new Set(["-a"]))
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "time": {
      const at = skipOpts(values, rest, new Set(["-f", "--format", "-o", "--output"]))
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "stdbuf": {
      const at = skipOpts(values, rest, new Set(["-i", "-o", "-e", "--input", "--output", "--error"]))
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    case "setsid":
    case "nohup":
    case "builtin":
    case "chronic":
    case "busybox": {
      const at = skipOpts(values, rest, new Set())
      return at < values.length ? { kind: "next", index: at } : { kind: "end" }
    }
    default:
      return rest < values.length ? { kind: "next", index: rest } : { kind: "end" }
  }
}

function refuse(reason: string): never {
  throw new MonitorPolicyError(`command refused by monitor policy (${reason})`)
}

function checkCommand(
  name: string,
  args: string[],
  argSubs: boolean[],
  inputRedirect: boolean,
  pipelineIndex: number,
  depth: number,
): void {
  if (!name) return
  if (HARD_DENY.has(name) || name.startsWith("mkfs.")) refuse(name)
  // 命令位出现未展开的变量/反引号：无法证明它指向什么，直接拒绝。
  if (/[$`]/.test(name)) refuse("unresolved command name")

  if (SHELL_NAMES.has(name)) {
    if (inputRedirect) refuse("shell reading script from stdin/file")
    let sawC = false
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      let script: string | undefined
      let scriptHasSub = false
      if (arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
        sawC = true
        script = args[index + 1]
        scriptHasSub = argSubs[index + 1] === true
      } else if (/^-[A-Za-z]*c.+$/.test(arg)) {
        sawC = true
        script = arg.slice(arg.indexOf("c") + 1)
        scriptHasSub = argSubs[index] === true
      }
      if (script !== undefined) {
        // 外层 $( )/反引号的输出会变成内层脚本（bash -c "$(echo sudo) id"），无法静态证明 → 拒绝。
        if (scriptHasSub) refuse("shell script from substitution")
        assertCommandInternal(script, depth + 1)
        return
      }
    }
    if (sawC) refuse("shell -c without script")
    if (args.some((arg) => !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))) {
      refuse("shell script file")
    }
    if (pipelineIndex > 0) refuse("pipe into shell")
    return
  }

  const evalFlag = INTERPRETER_EVAL[name]
  if (evalFlag && args.some((arg) => evalFlag.test(arg))) refuse(`${name} inline code`)
  if (name === "deno" && args[0] === "eval") refuse("deno eval")

  if (name === "find") {
    for (const arg of args) {
      if (arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir") refuse("find -exec")
      if (arg === "-delete") refuse("find -delete")
    }
  }

  if (DEVICE_WRITE_COMMANDS.has(name)) {
    if (args.some((arg) => DEVICE_SOURCE.test(arg))) refuse(`${name} /dev/zero`)
  }
  if (name === "dd" && args.some((arg) => arg.startsWith("of=/dev/"))) refuse("dd of=/dev/")

  if (name === "rm") {
    let recursive = false
    let force = false
    for (const arg of args) {
      if (arg === "--recursive") recursive = true
      else if (arg === "--force") force = true
      else if (/^-[A-Za-z]+$/.test(arg)) {
        const flags = arg.slice(1)
        if (/[rR]/.test(flags)) recursive = true
        if (flags.includes("f")) force = true
      }
    }
    if (recursive && force) refuse("rm recursive+force")
    if (recursive && args.some((arg) => arg === "/" || arg === "/*" || arg === "//")) refuse("rm -r /")
  }
}

function analyzeSingle(
  values: string[],
  start: number,
  subsAt: boolean[],
  inputRedirect: boolean,
  pipelineIndex: number,
  depth: number,
): void {
  let index = start
  let guard = 0
  while (index < values.length) {
    guard += 1
    if (guard > 12) refuse("nested wrapper")
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index])) {
      index += 1
      continue
    }
    // 命令位来自替换（$(echo sudo)）：实际执行的词不可静态证明 → 拒绝。
    if (subsAt[index]) refuse("command substitution at command position")
    const name = basename(values[index])
    if (!name) return
    if (WRAPPERS.has(name)) {
      const step = wrapperStep(name, values, index, subsAt)
      if (step.kind === "end") return
      if (step.kind === "inline") {
        if (step.text.trim()) assertCommandInternal(step.text, depth + 1)
        return
      }
      index = step.index
      continue
    }
    checkCommand(name, values.slice(index + 1), subsAt.slice(index + 1), inputRedirect, pipelineIndex, depth)
    return
  }
}

/** 命令位可能由花括号展开成多个候选（`s{udo,}`）；逐个候选独立判定。 */
function analyzeCommand(
  values: string[],
  start: number,
  subsAt: boolean[],
  inputRedirect: boolean,
  pipelineIndex: number,
  depth: number,
): void {
  const alternatives = expandBraces(values[start])
  for (const alternative of alternatives) {
    const next = values.slice()
    next[start] = alternative
    analyzeSingle(next, start, subsAt, inputRedirect, pipelineIndex, depth)
  }
}

function checkSegment(segment: ShellToken[], pipelineIndex: number, depth: number): void {
  for (const word of segment) {
    for (const sub of word.subs) assertCommandInternal(sub, depth + 1)
  }
  const words: ShellToken[] = []
  let inputRedirect = false
  const redirectTargets: string[] = []
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]
    if (token.op) {
      if (token.redirect) {
        if (token.redirect.startsWith("<")) inputRedirect = true
        const target = segment[index + 1]
        if (target && !target.op) {
          redirectTargets.push(target.value)
          index += 1
        }
      }
      continue
    }
    words.push(token)
  }
  for (const target of redirectTargets) {
    if (/^\/dev\/(?:sd|nvme|hd|vd|dm-|md)/.test(target)) refuse("raw device write")
  }
  const values = words.map((word) => word.value)
  const subsAt = words.map((word) => word.subs.length > 0)
  let index = 0
  while (index < values.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index])) index += 1
  if (index >= values.length) return
  analyzeCommand(values, index, subsAt, inputRedirect, pipelineIndex, depth)
}

function assertCommandInternal(command: string, depth: number): void {
  if (depth > 8) throw new MonitorPolicyError("command refused by monitor policy (nested substitution)")
  const tokens = lexShell(command)
  let segment: ShellToken[] = []
  let pipelineIndex = 0
  const flush = (): void => {
    if (segment.length > 0) checkSegment(segment, pipelineIndex, depth)
    segment = []
  }
  for (const token of tokens) {
    if (!token.op) {
      segment.push(token)
      continue
    }
    if (token.redirect) {
      // 重定向属于当前段：保留 token（目标词在 checkSegment 里识别）。
      segment.push(token)
      continue
    }
    if (token.value === "|") {
      flush()
      pipelineIndex += 1
      continue
    }
    flush()
    pipelineIndex = 0
  }
  flush()
}

export function assertMonitorCommandAllowed(command: string): void {
  if (typeof command !== "string" || !command.trim()) {
    throw new MonitorPolicyError("command refused by monitor policy (empty command)")
  }
  assertCommandInternal(command, 0)
}

// ── 持久层 ──────────────────────────────────────────────────────────────
let connection: Database | undefined

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ensureColumn(handle: Database, table: string, column: string, declaration: string): void {
  const columns = handle.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
}

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS session_monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    description TEXT NOT NULL,
    command TEXT,
    ws_url TEXT,
    timeout_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    event_count INTEGER NOT NULL DEFAULT 0,
    dropped_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_lines TEXT NOT NULL DEFAULT '[]',
    pid INTEGER,
    child_pid INTEGER,
    child_pgid INTEGER,
    truncated_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS session_monitors_session ON session_monitors(session_id, status);`)
  ensureColumn(next, "session_monitors", "pid", "INTEGER")
  ensureColumn(next, "session_monitors", "child_pid", "INTEGER")
  ensureColumn(next, "session_monitors", "child_pgid", "INTEGER")
  ensureColumn(next, "session_monitors", "truncated_count", "INTEGER NOT NULL DEFAULT 0")
  connection = next
  return next
}

function parseLines(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

// ── 进行中的监视句柄 ────────────────────────────────────────────────────
interface ActiveMonitor {
  id: number
  sessionId: string
  description: string
  timeoutMs: number
  startedAt: number
  eventCount: number
  droppedCount: number
  truncatedCount: number
  lastLines: string[]
  windowStart: number
  windowCount: number
  finished: boolean
  childPid: number | null
  childPgid: number | null
  kill: () => void
  timer?: ReturnType<typeof setTimeout>
  state?: SessionStateLike
}

const active = new Map<number, ActiveMonitor>()

function stateFor(handle: ActiveMonitor): SessionStateLike | undefined {
  if (!handle.state) handle.state = resolveSession(handle.sessionId)
  return handle.state
}

function deliver(handle: ActiveMonitor, rawLine: string): void {
  if (handle.finished) return
  const now = Date.now()
  if (now - handle.windowStart >= 1000) {
    handle.windowStart = now
    handle.windowCount = 0
  }
  if (handle.windowCount >= MONITOR_MAX_EVENTS_PER_SECOND) {
    handle.droppedCount += 1
    return
  }
  handle.windowCount += 1
  handle.eventCount += 1

  const line = rawLine.length > MONITOR_LINE_MAX_CHARS ? rawLine.slice(0, MONITOR_LINE_MAX_CHARS) : rawLine
  handle.lastLines.push(line)
  if (handle.lastLines.length > MONITOR_LAST_LINES) {
    handle.lastLines.splice(0, handle.lastLines.length - MONITOR_LAST_LINES)
  }
  const state = stateFor(handle)
  if (!state) return // 会话已不在：事件仍计数，但没有 SSE 出口可推。
  emitToSession(state, "monitor.event", {
    monitor_id: handle.id,
    description: handle.description,
    line,
    seq: handle.eventCount,
  })
}

function expiryMessage(minutes: number, events: number): string {
  const base = `[Monitor expired after ${minutes} minutes with ${events} events delivered. Re-arm it if you still need the watch.]`
  return events === 0 ? `${base} The monitor saw no output; widen the filter if silence was unexpected.` : base
}

function persistCounters(handle: ActiveMonitor, status = "running", endedAt: number | null = null): void {
  db()
    .query(
      "UPDATE session_monitors SET status=?,event_count=?,dropped_count=?,truncated_count=?,ended_at=?,last_lines=? WHERE id=?",
    )
    .run(
      status,
      handle.eventCount,
      handle.droppedCount,
      handle.truncatedCount,
      endedAt,
      JSON.stringify(handle.lastLines),
      handle.id,
    )
}

function emitMonitorFrame(
  sessionId: string,
  monitorId: number,
  description: string,
  eventCount: number,
  droppedCount: number,
  name: string,
  message?: string,
): void {
  const state = resolveSession(sessionId)
  if (!state) return
  emitToSession(state, name, {
    monitor_id: monitorId,
    description,
    event_count: eventCount,
    dropped_count: droppedCount,
    ...(message ? { message } : {}),
  })
  // turn.status 是既有的用户可见通知通道（ack/heartbeat 同款），不会结束当前 turn。
  if (message) emitToSession(state, "turn.status", { text: message })
}

/**
 * M6：状态如实记录退出原因——`ended:code` / `ended:signal`（超时才是 expired）。
 * 帧文案带具体 code/signal，不把非零退出与信号都伪装成 expired。
 */
function finishMonitor(handle: ActiveMonitor, status: string, detail?: string): void {
  if (handle.finished) return
  handle.finished = true
  active.delete(handle.id)
  if (handle.timer) clearTimeout(handle.timer)
  try {
    handle.kill()
  } catch {
    // 进程/连接可能已自行结束。
  }
  const endedAt = Date.now()
  persistCounters(handle, status, endedAt)
  const minutes = Math.max(0, Math.round((endedAt - handle.startedAt) / 60_000))
  if (status === "expired") {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.expired",
      expiryMessage(minutes, handle.eventCount),
    )
  } else if (status === "ended" || status.startsWith("ended:")) {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.ended",
      `[Monitor ended: ${detail || "source closed"}]`,
    )
  } else if (status === "error") {
    emitMonitorFrame(
      handle.sessionId,
      handle.id,
      handle.description,
      handle.eventCount,
      handle.droppedCount,
      "monitor.error",
      `[Monitor ended with an error: ${detail || "unknown error"}]`,
    )
  } else {
    emitMonitorFrame(handle.sessionId, handle.id, handle.description, handle.eventCount, handle.droppedCount, "monitor.stopped")
  }
  console.log(`[gateway] monitor ${status}: id=${handle.id} session=${handle.sessionId} events=${handle.eventCount} dropped=${handle.droppedCount}`)
}

// ── 采集源 ──────────────────────────────────────────────────────────────
function monitorEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "HOME", "LANG", "TZ"]) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/** M1：detached 让 bash 成为新进程组组长；停止时 SIGTERM 整组，2s 后 SIGKILL 兜底。 */
function killProcessGroup(proc: ReturnType<typeof Bun.spawn>): void {
  const pid = proc.pid
  const termGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // 已退出。
      }
    }
  }
  termGroup("SIGTERM")
  const killer = setTimeout(() => termGroup("SIGKILL"), MONITOR_KILL_GRACE_MS)
  killer.unref?.()
}

/** 按进程组回收（reaper 用：只拿得到 DB 里的 pgid，没有 Bun.spawn 句柄）。 */
function killProcessGroupId(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, signal)
    } catch {
      // ESRCH：组已不存在。
    }
  }
  signalGroup("SIGTERM")
  const killer = setTimeout(() => signalGroup("SIGKILL"), MONITOR_KILL_GRACE_MS)
  killer.unref?.()
}

function spawnCommand(handle: ActiveMonitor, command: string): void {
  const cwd = process.env.HARNESS_WORKSPACE || "/opt/agent-harness/workspace"
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    env: monitorEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  })
  handle.kill = () => killProcessGroup(proc)
  // P1：DB 里记的是采集子进程（detached → 自成一个进程组），不是 gateway 自己的 pid。
  // gateway 被 SIGKILL 后，新进程据此 kill(-pgid) 回收孤儿。
  handle.childPid = proc.pid
  handle.childPgid = proc.pid
  try {
    db()
      .query("UPDATE session_monitors SET child_pid=?,child_pgid=? WHERE id=?")
      .run(proc.pid, proc.pid, handle.id)
  } catch (e) {
    console.error(`[gateway] monitor ${handle.id} failed to record child pid:`, e)
  }

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let overflowed = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // P2：无换行的输出曾把 buffer 撑成无界；超过上限保留尾部并只记一次 output_truncated。
        if (buffer.length > MONITOR_BUFFER_MAX_CHARS) {
          buffer = buffer.slice(-MONITOR_BUFFER_MAX_CHARS)
          if (!overflowed) {
            overflowed = true
            handle.truncatedCount += 1
          }
        }
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          overflowed = false
          if (line.trim()) deliver(handle, line)
          newline = buffer.indexOf("\n")
        }
      }
      buffer += decoder.decode()
      if (buffer.length > MONITOR_BUFFER_MAX_CHARS) {
        buffer = buffer.slice(-MONITOR_BUFFER_MAX_CHARS)
        if (!overflowed) {
          overflowed = true
          handle.truncatedCount += 1
        }
      }
      const tail = buffer.replace(/\r$/, "")
      if (tail.trim()) deliver(handle, tail)
    } catch (e) {
      if (!handle.finished) finishMonitor(handle, "error", (e as Error)?.message || String(e))
    }
    let code: number | null = null
    try {
      code = await proc.exited
    } catch {
      // 退出码取不到不影响收档。
    }
    const signal = (proc as unknown as { signalCode?: string | null }).signalCode ?? null
    if (!handle.finished) {
      if (signal) {
        finishMonitor(handle, "ended:signal", `process terminated by signal ${signal}`)
      } else {
        const exitCode = code ?? 0
        finishMonitor(handle, "ended:code", `process exited with code ${exitCode}`)
      }
    }
  })()
}

function connectWebSocket(handle: ActiveMonitor, url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("ws must be a valid ws:// or wss:// URL")
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("ws must use ws:// or wss://")
  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch (e) {
    throw new Error(`websocket failed: ${(e as Error)?.message || String(e)}`)
  }
  handle.kill = () => {
    try {
      socket.close()
    } catch {
      // 已关闭。
    }
  }
  socket.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data
    const text =
      typeof data === "string" ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data ?? "")
    for (const line of text.split("\n")) if (line.trim()) deliver(handle, line)
  })
  socket.addEventListener("error", () => {
    if (!handle.finished) finishMonitor(handle, "error", "websocket error")
  })
  socket.addEventListener("close", () => {
    if (!handle.finished) finishMonitor(handle, "ended", "websocket closed")
  })
}

// ── 对外 API ────────────────────────────────────────────────────────────
export function startMonitor(
  sessionId: string,
  input: MonitorInput,
): { id: number; status: "running"; timeout_ms: number; description: string } {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const description = typeof input?.description === "string" ? input.description.trim() : ""
  if (!description) throw new Error("description is required")
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const ws = typeof input.ws === "string" ? input.ws.trim() : ""
  if (Boolean(command) === Boolean(ws)) throw new Error("exactly one of command or ws is required")
  if (command) assertMonitorCommandAllowed(command)
  const timeoutMs = normalizeMonitorTimeout(input.timeout_ms)

  const startedAt = Date.now()
  const inserted = db()
    .query(`INSERT INTO session_monitors(session_id,description,command,ws_url,timeout_ms,status,event_count,dropped_count,truncated_count,started_at,ended_at,last_lines,pid)
      VALUES(?,?,?,?,?,'running',0,0,0,?,NULL,'[]',?)`)
    .run(sid, description.slice(0, 200), command || null, ws || null, timeoutMs, startedAt, process.pid)
  const id = Number(inserted.lastInsertRowid)

  const handle: ActiveMonitor = {
    id,
    sessionId: sid,
    description,
    timeoutMs,
    startedAt,
    eventCount: 0,
    droppedCount: 0,
    truncatedCount: 0,
    lastLines: [],
    windowStart: startedAt,
    windowCount: 0,
    finished: false,
    childPid: null,
    childPgid: null,
    kill: () => {},
  }
  active.set(id, handle)

  try {
    if (command) spawnCommand(handle, command)
    else connectWebSocket(handle, ws)
  } catch (e) {
    active.delete(id)
    handle.finished = true
    persistCounters(handle, "error", Date.now())
    throw new Error(`monitor failed to start: ${(e as Error)?.message || String(e)}`)
  }

  handle.timer = setTimeout(() => finishMonitor(handle, "expired"), timeoutMs)
  handle.timer.unref()
  console.log(`[gateway] monitor started: id=${id} session=${sid} timeout=${timeoutMs}ms source=${command ? "command" : "ws"}`)
  return { id, status: "running", timeout_ms: timeoutMs, description }
}

export function stopMonitor(sessionId: string, id: number): { stopped: boolean; status: string } {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  if (!Number.isInteger(id) || id <= 0) throw new Error("monitor id must be a positive integer")
  const row = db().query("SELECT status FROM session_monitors WHERE id=? AND session_id=?").get(id, sid) as
    | { status: string }
    | null
  if (!row) throw new Error(`monitor ${id} not found for this session`)
  const handle = active.get(id)
  if (handle) finishMonitor(handle, "stopped")
  else if (row.status === "running") {
    db().query("UPDATE session_monitors SET status='stopped',ended_at=? WHERE id=? AND status='running'").run(Date.now(), id)
  }
  return { stopped: row.status === "running", status: row.status === "running" ? "stopped" : row.status }
}

export function listMonitors(sessionId: string): MonitorView[] {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  const rows = db().query("SELECT * FROM session_monitors WHERE session_id=? ORDER BY id DESC").all(sid) as SessionMonitorRow[]
  return rows.map((row) => {
    const handle = active.get(row.id)
    return {
      ...row,
      event_count: handle ? handle.eventCount : row.event_count,
      dropped_count: handle ? handle.droppedCount : row.dropped_count,
      last_lines: handle ? [...handle.lastLines] : parseLines(row.last_lines),
    }
  })
}

/** 会话拆除/显式取消时一并收档；返回实际停止的监视数。 */
export function killSessionMonitors(sessionId: string, reason = "stopped"): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) throw new Error("sessionId is required")
  let stopped = 0
  for (const handle of [...active.values()]) {
    if (handle.sessionId !== sid) continue
    finishMonitor(handle, "stopped", reason)
    stopped += 1
  }
  // 只动本进程 owner 的行：另一个存活 gateway 进程对同一 session 的监视不被误杀。
  const res = db()
    .query(
      "UPDATE session_monitors SET status='stopped',ended_at=? WHERE session_id=? AND status='running' AND (pid IS NULL OR pid=?)",
    )
    .run(Date.now(), sid, process.pid)
  return stopped + Number(res.changes)
}

/**
 * M10：保留清理——非 running 且超过 7 天、或每会话超过 200 行。只清终态行。
 */
export function pruneMonitors(now: number = Date.now()): number {
  const handle = db()
  let removed = 0
  const expired = handle
    .query("DELETE FROM session_monitors WHERE status<>'running' AND COALESCE(ended_at,started_at) < ?")
    .run(now - MONITOR_RETENTION_MS)
  removed += Number(expired.changes)
  const sessions = handle
    .query("SELECT session_id FROM session_monitors WHERE status<>'running' GROUP BY session_id HAVING COUNT(*) > ?")
    .all(MONITOR_RETENTION_PER_SESSION) as Array<{ session_id: string }>
  for (const session of sessions) {
    const res = handle
      .query(
        `DELETE FROM session_monitors WHERE session_id=? AND status<>'running'
         AND id NOT IN (
           SELECT id FROM session_monitors WHERE session_id=? AND status<>'running' ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(session.session_id, session.session_id, MONITOR_RETENTION_PER_SESSION)
    removed += Number(res.changes)
  }
  return removed
}

interface MonitorReaper {
  timer: ReturnType<typeof setInterval>
  stop: () => void
}

let reaper: MonitorReaper | null = null

/**
 * 会话存活判定：与其它 /internal 路由同一解析链。
 * - gateway 会话：resolveSession 含 gateway id / opencode id / DB 懒加载；
 * - 子代理会话：subagentParentState 回溯父会话。
 * 旧实现用 `sessions.has(id)`，而 sessions 的键是 gateway UUID —— 用 opencode id
 * 或子会话 id 创建的 monitor 会被每一拍当成「会话已消失」秒杀（P1）。
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sessionAlive(sessionId: string): boolean {
  try {
    return Boolean(resolveSession(sessionId) ?? subagentParentState(sessionId))
  } catch (e) {
    // 解析链异常（DB/宿主）时不误杀正在工作的监视。
    console.error("[gateway] monitor session liveness check failed:", e)
    return true
  }
}

/**
 * 启动全局 reaper（单实例、幂等、.unref()）：刷计数、按墙钟判超时，
 * 收档进程重启后失去内存句柄且 owner pid 已死的 running 行（M3：活跃进程的行绝不动），
 * 并在会话已拆除时杀整个监视进程组（M2 的接线点，无需改 sessions-core）。
 */
export function startMonitorReaper(opts: { intervalMs?: number } = {}): () => void {
  if (reaper) return reaper.stop
  const intervalMs = Math.max(1_000, Math.floor(opts.intervalMs ?? 10_000))
  let tickCount = 0

  const tick = (): void => {
    try {
      const now = Date.now()
      const goneSessions = new Set<string>()
      for (const handle of [...active.values()]) {
        // 会话已被 teardown/DELETE：监视不得继续占用子进程，整组收档。
        if (!sessionAlive(handle.sessionId)) {
          goneSessions.add(handle.sessionId)
          continue
        }
        persistCounters(handle, "running", null)
        if (now - handle.startedAt >= handle.timeoutMs) finishMonitor(handle, "expired")
      }
      // P1：killSessionMonitors 接到会话消失检测，不再是从未被呼叫的死码。
      for (const sid of goneSessions) {
        try {
          const killed = killSessionMonitors(sid, "session gone")
          console.log(`[gateway] monitor session gone: session=${sid} stopped=${killed}`)
        } catch (e) {
          console.error(`[gateway] killSessionMonitors failed for ${sid}:`, e)
        }
      }
      const orphans = db()
        .query(
          "SELECT id,session_id,description,event_count,dropped_count,started_at,pid,child_pid,child_pgid FROM session_monitors WHERE status='running'",
        )
        .all() as Array<{
        id: number
        session_id: string
        description: string
        event_count: number
        dropped_count: number
        started_at: number
        pid: number | null
        child_pid: number | null
        child_pgid: number | null
      }>
      for (const row of orphans) {
        if (active.has(row.id)) continue
        // M3：另一个存活 gateway 进程持有的行不碰；本进程 pid 的遗留行按孤儿处理
        //（pid 复用无法区分，宁可回收采集子进程也不留下孤儿）。
        if (typeof row.pid === "number" && row.pid !== process.pid && pidAlive(row.pid)) continue
        // P1：owner 已死 → 用 DB 里的采集子进程组 id 回收整组（不是 gateway pid）。
        if (typeof row.child_pgid === "number" && row.child_pgid > 1) {
          if (groupAlive(row.child_pgid)) {
            killProcessGroupId(row.child_pgid)
            console.log(
              `[gateway] monitor orphan reaped: id=${row.id} owner=${row.pid ?? "none"} pgid=${row.child_pgid}`,
            )
          }
        }
        db().query("UPDATE session_monitors SET status='expired',ended_at=? WHERE id=? AND status='running'").run(now, row.id)
        const minutes = Math.max(0, Math.round((now - row.started_at) / 60_000))
        emitMonitorFrame(
          row.session_id,
          row.id,
          row.description,
          row.event_count,
          row.dropped_count,
          "monitor.expired",
          expiryMessage(minutes, row.event_count),
        )
      }
      tickCount += 1
      if (tickCount % MONITOR_PRUNE_EVERY_TICKS === 0) pruneMonitors(now)
    } catch (e) {
      console.error("[gateway] monitor reaper error:", e)
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref()
  const stop = (): void => {
    clearInterval(timer)
    if (reaper?.timer === timer) reaper = null
  }
  reaper = { timer, stop }
  tick()
  return stop
}
