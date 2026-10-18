/**
 * agent-memory-write.ts — Claude Code 2.1.302 agent 可写记忆的 Eimu 落地。
 *
 * 约束（照 CC 2.1.302 原始实现）：
 * - 内容 ≤102400 bytes；name ≤1024 bytes、≤20 段；禁 "." / ".." / 控制与格式字符；必须 NFC。
 * - realpath containment 防 symlink 逃逸；archived（`.archived` 哨兵）拒写。
 * - 写入原子（同目录 tmp + rename），返回 {path,bytes,sha256}。
 * - secret 扫描宁可误拒；不把命中内容写进错误或日志。
 * - 所有路径操作 fail-closed。
 *
 * 目录布局（HARNESS_MEMORY_ROOT，默认 /opt/agent-harness/state/agent-memory）：
 *   user    <root>/<tenant>/user/<agent>/
 *   project <root>/<tenant>/project/<workspaceKey>/<agent>/
 *   local   <root>/<tenant>/local/<workspaceKey>/<sessionKey>/<agent>/
 * 三个 scope 分别对应 CC 的 ~/.claude/agent-memory、<workspace>/.claude/agent-memory、
 * <workspace>/.claude/agent-memory-local；tenant/workspace/session 用于 Eimu 隔离。
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

function sanitizeSegment(raw: unknown, fallback: string, max = 128): string {
  const text = typeof raw === "string" ? raw : ""
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, max)
  return cleaned.length > 0 ? cleaned : fallback
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
  const root = resolve((process.env.HARNESS_MEMORY_ROOT || DEFAULT_MEMORY_ROOT).trim())
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

async function ensureContainedDir(root: string, dir: string, create: boolean): Promise<string> {
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
        await mkdir(current, { mode: 0o700 })
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
  return dirReal
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
      await mkdir(parent, { mode: 0o700 })
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

async function assertNotArchived(dirReal: string): Promise<void> {
  const sentinel = await lstatOrNull(join(dirReal, MEMORY_ARCHIVED_SENTINEL))
  if (sentinel !== null) {
    throw new MemoryError("store_archived", "cannot modify archived resource")
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

// ─────────────────────────── secret 扫描 ───────────────────────────

// 约束：宁可误拒。命中只报类型，绝不回显命中的密文。
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "private-key", re: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
  { label: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/ },
  { label: "stripe-key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/ },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { label: "credential-assignment", re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|private[_-]?key)\b\s*[:=]\s*["'`]?[A-Za-z0-9_\-+/=.]{12,}/i },
  { label: "telegram-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  { label: "connection-string", re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i },
]

export function scanMemorySecrets(content: string): { ok: boolean; label?: string } {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(content)) return { ok: false, label: pattern.label }
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
  const dirReal = await ensureContainedDir(paths.root, paths.dir, true)
  await assertNotArchived(dirReal)
  const relativeName = relative(paths.dir, paths.file).split(sep).join("/")
  const file = await ensureContainedFilePath(dirReal, relativeName, true)

  let data = incoming
  if (mode === "append") {
    const existingInfo = await lstatOrNull(file)
    if (existingInfo !== null) {
      await assertRegularFile(file, dirReal)
      const existing = await readFile(file)
      if (existing.byteLength > MEMORY_CONTENT_MAX_BYTES) {
        throw new MemoryError("content_too_large", "existing memory file exceeds the size limit")
      }
      const separator = existing.byteLength > 0 && existing[existing.byteLength - 1] !== 0x0a ? Buffer.from("\n") : Buffer.alloc(0)
      data = Buffer.concat([existing, separator, incoming])
      if (data.byteLength > MEMORY_CONTENT_MAX_BYTES) {
        throw new MemoryError(
          "content_too_large",
          `content must be at most ${MEMORY_CONTENT_MAX_BYTES} bytes after append`,
        )
      }
    }
  }

  assertNoSecrets(data.toString("utf8"))
  await atomicWrite(file, data)

  return {
    scope: input.scope,
    agent: sanitizeAgentName(input.agent),
    path: file,
    relative_path: relative(paths.root, file),
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    mode,
  }
}

export async function memoryRead(
  location: MemoryLocation & { name?: string },
): Promise<MemoryReadResult> {
  const paths = resolveMemoryPaths(location)
  const dirReal = await ensureContainedDir(paths.root, paths.dir, false)
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
    path: relative(paths.root, file),
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
  let dirReal: string
  try {
    dirReal = await ensureContainedDir(paths.root, paths.dir, false)
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
