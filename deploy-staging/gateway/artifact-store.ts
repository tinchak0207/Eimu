// Artifact 交付物存储：版本化、ACL、真实性探测、资产表。
// 约束：单事务写版本；文件读取失败整笔拒绝；16MiB 上限（对齐 Kf=16777216）。
// 约束：verify 没有探测结果时只能报 no_row，不得宣称干净。
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import path from "node:path"

export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const MAX_NAME_LENGTH = 256
const MAX_SLUG_LENGTH = 96
const MAX_ASSET_KEY_LENGTH = 128
const MAX_URL_LENGTH = 4096
// 约束：verify 总预算 20s = HEAD 6s + GET 12s（每跳 redirect 重新校验并共享该预算）。
const PROBE_HEAD_TIMEOUT_MS = 6_000
const PROBE_GET_TIMEOUT_MS = 12_000
const MAX_PROBE_REDIRECTS = 5
// include_data 响应上限：8MB base64（小于 16MiB 文件本身，避免单次回包撑爆 agent 上下文）。
const INCLUDE_DATA_MAX_BASE64_BYTES = 8 * 1024 * 1024
const DEFAULT_WORKSPACE = "/opt/agent-harness/workspace"

export type AclMode = "owner" | "users" | "org" | "public"
export type AclAccess = "view" | "comment"
export type ArtifactListScope = "mine" | "shared" | "all"
export type VerifyState = "verified" | "blocked" | "no_row"

