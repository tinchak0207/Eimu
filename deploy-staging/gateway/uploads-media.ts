// uploads-media.ts — 附件上傳與檔名/類型/zip 安檢（自 index.ts 105-242 區逐行抽取，2026-09-19 Wave1）
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { ALLOWED_UPLOAD_EXTS, UPLOAD_MAX_BYTES, UPLOADS_DIR } from "./constants-gateway.ts"
import { jsonError } from "./gw-lib.ts"
import { getOwnedSession } from "./sessions-core.ts"
export function sanitizeUploadName(raw: string): string | null {
  const base = path.basename(raw).normalize("NFC")
  const safe = base.replace(/[^\w.\- ]/g, "_").replace(/_{2,}/g, "_").slice(0, 200)
  const ext = path.extname(safe).toLowerCase()
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) return null
  return safe
}

/** 附件靜態讀路由的 Content-Type 映射（按擴展名；未收錄一律 octet-stream）。 */
export function contentTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
  }
  return map[ext] ?? "application/octet-stream"
}

/** zip 內容安檢（紅隊加固 2026-08-22）：路徑穿越／絕對路徑／條目過多／解壓炸彈／嵌套 zip 一律拒。回 null=通過。 */
export function zipProbe(dest: string): string | null {
  const names = Bun.spawnSync(["unzip", "-Z1", dest], { stdout: "pipe", stderr: "ignore" })
  if (names.exitCode !== 0) return "invalid zip archive"
  const entries = names.stdout.toString().split("\n").filter((l) => l.length > 0)
  if (entries.length > 200) return `too many entries (${entries.length})`
  for (const e of entries) {
    if (e.startsWith("/") || e.includes("..") || e.includes("\\") || /^[a-zA-Z]:/.test(e)) return "unsafe entry path"
    if (e.toLowerCase().endsWith(".zip")) return "nested zip"
  }
  const sizes = Bun.spawnSync(["unzip", "-lv", dest], { stdout: "pipe", stderr: "ignore" })
  if (sizes.exitCode !== 0) return "invalid zip listing"
  let total = 0
  for (const line of sizes.stdout.toString().split("\n")) {
    const m = line.match(/^\s*(\d+)\s+\d+\s/)
    if (m) total += Number(m[1])
  }
  if (total > 32 * 1024 * 1024) return `uncompressed size too large (${Math.round(total / 1048576)}MB)`
  return null
}

export async function handleAttachmentUpload(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const ct = req.headers.get("content-type") || ""
  if (!ct.includes("multipart/form-data")) {
    return jsonError(400, "multipart/form-data required", "bad_request", "bad_request")
  }
  try {
    const form = await req.formData()
    const files = form.getAll("file") as File[]
    if (files.length === 0) return jsonError(400, "no file field", "bad_request", "bad_request")
    const uploadDir = path.join(UPLOADS_DIR, state.sessionId)
    await mkdir(uploadDir, { recursive: true })
    const results: { name: string; path: string; size: number }[] = []
    for (const file of files) {
      if (file.size > UPLOAD_MAX_BYTES) {
        return jsonError(413, "file exceeds 4MB limit", "payload_too_large", "payload_too_large")
      }
      const safeName = sanitizeUploadName(file.name)
      if (!safeName) {
        return jsonError(400, `disallowed file type: ${path.extname(file.name)}`, "bad_request", "bad_request")
      }
      const dest = path.join(uploadDir, safeName)
      if (!path.resolve(dest).startsWith(path.resolve(UPLOADS_DIR))) {
        return jsonError(400, "invalid path", "bad_request", "bad_request")
      }
      await Bun.write(dest, await file.arrayBuffer())
      if (safeName.toLowerCase().endsWith(".zip")) {
        const probe = zipProbe(dest)
        if (probe !== null) {
          await rm(dest, { force: true })
          return jsonError(400, `zip rejected: ${probe}`, "bad_request", "bad_request")
        }
      }
      results.push({ name: safeName, path: `uploads/${state.sessionId}/${safeName}`, size: file.size })
    }
    return Response.json({ attachments: results })
  } catch (e) {
    console.error("[gateway] upload error:", e)
    return jsonError(500, "upload failed", "server_error", "server_error")
  }
}
