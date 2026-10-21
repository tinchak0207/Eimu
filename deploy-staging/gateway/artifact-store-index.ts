import { Database } from "bun:sqlite"
import { ArtifactError, type AclMode, type ArtifactVersionView } from "./artifact-store-types.ts"
let connection: Database | undefined
export function db(): Database {
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
    version_epoch INTEGER NOT NULL DEFAULT 0,
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
    verify_epoch INTEGER NOT NULL DEFAULT 0,
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
  // 验证目标原地变化（含 A→B→A）必须递增 epoch，旧探测不能覆盖新引用。
  const versionColumns = next.query("PRAGMA table_info(artifact_versions)").all() as Array<{ name: string }>
  if (!versionColumns.some((column) => column.name === "verify_epoch")) {
    next.exec("ALTER TABLE artifact_versions ADD COLUMN verify_epoch INTEGER NOT NULL DEFAULT 0")
  }
  // P2-11：版本号单调 epoch。旧库没有该栏；ALTER 失败（已存在）不阻断。
  try {
    next.exec("ALTER TABLE artifacts ADD COLUMN version_epoch INTEGER NOT NULL DEFAULT 0")
  } catch {
    // 栏位已存在。
  }
  try {
    // 旧库回填：epoch 取当前存在过的最大版本，避免删除最新版后复用同一版本号。
    next.exec(`UPDATE artifacts SET version_epoch = (
      SELECT COALESCE(MAX(version), 0) FROM artifact_versions WHERE artifact_id = artifacts.id
    ) WHERE version_epoch = 0`)
  } catch {
    // 回填失败不阻断 store 启动；发布路径仍会取 max(latest, epoch)+1。
  }
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

export function withImmediate<T>(fn: () => T): T {
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
function parseAcl(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function rowView(artifact: any, version: any): ArtifactVersionView {
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

export function artifactRow(sessionId: string, name: string): any | null {
  return (db().query("SELECT * FROM artifacts WHERE session_id=? AND name=?").get(sessionId, name) as any) ?? null
}

export function versionRow(artifactId: number, version: number): any | null {
  return (db().query("SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?").get(artifactId, version) as any) ?? null
}

export function requireArtifact(sessionId: string, name: string): any {
  const row = artifactRow(sessionId, name)
  if (!row) throw new ArtifactError("artifact_not_found", `artifact 不存在：${name}`, 404)
  return row
}

export function resolvedVersion(artifact: any, version?: number): { artifact: any; version: any; view: ArtifactVersionView } {
  const wanted = version !== undefined ? version : Number(artifact.latest_version)
  const row = versionRow(Number(artifact.id), wanted)
  if (!row) throw new ArtifactError("version_not_found", `版本不存在：${wanted}`, 404)
  return { artifact, version: row, view: rowView(artifact, row) }
}

// ── 身份 / ACL（P1-2）───────────────────────────────────────────────────────
// P1 身份修复：actor **只**由 sessionId 推导。外部传入的 actor/requesterKey 一律忽略，
// 否则知道 session_id 的人可在 body 里换一个 actor 跨会话操作。
export function resolveActor(_actor: string | undefined, fallback: string): string {
  return fallback
}

/** P2-13：URL 只接受 http/https（javascript:/data: 等一律 400）。 */
export function assertHttpUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ArtifactError("invalid_url", `URL 无法解析：${value}`, 400)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ArtifactError(
      "unsupported_url_scheme",
      `只允许 http/https URL，收到 ${parsed.protocol}`,
      400,
      { scheme: parsed.protocol },
    )
  }
  return value
}

function aclUsers(artifact: any): string[] {
  const json = parseAcl(artifact.acl_json)
  const raw = Array.isArray(json.users) ? json.users : []
  return raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
}

export function sameIdentity(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/**
 * P2-10：可读判据 = owner 或 users 白名单。公共/组织共享没有真实租户概念，
 * 一律视为 owner-only（旧 public/org 行降级为 private，不再对所有人开放）。
 */
export function canReadArtifact(artifact: any, actor: string): boolean {
  const owner = String(artifact.owner_key ?? "")
  // owner 是密钥类不透明身份：精确匹配；users 名单按大小写不敏感匹配。
  if (owner !== "" && owner === actor) return true
  const mode = String(artifact.acl_mode ?? "owner")
  if (mode === "users") return aclUsers(artifact).some((user) => sameIdentity(user, actor))
  return false
}

export function requireReadAccess(artifact: any, actor: string): void {
  if (!canReadArtifact(artifact, actor)) {
    throw new ArtifactError("forbidden", "没有读取该 artifact 的权限", 403, { reason: "acl_denied" })
  }
}

export function requireOwner(artifact: any, actor: string, action: string): void {
  if (String(artifact.owner_key ?? "") !== actor) {
    throw new ArtifactError("not_owner", `只有 owner 能${action}`, 403, { reason: "not_owner" })
  }
}

/**
 * 用户存在性校验（P2-7）：复用本仓库既有身份表（sessions/user_settings），
 * 也承认当前 artifact owner（同进程内已登记过的身份）。查不到 → false（调用方回 400）。
 */
export function userExists(value: string): boolean {
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
