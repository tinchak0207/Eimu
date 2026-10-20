import { lstatSync, realpathSync } from "node:fs"
import { posix } from "node:path"
import { Behavior, PermissionDecision, PermissionMode, PermissionReason } from "./permission-policy-types"
import { CREDENTIAL_BASENAMES, SHELL_RC_BASENAMES, basenameOf, checkPathSafety, isEnvFile, isFishFunctionPath, isSettingsFile, lower } from "./permission-policy-path"
import { BASH_FAMILY, PermissionContext, contextCwd, contextHome, isEditTool, normalizeAbsolute, pathsFromTool } from "./permission-policy-match"

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
  const value = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\ /g, " ")
    // 子 shell 段可能以 `)` 结尾（`(cd /tmp; echo x > f)`）。
    .replace(/\)+$/g, "")
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

/** 简单 shell 分词：去引号，保留变量与命令替换原文。 */
function shellTokens(text: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s;&|()]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const token = match[1] ?? match[2] ?? match[3] ?? ""
    if (token) out.push(token)
  }
  return out
}

function isOptionToken(token: string): boolean {
  return token.length > 1 && token.startsWith("-")
}

function optionValueTargets(command: string, args: string[]): string[] {
  const targets: string[] = []
  const operands: string[] = []
  let targetDirectory: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-t" || arg === "--target-directory") {
      targetDirectory = args[i + 1] ?? targetDirectory
      i++
      continue
    }
    if (arg.startsWith("--target-directory=")) {
      targetDirectory = arg.slice("--target-directory=".length)
      continue
    }
    if (isOptionToken(arg)) continue
    operands.push(arg)
  }

  if (command === "tee") {
    for (const operand of operands) targets.push(operand)
    return targets
  }
  if (command === "ln" || command === "truncate") {
    if (targetDirectory) targets.push(targetDirectory)
    // truncate: 最后 operand 是档；ln: 最后 operand 是 link／目录。
    const last = operands[operands.length - 1]
    if (last) targets.push(last)
    return targets
  }
  if (command === "cp" || command === "mv" || command === "install") {
    if (targetDirectory) {
      targets.push(targetDirectory)
      return targets
    }
    const last = operands[operands.length - 1]
    if (operands.length >= 2 && last) targets.push(last)
    return targets
  }
  return targets
}

/** sed 的写目标：in-place 时最后一个非选项 operand（`--in-place` 与 `-i` 同判）。 */
function sedInPlaceTarget(args: string[]): string | null {
  let inPlace = false
  let hasScriptOption = false
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-e" || arg === "-f") {
      hasScriptOption = true
      i++
      continue
    }
    if (arg === "--in-place" || arg.startsWith("--in-place=") || /^-[a-zA-Z]*i(?:\.[^\s]*)?$/.test(arg)) {
      inPlace = true
      continue
    }
    if (isOptionToken(arg)) continue
    operands.push(arg)
  }
  if (!inPlace) return null
  const needed = hasScriptOption ? 1 : 2
  if (operands.length < needed) return null
  return operands[operands.length - 1] ?? null
}

/** python -c 中的 open(path, "w") 落点。 */
function pythonOpenTargets(args: string[]): string[] {
  const codeIndex = args.indexOf("-c")
  const code = codeIndex === -1 ? "" : args[codeIndex + 1] ?? ""
  if (!code || !/\bopen\s*\(/.test(code)) return []
  const targets: string[] = []
  let literal = false
  for (const match of code.matchAll(/\bopen\s*\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]*)\3)?/g)) {
    literal = true
    const mode = match[4] ?? ""
    if (!mode || /[wax+]/.test(mode)) targets.push(match[2])
  }
  if (!literal) {
    // 目标无法静态判定：动态目标交给 ask 分支（敏感字面量仍会 deny）。
    targets.push("$python_open")
  }
  return targets
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
  for (const match of segment.matchAll(/\bdd\s+[^;&|]*\bof=("?)([^\s;&|]+)\1/g)) {
    if (match[2]) targets.add(match[2])
  }

  const tokens = shellTokens(segment)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++
  const command = (tokens[index] ?? "").split("/").pop()?.toLowerCase() ?? ""
  const args = tokens.slice(index + 1)
  if (!command) return [...targets]

  if (command === "sed") {
    const target = sedInPlaceTarget(args)
    if (target) targets.add(target)
  } else if (command === "tee" || command === "ln" || command === "truncate" || command === "cp" || command === "mv" || command === "install") {
    for (const target of optionValueTargets(command, args)) targets.add(target)
  } else if (command === "rm") {
    for (const arg of args) if (!isOptionToken(arg)) targets.add(arg)
  } else if (/^python(?:\d+(?:\.\d+)*)?$/.test(command)) {
    for (const target of pythonOpenTargets(args)) targets.add(target)
  }
  return [...targets]
}

function bashWriteTargets(command: string, cwd: string, home: string): ShellWriteTarget[] {
  const targets: ShellWriteTarget[] = []
  let current: string | null = cwd
  for (const segment of splitShellSequence(command)) {
    // 支持 `cd`、`pushd` 与子 shell 前导 `(`（`(cd /tmp; ...)`）。
    const cdMatch = /^[\s(]*(?:cd|pushd)(?:\s+--)?\s+("([^"]+)"|'([^']+)'|([^\s;&|)]+))/.exec(segment)
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
    CREDENTIAL_BASENAMES.has(base) ||
    isFishFunctionPath(normalized) ||
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
export function resolveSafetyPath(raw: string, context: PermissionContext): string {
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

export function safetyCheck(
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