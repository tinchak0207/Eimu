import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ArtifactError, DEFAULT_WORKSPACE, MAX_ASSET_KEY_LENGTH } from "./artifact-store-types.ts"
function stateDir(): string {
  return process.env.ARTIFACT_STORE_DIR || path.join(path.dirname(process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db"), "artifacts")
}

export function assetDir(artifactId: number): string {
  return path.join(stateDir(), "assets", String(artifactId))
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

export function assertUploadPathAllowed(absolutePath: string): void {
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
export function safeAssetKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  const base = cleaned.slice(0, MAX_ASSET_KEY_LENGTH)
  // P2-12：归一化会把 `A/B` 与 `A B` 都变成 `A_B`；只有发生归一化/截断时加哈希后缀，
  // 保证不同原始键不撞同一行（已经是安全字符的键保持原样，兼容既有资产）。
  if (cleaned && cleaned === raw && cleaned.length <= MAX_ASSET_KEY_LENGTH) return cleaned
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8)
  const room = Math.max(1, MAX_ASSET_KEY_LENGTH - digest.length - 1)
  return `${(base || "asset").slice(0, room)}-${digest}`
}
export function localAssetPath(artifactId: number, sha256: string, assetKey: string): string | null {
  if (!artifactId || !sha256) return null
  return path.join(assetDir(artifactId), `${sha256.slice(0, 16)}-${safeAssetKey(assetKey)}`)
}

export function writeAssetFile(artifactId: number, sha256: string, assetKey: string, bytes: Buffer): string {
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

export function defaultAssetUrl(slug: string, assetKey: string, sha256: string): string {
  return `artifact://${slug}/assets/${encodeURIComponent(assetKey)}?sha256=${sha256}`
}
