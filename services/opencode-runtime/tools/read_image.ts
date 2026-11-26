import { tool } from "@opencode-ai/plugin/tool"
import { readImageSource, VisionToolError } from "../lib/vision_impl"
import { checkAgentPath } from "../lib/sandbox"
import { fitImageForContext } from "../lib/fit-image-context"

function imageTooLarge(hint: string) {
  return {
    title: "读图失败",
    output: JSON.stringify({ ok: false, error: { code: "image_too_large", hint } }),
  }
}

// 原生「中性读图」工具：把原图交给当前模型自己看。
//
// 图以 attachments 形式随工具结果进当前模型自己的上下文（多模态模型直接看；无视觉模型由
// gateway 端诚实告知不支援）。
// 与 vision_analyze 的分工：vision_analyze 是「毒蛇评审」（打分＋逐维点评），本工具只负责
// 把原图带进上下文。
//
// 路径闸：只允许本会话可见范围（uploads/<本会话 uuid>、workspace 内产物、/tmp）；
// 读图前用 checkAgentPath 验，挡跨租户与系统路径。注意 owner 集合由 plugin 的
// ensureSession 从 gateway 水合（PATH_TOOLS 必须列本工具，否则此闸拿空集合一律拒）。
// 公网 URL 亦可（下载在受信进程内）。

export default tool({
  description:
    "读图：把一张图片的原图（本地路径或公网 URL）直接交给当前模型查看，一步完成——原图以附件形式进入你的上下文，你自己看画面内容（主体/场景/风格/色彩/光线/可见文字）。" +
    "用户上传图片、问「这张图里有什么/描述这张图/是什么风格」等看图需求用它，一步完成。" +
    "只接受图片文件（png/jpeg/webp/gif/bmp/avif/heic），音频/视频会被人话报错。超过约 1MB 会自动压成 JPEG 再看，不会因为体积拒绝。" +
    "要对图片打分/审美点评用 vision_analyze；要反推可生图的提示词另走反推 skill。",
  args: {
    image_path: tool.schema
      .string()
      .optional()
      .describe("图片本地路径（与 image_url 二选一），如 uploads/<session>/a.png。只能是本会话可见的文件。"),
    image_url: tool.schema
      .string()
      .optional()
      .describe("图片公网 URL（与 image_path 二选一）。"),
    question: tool.schema
      .string()
      .optional()
      .describe("可选：针对这张图你关注的要点（如「背景是什么建筑风格」），会作为 user_focus 写进返回文字，提醒你重点看画面哪里。"),
  },
  async execute(args, context) {
    const t0 = Date.now()
    const imagePath = typeof args.image_path === "string" && args.image_path.trim() ? args.image_path.trim() : undefined
    const imageUrl = typeof args.image_url === "string" && args.image_url.trim() ? args.image_url.trim() : undefined
    if (!imagePath && !imageUrl) {
      return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "invalid_args", hint: "缺少图片来源：image_path 或 image_url 二选一必填。" } }) }
    }
    if (imagePath && imageUrl) {
      return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "invalid_args", hint: "image_path 与 image_url 只能二选一。" } }) }
    }
    if (imagePath) {
      const verdict = checkAgentPath(imagePath, context.sessionID)
      if (!verdict.ok) {
        return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "path_denied", hint: "该图片不在当前会话可访问的范围内（只能读本会话的附件与产物）。" } }) }
      }
    }
    try {
      const image = await readImageSource(imageUrl, imagePath)
      let bytes: Uint8Array = image.bytes
      let mime = image.mime
      let shrunk = false
      try {
        const fitted = await fitImageForContext({ bytes, mime })
        bytes = fitted.bytes
        mime = fitted.mime
        shrunk = fitted.shrunk
      } catch (error) {
        const hint = error instanceof Error ? error.message : String(error)
        return imageTooLarge(hint)
      }
      const ext = mime.slice(mime.indexOf("/") + 1).replace(/[^a-z0-9]/gi, "") || "png"
      const filename = shrunk
        ? `image.${ext}`
        : imagePath
          ? imagePath.split(/[\\/]/).pop() || `image.${ext}`
          : `image.${ext}`
      const label = imagePath ? (imagePath.split(/[\\/]/).pop() || filename) : imageUrl!.startsWith("data:") ? `${mime} 数据` : imageUrl!.slice(0, 80)
      const question = args.question && args.question.trim() ? args.question.trim() : undefined
      const base64 = Buffer.from(bytes).toString("base64")
      return {
        title: `读图：${label}`,
        output: JSON.stringify({
          ok: true,
          attached: true,
          mime,
          bytes: bytes.byteLength,
          bytes_approx: `${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`,
          shrunk,
          note: shrunk
            ? "原图超过上下文上限，已压成 JPEG 附上。请直接查看图像内容后作答。"
            : "原图已随本次工具结果附上，请直接查看图像内容后作答。",
          duration_ms: Date.now() - t0,
          ...(question ? { user_focus: question } : {}),
        }),
        attachments: [{ type: "file", mime, filename, url: `data:${mime};base64,${base64}` }],
      }
    } catch (e) {
      const hint = e instanceof VisionToolError ? e.message : e instanceof Error ? e.message : String(e)
      return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "read_image_failed", hint } }) }
    }
  },
})
