// S20 接线 2：export 产物公网化（设计文档 §3.9「交付只认 export 产物」的最后一跳）。
//
// 复用现有公网面，不造新通道：media-internal-routes.ts:143 的
//   /opt/image-data-api/data/uploads  ←→  https://store.tinchak0207.xyz/image-data/files/uploads
// 同机共享目录（网关容器与控制面挂同一份 uploads），直接文件复制即可；不走 HTTP 上传。
//
// 文件落盘惯例与同仓一致：先写 `.tmp-<pid>-<rand>` 再 rename（原子可见）。
// 发布失败绝不抛：ENOENT/EACCES/ENOTDIR 等一律返回 {url:null, reason}，
// 调用方（executors/export.ts）继续交付，只把 reason 记进 meta.publishError。
import { randomBytes } from "node:crypto"
import { copyFile, mkdir, rename, stat } from "node:fs/promises"
import path from "node:path"

/** 公网 uploads 目录缺省值（与 media-internal-routes.ts:143 同一目录）。 */
export const DEFAULT_PUBLIC_UPLOADS_DIR = "/opt/image-data-api/data/uploads"
/** 公网基础 URL 缺省值（与 media-internal-routes.ts:152 同一公网面）。 */
export const DEFAULT_PUBLIC_BASE_URL = "https://store.tinchak0207.xyz/image-data/files/uploads"

/** 产物扩展名由 mime 决定；未知 mime 用 .bin。 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "application/json": ".json",
}

export function extForMime(mime: string): string {
  return EXT_BY_MIME[String(mime ?? "").toLowerCase()] ?? ".bin"
}

export interface PublishRef {
  sessionId: string
  artifactId: string
  mime: string
}

export type PublishResult = { url: string } | { url: null; reason: string }

/** 判别式辅助：url===null ⇒ 失败分支（带 reason）。 */
export function isPublishFailure(r: PublishResult): r is { url: null; reason: string } {
  return r.url === null
}

/** 公网文件名：project-<sessionId 前 8 位去非法字符>-<artifactId>.<ext>。确定性 ⇒ 同产物同 URL。 */
export function publicFileName(ref: PublishRef): string {
  const sid = String(ref.sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "session"
  const art = String(ref.artifactId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96) || "artifact"
  return `project-${sid}-${art}${extForMime(ref.mime)}`
}

function uploadsDir(): string {
  const dir = process.env.PROJECT_PUBLIC_UPLOADS_DIR
  return dir && dir.trim() ? dir : DEFAULT_PUBLIC_UPLOADS_DIR
}

function publicBaseUrl(): string {
  const base = process.env.PROJECT_PUBLIC_BASE_URL
  return (base && base.trim() ? base : DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "")
}

/**
 * 把 artifact-store 里的一份产物复制进公网 uploads 目录，返回可播放/下载的 URL。
 * 幂等：文件名由 artifactId（内容寻址）决定，目标已在就复用同一 URL，不重复复制。
 */
export async function publishProjectArtifact(srcPath: string, ref: PublishRef): Promise<PublishResult> {
  const dir = uploadsDir()
  const fileName = publicFileName(ref)
  const finalPath = path.join(dir, fileName)
  const url = `${publicBaseUrl()}/${fileName}`
  try {
    // 源文件不可读（ENOENT/EACCES…）在这里就失败，不留下半份公网文件。
    const src = await stat(srcPath)
    if (!src.isFile()) return { url: null, reason: `源产物不是常规文件：${srcPath}`.slice(0, 200) }
    const already = await stat(finalPath).then((s) => s.isFile()).catch(() => false)
    if (already) return { url }
    await mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`)
    await copyFile(srcPath, tmp)
    await rename(tmp, finalPath)
    return { url }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    const reason = `${err?.code ?? "error"}: ${err?.message ?? String(e)}`.slice(0, 200)
    return { url: null, reason }
  }
}
