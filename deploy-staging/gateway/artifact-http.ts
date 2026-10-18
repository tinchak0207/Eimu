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

function numberValue(body: Body, field: string): number | undefined {
  const value = body[field]
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
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
 * P1-2：actor 从 body.actor 或 X-Session-Id 取，默认 session_id。
 * （内部路由只由 loopback 闸门保护，此处是身份归属而非第二套鉴权。）
 */
function actorOf(req: Request, body: Body, sessionId: string): string {
  const fromBody = typeof body.actor === "string" ? body.actor.trim() : ""
  if (fromBody) return fromBody
  const fromHeader = (req.headers.get("x-session-id") || "").trim()
  if (fromHeader) return fromHeader
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
    const body = await readBody(req)
    const route = pathname.replace(/^\/internal\/artifact\/?/, "").replace(/\/+$/, "")
    const sessionId = requireSession(body)

    if (route === "publish") {
      const name = text(body, "name")
      const filePath = text(body, "path")
      if (!name || !filePath) return responseError("missing_required_args", "name 与 path 必填", 400)
      const result = publishArtifact({
        sessionId,
        ownerKey: text(body, "owner_key"),
        name,
        path: filePath,
        url: text(body, "url"),
        contentType: text(body, "content_type"),
        producer: text(body, "producer"),
        expectedVersion: strictExpectedVersion(body),
      })
      return Response.json({ ok: true, ...result, artifact: result })
    }

    if (route === "get") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const artifact = getArtifact(sessionId, name, numberValue(body, "version"))
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
      const result = await verifyArtifact({ sessionId, name, version: numberValue(body, "version") })
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
      if (mode !== "org" && mode !== "people" && mode !== "users" && mode !== "private") {
        return responseError("invalid_acl_mode", "mode 只接受 private/org/people/users", 400)
      }
      const access = text(body, "access")
      if (access !== undefined && access !== "view" && access !== "comment") {
        return responseError("invalid_access", "access 只接受 view/comment", 400)
      }
      const people = Array.isArray(body.people) ? body.people.filter((p): p is string => typeof p === "string") : undefined
      const artifact = setAcl({
        sessionId,
        name,
        actor: actorOf(req, body, sessionId),
        requesterKey: text(body, "requester_key"),
        mode: mode as "org" | "people" | "users" | "private",
        access: access as AclAccess | undefined,
        people,
      })
      return Response.json({ ok: true, artifact })
    }

    if (route === "delete") {
      const name = text(body, "name")
      if (!name) return responseError("missing_required_args", "name 必填", 400)
      const result = deleteArtifact({ sessionId, name, actor: actorOf(req, body, sessionId) })
      return Response.json({ ok: true, ...result })
    }

    if (route === "delete_version") {
      const name = text(body, "name")
      const version = numberValue(body, "version")
      if (!name || version === undefined) return responseError("missing_required_args", "name 与 version 必填", 400)
      const result = deleteArtifactVersion({ sessionId, name, version, actor: actorOf(req, body, sessionId) })
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
          path: filePath,
          url: text(body, "url"),
          contentType: text(body, "content_type"),
          assetKey: text(body, "asset_key"),
        })
        return Response.json({ ok: true, asset })
      }

      if (action === "list") {
        const assets = listAssets(sessionId, name)
        return Response.json({ ok: true, count: assets.length, assets })
      }

      if (action === "read") {
        const asset = readAsset({
          sessionId,
          name,
          actor: actorOf(req, body, sessionId),
          assetId: numberValue(body, "asset_id"),
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
          actor: actorOf(req, body, sessionId),
          fromSessionId: text(body, "from_session_id"),
          fromName,
          fromAssetId: numberValue(body, "from_asset_id"),
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
