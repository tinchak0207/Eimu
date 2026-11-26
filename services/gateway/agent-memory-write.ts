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

/** 约束（P2 配额）：每 tenant/scope 的记忆文件数与总字节上限。 */
export const MEMORY_SCOPE_MAX_FILES = 500
export const MEMORY_SCOPE_MAX_BYTES = 20 * 1024 * 1024
/** 写锁：退避重试，超时回 conflict；持锁超过 stale 阈值视为崩溃残留。 */
export const MEMORY_LOCK_TIMEOUT_MS = 10_000
export const MEMORY_LOCK_STALE_MS = 30_000

/** 注入围栏：读出的记忆正文进入 prompt 时必须包在这两个哨兵之间。 */
export const MEMORY_PROMPT_FENCE_OPEN = "<<<MEMORY_DATA>>>"
export const MEMORY_PROMPT_FENCE_CLOSE = "<<<END_MEMORY_DATA>>>"

export type MemoryScope = "user" | "project" | "local"
export type MemoryWriteMode = "overwrite" | "append"

export type MemoryErrorCode =
  | "content_too_large"
  | "content_secret"
  | "invalid_path"
  | "store_archived"
  | "store_full"
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
    case "store_full":
      return 507
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
 * 约束（P1-4）：`.archived` 哨兵对 **name 展开后的最终路径** 的所有祖先生效。
 * 必须在创建任何锁文件/临时文件之前调用，否则会先在归档目录里留下写痕迹。
 */
async function assertNotArchivedPath(rootReal: string, file: string): Promise<void> {
  const targetDir = dirname(file)
  const rel = relative(rootReal, targetDir)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new MemoryError("invalid_path", "memory path escapes the configured root")
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

/**
 * 在真正创建 name 展开的子目录之前，先按词法路径检查已存在的祖先目录是否归档。
 * 不存在的目录不可能带哨兵；符号链接/非目录交给后续 ensureContainedFilePath 拒绝。
 */
async function assertNoArchivedAlongName(dirReal: string, relativeName: string): Promise<void> {
  let current = dirReal
  for (const segment of relativeName.split("/").slice(0, -1)) {
    current = join(current, segment)
    const info = await lstatOrNull(current)
    if (info === null || info.isSymbolicLink() || !info.isDirectory()) return
    const sentinel = await lstatOrNull(join(current, MEMORY_ARCHIVED_SENTINEL))
    if (sentinel !== null) {
      throw new MemoryError("store_archived", "cannot modify archived resource")
    }
  }
}

// ─────────────────────────── 写锁 / 配额 ───────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function lockPathFor(file: string): string {
  return join(dirname(file), `.${basename(file)}.lock`)
}

/**
 * 约束（P0-1/P0-2）：同一文件的 overwrite 与 append 必须串行。用 O_EXCL 锁文件 +
 * 退避重试；持锁进程崩溃的残留以 mtime 超时回收。取锁失败回 conflict，不无限等待。
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + MEMORY_LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | null = null
  for (;;) {
    try {
      handle = await open(lockPath, "wx", 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const info = await lstatOrNull(lockPath)
      if (info !== null && Date.now() - Number(info.mtimeMs) > MEMORY_LOCK_STALE_MS) {
        try {
          await unlink(lockPath)
        } catch {
          // 约束：别人已回收同一把锁是成功路径。
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new MemoryError("conflict", "memory store is busy; retry later")
      }
      await sleep(2 + Math.random() * 8)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      await handle.close()
    } catch {
      // 约束：关闭失败不掩盖业务结果。
    }
    try {
      await unlink(lockPath)
    } catch {
      // 约束：锁可能已被 stale 回收。
    }
  }
}

interface ScopeUsage {
  files: number
  bytes: number
}

/** 统计 tenant/scope 下的记忆文件（只算 .md；不跟随 symlink）。 */
async function scopeUsage(scopeRoot: string): Promise<ScopeUsage> {
  const usage: ScopeUsage = { files: 0, bytes: 0 }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MEMORY_PATH_MAX_SEGMENTS + 2) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
      const info = await lstatOrNull(full)
      if (info === null || info.isSymbolicLink() || !info.isFile()) continue
      usage.files += 1
      usage.bytes += statSize(info)
    }
  }
  await walk(scopeRoot, 0)
  return usage
}

/**
 * 约束（P2-8）：每 tenant/scope 文件数 ≤500、总字节 ≤20MB。配额检查在 scope 锁内、
 * 写入前完成；超限回 store_full，本次不落盘。
 */
