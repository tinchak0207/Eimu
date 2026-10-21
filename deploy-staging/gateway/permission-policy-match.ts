import { posix } from "node:path"
import { Behavior, PermissionMode, PermissionRule } from "./permission-policy-types"
import { normalizePathString } from "./permission-policy-path"

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
  /** 计划模式计划文件绝对路径：写它本身是计划模式的合法动作，不视为越界写。 */
  planFilePath?: string
}

/**
 * 计划/权限共用的只读工具唯一真源。
 * - plan-http 通过 /internal/plan/state 的 read_only_tools 下发；
 * - 权限内核的 plan 分支与 isReadOnlyTool 直接引用本常量；
 * - 插件在网关不可用时使用的 fallback 必须与本表逐项一致（跨树无法 import）。
 */
export const PLAN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  [
    "read",
    "read_file",
    "list",
    "list_dir",
    "ls",
    "glob",
    "grep",
    "stat",
    "lsp",
    "lsp_diagnostics",
    "read_image",
    "vision_analyze",
    "webfetch",
    "web_fetch",
    "fetch",
    "websearch",
    "web_search",
    "search_web",
    "search_aggregate",
    "smart_search",
    "todo_read",
    "todo_status",
    "task_status",
    "task_list",
    "task_get",
    "subagent_status",
    "workflow_status",
    "workflow_history",
    "image_get_result",
    "video_result_fetch",
    "video_analyze",
    "video_measure",
    "video_transcribe",
    "video_evidence",
    "timeline_query",
    "canvas_get_state",
    "director_get_state",
    "quota",
    "memory_recall",
    "asset_search",
    "asset_get",
    "character_card_list",
    "whoami",
  ].map((name) => name.toLowerCase()),
)

const READ_ONLY_TOOLS = PLAN_READ_ONLY_TOOLS

/** 计划模式下必须放行的控制类工具（进入/退出计划、向用户提问）。 */
export const PLAN_CONTROL_TOOLS: ReadonlySet<string> = new Set(
  [
    "enter_plan_mode",
    "exit_plan_mode",
    "enterplanmode",
    "exitplanmode",
    "ask",
    "askuserquestion",
    "ask_parent",
  ].map((name) => name.toLowerCase()),
)

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

export function isReadOnly(tool: string, context: PermissionContext): boolean {
  if (context.isReadOnlyTool) return context.isReadOnlyTool(tool) === true
  return READ_ONLY_TOOLS.has(tool.toLowerCase())
}

export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool.toLowerCase())
}

export function contextCwd(context: PermissionContext): string {
  return context.cwd && context.cwd.trim() ? context.cwd : process.cwd()
}

export function contextHome(context: PermissionContext): string {
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

export function pathsFromTool(tool: string, input: Record<string, unknown>): string[] {
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
    for (const match of patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+)$/gm)) {
      const path = match[1]?.trim()
      if (path && path !== "/dev/null") paths.add(path)
    }
    for (const match of patchText.matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm)) {
      const path = match[1]?.trim()
      if (path && path !== "/dev/null") paths.add(path)
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

export function normalizeAbsolute(path: string): string {
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

export function withinAnyRoot(rawPath: string, context: PermissionContext): boolean {
  const roots = [contextCwd(context), ...(context.additionalDirectories ?? [])]
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => normalizeAbsolute(root))
  const caseInsensitive = effectivePathCaseInsensitive(context)
  for (const candidate of candidatePathSpellings(rawPath, context)) {
    const value = caseInsensitive ? candidate.toLowerCase() : candidate
    for (const root of roots) {
      const rootValue = caseInsensitive ? root.toLowerCase() : root
      // 根为 "/" 时 `${root}/` 会变成 "//"，永远不命中；单独处理。
      if (rootValue === "" || rootValue === "/") return true
      if (value === rootValue || value.startsWith(`${rootValue}/`)) return true
    }
  }
  return false
}

// ── 规则匹配 ───────────────────────────────────────────────────────────────

export const BASH_FAMILY = new Set(["bash", "powershell", "shell", "exec", "run_py", "runpy"])

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

/** 命令位归一化（仅 deny 匹配）：剥引号/反斜线转义并把可执行档路径取 basename。
 * 使 `r''m`、`r\m`、`/usr/bin/curl` 与规则 `rm` / `curl *` 同判。 */
function normalizeDenyCommand(command: string): string {
  const squashed = squashCommand(command)
    .replace(/['"]/g, "")
    .replace(/\\ /g, " ")
    .replace(/\\(?![\\\s])/g, "")
  const space = squashed.search(/\s/)
  const head = space === -1 ? squashed : squashed.slice(0, space)
  const rest = space === -1 ? "" : squashed.slice(space)
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head
  return `${base}${rest}`.trim()
}

function matchBashContent(content: string, command: string, denyMode = false): boolean {
  const value = squashCommand(denyMode ? normalizeDenyCommand(command) : command)
  let pattern = squashCommand(denyMode ? normalizeDenyCommand(content) : content)
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
      // deny 匹配额外做命令位归一（引号/反斜线/绝对路径），挡纯文本变体。
      return splitSimpleCommands(command).some((segment) => matchBashContent(content, segment, true))
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
