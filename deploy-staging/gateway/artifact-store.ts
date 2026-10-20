// Artifact 交付物存储：版本化、ACL、真实性探测、资产表。
// 约束：单事务写版本；文件读取失败整笔拒绝；16MiB 上限（对齐 Kf=16777216）。
// 约束：verify 没有探测结果时只能报 no_row，不得宣称干净。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { assetDir, defaultAssetUrl, localAssetPath, safeAssetKey, writeAssetFile } from "./artifact-store-paths.ts"
import { contentTypeFor, expectedContentTypeForUrl, normalizeAssetId, normalizeExpectedVersion, normalizeVersion, optionalText, probeUrl, readRegularFile, requiredText, slugFor } from "./artifact-store-io.ts"
import { assertHttpUrl, artifactRow, canReadArtifact, db, requireArtifact, requireOwner, requireReadAccess, resolveActor, resolvedVersion, rowView, sameIdentity, userExists, versionRow, withImmediate } from "./artifact-store-index.ts"
import { INCLUDE_DATA_MAX_BASE64_BYTES, MAX_ASSET_KEY_LENGTH, MAX_NAME_LENGTH, MAX_URL_LENGTH, ArtifactConflictError, ArtifactError, type AclAccess, type AclMode, type ArtifactAssetView, type ArtifactListScope, type ArtifactVersionView, type CopyAssetInput, type DeleteArtifactInput, type DeleteArtifactVersionInput, type PublishArtifactInput, type PublishArtifactResult, type ReadAssetInput, type RegisterArtifactInput, type SetAclInput, type UploadAssetInput, type VerifyArtifactInput, type VerifyArtifactResult, type VerifyState } from "./artifact-store-types.ts"
export function getArtifact(sessionId: string, name: string, version?: number, actor?: string): ArtifactVersionView | null {
  const sid = requiredText(sessionId, "session_id", MAX_NAME_LENGTH)
  const artifactName = requiredText(name, "name", MAX_NAME_LENGTH)
  const artifact = artifactRow(sid, artifactName)
  if (!artifact) return null
  // P1：可读性由 ACL 决定；跨会话非共享读取 → 403（不再仅凭知道 session_id 就放行）。
  requireReadAccess(artifact, resolveActor(actor, sid))
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
    // 先全取，再按 ACL 过滤：旧查询把 acl_mode<>'owner' 当共享，会把 users 名单外的人
    // 也算作可读（P1 泄漏）。真正可读性只由 canReadArtifact 判定。
    rows = db().query(`${base} WHERE a.session_id <> ? ORDER BY a.updated_at DESC`).all(sid) as any[]
  } else if (scope === "all") {
    rows = db().query(`${base} ORDER BY a.updated_at DESC`).all() as any[]
  } else if (scope === "mine") {
    rows = db().query(`${base} WHERE a.session_id = ? ORDER BY a.updated_at DESC`).all(sid) as any[]
  } else {
    throw new ArtifactError("invalid_scope", "scope 只接受 mine/shared/all")
  }
  const out: ArtifactVersionView[] = []
  for (const row of rows) {
    if (row.v_version === null) continue
    const own = String(row.session_id ?? "") === sid
    if (scope === "mine" && !own) continue
    if (!own && !canReadArtifact(row, sid)) continue
    const view = rowView(row, {
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
    })
    if (!own) {
      // P1：shared/all 只返回可读条目；非 owner 的条目脱敏 url/sha/name（及 path/owner_key）。
      out.push({ ...view, owner_key: "", name: "", slug: "", url: null, path: null, sha256: "" })
    } else {
      out.push(view)
    }
  }
  return out
}