export class ArtifactError extends Error {
  code: string
  status: number
  detail: Record<string, unknown>
  constructor(code: string, message: string, status = 400, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = "ArtifactError"
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export class ArtifactConflictError extends ArtifactError {
  liveVersion: number
  live: ArtifactVersionView | null
  constructor(liveVersion: number, live: ArtifactVersionView | null) {
    super(
      "version_conflict",
      `版本冲突：当前 live version 为 ${liveVersion}，未写入本次发布`,
      409,
      { live_version: liveVersion, live },
    )
    this.name = "ArtifactConflictError"
    this.liveVersion = liveVersion
    this.live = live
  }
}

export interface ArtifactVersionView {
  artifact_id: number
  session_id: string
  owner_key: string
  name: string
  slug: string
  latest_version: number
  version: number
  url: string | null
  path: string | null
  sha256: string
  bytes: number
  content_type: string
  producer: string | null
  verified_at: number | null
  verify_status: string | null
  created_at: number
  updated_at: number
  acl_mode: AclMode
  acl_json: Record<string, unknown>
  pinned: boolean
}

export interface PublishArtifactInput {
  sessionId: string
  ownerKey?: string
  name: string
  path: string
  url?: string
  contentType?: string
  producer?: string
  expectedVersion?: number
}

export interface PublishArtifactResult extends ArtifactVersionView {
  readBack: ArtifactVersionView
  changed: boolean
}

export interface SetAclInput {
  sessionId: string
  name: string
  /** 身份（HTTP 取 body.actor / X-Session-Id，默认 session_id）。必须等于 owner_key。 */
  actor?: string
  /** 兼容旧调用方：actor 未给时回退到 requesterKey。 */
  requesterKey?: string
  mode: "org" | "people" | "users" | "private"
  access?: AclAccess
  people?: string[]
}

export interface VerifyArtifactInput {
  sessionId: string
  name: string
  version?: number
}

export interface VerifyArtifactResult {
  state: VerifyState
  verify_status: string
  reason: string | null
  artifact_id: number
  slug: string
  name: string
  version: number
  url: string | null
  status: number | null
  content_type: string | null
  bytes: number | null
  sha256: string | null
  expected_sha256: string
  sha256_match: boolean | null
  method: string | null
  partial: boolean
  error: string | null
  checked_at: number
  verified_at: number | null
}

export interface UploadAssetInput {
  sessionId: string
  name: string
  path: string
  url?: string
  contentType?: string
  assetKey?: string
}

export interface CopyAssetInput {
  sessionId: string
  name: string
  /** 操作者身份；源必须可读、目标必须归操作者所有。 */
  actor?: string
  fromSessionId?: string
  fromName: string
  fromAssetId?: number
  fromAssetKey?: string
  assetKey?: string
}

export interface DeleteArtifactInput {
  sessionId: string
  name: string
  actor?: string
}

export interface DeleteArtifactVersionInput {
  sessionId: string
  name: string
  version: number
  actor?: string
}

export interface ReadAssetInput {
  sessionId: string
  name: string
  /** 读取者身份；省略时回退 sessionId。必须满足 owner/public/org/users ACL。 */
  actor?: string
  assetId?: number
  assetKey?: string
  includeData?: boolean
}

export interface ArtifactAssetView {
  id: number
  artifact_id: number
  asset_key: string
  url: string | null
  sha256: string
  bytes: number
  content_type: string
  created_at: number
  local_path: string | null
  exists: boolean
}

let connection: Database | undefined

function stateDir(): string {
  return process.env.ARTIFACT_STORE_DIR || path.join(path.dirname(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db"), "artifacts")
}

function assetDir(artifactId: number): string {
  return path.join(stateDir(), "assets", String(artifactId))
}

function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    owner_key TEXT,
    name TEXT,
    slug TEXT,
    latest_version INTEGER NOT NULL DEFAULT 0,
    acl_mode TEXT NOT NULL DEFAULT 'owner',
    acl_json TEXT NOT NULL DEFAULT '{}',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    UNIQUE(session_id,name)
  );
  CREATE TABLE IF NOT EXISTS artifact_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    url TEXT,
    path TEXT,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    producer TEXT,
    verified_at INTEGER,
    verify_status TEXT,
    created_at INTEGER,
    UNIQUE(artifact_id,version)
  );
  CREATE TABLE IF NOT EXISTS artifact_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id INTEGER,
    asset_key TEXT,
    url TEXT,
    sha256 TEXT,
    bytes INTEGER,
    content_type TEXT,
    created_at INTEGER,
    UNIQUE(artifact_id, asset_key)
  );
  CREATE INDEX IF NOT EXISTS artifact_versions_artifact ON artifact_versions(artifact_id);
  CREATE INDEX IF NOT EXISTS artifact_assets_artifact ON artifact_assets(artifact_id);`)
  // 既有库迁移（P1-4）：旧表没有 UNIQUE；先去重保留最新一行，再建唯一索引。
  // 任何一步失败都不得阻止 store 载入（旧库可能仍在写入）。
  try {
    next.exec(`DELETE FROM artifact_assets
      WHERE artifact_id IS NOT NULL AND asset_key IS NOT NULL AND id NOT IN (
        SELECT MAX(id) FROM artifact_assets WHERE artifact_id IS NOT NULL AND asset_key IS NOT NULL
        GROUP BY artifact_id, asset_key
      )`)
    next.exec("CREATE UNIQUE INDEX IF NOT EXISTS artifact_assets_artifact_key ON artifact_assets(artifact_id, asset_key)")
  } catch {
    // 迁移失败留待后续写路径的 upsert 兜底；不阻断 store 启动。
  }
  connection = next
  return next
}

function withImmediate<T>(fn: () => T): T {
  const d = db()
  d.exec("BEGIN IMMEDIATE")
  try {
    const out = fn()
    d.exec("COMMIT")
    return out
  } catch (e) {
    try {
      d.exec("ROLLBACK")
    } catch {
      // 回滚失败不得覆盖原始错误。
    }
    throw e
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ArtifactError(`invalid_${field}`, `${field} 必须是字符串`)
  const text = value.trim()
  if (!text) throw new ArtifactError(`invalid_${field}`, `${field} 不能为空`)
  if (text.length > max) throw new ArtifactError(`invalid_${field}`, `${field} 超过 ${max} 字符`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new ArtifactError(`invalid_${field}`, `${field} 含控制字符`)
  return text
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredText(value, field, max)
}

function normalizeVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(n) || n < 1) throw new ArtifactError("invalid_version", "version 必须是 ≥1 的整数")
  return n
}

function normalizeExpectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  // 约束（P2-7）：严格 number 校验——字符串数字、布尔、数组、NaN、Infinity 一律 400。
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ArtifactError(
      "invalid_expected_version",
      "expectedVersion 必须是 ≥0 的有限整数（不接受字符串/布尔/数组/NaN/Infinity）",
    )
  }
  // 约束：expectedVersion=0 表示“预期尚未发布”。
  return value
}

function slugFor(sessionId: string, name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  const digest = createHash("sha256").update(`${sessionId}\0${name}`).digest("hex").slice(0, 10)
  return `${base || "artifact"}-${digest}`.slice(0, MAX_SLUG_LENGTH)
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
}

function contentTypeFor(filePath: string, provided?: string): string {
  if (provided) return provided.slice(0, 256)
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

interface ReadFileResult {
  absolutePath: string
  bytes: Buffer
  sha256: string
  size: number
}

// 上传路径闸（P2-8）：只允许 HARNESS_WORKSPACE 或 HARNESS_UPLOAD_ROOTS 白名单内的真实路径。
// 白名单分隔符兼容 `:`（POSIX PATH 风格）与 `,`；每一步 realpath 后做包含检查。
function uploadRoots(): string[] {
  const roots: string[] = []
  const add = (raw: string | undefined): void => {
    if (!raw) return
    for (const part of raw.split(/[:,]/)) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const absolute = path.resolve(trimmed)
      try {
        roots.push(realpathSync(absolute))
      } catch {
        roots.push(absolute)
      }
    }
  }
  add(process.env.HARNESS_WORKSPACE || DEFAULT_WORKSPACE)
  add(process.env.HARNESS_UPLOAD_ROOTS)
  return Array.from(new Set(roots))
}

function isWithinPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function assertUploadPathAllowed(absolutePath: string): void {
  let real: string
  try {
    real = realpathSync(absolutePath)
  } catch {
    throw new ArtifactError("file_not_found", `文件不存在：${absolutePath}`, 400)
  }
  const roots = uploadRoots()
  if (!roots.some((root) => isWithinPath(root, real))) {
    throw new ArtifactError(
      "path_not_allowed",
      `路径必须位于 HARNESS_WORKSPACE（${process.env.HARNESS_WORKSPACE || DEFAULT_WORKSPACE}）或 HARNESS_UPLOAD_ROOTS 内：${absolutePath}`,
      400,
    )
  }
}

function readRegularFile(inputPath: string): ReadFileResult {
  const absolutePath = path.resolve(requiredText(inputPath, "path", MAX_URL_LENGTH))
  let before: ReturnType<typeof lstatSync>
  try {
    before = lstatSync(absolutePath)
  } catch {
    throw new ArtifactError("file_not_found", `文件不存在：${absolutePath}`, 400)
  }
  // 约束：只接受常规文件；符号链接、目录、设备、FIFO 一律拒绝。
  if (before.isSymbolicLink()) throw new ArtifactError("file_symlink", "拒绝符号链接", 400)
  if (!before.isFile()) throw new ArtifactError("file_not_regular", "只接受常规文件", 400)
  // 约束：硬链接会让同一 inode 从别处被改写；拒绝 nlink>1。
  if (before.nlink > 1) throw new ArtifactError("file_hardlink", "拒绝硬链接文件", 400)
  // 约束：路径必须落在允许的上传根（realpath 后包含检查，防 `..` 与中间层 symlink 逃逸）。
  assertUploadPathAllowed(absolutePath)
  if (before.size > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError("file_too_large", `文件 ${before.size} 字节，超过 16MiB 上限`, 413)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(absolutePath)
  } catch (e) {
    throw new ArtifactError("file_read_failed", `读取失败：${e instanceof Error ? e.message : String(e)}`, 400)
  }
  const after = lstatSync(absolutePath)
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new ArtifactError("file_changed_during_read", "读取期间文件发生变化，整笔拒绝", 409)
  }
  if (bytes.length > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError("file_too_large", `文件 ${bytes.length} 字节，超过 16MiB 上限`, 413)
  }
  return { absolutePath, bytes, sha256: sha256Hex(bytes), size: bytes.length }
}

function parseAcl(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function rowView(artifact: any, version: any): ArtifactVersionView {
  return {
    artifact_id: Number(artifact.id),
    session_id: String(artifact.session_id ?? ""),
    owner_key: String(artifact.owner_key ?? ""),
    name: String(artifact.name ?? ""),
    slug: String(artifact.slug ?? ""),
    latest_version: Number(artifact.latest_version ?? 0),
    version: Number(version.version),
    url: typeof version.url === "string" ? version.url : null,
    path: typeof version.path === "string" ? version.path : null,
    sha256: String(version.sha256),
    bytes: Number(version.bytes),
    content_type: String(version.content_type),
    producer: typeof version.producer === "string" ? version.producer : null,
    verified_at: typeof version.verified_at === "number" ? version.verified_at : null,
    verify_status: typeof version.verify_status === "string" ? version.verify_status : null,
    created_at: Number(version.created_at ?? 0),
    updated_at: Number(artifact.updated_at ?? 0),
    acl_mode: (artifact.acl_mode as AclMode) || "owner",
    acl_json: parseAcl(artifact.acl_json),
    pinned: Number(artifact.pinned) === 1,
  }
}

function artifactRow(sessionId: string, name: string): any | null {
  return (db().query("SELECT * FROM artifacts WHERE session_id=? AND name=?").get(sessionId, name) as any) ?? null
}

function versionRow(artifactId: number, version: number): any | null {
  return (db().query("SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?").get(artifactId, version) as any) ?? null
}

function requireArtifact(sessionId: string, name: string): any {
  const row = artifactRow(sessionId, name)
  if (!row) throw new ArtifactError("artifact_not_found", `artifact 不存在：${name}`, 404)
  return row
}

function resolvedVersion(artifact: any, version?: number): { artifact: any; version: any; view: ArtifactVersionView } {
  const wanted = version !== undefined ? version : Number(artifact.latest_version)
  const row = versionRow(Number(artifact.id), wanted)
  if (!row) throw new ArtifactError("version_not_found", `版本不存在：${wanted}`, 404)
  return { artifact, version: row, view: rowView(artifact, row) }
}

// ── 身份 / ACL（P1-2）───────────────────────────────────────────────────────
// actor 默认等于 sessionId（既有 HTTP/工具调用不传 actor 时行为不变）。
function resolveActor(actor: string | undefined, fallback: string): string {
  const value = typeof actor === "string" ? actor.trim() : ""
  return value || fallback
}

function aclUsers(artifact: any): string[] {
  const json = parseAcl(artifact.acl_json)
  const raw = Array.isArray(json.users) ? json.users : []
  return raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
}

function sameIdentity(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/** owner / public / org / users 命中任一即视为可读。 */
function canReadArtifact(artifact: any, actor: string): boolean {
  const owner = String(artifact.owner_key ?? "")
  // owner 是密钥类不透明身份：精确匹配；users 名单按大小写不敏感匹配。
  if (owner !== "" && owner === actor) return true
  const mode = String(artifact.acl_mode ?? "owner")
  if (mode === "public" || mode === "org") return true
  if (mode === "users") return aclUsers(artifact).some((user) => sameIdentity(user, actor))
  return false
}

function requireReadAccess(artifact: any, actor: string): void {
  if (!canReadArtifact(artifact, actor)) {
    throw new ArtifactError("forbidden", "没有读取该 artifact 的权限", 403, { reason: "acl_denied" })
  }
}

function requireOwner(artifact: any, actor: string, action: string): void {
  if (String(artifact.owner_key ?? "") !== actor) {
    throw new ArtifactError("not_owner", `只有 owner 能${action}`, 403, { reason: "not_owner" })
  }
}

/**
 * 用户存在性校验（P2-7）：复用本仓库既有身份表（sessions/user_settings），
 * 也承认当前 artifact owner（同进程内已登记过的身份）。查不到 → false（调用方回 400）。
 */
function userExists(value: string): boolean {
  const d = db()
  const probes: Array<[string, string]> = [
    ["SELECT 1 AS hit FROM sessions WHERE id=? LIMIT 1", value],
    ["SELECT 1 AS hit FROM sessions WHERE owner_key=? LIMIT 1", value],
    ["SELECT 1 AS hit FROM user_settings WHERE owner_key=? LIMIT 1", value],
    ["SELECT 1 AS hit FROM artifacts WHERE owner_key=? LIMIT 1", value],
  ]
  for (const [sql, param] of probes) {
    try {
      if (d.query(sql).get(param)) return true
    } catch {
      // 表不存在：继续尝试下一个既有身份源。
    }
  }
  return false
}

export function getArtifact(sessionId: string, name: string, version?: number): ArtifactVersionView | null {
  const sid = requiredText(sessionId, "session_id", MAX_NAME_LENGTH)
  const artifactName = requiredText(name, "name", MAX_NAME_LENGTH)
  const artifact = artifactRow(sid, artifactName)
  if (!artifact) return null
  const wanted = normalizeVersion(version)
  const row = versionRow(Number(artifact.id), wanted ?? Number(artifact.latest_version))
  // P3：artifact 还在但版本行被删除时，明确回 version_not_found（不能伪装成 artifact 不存在）。
  if (!row) throw new ArtifactError("version_not_found", `版本不存在：${wanted ?? artifact.latest_version}`, 404)
  return rowView(artifact, row)
}

export function listArtifacts(sessionId: string, scope: ArtifactListScope = "mine"): ArtifactVersionView[] {
  const sid = requiredText(sessionId, "session_id", MAX_NAME_LENGTH)
  const base = `SELECT a.*, v.version AS v_version, v.url AS v_url, v.path AS v_path, v.sha256 AS v_sha256,
      v.bytes AS v_bytes, v.content_type AS v_content_type, v.producer AS v_producer,
      v.verified_at AS v_verified_at, v.verify_status AS v_verify_status, v.created_at AS v_created_at
    FROM artifacts a
    LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.latest_version`
  let rows: any[]
  if (scope === "shared") {
    rows = db().query(`${base} WHERE a.acl_mode <> 'owner' ORDER BY a.updated_at DESC`).all() as any[]
  } else if (scope === "all") {
    rows = db().query(`${base} WHERE a.session_id = ? OR a.acl_mode <> 'owner' ORDER BY a.updated_at DESC`).all(sid) as any[]
  } else if (scope === "mine") {
    rows = db().query(`${base} WHERE a.session_id = ? ORDER BY a.updated_at DESC`).all(sid) as any[]
  } else {
    throw new ArtifactError("invalid_scope", "scope 只接受 mine/shared/all")
  }
  return rows
    .filter((row) => row.v_version !== null)
    .map((row) => {
      const view = rowView(
        row,
        {
          version: row.v_version,
          url: row.v_url,
          path: row.v_path,
          sha256: row.v_sha256,
          bytes: row.v_bytes,
          content_type: row.v_content_type,
          producer: row.v_producer,
          verified_at: row.v_verified_at,
          verify_status: row.v_verify_status,
          created_at: row.v_created_at,
        },
      )
      // P1-2：shared / all 里不属于本次 session 的条目脱敏——不回 path 与 owner_key。
      if (scope === "shared" || String(row.session_id ?? "") !== sid) {
        return { ...view, owner_key: "", path: null }
      }
      return view
    })
}

export function publishArtifact(input: PublishArtifactInput): PublishArtifactResult {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const ownerKey = optionalText(input.ownerKey, "owner_key", MAX_NAME_LENGTH) || sessionId
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  // 约束：文件在进入事务前完整读取并校验；失败不得留下半条版本。
  const file = readRegularFile(input.path)
  const contentType = contentTypeFor(file.absolutePath, optionalText(input.contentType, "content_type", 256))
  const url = optionalText(input.url, "url", MAX_URL_LENGTH) || null
  const producer = optionalText(input.producer, "producer", MAX_NAME_LENGTH) || null
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const now = Date.now()

  return withImmediate(() => {
    const existing = artifactRow(sessionId, name)
    if (!existing) {
      // 约束：只有 expectedVersion=0 或省略才允许创建；带正数表示调用方以为已有版本。
      if (expectedVersion !== undefined && expectedVersion !== 0) {
        throw new ArtifactConflictError(0, null)
      }
      const inserted = db()
        .query(
          `INSERT INTO artifacts(session_id,owner_key,name,slug,latest_version,acl_mode,acl_json,pinned,created_at,updated_at)
           VALUES(?,?,?,?,1,'owner','{}',0,?,?)`,
        )
        .run(sessionId, ownerKey, name, slugFor(sessionId, name), now, now)
      const artifactId = Number(inserted.lastInsertRowid)
      db()
        .query(
          `INSERT INTO artifact_versions(artifact_id,version,url,path,sha256,bytes,content_type,producer,verified_at,verify_status,created_at)
           VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)`,
        )
        .run(artifactId, 1, url, file.absolutePath, file.sha256, file.size, contentType, producer, now)
      const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(artifactId) as any
      const view = rowView(artifact, versionRow(artifactId, 1))
      return { ...view, readBack: view, changed: true }
    }

    const liveVersion = Number(existing.latest_version)
    // P1-3：artifact 已存在时 owner 不可被 publish 改写。
    if (String(existing.owner_key ?? "") !== ownerKey) {
      throw new ArtifactError("not_owner", `artifact 属于 ${String(existing.owner_key ?? "")}，不能被 ${ownerKey} 改写`, 403, {
        reason: "not_owner",
      })
    }
    // 约束：乐观并发先于内容去重；stale 写入即使内容相同也必须 409。
    if (expectedVersion !== undefined && expectedVersion !== liveVersion) {
      const liveRow = versionRow(Number(existing.id), liveVersion)
      throw new ArtifactConflictError(liveVersion, liveRow ? rowView(existing, liveRow) : null)
    }
    const live = versionRow(Number(existing.id), liveVersion)
    // P2-6：内容未变（sha256/bytes 相同）不升版本，但必须吸收新的 url/content_type/producer 元数据
    // 并回 changed:true——新 URL 不得被吞掉。
    if (live && String(live.sha256) === file.sha256 && Number(live.bytes) === file.size) {
      db()
        .query("UPDATE artifact_versions SET url=?,path=?,content_type=?,producer=? WHERE id=?")
        .run(
          url ?? (typeof live.url === "string" ? live.url : null),
          file.absolutePath,
          contentType,
          producer ?? (typeof live.producer === "string" ? live.producer : null),
          Number(live.id),
        )
      db().query("UPDATE artifacts SET updated_at=? WHERE id=?").run(now, Number(existing.id))
      const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(existing.id)) as any
      const updatedLive = versionRow(Number(existing.id), liveVersion)
      const view = rowView(artifact, updatedLive)
      return { ...view, readBack: view, changed: true }
    }

    const nextVersion = liveVersion + 1
    // P1-3：owner_key 只由创建时决定，后续版本更新不得改写。
    db().query("UPDATE artifacts SET latest_version=?,updated_at=? WHERE id=?").run(nextVersion, now, Number(existing.id))
    db()
      .query(
        `INSERT INTO artifact_versions(artifact_id,version,url,path,sha256,bytes,content_type,producer,verified_at,verify_status,created_at)
         VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)`,
      )
      .run(Number(existing.id), nextVersion, url, file.absolutePath, file.sha256, file.size, contentType, producer, now)
    const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(existing.id)) as any
    const view = rowView(artifact, versionRow(Number(existing.id), nextVersion))
    return { ...view, readBack: view, changed: true }
  })
}

export function setAcl(input: SetAclInput): ArtifactVersionView {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const actor = resolveActor(input.actor, resolveActor(input.requesterKey, sessionId))
  const artifact = requireArtifact(sessionId, name)
  // 约束：只有 owner_key 本人能改 ACL。
  requireOwner(artifact, actor, "修改共享设置")
  // 约束：已 public 不可收窄。
  if (artifact.acl_mode === "public") {
    throw new ArtifactError("already_public", "已 public 的 artifact 不能收窄", 409)
  }
  const mode = input.mode
  const access: AclAccess = input.access === "view" ? "view" : "comment"
  let aclMode: AclMode
  let aclJson: Record<string, unknown>
  if (mode === "private") {
    // P2-7：private 收回归属 owner-only。
    aclMode = "owner"
    aclJson = {}
  } else if (mode === "org") {
    aclMode = "org"
    aclJson = { access }
  } else if (mode === "people" || mode === "users") {
    const rawPeople = Array.isArray(input.people)
      ? input.people.filter((p): p is string => typeof p === "string" && Boolean(p.trim())).map((p) => p.trim())
      : []
    if (rawPeople.length === 0) throw new ArtifactError("missing_people", "mode=people 时必须提供 people", 400)
    const unique: string[] = []
    for (const person of rawPeople) {
      if (unique.some((item) => sameIdentity(item, person))) continue
      // P2-7：people 必须是仓库里真实存在的用户；查不到 → 400。
      if (!userExists(person)) {
        throw new ArtifactError("unknown_user", `用户不存在：${person}`, 400, { user: person })
      }
      unique.push(person)
    }
    aclMode = "users"
    aclJson = { users: unique.slice(0, 256), access }
  } else {
    throw new ArtifactError("invalid_acl_mode", "mode 只接受 private/org/people/users", 400)
  }
  const now = Date.now()
  db().query("UPDATE artifacts SET acl_mode=?,acl_json=?,updated_at=? WHERE id=?").run(aclMode, JSON.stringify(aclJson), now, Number(artifact.id))
  const updated = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(artifact.id)) as any
  const live = versionRow(Number(updated.id), Number(updated.latest_version))
  return rowView(updated, live)
}

interface ProbeOutcome {
  status: number | null
  contentType: string | null
  bytes: number | null
  sha256: string | null
  partial: boolean
  method: string | null
  error: string | null
}

function parseLength(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function contentRangeTotal(value: string | null): number | null {
  if (!value) return null
  const match = /\/(\d+)\s*$/.exec(value)
  return match ? Number(match[1]) : null
}

async function readCapped(response: Response, cap: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) {
    const raw = Buffer.from(await response.arrayBuffer())
    return { buffer: raw.subarray(0, cap), truncated: raw.length > cap }
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    if (total + value.byteLength > cap) {
      chunks.push(Buffer.from(value.subarray(0, cap - total)))
      total = cap
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // 取消失败不影响已取得的探测证据。
      }
      break
    }
    chunks.push(Buffer.from(value))
    total += value.byteLength
  }
  return { buffer: Buffer.concat(chunks), truncated }
}

// ── SSRF 防护（P0-1）────────────────────────────────────────────────────────
// 判据：scheme 只准 http/https；host 解析后校验实际 IP；每一跳 redirect 重新校验。
class BlockedUrlError extends Error {
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = "BlockedUrlError"
    this.kind = kind
  }
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  while (host.endsWith(".")) host = host.slice(0, -1)
  return host
}

function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = Number.parseInt(part.slice(2), 16)
    return Number.isFinite(value) ? value : null
  }
  // 八进制（前导 0，且后续全为 0-7）；"0" 本身按十进制 0 处理。
  if (/^0[0-7]+$/.test(part)) {
    const value = Number.parseInt(part.slice(1), 8)
    return Number.isFinite(value) ? value : null
  }
  if (/^(0|[1-9]\d*)$/.test(part)) {
    const value = Number(part)
    return Number.isFinite(value) ? value : null
  }
  return null
}

/** 解析十进制/十六进制/八进制/IPv4 简写（`2130706433`、`0x7f000001`、`0177.0.0.1`）。 */
function parseIpv4Literal(host: string): number | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    const value = parseIpv4Part(part)
    if (value === null || value < 0) return null
    nums.push(value)
  }
  let value = 0
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 255) return null
    value = value * 256 + nums[i]
  }
  const last = nums[nums.length - 1]
  const limit = 256 ** (5 - nums.length)
  if (last >= limit) return null
  value = value * limit + last
  return value >>> 0
}

function isPrivateIpv4(value: number): boolean {
  const a = (value >>> 24) & 0xff
  const b = (value >>> 16) & 0xff
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast / reserved / broadcast
  return value === 0xffffffff
}

function isPrivateIpv6(raw: string): boolean {
  const addr = raw.toLowerCase().split("%")[0]
  if (addr === "::" || addr === "::1") return true
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true
  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true
  // IPv4-mapped / IPv4-compatible：提取末尾 32 位再按 IPv4 规则判。
  const mapped = /^::(?:ffff:)?(.+)$/.exec(addr)
  if (mapped) {
    const tail = mapped[1]
    if (isIP(tail) === 4) {
      const value = parseIpv4Literal(tail)
      return value === null ? true : isPrivateIpv4(value)
    }
    const groups = tail.split(":")
    // ::ffff:7f00:1 → 后两组十六进制即 IPv4。
    if (groups.length >= 2) {
      const hi = Number.parseInt(groups[groups.length - 2], 16)
      const lo = Number.parseInt(groups[groups.length - 1], 16)
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIpv4(((hi << 16) | lo) >>> 0)
      }
    }
    return true
  }
  return false
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = parseIpv4Literal(address)
    return value === null ? true : isPrivateIpv4(value)
  }
  if (family === 6) return isPrivateIpv6(address)
  return false
}

function hostnameLooksBlocked(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return true
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true
  if (isIP(host) !== 0) return isPrivateAddress(host)
  // URL 未正规化的数字型 IP（十进制/十六进制/八进制）。
  const numeric = parseIpv4Literal(host)
  if (numeric !== null) return isPrivateIpv4(numeric)
  return false
}

/** DNS 解析后校验每个实际 IP（至少校验一次，缩小 DNS rebinding 窗口）。 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = normalizeHostname(hostname)
  if (hostnameLooksBlocked(host)) {
    throw new BlockedUrlError("private_address", `拒绝内网/本机地址：${hostname}`)
  }
  if (isIP(host) !== 0) return
  let records: Array<{ address: string; family: number }>
  try {
    records = await lookup(host, { all: true, verbatim: true })
  } catch (e) {
    throw new BlockedUrlError(
      "dns_resolution_failed",
      `DNS 解析失败：${hostname}（${e instanceof Error ? e.message : String(e)}）`,
    )
  }
  if (records.length === 0) throw new BlockedUrlError("dns_resolution_failed", `DNS 无记录：${hostname}`)
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new BlockedUrlError("private_address", `${hostname} 解析到内网地址 ${record.address}`)
    }
  }
}

async function fetchManualRedirects(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let current = url
  const deadline = Date.now() + timeoutMs
  for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      throw new BlockedUrlError("unsupported_url_scheme", `URL 无法解析：${current}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BlockedUrlError("unsupported_url_scheme", `只允许 http/https：${parsed.protocol}`)
    }
    // 约束：每一跳都校验 host（含 302 → 169.254/127.0.0.1 等跳转型 SSRF）。
    await assertPublicHost(parsed.hostname)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("probe_timeout")
    const response = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(remaining) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) return response
      try {
        await response.body?.cancel()
      } catch {
        // 丢弃 redirect body 失败不影响后续校验。
      }
      current = new URL(location, current).toString()
      continue
    }
    return response
  }
  throw new BlockedUrlError("too_many_redirects", `redirect 超过 ${MAX_PROBE_REDIRECTS} 跳`)
}