async function assertScopeQuota(
  scopeRoot: string,
  existingBytes: number | null,
  nextBytes: number,
): Promise<void> {
  const usage = await scopeUsage(scopeRoot)
  const projectedFiles = usage.files + (existingBytes === null ? 1 : 0)
  const projectedBytes = usage.bytes - (existingBytes ?? 0) + nextBytes
  if (projectedFiles > MEMORY_SCOPE_MAX_FILES) {
    throw new MemoryError(
      "store_full",
      `memory scope file limit reached (max ${MEMORY_SCOPE_MAX_FILES} files)`,
    )
  }
  if (projectedBytes > MEMORY_SCOPE_MAX_BYTES) {
    throw new MemoryError(
      "store_full",
      `memory scope size limit reached (max ${MEMORY_SCOPE_MAX_BYTES} bytes)`,
    )
  }
}

// ─────────────────────────── secret 扫描 ───────────────────────────

// 约束（P1-3）：先剥离零宽/双向控制字符再扫，避免 `AKIA\u200b...` 这类
// 「字符中间塞不可见符」把前缀拆散。任何扫描都只报类型，绝不回显命中内容。
const INVISIBLE_CHARS_RE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE_CHARS_RE, "")
}

// 约束（P1-3）：JS 的 \b 把 `_` 当词字符，`MY_AWS_SECRET_ACCESS_KEY` 这类
// 环境变量式前缀会漏判。统一用「前后不是字母数字」的边界，`_` 视为分隔符。
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "private-key", re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i },
  // PEM 正文（去掉 header 后剩下的 base64 长串）单独命中：只贴正文也算泄漏。
  { label: "private-key-body", re: /(?<![A-Za-z0-9])MII[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9])/ },
  { label: "aws-access-key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  { label: "github-token", re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/ },
  { label: "slack-token", re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/ },
  { label: "google-api-key", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}(?![A-Za-z0-9])/ },
  { label: "model-api-key", re: /(?<![A-Za-z0-9])(?:sk|pk|xsk)-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/ },
  { label: "npm-token", re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/ },
  { label: "stripe-key", re: /(?<![A-Za-z0-9])[rs]k_live_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/ },
  { label: "jwt", re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9])/ },
  { label: "bearer-token", re: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/-]{20,}=*(?![A-Za-z0-9])/i },
  // 约束（P1-3）：任何赋值给 *KEY/*TOKEN/*SECRET/*PASSWORD* 且值长 ≥8 一律拒。
  // 兼容 `AWS_SECRET_ACCESS_KEY=`、`DB_PASSWORD=`、`OPENAI_API_KEY="..."` 等
  // 环境变量/配置行；宁可误拒。
  {
    label: "credential-assignment",
    re: /(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_.-]*["'`]?\s*[:=]\s*["'`]?[^\s"'`]{8,}/i,
  },
  // 旧式 api_key: value（保持标签可读，已被上面的通用规则覆盖）。
  {
    label: "credential-assignment",
    re: /(?<![A-Za-z0-9])(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|private[_-]?key)["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9_\-+/=.]{8,}/i,
  },
  { label: "telegram-token", re: /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9])/ },
  // URL 内嵌凭据：任意 scheme://user:pass@（不再只限数据库 URL）。
  { label: "url-credentials", re: /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i },
  {
    label: "connection-string",
    re: /(?<![A-Za-z0-9])(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@/i,
  },
]

const BASE64_RUN_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g
const HEX_RUN_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g

function scanText(text: string): { ok: boolean; label?: string } {
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0
    if (pattern.re.test(text)) return { ok: false, label: pattern.label }
  }
  return { ok: true }
}

function mostlyPrintable(text: string): boolean {
  if (text.length === 0) return false
  let printable = 0
  let counted = 0
  for (const ch of text) {
    counted += 1
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x0d || code === 0x09 || (code >= 0x20 && code <= 0x7e)) printable += 1
  }
  return counted > 0 && printable / counted > 0.9
}

/** 把一段 base64/hex 文本解码后再扫；解码结果不像文本就跳过。 */
function scanEncodedRuns(
  text: string,
  re: RegExp,
  label: string,
  decode: (match: string) => string,
): { ok: boolean; label?: string } {
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let decoded = ""
    try {
      decoded = decode(match[0])
    } catch {
      continue
    }
    if (!mostlyPrintable(decoded)) continue
    const hit = scanText(decoded)
    if (!hit.ok) return { ok: false, label: `${label}:${hit.label ?? "secret"}` }
  }
  return { ok: true }
}

/**
 * 约束（P1-3）：扫描输入是「最终文件全文」——overwrite 是本次内容，append 是
 * 既有内容＋本次内容。扫描前剥离零宽/双向控制字符与全部空白（分片拼接），
 * 再对 base64（含 MIME 折行）与 hex 解码后复扫。
 */
export function scanMemorySecrets(content: string): { ok: boolean; label?: string } {
  const normalized = stripInvisibleChars(String(content ?? ""))
  const direct = scanText(normalized)
  if (!direct.ok) return direct

  // 分片拼接：去掉所有空白后连续扫描，覆盖「密钥被换行/空格拆成多段」。
  const compact = normalized.replace(/\s+/g, "")
  if (compact !== normalized) {
    const split = scanText(compact)
    if (!split.ok) return split
  }

  // base64/hex：原文（跨行分片）与去空白文本各扫一遍。
  const sources = compact === normalized ? [normalized] : [normalized, compact]
  for (const source of sources) {
    const b64 = scanEncodedRuns(source, BASE64_RUN_RE, "base64", (m) =>
      Buffer.from(m, "base64").toString("utf8"),
    )
    if (!b64.ok) return b64
    const hex = scanEncodedRuns(source, HEX_RUN_RE, "hex", (m) =>
      m.length % 2 === 0 ? Buffer.from(m, "hex").toString("utf8") : "",
    )
    if (!hex.ok) return hex
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
 * 约束（P1-13/P3-14）：记忆正文是不可执行的资料，不是指令。注入 prompt 前包上围栏，
 * 并把正文里可能被误读为控制标记的字符转义。行首 `#` 的变体（引用 `> #`、
 * 有序/无序列表 `1. #`、`- #`）一律转义，避免伪造章节。
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
    .replace(/^([ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?)#/gm, "$1[ESC_HASH]")
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
  // 约束（P1-4）：name 展开后的祖先先查归档，再建目录/锁。
  await assertNoArchivedAlongName(dirReal, relativeName)
  const file = await ensureContainedFilePath(dirReal, relativeName, true)
  await assertNotArchivedPath(rootReal, file)

  // tenant/scope 根：root/tenant/{user|project|local}
  const scopeSegments = relative(rootReal, dirReal).split(sep).slice(0, 2).filter((s) => s.length > 0)
  const scopeRoot = await realpath(join(rootReal, ...scopeSegments))
  if (!isUnder(rootReal, scopeRoot)) {
    throw new MemoryError("invalid_path", "memory scope escapes the configured root")
  }

  let bytes = 0
  let sha256 = ""
  // 锁序固定：scope 锁 → 文件锁（全局唯一顺序，避免死锁）。
  await withFileLock(join(scopeRoot, ".quota.lock"), async () => {
    await withFileLock(lockPathFor(file), async () => {
      const existingInfo = await lstatOrNull(file)
      let existing = Buffer.alloc(0)
      if (existingInfo !== null) {
        await assertRegularFile(file, dirReal)
        existing = await readFile(file)
      }

      let final: Buffer
      if (mode === "append") {
        const needsSeparator =
          incoming.byteLength > 0 &&
          existing.byteLength > 0 &&
          existing[existing.byteLength - 1] !== 0x0a
        final = needsSeparator
          ? Buffer.concat([existing, Buffer.from("\n"), incoming])
          : Buffer.concat([existing, incoming])
      } else {
        final = incoming
      }

      // 约束（P0-2）：锁内检查总量；超限直接拒绝，目标文件保持原样。
      if (final.byteLength > MEMORY_CONTENT_MAX_BYTES) {
        throw new MemoryError(
          "content_too_large",
          `content must be at most ${MEMORY_CONTENT_MAX_BYTES} bytes after append`,
        )
      }
      // 约束（P1-3）：append 扫「最终文件全文」，分片写入无法绕过。
      assertNoSecrets(final.toString("utf8"))
      await assertScopeQuota(
        scopeRoot,
        existingInfo !== null ? existing.byteLength : null,
        final.byteLength,
      )
      await atomicWrite(file, final)
      bytes = final.byteLength
      // 约束（P3-13）：bytes/sha256 统一为 **写入后的最终文件** 语义。
      sha256 = createHash("sha256").update(final).digest("hex")
    })
  })

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
  // 约束（P1-4）：name 展开后的所有祖先都要查归档，嵌套目录同样拒读。
  await assertNotArchivedPath(rootReal, file)
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
        // 约束（P1-4）：归档子树不再可列出。
        if (entry.name === MEMORY_ARCHIVED_SENTINEL) continue
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