export function publishArtifact(input: PublishArtifactInput): PublishArtifactResult {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  // P1：owner 只由 session_id 推导；body 里的 owner_key 一律忽略。
  const ownerKey = sessionId
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  // 约束：文件在进入事务前完整读取并校验；失败不得留下半条版本。
  const file = readRegularFile(input.path)
  const contentType = contentTypeFor(file.absolutePath, optionalText(input.contentType, "content_type", 256))
  const rawUrl = optionalText(input.url, "url", MAX_URL_LENGTH)
  const url = rawUrl ? assertHttpUrl(rawUrl) : null
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
          `INSERT INTO artifacts(session_id,owner_key,name,slug,latest_version,version_epoch,acl_mode,acl_json,pinned,created_at,updated_at)
           VALUES(?,?,?,?,1,1,'owner','{}',0,?,?)`,
        )
        .run(sessionId, ownerKey, name, slugFor(sessionId, name), now, now)
      const artifactId = Number(inserted.lastInsertRowid)
      db()
        .query(
          `INSERT INTO artifact_versions(artifact_id,version,url,path,sha256,bytes,content_type,producer,verified_at,verify_status,created_at)
           VALUES(?,?,?,?,?,?,?,?,NULL,'unverified',?)`,
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
      const nextUrl = url ?? (typeof live.url === "string" ? live.url : null)
      const nextPath = file.absolutePath
      const nextType = contentType
      const nextProducer = producer ?? (typeof live.producer === "string" ? live.producer : null)
      // P1：URL/path/content_type/producer 任一变化 → 旧的 verify 结论失效，必须重置。
      const metadataChanged =
        nextUrl !== (typeof live.url === "string" ? live.url : null) ||
        nextPath !== (typeof live.path === "string" ? live.path : null) ||
        nextType !== String(live.content_type ?? "") ||
        nextProducer !== (typeof live.producer === "string" ? live.producer : null)
      if (metadataChanged) {
        db()
          .query(
            "UPDATE artifact_versions SET url=?,path=?,content_type=?,producer=?,verify_epoch=verify_epoch+1,verify_status='unverified',verified_at=NULL WHERE id=?",
          )
          .run(nextUrl, nextPath, nextType, nextProducer, Number(live.id))
      } else {
        db()
          .query("UPDATE artifact_versions SET url=?,path=?,content_type=?,producer=? WHERE id=?")
          .run(nextUrl, nextPath, nextType, nextProducer, Number(live.id))
      }
      db().query("UPDATE artifacts SET updated_at=? WHERE id=?").run(now, Number(existing.id))
      const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(existing.id)) as any
      const updatedLive = versionRow(Number(existing.id), liveVersion)
      const view = rowView(artifact, updatedLive)
      return { ...view, readBack: view, changed: true }
    }

    // P2-11：版本号单调——删除最新版后不得复用同号；epoch 记录历史最大版本。
    const epoch = Number(existing.version_epoch ?? 0)
    const nextVersion = Math.max(liveVersion, Number.isFinite(epoch) ? epoch : 0) + 1
    // P1-3：owner_key 只由创建时决定，后续版本更新不得改写。
    db()
      .query("UPDATE artifacts SET latest_version=?,version_epoch=?,updated_at=? WHERE id=?")
      .run(nextVersion, nextVersion, now, Number(existing.id))
    db()
      .query(
        `INSERT INTO artifact_versions(artifact_id,version,url,path,sha256,bytes,content_type,producer,verified_at,verify_status,created_at)
         VALUES(?,?,?,?,?,?,?,?,NULL,'unverified',?)`,
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
    // P2-10：本仓库没有 org/租户成员表，无法证明「同组织」。拒绝而不是把 org 当所有人。
    throw new ArtifactError(
      "org_unsupported",
      "当前没有组织/租户概念，mode=org 无法安全实现；请用 mode=users 指定成员，或 mode=private",
      400,
    )
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
    throw new ArtifactError("invalid_acl_mode", "mode 只接受 private/people/users", 400)
  }
  const now = Date.now()
  db().query("UPDATE artifacts SET acl_mode=?,acl_json=?,updated_at=? WHERE id=?").run(aclMode, JSON.stringify(aclJson), now, Number(artifact.id))
  const updated = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(artifact.id)) as any
  const live = versionRow(Number(updated.id), Number(updated.latest_version))
  return rowView(updated, live)
}
export async function verifyArtifact(input: VerifyArtifactInput): Promise<VerifyArtifactResult> {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const artifact = requireArtifact(sessionId, name)
  const { version, view } = resolvedVersion(artifact, normalizeVersion(input.version))
  const checkedAt = Date.now()
  const verifyEpoch = Number(version.verify_epoch ?? 0)

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
  const storedSha = typeof view.sha256 === "string" ? view.sha256.trim() : ""
  // P1-5：URL-only 登记（sha 为空）没有可比对的期望值；verify 成功后回填实测 sha。
  const sha256Match = storedSha === "" ? null : probe.sha256 !== null ? probe.sha256 === storedSha : null
  const expectedType = expectedContentTypeForUrl(view.url)
  const observedType = (probe.contentType ?? "").split(";")[0].trim().toLowerCase()
  const typeMismatch =
    reachable &&
    expectedType !== null &&
    observedType !== "" &&
    observedType !== "application/octet-stream" &&
    observedType !== expectedType
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
  } else if ((probe.bytes ?? 0) <= 0 && input.allowEmpty !== true) {
    // P2-6：0 字节 / 204 不是“干净证据”；必须显式 allow_empty。
    reason = "empty_body"
  } else if (typeMismatch) {
    reason = "content_type_mismatch"
  } else if (!probe.sha256) {
    reason = "sha256_unavailable"
  } else if (storedSha === "") {
    // 登记行：把实测 sha/bytes 回填，之后才有可复核的期望值。
    state = "verified"
  } else if (!sha256Match) {
    reason = "sha256_mismatch"
  } else {
    state = "verified"
  }
  // P2-5：只有 verified 才写 verified_at；blocked/no_row 一律 NULL。
  const verifiedAt = state === "verified" ? Date.now() : null
  // CAS 同时绑定 epoch 与探测快照；并发元数据变更、删除或另一验证回填均使旧结果失效。
  const targetMatch = "id=? AND verify_epoch=? AND url IS ? AND path IS ? AND sha256 IS ? AND bytes IS ? AND content_type IS ? AND producer IS ?"
  const targetParams = [Number(version.id), verifyEpoch, version.url, version.path, version.sha256, version.bytes, version.content_type, version.producer]
  const applied = state === "verified" && storedSha === "" && probe.sha256
    ? db().query(`UPDATE artifact_versions SET sha256=?,bytes=?,verify_status=?,verified_at=? WHERE ${targetMatch}`)
        .run(probe.sha256, probe.bytes ?? 0, state, verifiedAt, ...targetParams)
    : db().query(`UPDATE artifact_versions SET verify_status=?,verified_at=? WHERE ${targetMatch}`)
        .run(state, verifiedAt, ...targetParams)
  if (applied.changes === 0) {
    throw new ArtifactError("verification_target_changed", "验证期间交付物引用已变化，请重新验证当前版本", 409)
  }
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
    expected_sha256: storedSha || (probe.sha256 ?? ""),
    sha256_match: sha256Match,
    method: probe.method,
    partial: probe.partial,
    error: probe.error,
    checked_at: checkedAt,
    verified_at: verifiedAt,
  }
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
export function uploadAsset(input: UploadAssetInput): ArtifactAssetView {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const actor = resolveActor(input.actor, sessionId)
  const artifact = requireArtifact(sessionId, name)
  // P2-8：写资产必须 owner；跨会话一律 403（与 copy_from 的目标端同口径）。
  requireOwner(artifact, actor, "写入该 artifact 的资产")
  const file = readRegularFile(input.path)
  const key = safeAssetKey(optionalText(input.assetKey, "asset_key", MAX_ASSET_KEY_LENGTH) || path.basename(file.absolutePath))
  const contentType = contentTypeFor(file.absolutePath, optionalText(input.contentType, "content_type", 256))
  const rawUrl = optionalText(input.url, "url", MAX_URL_LENGTH)
  const url = rawUrl ? assertHttpUrl(rawUrl) : defaultAssetUrl(String(artifact.slug), key, file.sha256)
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

export function listAssets(sessionId: string, name: string, actor?: string): ArtifactAssetView[] {
  const sid = requiredText(sessionId, "session_id", MAX_NAME_LENGTH)
  const artifact = requireArtifact(sid, requiredText(name, "name", MAX_NAME_LENGTH))
  // P2-8：与 upload/copy 同口径——只有 owner 能列资产，跨会话 403。
  requireOwner(artifact, resolveActor(actor, sid), "列出该 artifact 的资产")
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
  const assetId = normalizeAssetId(input.assetId)
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
  const fromAssetId = normalizeAssetId(input.fromAssetId)
  if (fromAssetId !== undefined) {
    sourceRow = db().query("SELECT * FROM artifact_assets WHERE artifact_id=? AND id=?").get(Number(source.id), fromAssetId) as any
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

/**
 * P1-5/P3-15：只登记元数据，不发布版本。
 * - artifact 不存在 → 建 artifact + version 1（sha256 为空，bytes=0；verify 成功后回填）。
 * - 已存在（owner 才可）→ 不升版本；仅当现有 live 行本身也是未哈希的登记行时原地更新
 *   元数据并重置 verify；已发布（有 sha）的行一律不碰，交由 artifact_publish 升版。
 */
export function registerArtifact(input: RegisterArtifactInput): ArtifactVersionView & { changed: boolean } {
  const sessionId = requiredText(input.sessionId, "session_id", MAX_NAME_LENGTH)
  const name = requiredText(input.name, "name", MAX_NAME_LENGTH)
  const rawUrl = optionalText(input.url, "url", MAX_URL_LENGTH)
  const url = rawUrl ? assertHttpUrl(rawUrl) : null
  const rawPath = optionalText(input.path, "path", MAX_URL_LENGTH)
  const localPath = rawPath ? path.resolve(rawPath) : null
  if (!url && !localPath) throw new ArtifactError("missing_uri", "register 需要 url 或 path", 400)
  const contentType = contentTypeFor(url ?? localPath ?? "", optionalText(input.contentType, "content_type", 256))
  const producer = optionalText(input.producer, "producer", MAX_NAME_LENGTH) || "artifact_register"
  const now = Date.now()

  return withImmediate(() => {
    const existing = artifactRow(sessionId, name)
    if (!existing) {
      const inserted = db()
        .query(
          `INSERT INTO artifacts(session_id,owner_key,name,slug,latest_version,version_epoch,acl_mode,acl_json,pinned,created_at,updated_at)
           VALUES(?,?,?,?,1,1,'owner','{}',0,?,?)`,
        )
        .run(sessionId, sessionId, name, slugFor(sessionId, name), now, now)
      const artifactId = Number(inserted.lastInsertRowid)
      db()
        .query(
          `INSERT INTO artifact_versions(artifact_id,version,url,path,sha256,bytes,content_type,producer,verified_at,verify_status,created_at)
           VALUES(?,?,?,?,?,0,?,?,NULL,'unverified',?)`,
        )
        .run(artifactId, 1, url, localPath, "", contentType, producer, now)
      const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(artifactId) as any
      return { ...rowView(artifact, versionRow(artifactId, 1)), changed: true }
    }
    // P1：登记同样只有 owner 能做；跨会话 403。
    requireOwner(existing, sessionId, "登记该 artifact")
    const liveVersion = Number(existing.latest_version)
    const live = versionRow(Number(existing.id), liveVersion)
    if (!live) {
      throw new ArtifactError("no_live_version", "artifact 没有可登记的 live 版本；请用 artifact_publish 创建", 409)
    }
    // 已发布（有真实 sha）的行不得被登记静默改写或升版。
    if (String(live.sha256 ?? "").trim() !== "") {
      return { ...rowView(existing, live), changed: false }
    }
    const metadataChanged =
      (url ?? null) !== (typeof live.url === "string" ? live.url : null) ||
      (localPath ?? null) !== (typeof live.path === "string" ? live.path : null) ||
      contentType !== String(live.content_type ?? "") ||
      producer !== (typeof live.producer === "string" ? live.producer : producer)
    if (metadataChanged) {
      db()
        .query(
          "UPDATE artifact_versions SET url=?,path=?,content_type=?,producer=?,verify_epoch=verify_epoch+1,verify_status='unverified',verified_at=NULL WHERE id=?",
        )
        .run(url, localPath, contentType, producer, Number(live.id))
      db().query("UPDATE artifacts SET updated_at=? WHERE id=?").run(now, Number(existing.id))
    }
    const artifact = db().query("SELECT * FROM artifacts WHERE id=?").get(Number(existing.id)) as any
    return { ...rowView(artifact, versionRow(Number(existing.id), liveVersion)), changed: metadataChanged }
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
export { ARTIFACT_MAX_BYTES, ArtifactConflictError, ArtifactError, artifactVerifyMaxBytes } from "./artifact-store-types.ts"
export type { AclAccess, AclMode, ArtifactAssetView, ArtifactListScope, ArtifactVersionView, CopyAssetInput, DeleteArtifactInput, DeleteArtifactVersionInput, PublishArtifactInput, PublishArtifactResult, ReadAssetInput, RegisterArtifactInput, SetAclInput, UploadAssetInput, VerifyArtifactInput, VerifyArtifactResult, VerifyState } from "./artifact-store-types.ts"
export { artifactLocalEvidenceMatches, assertPublicHost, resolvePublicHost } from "./artifact-store-io.ts"