function blockedProbe(error: string): ProbeOutcome {
  return { status: null, contentType: null, bytes: null, sha256: null, partial: false, method: null, error }
}

async function probeUrl(url: string): Promise<ProbeOutcome> {
  // 约束：只探测 http(s)；其他 scheme 没有可记录的 HTTP 证据。
  if (!/^https?:\/\//i.test(url)) return blockedProbe("unsupported_url_scheme")
  let headStatus: number | null = null
  let headType: string | null = null
  let headLength: number | null = null
  let headError: string | null = null
  try {
    const head = await fetchManualRedirects(url, { method: "HEAD" }, PROBE_HEAD_TIMEOUT_MS)
    headStatus = head.status
    headType = head.headers.get("content-type")
    headLength = parseLength(head.headers.get("content-length"))
    try {
      await head.body?.cancel()
    } catch {
      // HEAD body 通常为空。
    }
  } catch (e) {
    if (e instanceof BlockedUrlError) return blockedProbe(e.kind)
    headError = e instanceof Error ? e.message : String(e)
  }

  let getStatus: number | null = null
  let getType: string | null = null
  let getTotal: number | null = null
  let observed: Buffer | null = null
  let getTruncated = false
  let getError: string | null = null
  let getRan = false

  // 约束：HEAD 2xx 仍要 GET Range 才能记录 sha256；HEAD 405/501 或抛错时也必须 GET。
  const needGet = headStatus === null || (headStatus >= 200 && headStatus < 300) || headStatus === 405 || headStatus === 501
  if (needGet) {
    getRan = true
    try {
      const get = await fetchManualRedirects(
        url,
        { method: "GET", headers: { Range: `bytes=0-${ARTIFACT_MAX_BYTES - 1}` } },
        PROBE_GET_TIMEOUT_MS,
      )
      getStatus = get.status
      getType = get.headers.get("content-type")
      getTotal = contentRangeTotal(get.headers.get("content-range")) ?? parseLength(get.headers.get("content-length"))
      const read = await readCapped(get, ARTIFACT_MAX_BYTES)
      observed = read.buffer
      getTruncated = read.truncated
    } catch (e) {
      if (e instanceof BlockedUrlError) return blockedProbe(e.kind)
      getError = e instanceof Error ? e.message : String(e)
    }
  }

  const status = getStatus ?? headStatus
  const contentType = getType ?? headType
  // P2-9：0 字节是合法内容，空 buffer 的 sha256 = e3b0c442...；不能因 length 0 当成“无证据”。
  const decoded = observed
  const sha = decoded ? sha256Hex(decoded) : null
  const bytes = getTruncated ? ARTIFACT_MAX_BYTES : getTotal ?? (decoded ? decoded.length : headLength)
  const partial = getTruncated || (getTotal !== null && decoded !== null && getTotal > decoded.length) || (getRan && getStatus === 206 && getTotal !== null && decoded !== null && decoded.length < getTotal)
  const error = getError ?? headError
  const method = getRan ? (headStatus !== null ? "HEAD+GET" : "GET") : headStatus !== null ? "HEAD" : null
  return { status, contentType, bytes, sha256: sha, partial, method, error }
}

export async function verifyArtifact(input: VerifyArtifactInput): Promise<VerifyArtifactResult> {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const artifact = requireArtifact(sessionId, name)
  const { version, view } = resolvedVersion(artifact, normalizeVersion(input.version))
  const checkedAt = Date.now()

  // 约束：无 url = 没有探测结果 → no_row；不得写 verified_at，不得宣称干净。
  if (!view.url) {
    db().query("UPDATE artifact_versions SET verify_status='no_row', verified_at=NULL WHERE id=?").run(Number(version.id))
    return {
      state: "no_row",
      verify_status: "no_row",
      reason: "no_url",
      artifact_id: view.artifact_id,
      slug: view.slug,
      name: view.name,
      version: view.version,
      url: null,
      status: null,
      content_type: null,
      bytes: null,
      sha256: null,
      expected_sha256: view.sha256,
      sha256_match: null,
      method: null,
      partial: false,
      error: null,
      checked_at: checkedAt,
      verified_at: null,
    }
  }

  const probe = await probeUrl(view.url)
  const reachable = probe.status !== null && probe.status >= 200 && probe.status < 300
  const sha256Match = probe.sha256 !== null ? probe.sha256 === view.sha256 : null
  let state: VerifyState = "blocked"
  let reason: string | null = null
  if (!reachable) {
    // SSRF 拦截等安全拒绝必须原样上报，不能混成普通 unreachable。
    reason = probe.error === "private_address" || probe.error === "unsupported_url_scheme" || probe.error === "too_many_redirects" || probe.error === "dns_resolution_failed"
      ? probe.error
      : probe.status === null
        ? "unreachable"
        : "http_status"
  } else if (probe.partial) {
    reason = "body_partial"
  } else if (!probe.sha256) {
    reason = "sha256_unavailable"
  } else if (!sha256Match) {
    reason = "sha256_mismatch"
  } else {
    state = "verified"
  }
  // P2-5：只有 verified 才写 verified_at；blocked/no_row 一律 NULL。
  const verifiedAt = state === "verified" ? Date.now() : null
  db().query("UPDATE artifact_versions SET verify_status=?, verified_at=? WHERE id=?").run(state, verifiedAt, Number(version.id))
  return {
    state,
    verify_status: state,
    reason,
    artifact_id: view.artifact_id,
    slug: view.slug,
    name: view.name,
    version: view.version,
    url: view.url,
    status: probe.status,
    content_type: probe.contentType,
    bytes: probe.bytes,
    sha256: probe.sha256,
    expected_sha256: view.sha256,
    sha256_match: sha256Match,
    method: probe.method,
    partial: probe.partial,
    error: probe.error,
    checked_at: checkedAt,
    verified_at: verifiedAt,
  }
}

function safeAssetKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, MAX_ASSET_KEY_LENGTH)
  return cleaned || "asset"
}

