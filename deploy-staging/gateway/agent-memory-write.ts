/**
 * agent-memory-write.ts — Claude Code 2.1.302 agent 可写记忆的 Eimu 落地。
 *
 * 约束（照 CC 2.1.302 原始实现）：
 * - 内容 ≤102400 bytes；name ≤1024 bytes、≤20 段；禁 "." / ".." / 控制与格式字符；必须 NFC。
 * - realpath containment 防 symlink 逃逸；archived（`.archived` 哨兵，含所有祖先）拒写／拒读。
 * - 覆盖写原子（同目录 tmp + rename）；append 用 O_APPEND 单次追加，追加后做总量检查。
 * - secret 扫描宁可误拒（含 base64 解码、PEM 正文、分片拼接、URL 内嵌凭据）；不把命中内容
 *   写进错误或日志。
 * - 所有路径操作 fail-closed。
 *
 * 目录布局（HARNESS_MEMORY_ROOT，默认 /opt/agent-harness/state/agent-memory）：
 *   user    <root>/<tenant>/user/<agent>/
 *   project <root>/<tenant>/project/<workspaceKey>/<agent>/
 *   local   <root>/<tenant>/local/<workspaceKey>/<sessionKey>/<agent>/
 * 三个 scope 分别对应 CC 的 ~/.claude/agent-memory、<workspace>/.claude/agent-memory、
 * <workspace>/.claude/agent-memory-local；tenant/workspace/session 用于 Eimu 隔离。
 * tenant/workspace/session 必须由网关 session 解析后传入，调用方不得信任请求体。
 */
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const MEMORY_CONTENT_MAX_BYTES = 102400
export const MEMORY_PATH_MAX_BYTES = 1024
export const MEMORY_PATH_MAX_SEGMENTS = 20
export const MEMORY_PATH_SEGMENT_MAX_BYTES = 255
export const MEMORY_READ_MAX_CHARS = 65536
export const MEMORY_LIST_MAX_FILES = 1000
export const MEMORY_DEFAULT_NAME = "MEMORY.md"
export const MEMORY_ARCHIVED_SENTINEL = ".archived"
export const DEFAULT_MEMORY_ROOT = "/opt/agent-harness/state/agent-memory"

/** 注入围栏：读出的记忆正文进入 prompt 时必须包在这两个哨兵之间。 */
export const MEMORY_PROMPT_FENCE_OPEN = "<<<MEMORY_DATA>>>"
export const MEMORY_PROMPT_FENCE_CLOSE = "<<<END_MEMORY_DATA>>>"

export type MemoryScope = "user" | "project" | "local"
export type MemoryWriteMode = "overwrite" | "append"

export type MemoryErrorCode =
  | "content_too_large"
  | "index_too_large"
  | "content_screened"
  | "content_secret"
  | "invalid_path"
  | "store_archived"
  | "not_writable"
  | "not_found"
  | "conflict"
  | "read_failed"

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly status: number
  constructor(code: MemoryErrorCode, message: string, status?: number) {
    super(message)
    this.name = "MemoryError"
    this.code = code
    this.status = status ?? memoryErrorStatus(code)
  }
}

function memoryErrorStatus(code: MemoryErrorCode): number {
  switch (code) {
    case "not_found":
      return 404
    case "not_writable":
      return 403
    case "store_archived":
    case "conflict":
      return 409
    case "read_failed":
      return 500
    default:
      return 400
  }
}

export interface MemoryLocation {
  scope: MemoryScope
  agent: string
  tenantId?: string
  workspaceDir?: string
  sessionId?: string
}

export interface MemoryPaths {
  root: string
  dir: string
  file: string
  relativeFile: string
}

export interface MemorySaveInput extends MemoryLocation {
  name?: string
  content: string
  mode?: MemoryWriteMode
}

export interface MemorySaveResult {
  scope: MemoryScope
  agent: string
  path: string
  relative_path: string
  bytes: number
  sha256: string
  mode: MemoryWriteMode
}

export interface MemoryReadResult {
  scope: MemoryScope
  agent: string
  path: string
  absolute_path: string
  content: string
  chars: number
  bytes: number
  truncated: boolean
  limit: number
  hint?: string
}

export interface MemoryListEntry {
  path: string
  bytes: number
  updatedAt: string
}

export interface MemoryListResult {
  scope: MemoryScope
  agent: string
  dir: string
  files: MemoryListEntry[]
  count: number
  truncated: boolean
}

