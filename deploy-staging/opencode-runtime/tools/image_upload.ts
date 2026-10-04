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
      const { mediaId, url: platformUrl } = await uploadImageBytes(args.image_url, context.sessionID, context.abort)
      // 平台 /v1/uploads 只回 mediaId（不回公網 url）——本地/工作區路徑再複用
      // publicImageUrl（網關 /internal/media/upload，與 image_edit 同一輪子）換出公網 URL；
      // http(s)/data 來源本身即是可用地址，原樣回傳，不做多餘上傳。
      const url =
        platformUrl && /^https?:\/\//i.test(platformUrl)
          ? platformUrl
          : await publicImageUrl(args.image_url, context.sessionID, context.abort)
      return ok({ title: "上傳完成", media_id: mediaId, url })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "上傳失敗" })
    }
  },
})
