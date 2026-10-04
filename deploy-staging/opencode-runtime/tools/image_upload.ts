import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, ok, fail, publicImageUrl, uploadImageBytes } from "../lib/client"
import { LOCAL_PATH_HINT } from "../lib/agent-paths"

export default tool({
  description:
    "上傳圖片取得 mediaId 與可直接使用的公網 URL（通常由 edit/upscale 內部調用，免費不扣費）。來源支援 http(s)/data URL 或本地絕對路徑（聊天附件解析出的 uploads 路徑直接可傳，工具與附件同機）。本地/工作區路徑會上傳到平台存儲，回傳的 url 即為公網地址，可直接餵給 image_generate 的 reference_images 或 image_edit 的 image_url，不必再猜 URL。",
  args: {
    image_url: tool.schema
      .string()
      .describe(`圖片 URL 或本地絕對路徑，將讀取/下載後上傳，回傳 mediaId 與公網 URL。${LOCAL_PATH_HINT}`),
  },
  async execute(args, context) {
    try {
      // mediaId 來自平台 /v1/uploads（best-effort）：它只保證回 mediaId，不保證回公網 url，
      // 且該上游端點可能暫時故障（實測 HTTP 502）。任一種都不得讓「取得公網 URL」失敗。
      let mediaId: string | null = null
      let platformUrl: string | null = null
      let mediaErr: string | null = null
      try {
        const r = await uploadImageBytes(args.image_url, context.sessionID, context.abort)
        mediaId = r.mediaId || null
        platformUrl = r.url
      } catch (e: any) {
        mediaErr = e?.message || String(e)
      }
      // 公網 URL 一律以 publicImageUrl 兜底（與 image_edit 同一輪子：本地/工作區路徑讀位元組 →
      // 網關 /internal/media/upload → 公網 URL；http(s)/data 來源原樣放行）。平台 /uploads
      // 不回 url 或直接故障時，這條仍能給出可直接餵給 reference_images / image_url 的地址。
      const url =
        platformUrl && /^https?:\/\//i.test(platformUrl)
          ? platformUrl
          : await publicImageUrl(args.image_url, context.sessionID, context.abort)
      return ok({
        title: "上傳完成",
        media_id: mediaId,
        url,
        ...(mediaErr
          ? { note: `平台 /uploads 未回可用位址（${mediaErr}），已改用网关上传播取公网 URL。` }
          : {}),
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "上傳失敗" })
    }
  },
})