// ─────────────────────────── 路径与名称校验 ───────────────────────────

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/**
 * 约束：清洗后的段名必须唯一可逆到来源。清洗或截断会改变原文时追加
 * sha256 前 8 位短哈希，避免 "a b" 与 "a-b" 这类冲突互相覆盖。
 */
function sanitizeSegment(raw: unknown, fallback: string, max = 128): string {
  const text = typeof raw === "string" ? raw : ""
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, max)
  if (cleaned.length === 0) return fallback
  if (cleaned === text) return cleaned
  const suffix = `-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`
  const head = cleaned.slice(0, Math.max(1, max - suffix.length))
  return `${head}${suffix}`
}

function workspaceKeyOf(workspaceDir: string | undefined): string {
  const raw = (workspaceDir && workspaceDir.trim()) || process.env.HARNESS_WORKSPACE || process.cwd()
  const absolute = resolve(raw)
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16)
  const label = sanitizeSegment(basename(absolute), "workspace", 32)
  return `${label}-${hash}`
}

export function tenantIdOf(tenantId: string | undefined): string {
  return sanitizeSegment(tenantId ?? process.env.HARNESS_TENANT_ID, "default", 128)
}

/** CC 的 agent 目录名规则：非 [A-Za-z0-9-_] 一律换成 "-"，空值 "unknown"。 */
export function sanitizeAgentName(agent: string): string {
  return sanitizeSegment(agent, "unknown", 128)
}

/** 解析 HARNESS_MEMORY_ROOT；显式配置为空白或相对路径一律拒绝（fail-closed）。 */
function resolveMemoryRoot(): string {
  const configured = process.env.HARNESS_MEMORY_ROOT
  if (configured === undefined) return DEFAULT_MEMORY_ROOT
  const trimmed = configured.trim()
  if (trimmed.length === 0) {
    throw new MemoryError("invalid_path", "HARNESS_MEMORY_ROOT must not be empty")
  }
  if (!isAbsolute(trimmed)) {
    throw new MemoryError("invalid_path", "HARNESS_MEMORY_ROOT must be an absolute path")
  }
  return resolve(trimmed)
}

function isUnder(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

export function validateMemoryName(input: unknown): string {
  const name = input === undefined || input === null ? MEMORY_DEFAULT_NAME : input
  if (typeof name !== "string" || name.length === 0) {
    throw new MemoryError("invalid_path", "path must be a non-empty string")
  }
  if (utf8Bytes(name) > MEMORY_PATH_MAX_BYTES) {
    throw new MemoryError("invalid_path", "path must be at most 1024 bytes")
  }
  if (name.normalize("NFC") !== name) {
    throw new MemoryError("invalid_path", "path must be NFC-normalized")
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new MemoryError("invalid_path", "path must not contain control or format characters")
  }
  if (name.includes("\\")) {
    throw new MemoryError("invalid_path", "path must use '/' separators")
  }
  if (name.startsWith("/") || isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new MemoryError("invalid_path", "path must be relative")
  }
  const segments = name.split("/")
  if (segments.length > MEMORY_PATH_MAX_SEGMENTS) {
    throw new MemoryError("invalid_path", "path must be at most 20 segments deep")
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new MemoryError("invalid_path", "path must not contain . or .. segments")
    }
    if (segment !== segment.trim()) {
      throw new MemoryError("invalid_path", "path segments must not have leading or trailing whitespace")
    }
    if (utf8Bytes(segment) > MEMORY_PATH_SEGMENT_MAX_BYTES) {
      throw new MemoryError("invalid_path", "path segment is too long")
    }
    // 约束：字面 %2e/%2f 会让下游（编辑器/前端/归档工具）二次解码成 ".." 或 "/"。
    if (/%2e|%2f/i.test(segment)) {
      throw new MemoryError("invalid_path", "path must not contain percent-encoded separators or dots")
    }
    // 约束：归档哨兵本身不可作为文件/目录段。
    if (segment === MEMORY_ARCHIVED_SENTINEL) {
      throw new MemoryError("invalid_path", "path must not reference the archived sentinel")
    }
  }
  if (!segments[segments.length - 1].toLowerCase().endsWith(".md")) {
    throw new MemoryError("invalid_path", "memory files must end with .md")
  }
  return segments.join("/")
}

