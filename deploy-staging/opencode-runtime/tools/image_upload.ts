import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, ok, fail, publicImageUrl, uploadImageBytes } from "../lib/client"
import { LOCAL_PATH_HINT } from "../lib/agent-paths"

export default tool({
  description:
    "上传图片取得 mediaId 与可直接使用的公网 URL（通常由 edit/upscale 内部调用，免费不扣费）。来源支援 http(s)/data URL 或本地绝对路径（聊天附件解析出的 uploads 路径直接可传，工具与附件同机）。本地/工作区路径会上传到平台存储，回传的 url 即为公网地址，可直接喂给 image_generate 的 reference_images 或 image_edit 的 image_url，不必再猜 URL。",
  args: {
    image_url: tool.schema
      .string()
      .describe(`图片 URL 或本地绝对路径，将读取/下载后上传，回传 mediaId 与公网 URL。${LOCAL_PATH_HINT}`),
  },
  async execute(args, context) {
    try {
      // mediaId 来自平台 /v1/uploads（best-effort）：它只保证回 mediaId，不保证回公网 url，
      // 且该上游端点可能暂时故障（实测 HTTP 502）。任一种都不得让「取得公网 URL」失败。
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
      // 公网 URL 一律以 publicImageUrl 兜底（与 image_edit 同一轮子：本地/工作区路径读位元组 →
      // 网关 /internal/media/upload → 公网 URL；http(s)/data 来源原样放行）。平台 /uploads
      // 不回 url 或直接故障时，这条仍能给出可直接喂给 reference_images / image_url 的地址。
      const url =
        platformUrl && /^https?:\/\//i.test(platformUrl)
          ? platformUrl
          : await publicImageUrl(args.image_url, context.sessionID, context.abort)
      return ok({
        title: "上传完成",
        media_id: mediaId,
        url,
        ...(mediaErr
          ? { note: `平台 /uploads 未回可用位址（${mediaErr}），已改用网关上传播取公网 URL。` }
          : {}),
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "上传失败" })
    }
  },
})
