export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
// 入库字节上限仍是 16MiB；verify 只读取远端字节做流式哈希，影音成品可远超 16MiB。
const DEFAULT_VERIFY_MAX_BYTES = 256 * 1024 * 1024
export function artifactVerifyMaxBytes(): number {
  const raw = process.env.ARTIFACT_VERIFY_MAX_BYTES
  if (!raw) return DEFAULT_VERIFY_MAX_BYTES
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_VERIFY_MAX_BYTES
  return Math.floor(n)
}
export const MAX_NAME_LENGTH = 256
export const MAX_SLUG_LENGTH = 96
export const MAX_ASSET_KEY_LENGTH = 128
export const MAX_URL_LENGTH = 4096
// 约束：verify 总预算 20s = HEAD 6s + GET 12s（每跳 redirect 重新校验并共享该预算）。
export const PROBE_HEAD_TIMEOUT_MS = 6_000
export const PROBE_GET_TIMEOUT_MS = 12_000
export const MAX_PROBE_REDIRECTS = 5
// include_data 响应上限：8MB base64（小于 16MiB 文件本身，避免单次回包撑爆 agent 上下文）。
export const INCLUDE_DATA_MAX_BASE64_BYTES = 8 * 1024 * 1024
export const DEFAULT_WORKSPACE = "/opt/agent-harness/workspace"

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
  /** 已废弃：owner 一律由 sessionId 推导，忽略调用方传入值（P1 身份修复）。 */
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
  /** P2-6：0 字节 / 204 默认 blocked；显式 allow_empty=true 才允许。 */
  allowEmpty?: boolean
}

/** P1/P3：只登记元数据（不产生新版本、不隐式 publish）。 */
export interface RegisterArtifactInput {
  sessionId: string
  name: string
  url?: string
  path?: string
  contentType?: string
  producer?: string
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
  /** 操作者身份；store 层一律取 sessionId（忽略外部传入）。 */
  actor?: string
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