function assetRowView(row: any): ArtifactAssetView {
  const local = localAssetPath(Number(row.artifact_id), String(row.sha256 ?? ""), String(row.asset_key ?? ""))
  return {
    id: Number(row.id),
    artifact_id: Number(row.artifact_id),
    asset_key: String(row.asset_key ?? ""),
    url: typeof row.url === "string" ? row.url : null,
    sha256: String(row.sha256 ?? ""),
    bytes: Number(row.bytes ?? 0),
    content_type: String(row.content_type ?? "application/octet-stream"),
    created_at: Number(row.created_at ?? 0),
    local_path: local,
    exists: Boolean(local && existsSync(local)),
  }
}

function localAssetPath(artifactId: number, sha256: string, assetKey: string): string | null {
  if (!artifactId || !sha256) return null
  return path.join(assetDir(artifactId), `${sha256.slice(0, 16)}-${safeAssetKey(assetKey)}`)
}

function writeAssetFile(artifactId: number, sha256: string, assetKey: string, bytes: Buffer): string {
  const dir = assetDir(artifactId)
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${sha256.slice(0, 16)}-${safeAssetKey(assetKey)}`)
  // 约束：内容寻址；同 sha 同 key 不重复写。
  if (!existsSync(target)) {
    try {
      writeFileSync(target, bytes, { flag: "wx" })
    } catch (e) {
      if ((e as { code?: string })?.code !== "EEXIST") throw e
    }
  }
  return target
}

function defaultAssetUrl(slug: string, assetKey: string, sha256: string): string {
  return `artifact://${slug}/assets/${encodeURIComponent(assetKey)}?sha256=${sha256}`
}