export function resolveMemoryPaths(location: MemoryLocation): MemoryPaths {
  if (location.scope !== "user" && location.scope !== "project" && location.scope !== "local") {
    throw new MemoryError("invalid_path", "scope must be user, project or local")
  }
  if (typeof location.agent !== "string" || location.agent.trim().length === 0) {
    throw new MemoryError("invalid_path", "agent is required")
  }
  const root = resolveMemoryRoot()
  const tenant = tenantIdOf(location.tenantId)
  const agent = sanitizeAgentName(location.agent)
  const segments: string[] = [tenant]
  if (location.scope === "user") {
    segments.push("user", agent)
  } else if (location.scope === "project") {
    segments.push("project", workspaceKeyOf(location.workspaceDir), agent)
  } else {
    const sessionKey = sanitizeSegment(location.sessionId, "default", 128)
    segments.push("local", workspaceKeyOf(location.workspaceDir), sessionKey, agent)
  }
  const dir = resolve(join(root, ...segments))
  if (!isUnder(root, dir)) {
    throw new MemoryError("invalid_path", "memory directory escapes the configured root")
  }
  const name = validateMemoryName((location as { name?: unknown }).name)
  const file = resolve(join(dir, name))
  if (!isUnder(dir, file)) {
    throw new MemoryError("invalid_path", "memory file escapes the agent directory")
  }
  return { root, dir, file, relativeFile: relative(root, file) }
}

// ─────────────────────────── realpath containment / 原子写 ───────────────────────────

function statSize(info: { size: number | bigint }): number {
  return typeof info.size === "number" ? info.size : Number(info.size)
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

interface ResolvedDir {
  dirReal: string
  rootReal: string
}

async function ensureContainedDir(root: string, dir: string, create: boolean): Promise<ResolvedDir> {
  let base = root
  let rootStat = await lstatOrNull(base)
  if (rootStat === null) {
    if (!create) throw new MemoryError("not_found", `memory root not found: ${root}`)
    await mkdir(base, { recursive: true, mode: 0o700 })
    rootStat = await lstat(base)
  }
  // 约束：只允许部署配置的 root 本身是 symlink；root 以下任何 symlink 一律拒绝。
  if (rootStat.isSymbolicLink()) {
    base = await realpath(root)
    rootStat = await stat(base)
  }
  if (!rootStat.isDirectory()) {
    throw new MemoryError("not_writable", `memory root is not a directory: ${root}`)
  }
  const rootReal = await realpath(base)
  const lexicalRel = relative(root, dir)
  if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new MemoryError("invalid_path", "memory directory escapes the configured root")
  }
  const targetDir = lexicalRel.length === 0 ? base : resolve(base, lexicalRel)
  const rel = relative(base, targetDir)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new MemoryError("invalid_path", "memory directory escapes the configured root")
  }
  if (rel.length > 0) {
    let current = base
    for (const segment of rel.split(sep)) {
      current = join(current, segment)
      const info = await lstatOrNull(current)
      if (info === null) {
        if (!create) throw new MemoryError("not_found", `memory directory not found: ${current}`)
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          // 并发创建：别人已经建好同名目录是成功路径，不是失败。
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        const created = await lstat(current)
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new MemoryError("invalid_path", `memory directory is not a real directory: ${current}`)
        }
      } else if (info.isSymbolicLink()) {
        throw new MemoryError("invalid_path", `memory path traverses a symlink: ${current}`)
      } else if (!info.isDirectory()) {
        throw new MemoryError("invalid_path", `memory path is not a directory: ${current}`)
      }
    }
  }
  const dirReal = await realpath(targetDir)
  if (!isUnder(rootReal, dirReal)) {
    throw new MemoryError("invalid_path", "memory directory escapes the configured root via symlink")
  }
  return { dirReal, rootReal }
}

async function assertRegularFile(file: string, rootReal: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstatOrNull(file)
  if (info === null) throw new MemoryError("not_found", `memory file not found: ${file}`)
  if (info.isSymbolicLink()) {
    throw new MemoryError("invalid_path", "memory file must not be a symlink")
  }
  if (!info.isFile()) {
    throw new MemoryError("invalid_path", "memory path is not a regular file")
  }
  const fileReal = await realpath(file)
  if (!isUnder(rootReal, fileReal)) {
    throw new MemoryError("invalid_path", "memory file escapes the configured root via symlink")
  }
  return info
}

/**
 * 约束：name 可含子目录，逐段验证，任何 symlink 一律拒绝。
 * 返回基于 dirReal 的最终文件路径，后续写盘不再走词法路径。
 */
