import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, ok, fail, uploadImageBytes } from "../lib/client"

export default tool({
  description:
    "上傳圖片取得 mediaId（通常由 edit/upscale 內部調用，免費不扣費）。來源支援 http(s)/data URL 或本地絕對路徑（聊天附件解析出的 uploads 路徑直接可傳，工具與附件同機）。",
  args: {
    image_url: tool.schema
      .string()
      .describe("圖片 URL 或本地絕對路徑，將讀取/下載後上傳，回傳 mediaId"),
  },
  async execute(args, context) {
    try {
      const { mediaId, url } = await uploadImageBytes(args.image_url, context.sessionID, context.abort)
      return ok({ title: "上傳完成", media_id: mediaId, url })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "上傳失敗" })
    }
  },
})