export function uploadAsset(input: UploadAssetInput): ArtifactAssetView {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const artifact = requireArtifact(sessionId, name)
  const file = readRegularFile(input.path)
  const key = safeAssetKey(optionalText(input.assetKey, "asset_key", MAX_ASSET_KEY_LENGTH) || path.basename(file.absolutePath))
  const contentType = contentTypeFor(file.absolutePath, optionalText(input.contentType, "content_type", 256))
  const url = optionalText(input.url, "url", MAX_URL_LENGTH) || defaultAssetUrl(String(artifact.slug), key, file.sha256)
  writeAssetFile(Number(artifact.id), file.sha256, key, file.bytes)
  const now = Date.now()
  // P1-4：唯一键 (artifact_id, asset_key)；upsert 保证并发同 key 只留一行。
  return withImmediate(() => {
    db()
      .query(
        `INSERT INTO artifact_assets(artifact_id,asset_key,url,sha256,bytes,content_type,created_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(artifact_id,asset_key) DO UPDATE SET
           url=excluded.url, sha256=excluded.sha256, bytes=excluded.bytes,
           content_type=excluded.content_type, created_at=excluded.created_at`,
      )
      .run(Number(artifact.id), key, url, file.sha256, file.size, contentType, now)
    const row = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(Number(artifact.id), key) as any
    return assetRowView(row)
  })
}