async function ensureContainedFilePath(dirReal: string, relativeName: string, create: boolean): Promise<string> {
  const segments = relativeName.split("/")
  let parent = dirReal
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment)
    const info = await lstatOrNull(parent)
    if (info === null) {
      if (!create) throw new MemoryError("not_found", `memory directory not found: ${parent}`)
      try {
        await mkdir(parent, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const created = await lstat(parent)
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new MemoryError("invalid_path", `memory directory is not a real directory: ${parent}`)
      }
    } else if (info.isSymbolicLink()) {
      throw new MemoryError("invalid_path", `memory path traverses a symlink: ${parent}`)
    } else if (!info.isDirectory()) {
      throw new MemoryError("invalid_path", `memory path is not a directory: ${parent}`)
    }
  }
  const parentReal = await realpath(parent)
  if (!isUnder(dirReal, parentReal)) {
    throw new MemoryError("invalid_path", "memory file escapes the agent directory via symlink")
  }
  return join(parentReal, segments[segments.length - 1])
}

/**
 * 约束：`.archived` 哨兵在层级路径的任意祖先上都必须生效。
 * 从 memory root 一路检查到目标目录（含目标目录自身）。
 */
async function assertNotArchived(rootReal: string, dirReal: string): Promise<void> {
  const rel = relative(rootReal, dirReal)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new MemoryError("invalid_path", "memory directory escapes the configured root")
  }
  const chain = [rootReal]
  if (rel.length > 0) {
    let current = rootReal
    for (const segment of rel.split(sep)) {
      current = join(current, segment)
      chain.push(current)
    }
  }
  for (const dir of chain) {
    const sentinel = await lstatOrNull(join(dir, MEMORY_ARCHIVED_SENTINEL))
    if (sentinel !== null) {
      throw new MemoryError("store_archived", "cannot modify archived resource")
    }
  }
}

async function atomicWrite(file: string, data: Buffer): Promise<void> {
  const dir = dirname(file)
  const tmp = join(dir, `.tmp-${randomUUID()}`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tmp, "wx", 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, file)
    await chmod(file, 0o600)
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // 约束：清理失败不掩盖原始错误。
      }
    }
    try {
      await unlink(tmp)
    } catch {
      // 约束：tmp 可能尚未建立；忽略。
    }
    throw error
  }
}

/**
 * 约束（P0-2）：append 不得 read-modify-write。用 O_APPEND 打开后单次写入
 * 自定界负载（内容末尾补一个换行），追加完再做总量检查；超限时明确报错，
 * 可行时回滚本次追加，绝不静默丢写。
 * 返回 { bytes, sha256 }：bytes 是追加后的文件总大小。
 */
async function appendFileAtomic(
  file: string,
  incoming: Buffer,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  // 约束：追加负载自带尾换行，避免并发时依赖「先读末尾再决定分隔符」的竞态。
  const payload =
    incoming.byteLength > 0 && incoming[incoming.byteLength - 1] !== 0x0a
      ? Buffer.concat([incoming, Buffer.from("\n")])
      : incoming

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, "a", 0o600)
    const before = statSize(await handle.stat())
    if (before > maxBytes) {
      throw new MemoryError("content_too_large", "existing memory file exceeds the size limit")
    }
    if (before + payload.byteLength > maxBytes) {
      throw new MemoryError(
        "content_too_large",
        `content must be at most ${maxBytes} bytes after append`,
      )
    }
    const { bytesWritten } = await handle.write(payload)
    if (bytesWritten !== payload.byteLength) {
      throw new MemoryError("not_writable", "append was not written atomically")
    }
    await handle.sync()
    const after = statSize(await handle.stat())
    if (after > maxBytes) {
      // 只有确认没有并发交错时才回滚，避免误删别人的追加。
      if (after === before + payload.byteLength) {
        await handle.truncate(before)
      }
      throw new MemoryError(
        "content_too_large",
        `content must be at most ${maxBytes} bytes after append`,
      )
    }
    return { bytes: after, sha256: createHash("sha256").update(payload).digest("hex") }
  } finally {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // 约束：关闭失败不掩盖写入错误。
      }
    }
  }
}

// ─────────────────────────── secret 扫描 ───────────────────────────

