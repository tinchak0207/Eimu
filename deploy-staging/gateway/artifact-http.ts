// Artifact HTTP 面：POST /internal/artifact/{publish|get|list|verify|acl|assets}
// 约束：与既有 /internal/* 同构，只由 router 的 loopback 闸门保护；本档不二次鉴权。
// 约束：所有失败必须回 JSON + 明确 code；不得把内部异常泄漏成 HTML。
import {
  ArtifactConflictError,
  ArtifactError,
  copyAsset,
  deleteArtifact,
  deleteArtifactVersion,
  getArtifact,
  listArtifacts,
  listAssets,
  publishArtifact,
  readAsset,
  registerArtifact,
  setAcl,
  uploadAsset,
  verifyArtifact,
  type AclAccess,
  type ArtifactListScope,
} from "./artifact-store.ts"

type Body = Record<string, unknown>

function responseError(code: string, error: string, status: number, detail: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, code, error, ...detail }, { status })
}

function text(body: Body, field: string): string | undefined {
  const value = body[field]
  return typeof value === "string" ? value : undefined
}

/** P2-9：version 严格校验——`"abc"`/浮点/布尔 → 400，绝不静默回退 latest。 */
function strictVersion(body: Body): number | undefined {
  const value = body["version"]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ArtifactError("invalid_version", "version 必须是 ≥1 的整数", 400)
  }
  return value
}

/** P2-9：asset_id/from_asset_id 严格校验。 */
function strictAssetId(body: Body, field: string): number | undefined {
  const value = body[field]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ArtifactError(`invalid_${field}`, `${field} 必须是 ≥1 的整数`, 400)
  }
  return value
}

/** P2-7：expected_version 严格 number 校验（boolean/array/NaN/Infinity/字符串 → 400）。 */
function strictExpectedVersion(body: Body): number | undefined {
  const value = body["expected_version"]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ArtifactError(
      "invalid_expected_version",
      "expected_version 必须是 ≥0 的有限整数（不接受字符串/布尔/数组/NaN/Infinity）",
      400,
    )
  }
  return value
}

/**
 * P1 身份修复：actor **只**由 session_id 推导，body.actor / X-Session-Id 不再作为身份。
 * 若调用方显式给出不同的 actor 或 X-Session-Id，视为跨会话操作 → 403。
 * HARNESS_INTERNAL_TOKEN 设置时，所有 artifact HTTP 入口额外校验 X-Internal-Token。
 */
function assertInternalToken(req: Request): void {
  const expected = process.env.HARNESS_INTERNAL_TOKEN
  if (typeof expected !== "string" || !expected) return
  const supplied = req.headers.get("x-internal-token") ?? ""
  if (supplied !== expected) {
    throw new ArtifactError("unauthorized", "X-Internal-Token 缺失或不匹配", 403)
  }
}

function actorOf(req: Request, body: Body, sessionId: string): string {
  const fromBody = typeof body.actor === "string" ? body.actor.trim() : ""
  if (fromBody && fromBody !== sessionId) {
    throw new ArtifactError("cross_session_forbidden", "actor 必须等于 session_id，禁止跨会话操作", 403)
  }
  const fromHeader = (req.headers.get("x-session-id") || "").trim()
  if (fromHeader && fromHeader !== sessionId) {
    throw new ArtifactError("cross_session_forbidden", "X-Session-Id 必须等于 session_id，禁止跨会话操作", 403)
  }
  return sessionId
}

function boolValue(body: Body, field: string): boolean | undefined {
  const value = body[field]
  return typeof value === "boolean" ? value : undefined
}

function requireSession(body: Body): string {
  const sessionId = text(body, "session_id")
  if (!sessionId || !sessionId.trim()) throw new ArtifactError("missing_session_id", "session_id 必填", 400)
  return sessionId.trim()
}

async function readBody(req: Request): Promise<Body> {
  if (req.method !== "POST") throw new ArtifactError("method_not_allowed", "只接受 POST", 405)
  const parsed: unknown = await req.json().catch(() => null)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactError("invalid_json", "body 必须是 JSON 对象", 400)
  }
  return parsed as Body
}