export function listAssets(sessionId: string, name: string): ArtifactAssetView[] {
  const artifact = requireArtifact(
    requiredText(sessionId, "session_id", MAX_NAME_LENGTH),
    requiredText(name, "name", MAX_NAME_LENGTH),
  )
  const rows = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? ORDER BY created_at,id").all(Number(artifact.id)) as any[]
  return rows.map(assetRowView)
}

export function readAsset(input: ReadAssetInput): ArtifactAssetView & { content_base64?: string } {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const artifact = requireArtifact(sessionId, name)
  const actor = resolveActor(input.actor, sessionId)
  // P1-2：读必须满足 owner/public/org/users ACL。
  requireReadAccess(artifact, actor)
  const assetId = input.assetId === undefined ? undefined : Number(input.assetId)
  const assetKey = optionalText(input.assetKey, "asset_key", MAX_ASSET_KEY_LENGTH)
  let row: any | null
  if (assetId !== undefined) {
    row = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND id=?").get(Number(artifact.id), assetId) as any
  } else if (assetKey) {
    row = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(Number(artifact.id), assetKey) as any
  } else {
    throw new ArtifactError("missing_asset_selector", "readAsset 需要 assetId 或 assetKey", 400)
  }
  if (!row) throw new ArtifactError("asset_not_found", "asset 不存在", 404)
  const view = assetRowView(row)
  if (input.includeData !== true) return view
  const file = view.local_path && existsSync(view.local_path) ? view.local_path : null
  if (!file) throw new ArtifactError("asset_bytes_missing", "asset 字节不在本地存储", 404)
  const content = readFileSync(file).toString("base64")
  // P2-8：include_data 响应上限 8MB base64。
  if (content.length > INCLUDE_DATA_MAX_BASE64_BYTES) {
    throw new ArtifactError(
      "include_data_too_large",
      `include_data 需要 ${content.length} 字节 base64，超过 ${INCLUDE_DATA_MAX_BASE64_BYTES} 上限`,
      413,
      { base64_bytes: content.length, limit: INCLUDE_DATA_MAX_BASE64_BYTES },
    )
  }
  return { ...view, content_base64: content }
}

