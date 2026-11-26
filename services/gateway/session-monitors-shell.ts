import { MonitorPolicyError } from "./session-monitors-types.ts"
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