export async function handleArtifact(req: Request, pathname: string): Promise<Response> {
  try {
    assertInternalToken(req)
    const body = await readBody(req)
    const route = pathname.replace(/^\/internal\/artifact\/?/, "").replace(/\/+$/, "")
    const sessionId = requireSession(body)
    // P1：所有入口先固定 actor=session_id；显式跨会话字段一律 403。
    const actor = actorOf(req, body, sessionId)

    if (route === "publish") {
      const name = text(body, "name")
      const filePath = text(body, "path")
      if (!name || !filePath) return responseError("missing_required_args", "name 与 path 必填", 400)
      const bodyOwner = typeof body.owner_key === "string" ? body.owner_key.trim() : ""
      if (bodyOwner && bodyOwner !== sessionId) {
        throw new ArtifactError("cross_session_forbidden", "owner_key 必须等于 session_id，禁止跨会话发布", 403)
      }
      const result = publishArtifact({
        sessionId,
        name,
        path: filePath,
        url: text(body, "url"),
        contentType: text(body, "content_type"),
        producer: text(body, "producer"),
        expectedVersion: strictExpectedVersion(body),
      })
      return Response.json({ ok: true, ...result, artifact: result })
    }

    if (route === "register") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const result = registerArtifact({
        sessionId,
        name,
        url: text(body, "url"),
        path: text(body, "path"),
        contentType: text(body, "content_type"),
        producer: text(body, "producer"),
      })
      return Response.json({ ok: true, ...result, artifact: result })
    }

    if (route === "get") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const artifact = getArtifact(sessionId, name, strictVersion(body), actor)
      if (!artifact) return responseError("artifact_not_found", `artifact 不存在：${name}`, 404)
      return Response.json({ ok: true, artifact })
    }

    if (route === "list") {
      const rawScope = text(body, "scope") || "mine"
      if (rawScope !== "mine" && rawScope !== "shared" && rawScope !== "all") {
        return responseError("invalid_scope", "scope 只接受 mine/shared/all", 400)
      }
      const artifacts = listArtifacts(sessionId, rawScope as ArtifactListScope)
      return Response.json({ ok: true, count: artifacts.length, artifacts })
    }

    if (route === "verify") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const result = await verifyArtifact({
        sessionId,
        name,
        version: strictVersion(body),
        allowEmpty: boolValue(body, "allow_empty") === true,
      })
      // P2-5：blocked/no_row 一律 ok:false + 非 2xx（工具层已 fail，这里统一）。
      if (result.state !== "verified") {
        const code = result.state === "no_row" ? "verify_no_row" : "verify_blocked"
        const error =
          result.state === "no_row"
            ? "没有探测结果（artifact 无 url），不能宣称干净"
            : `探测未通过：${result.reason ?? "unknown"}（status=${result.status ?? "none"}）`
        return Response.json({ ok: false, code, error, ...result, verify: result }, { status: result.state === "no_row" ? 409 : 422 })
      }
      return Response.json({ ok: true, ...result, verify: result })
    }

    if (route === "acl") {
      const name = text(body, "name")
      const mode = text(body, "mode")
      if (!name || !mode) return responseError("missing_required_args", "name 与 mode 必填", 400)
      if (mode !== "people" && mode !== "users" && mode !== "private") {
        return responseError("invalid_acl_mode", "mode 只接受 private/people/users（没有 org/租户概念）", 400)
      }
      const access = text(body, "access")
      if (access !== undefined && access !== "view" && access !== "comment") {
        return responseError("invalid_access", "access 只接受 view/comment", 400)
      }
      const people = Array.isArray(body.people) ? body.people.filter((p): p is string => typeof p === "string") : undefined
      const artifact = setAcl({
        sessionId,
        name,
        actor,
        mode: mode as "people" | "users" | "private",
        access: access as AclAccess | undefined,
        people,
      })
      return Response.json({ ok: true, artifact })
    }

    if (route === "delete") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const result = deleteArtifact({ sessionId, name, actor })
      return Response.json({ ok: true, ...result })
    }

    if (route === "delete_version") {
      const name = text(body, "name")
      const version = strictVersion(body)
      if (!name || version === undefined) return responseError("missing_required_args", "name 与 version 必填", 400)
      const result = deleteArtifactVersion({ sessionId, name, version, actor })
      return Response.json({ ok: true, ...result })
    }

    if (route === "assets") {
      const action = text(body, "action")
      const name = text(body, "name")
      if (!action || !name) return responseError("missing_required_args", "action 与 name 必填", 400)

      if (action === "upload") {
        const filePath = text(body, "path")
        if (!filePath) return responseError("missing_required_args", "action=upload 时 path 必填", 400)
        const asset = uploadAsset({
          sessionId,
          name,
          actor,
          path: filePath,
          url: text(body, "url"),
          contentType: text(body, "content_type"),
          assetKey: text(body, "asset_key"),
        })
        return Response.json({ ok: true, asset })
      }

      if (action === "list") {
        const assets = listAssets(sessionId, name, actor)
        return Response.json({ ok: true, count: assets.length, assets })
      }

      if (action === "read") {
        const asset = readAsset({
          sessionId,
          name,
          actor,
          assetId: strictAssetId(body, "asset_id"),
          assetKey: text(body, "asset_key"),
          includeData: boolValue(body, "include_data"),
        })
        return Response.json({ ok: true, asset })
      }

      if (action === "copy_from") {
        const fromName = text(body, "from_name")
        if (!fromName) return responseError("missing_required_args", "action=copy_from 时 from_name 必填", 400)
        const asset = copyAsset({
          sessionId,
          name,
          actor,
          fromSessionId: text(body, "from_session_id"),
          fromName,
          fromAssetId: strictAssetId(body, "from_asset_id"),
          fromAssetKey: text(body, "from_asset_key"),
          assetKey: text(body, "asset_key"),
        })
        return Response.json({ ok: true, asset })
      }

      return responseError("invalid_action", "assets.action 只接受 upload/list/read/copy_from", 400)
    }

    return responseError("unknown_artifact_route", `未知 artifact 路由：${pathname}`, 404)
  } catch (e) {
    if (e instanceof ArtifactConflictError) {
      return responseError(e.code, e.message, e.status, e.detail)
    }
    if (e instanceof ArtifactError) {
      return responseError(e.code, e.message, e.status, e.detail)
    }
    console.error("[gateway] artifact endpoint error:", e)
    return responseError("internal_error", e instanceof Error ? e.message : String(e), 500)
  }
}