export function copyAsset(input: CopyAssetInput): ArtifactAssetView {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const actor = resolveActor(input.actor, sessionId)
  const fromSessionId = optionalText(input.fromSessionId, "from_session_id", MAX_NAME_LENGTH) || sessionId
  const fromName = requiredText(input.fromName, "from_name", MAX_NAME_LENGTH)
  const dest = requireArtifact(sessionId, name)
  const source = requireArtifact(fromSessionId, fromName)
  // P1-2：源必须可读；目标必须归操作者（写权限不放给 ACL 读者）。
  requireReadAccess(source, actor)
  requireOwner(dest, actor, "写入该 artifact 的资产")
  let sourceRow: any | null
  if (input.fromAssetId !== undefined) {
    sourceRow = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND id=?").get(Number(source.id), Number(input.fromAssetId)) as any
  } else if (input.fromAssetKey) {
    sourceRow = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(
      Number(source.id),
      safeAssetKey(input.fromAssetKey),
    ) as any
  } else {
    throw new ArtifactError("missing_asset_selector", "copy_from 需要 fromAssetId 或 fromAssetKey", 400)
  }
  if (!sourceRow) throw new ArtifactError("asset_not_found", "源 asset 不存在", 404)

  const sourceView = assetRowView(sourceRow)
  if (!sourceView.local_path || !existsSync(sourceView.local_path)) {
    throw new ArtifactError("asset_bytes_missing", "源 asset 字节不在本地存储", 404)
  }
  const sourcePath: string = sourceView.local_path
  const desiredKey = safeAssetKey(optionalText(input.assetKey, "asset_key", MAX_ASSET_KEY_LENGTH) || sourceView.asset_key)
  return withImmediate(() => {
    let collision = db().query("SELECT id FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(Number(dest.id), desiredKey) as any
    let key = desiredKey
    for (let i = 2; collision && i < 1000; i += 1) {
      key = `${desiredKey}-copy${i}`
      collision = db().query("SELECT id FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(Number(dest.id), key) as any
    }
    // 约束：copy_from 必须产生新行；新 url 与源 url 不同。
    const targetDir = assetDir(Number(dest.id))
    mkdirSync(targetDir, { recursive: true })
    const targetFile = path.join(targetDir, `${sourceView.sha256.slice(0, 16)}-${key}`)
    copyFileSync(sourcePath, targetFile)
    const url = defaultAssetUrl(String(dest.slug), key, sourceView.sha256)
    const now = Date.now()
    db()
      .query(
        `INSERT INTO artifact_assets(artifact_id,asset_key,url,sha256,bytes,content_type,created_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(artifact_id,asset_key) DO UPDATE SET
           url=excluded.url, sha256=excluded.sha256, bytes=excluded.bytes,
           content_type=excluded.content_type, created_at=excluded.created_at`,
      )
      .run(Number(dest.id), key, url, sourceView.sha256, sourceView.bytes, sourceView.content_type, now)
    const row = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND asset_key=?").get(Number(dest.id), key) as any
    return assetRowView(row)
  })
}

// ── 删除（P3）──────────────────────────────────────────────────────────────
export interface DeleteResult {
  deleted: boolean
  artifact_id: number
  versions_removed: number
  assets_removed: number
}

export function deleteArtifact(input: DeleteArtifactInput): DeleteResult {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const actor = resolveActor(input.actor, sessionId)
  const artifact = requireArtifact(sessionId, name)
  requireOwner(artifact, actor, "删除该 artifact")
  const artifactId = Number(artifact.id)
  const outcome = withImmediate(() => {
    const assets = db().query("DELETE FROM artifact_assets WHERE artifact_id=?").run(artifactId)
    // 约束：artifact 删除必须级联 versions（无 FK，显式删除）。
    const versions = db().query("DELETE FROM artifact_versions WHERE artifact_id=?").run(artifactId)
    db().query("DELETE FROM artifacts WHERE id=?").run(artifactId)
    return { versions: Number(versions.changes ?? 0), assets: Number(assets.changes ?? 0) }
  })
  try {
    rmSync(assetDir(artifactId), { recursive: true, force: true })
  } catch {
    // 清理本地字节失败不回滚已提交的数据库删除。
  }
  return { deleted: true, artifact_id: artifactId, versions_removed: outcome.versions, assets_removed: outcome.assets }
}

export function deleteArtifactVersion(input: DeleteArtifactVersionInput): {
  deleted: boolean
  artifact_id: number
  version: number
  latest_version: number
} {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const actor = resolveActor(input.actor, sessionId)
  const wanted = normalizeVersion(input.version)
  if (wanted === undefined) throw new ArtifactError("invalid_version", "version 必填且必须是 ≥1 的整数", 400)
  const artifact = requireArtifact(sessionId, name)
  requireOwner(artifact, actor, "删除该版本")
  const row = versionRow(Number(artifact.id), wanted)
  if (!row) throw new ArtifactError("version_not_found", `版本不存在：${wanted}`, 404)
  return withImmediate(() => {
    db().query("DELETE FROM artifact_versions WHERE id=?").run(Number(row.id))
    const latest = db().query("SELECT MAX(version) AS latest FROM artifact_versions WHERE artifact_id=?").get(Number(artifact.id)) as any
    const latestVersion = latest?.latest === null || latest?.latest === undefined ? 0 : Number(latest.latest)
    db().query("UPDATE artifacts SET latest_version=?,updated_at=? WHERE id=?").run(latestVersion, Date.now(), Number(artifact.id))
    return { deleted: true, artifact_id: Number(artifact.id), version: wanted, latest_version: latestVersion }
  })
}
