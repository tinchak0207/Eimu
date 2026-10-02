// turn-image-parts.ts — 把本輪用戶訊息尾端的 [ATTACHMENTS_BLOCK] 圖片列轉成
// opencode prompt 的 content block（part type="file"），讓圖直接進模型上下文。
// 對齊 Claude Code：圖不是另一條消息，而是同一個 /prompt_async 請求裡的 content block。
//
// opencode 1.18.14 吃 parts:[{type:"file",mime,filename,url}]，image/* 會轉成 image_url
// 給 OpenAI-compatible 上游；url 必須是 `data:<mime>;base64,...`（其 Image.normalize 對
// 非 data: 直接失敗）。縮放/壓縮由 opencode 自己做（attachment.image），本模組不實作。
//
// 本模組不碰 network、不碰 session state，輸入輸出皆為純資料，方便單測。
//
// 為何不共用 opencode-runtime/lib/vision_impl.ts 的 mime 判斷：
//   ① gateway release 只打包 deploy-staging/gateway（見 memory harness-deploy-source-of-truth），
//      跨樹 import opencode-runtime 會讓 VPS release 目錄找不到模組 → build/執行失敗；
//   ② vision_impl 是按「副檔名」猜 mime（IMAGE_MIME_BY_EXT），不是 magic-bytes 嗅探，
//      而本處要求「嗅探優先、清單 mime 後備」，語義不同。
//   故在此自寫一個最小 magic-bytes 判斷（只認 gateway 附件實際會出現的格式）。
import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { UPLOADS_DIR } from "./constants-gateway.ts"

/** 單輪最多附幾張圖（超出即 skip，不拋錯）。 */
export const MAX_TURN_IMAGES = 4
/** 單張原檔大小上限（bytes）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 單輪合計大小上限（bytes）。 */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024

export type TurnImagePart = { type: "file"; mime: string; filename: string; url: string }
export type SkippedImage = { path: string; reason: string }
export type TurnImagePartsResult = { parts: TurnImagePart[]; skipped: SkippedImage[] }

/** content block 型別：文字 part 或檔案 part（本模組只產檔案的 image/*）。 */
export type PromptPartInput = { type: string; text?: string; mime?: string; filename?: string; url?: string }

/** 從檔案 bytes 嗅探圖片 mime；認不得回 null（呼叫方以清單 mime 後備）。 */
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

/** 解析 [ATTACHMENTS_BLOCK]：容忍行首 `N. ` 編號、`|` 分隔、前後空白；認不出回 []（絕不拋錯）。 */
function parseImageRows(content: string): ImageRow[] {
  if (typeof content !== "string" || content.length === 0) return []
  const block = /\[ATTACHMENTS_BLOCK\]([\s\S]*?)\[\/ATTACHMENTS_BLOCK\]/.exec(content)
  if (!block) return []
  const rows: ImageRow[] = []
  for (const rawLine of block[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // path | mime | size 三段；行首可有 `1. `（或 `1)`）編號。
    const m = /^(?:\d+[.)]\s*)?(.*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*$/.exec(line)
    if (!m) continue
    const p = m[1].trim()
    const mime = m[2].trim().toLowerCase()
    if (!p) continue
    if (!mime.startsWith("image/")) continue // 只取圖片列；其餘（pdf/影片等）直接忽略
    rows.push({ path: p, mime })
  }
  return rows
}

/**
 * 建本輪的圖片 parts。
 *
 * @param opts.sessionId  會話 id（安全閘：path 必須落在 <uploadsRoot>/<sessionId>/ 內）
 * @param opts.content    本輪用戶訊息全文（含 [ATTACHMENTS_BLOCK]）
 * @param opts.vision     該輪模型是否支援圖像輸入；false 時不讀檔、不產 base64，
 *                        只把圖片列以 reason=model_no_vision 回報（供接線端注入誠實提示）
 * @param opts.uploadsRoot 上傳根目錄；預設 UPLOADS_DIR（僅單測注入 tmp 目錄時覆寫）
 */
export async function buildTurnImageParts(opts: {
  sessionId: string
  content: string
  vision: boolean
  uploadsRoot?: string
}): Promise<TurnImagePartsResult> {
  const rows = parseImageRows(opts.content)
  if (rows.length === 0) return EMPTY
  // 非視覺模型：不附圖，但如實回報有哪些圖片（給誠實提示用），零檔案 IO。
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
    // 安全閘：文字清單是使用者可控資料，必須證明檔案真的落在本會話的上傳目錄。
    // 解析路徑（容忍 `uploads/<sid>/<name>` 與裸檔名兩種寫法），realpath 後比對前綴。
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