// 约束：宁可误拒。命中只报类型，绝不回显命中的密文。
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "private-key", re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i },
  // PEM 正文（去掉 header 后剩下的 base64 长串）单独命中：只贴正文也算泄漏。
  { label: "private-key-body", re: /\bMII[A-Za-z0-9+/]{40,}={0,2}\b/ },
  { label: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "model-api-key", re: /\b(?:sk|pk|xsk)-[A-Za-z0-9_-]{16,}\b/ },
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: "stripe-key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/ },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { label: "credential-assignment", re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|private[_-]?key)\b\s*[:=]\s*["'`]?[A-Za-z0-9_\-+/=.]{12,}/i },
  { label: "telegram-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  // URL 内嵌凭据：任意 scheme://user:pass@（不再只限数据库 URL）。
  { label: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i },
  { label: "connection-string", re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@/i },
]

const BASE64_RUN_RE = /[A-Za-z0-9+/]{24,}={0,2}/g

function scanText(text: string): { ok: boolean; label?: string } {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) return { ok: false, label: pattern.label }
  }
  return { ok: true }
}

function mostlyPrintable(text: string): boolean {
  if (text.length === 0) return false
  let printable = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x0d || code === 0x09 || (code >= 0x20 && code <= 0x7e)) printable += 1
  }
  return printable / text.length > 0.9
}

/** 约束：先按字面扫；再做 base64 解码扫描、去空白拼接扫描（分片拼秘密）。 */
export function scanMemorySecrets(content: string): { ok: boolean; label?: string } {
  const direct = scanText(content)
  if (!direct.ok) return direct

  // 分片拼接：去掉所有空白后连续扫描，覆盖「密钥被换行/空格拆成多段」。
  const joined = content.replace(/\s+/g, "")
  if (joined !== content) {
    const split = scanText(joined)
    if (!split.ok) return split
  }

  // base64：解码后仍以可打印文本为主时再扫一遍。
  BASE64_RUN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BASE64_RUN_RE.exec(content)) !== null) {
    try {
      const decoded = Buffer.from(match[0], "base64").toString("utf8")
      if (!mostlyPrintable(decoded)) continue
      const hit = scanText(decoded)
      if (!hit.ok) return { ok: false, label: `base64:${hit.label ?? "secret"}` }
    } catch {
      // 约束：解码失败视为普通文本，不影响后续扫描。
    }
  }
  return { ok: true }
}

function assertNoSecrets(content: string): void {
  const scan = scanMemorySecrets(content)
  if (!scan.ok) {
    throw new MemoryError(
      "content_secret",
      "memory content appears to contain a credential or API key; remove it before writing. If the credential is real, rotate it.",
    )
  }
}

// ─────────────────────────── prompt 注入围栏 ───────────────────────────

/**
 * 约束（P1-13）：记忆正文是不可执行的资料，不是指令。注入 prompt 前包上围栏，
 * 并把正文里可能被误读为控制标记的字符转义。
 * 注意：memory_read 的返回值保持原文；本函数只供注入层使用。
 */
