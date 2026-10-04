// turn-image-parts.ts — 把本轮用户讯息尾端的 [ATTACHMENTS_BLOCK] 图片列转成
// opencode prompt 的 content block（part type="file"），让图直接进模型上下文。
// 对齐 Claude Code：图不是另一条消息，而是同一个 /prompt_async 请求里的 content block。
//
// opencode 1.18.14 吃 parts:[{type:"file",mime,filename,url}]，image/* 会转成 image_url
// 给 OpenAI-compatible 上游；url 必须是 `data:<mime>;base64,...`（其 Image.normalize 对
// 非 data: 直接失败）。缩放/压缩由 opencode 自己做（attachment.image），本模组不实作。
//
// 本模组不碰 network、不碰 session state，输入输出皆为纯资料，方便单测。
//
// 为何不共用 opencode-runtime/lib/vision_impl.ts 的 mime 判断：
//   ① gateway release 只打包 deploy-staging/gateway（见 memory harness-deploy-source-of-truth），
//      跨树 import opencode-runtime 会让 VPS release 目录找不到模组 → build/执行失败；
//   ② vision_impl 是按「副档名」猜 mime（IMAGE_MIME_BY_EXT），不是 magic-bytes 嗅探，
//      而本处要求「嗅探优先、清单 mime 后备」，语义不同。
//   故在此自写一个最小 magic-bytes 判断（只认 gateway 附件实际会出现的格式）。
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { UPLOADS_DIR } from "./constants-gateway.ts"

/** 单轮最多附几张图（超出即 skip，不抛错）。 */
export const MAX_TURN_IMAGES = 4
/** 单张原档大小上限（bytes）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 单轮合计大小上限（bytes）。 */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024

export type TurnImagePart = { type: "file"; mime: string; filename: string; url: string }
export type SkippedImage = { path: string; reason: string }
export type TurnImagePartsResult = { parts: TurnImagePart[]; skipped: SkippedImage[] }

/** content block 型别：文字 part 或档案 part（本模组只产档案的 image/*）。 */
export type PromptPartInput = { type: string; text?: string; mime?: string; filename?: string; url?: string }

/** 从档案 bytes 嗅探图片 mime；认不得回 null（呼叫方以清单 mime 后备）。 */
function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif"
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp"
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp"
  return null
}

type ImageRow = { path: string; mime: string }
const EMPTY: TurnImagePartsResult = { parts: [], skipped: [] }

/** 解析 [ATTACHMENTS_BLOCK]：容忍行首 `N. ` 编号、`|` 分隔、前后空白；认不出回 []（绝不抛错）。 */
function parseImageRows(content: string): ImageRow[] {
  if (typeof content !== "string" || content.length === 0) return []
  const block = /\[ATTACHMENTS_BLOCK\]([\s\S]*?)\[\/ATTACHMENTS_BLOCK\]/.exec(content)
  if (!block) return []
  const rows: ImageRow[] = []
  for (const rawLine of block[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // path | mime | size 三段；行首可有 `1. `（或 `1)`）编号。
    const m = /^(?:\d+[.)]\s*)?(.*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*$/.exec(line)
    if (!m) continue
    const p = m[1].trim()
    const mime = m[2].trim().toLowerCase()
    if (!p) continue
    if (!mime.startsWith("image/")) continue // 只取图片列；其余（pdf/影片等）直接忽略
    rows.push({ path: p, mime })
  }
  return rows
}

/**
 * 建本轮的图片 parts。
 *
 * @param opts.sessionId  会话 id（安全闸：path 必须落在 <uploadsRoot>/<sessionId>/ 内）
 * @param opts.content    本轮用户讯息全文（含 [ATTACHMENTS_BLOCK]）
 * @param opts.vision     该轮模型是否支援图像输入；false 时不读档、不产 base64，
 *                        只把图片列以 reason=model_no_vision 回报（供接线端注入诚实提示）
 * @param opts.uploadsRoot 上传根目录；预设 UPLOADS_DIR（仅单测注入 tmp 目录时覆写）
 */
export async function buildTurnImageParts(opts: {
  sessionId: string
  content: string
  vision: boolean
  uploadsRoot?: string
}): Promise<TurnImagePartsResult> {
  const rows = parseImageRows(opts.content)
  if (rows.length === 0) return EMPTY
  // 非视觉模型：不附图，但如实回报有哪些图片（给诚实提示用），零档案 IO。
  if (!opts.vision) return { parts: [], skipped: rows.map((r) => ({ path: r.path, reason: "model_no_vision" })) }

  const uploadsRoot = path.resolve(opts.uploadsRoot ?? UPLOADS_DIR)
  let sessionRoot: string
  try {
    sessionRoot = realpathSync(path.join(uploadsRoot, opts.sessionId))
  } catch {
    sessionRoot = path.resolve(path.join(uploadsRoot, opts.sessionId))
  }

  const parts: TurnImagePart[] = []
  const skipped: SkippedImage[] = []
  let totalBytes = 0
  for (const row of rows) {
    if (parts.length >= MAX_TURN_IMAGES) {
      skipped.push({ path: row.path, reason: "over_image_limit" })
      continue
    }
    // 安全闸：文字清单是使用者可控资料，必须证明档案真的落在本会话的上传目录。
    // 解析路径（容忍 `uploads/<sid>/<name>` 与裸档名两种写法），realpath 后比对前缀。
    const rel = row.path.replace(/^\.?[\\/]+/, "").replace(/^uploads[\\/]/, "")
    const candidate = path.resolve(uploadsRoot, rel)
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      skipped.push({ path: row.path, reason: "file_not_found" })
      continue
    }
    if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) {
      skipped.push({ path: row.path, reason: "outside_session_uploads" })
      continue
    }
    let size: number
    try {
      size = statSync(real).size
    } catch {
      skipped.push({ path: row.path, reason: "file_not_found" })
      continue
    }
    if (size > MAX_IMAGE_BYTES) {
      skipped.push({ path: row.path, reason: "image_too_large" })
      continue
    }
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      skipped.push({ path: row.path, reason: "total_too_large" })
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(real)
    } catch {
      skipped.push({ path: row.path, reason: "file_not_found" })
      continue
    }
    const mime = sniffImageMime(bytes) ?? row.mime
    totalBytes += bytes.length
    parts.push({
      type: "file",
      mime,
      filename: path.basename(real),
      url: `data:${mime};base64,${bytes.toString("base64")}`,
    })
  }
  return { parts, skipped }
}