export function fenceMemoryForPrompt(text: string): string {
  const escaped = String(text ?? "")
    .replaceAll(MEMORY_PROMPT_FENCE_OPEN, "[ESCAPED_MEMORY_FENCE_OPEN]")
    .replaceAll(MEMORY_PROMPT_FENCE_CLOSE, "[ESCAPED_MEMORY_FENCE_CLOSE]")
    .replace(/【/g, "[ESC_U3010]")
    .replace(/】/g, "[ESC_U3011]")
    .replace(/⟦/g, "[ESC_U27E6]")
    .replace(/⟧/g, "[ESC_U27E7]")
    .replace(/(^|\n)([ \t]*)#[ \t]*交付/g, "$1$2[ESC_HASH] 交付")
  return `${MEMORY_PROMPT_FENCE_OPEN}\n${escaped}\n${MEMORY_PROMPT_FENCE_CLOSE}`
}

// ─────────────────────────── save / read / list ───────────────────────────

export async function memorySave(input: MemorySaveInput): Promise<MemorySaveResult> {
  const mode: MemoryWriteMode = input.mode ?? "overwrite"
  if (mode !== "overwrite" && mode !== "append") {
    throw new MemoryError("invalid_path", "mode must be overwrite or append")
  }
  if (typeof input.content !== "string") {
    throw new MemoryError("invalid_path", "content must be a string")
  }
  const incoming = Buffer.from(input.content, "utf8")
  if (incoming.byteLength > MEMORY_CONTENT_MAX_BYTES) {
    throw new MemoryError(
      "content_too_large",
      `content must be at most ${MEMORY_CONTENT_MAX_BYTES} bytes`,
    )
  }
  const paths = resolveMemoryPaths(input)
  const { dirReal, rootReal } = await ensureContainedDir(paths.root, paths.dir, true)
  await assertNotArchived(rootReal, dirReal)
  const relativeName = relative(paths.dir, paths.file).split(sep).join("/")
  const file = await ensureContainedFilePath(dirReal, relativeName, true)

  let bytes: number
  let sha256: string
  if (mode === "append") {
    assertNoSecrets(incoming.toString("utf8"))
    const existingInfo = await lstatOrNull(file)
    if (existingInfo !== null) await assertRegularFile(file, dirReal)
    const appended = await appendFileAtomic(file, incoming, MEMORY_CONTENT_MAX_BYTES)
    bytes = appended.bytes
    sha256 = appended.sha256
  } else {
    assertNoSecrets(incoming.toString("utf8"))
    await atomicWrite(file, incoming)
    bytes = incoming.byteLength
    sha256 = createHash("sha256").update(incoming).digest("hex")
  }

  return {
    scope: input.scope,
    agent: sanitizeAgentName(input.agent),
    path: file,
    relative_path: relative(rootReal, file),
    bytes,
    sha256,
    mode,
  }
}

export async function memoryRead(
  location: MemoryLocation & { name?: string },
): Promise<MemoryReadResult> {
  const paths = resolveMemoryPaths(location)
  const { dirReal, rootReal } = await ensureContainedDir(paths.root, paths.dir, false)
  await assertNotArchived(rootReal, dirReal)
  const relativeName = relative(paths.dir, paths.file).split(sep).join("/")
  const file = await ensureContainedFilePath(dirReal, relativeName, false)
  const info = await assertRegularFile(file, dirReal)

  // 约束：单次最多回传 65536 字符；超出截断并提示先分段读取。
  const maxReadBytes = MEMORY_READ_MAX_CHARS * 4 + 8
  const fileSize = statSize(info)
  const toRead = Math.min(fileSize, maxReadBytes)
  const buffer = Buffer.alloc(toRead)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, "r")
    await handle.read(buffer, 0, toRead, 0)
  } catch (error) {
    throw new MemoryError("read_failed", `failed to read memory file: ${(error as Error).message}`)
  } finally {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // 约束：关闭失败不掩盖读取错误。
      }
    }
  }

  const text = buffer.toString("utf8")
  const chars = Array.from(text)
  const truncated = chars.length > MEMORY_READ_MAX_CHARS || fileSize > toRead
  const content = truncated ? chars.slice(0, MEMORY_READ_MAX_CHARS).join("") : text
  return {
    scope: location.scope,
    agent: sanitizeAgentName(location.agent),
    path: relative(rootReal, file),
    absolute_path: file,
    content,
    chars: truncated ? MEMORY_READ_MAX_CHARS : chars.length,
    bytes: fileSize,
    truncated,
    limit: MEMORY_READ_MAX_CHARS,
    ...(truncated
      ? { hint: `内容超过单次读取上限 ${MEMORY_READ_MAX_CHARS} 字符，已截断；改写前先分段读取或缩小文件。` }
      : {}),
  }
}

export async function memoryList(
  location: MemoryLocation,
): Promise<MemoryListResult> {
  const paths = resolveMemoryPaths(location)
  let resolved: ResolvedDir
  try {
    resolved = await ensureContainedDir(paths.root, paths.dir, false)
  } catch (error) {
    if (error instanceof MemoryError && error.code === "not_found") {
      return {
        scope: location.scope,
        agent: sanitizeAgentName(location.agent),
        dir: paths.dir,
        files: [],
        count: 0,
        truncated: false,
      }
    }
    throw error
  }
  const { dirReal, rootReal } = resolved
  // 约束：归档目录不再是可列出的活记忆（与 read 的 409 一致）。
  await assertNotArchived(rootReal, dirReal)

  const files: MemoryListEntry[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    if (depth > MEMORY_PATH_MAX_SEGMENTS) {
      truncated = true
      return
    }
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)
      const info = await lstatOrNull(full)
      if (info === null) continue
      // 约束：不跟随 symlink。
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!info.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
      if (files.length >= MEMORY_LIST_MAX_FILES) {
        truncated = true
        return
      }
      files.push({
        path: relative(dirReal, full),
        bytes: statSize(info),
        updatedAt: info.mtime.toISOString(),
      })
    }
  }
  await walk(dirReal, 0)
  return {
    scope: location.scope,
    agent: sanitizeAgentName(location.agent),
    dir: paths.dir,
    files,
    count: files.length,
    truncated,
  }
}

// ─────────────────────────── save / read / list ───────────────────────────
