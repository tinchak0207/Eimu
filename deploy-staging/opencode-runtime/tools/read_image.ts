import { tool } from "@opencode-ai/plugin/tool"
import { readImageSource, VisionToolError } from "../lib/vision_impl"
import { checkAgentPath } from "../lib/sandbox"

// 原生「中性讀圖」工具（2026-09-29 審計修復）。
//
// 背景：舊路徑是 agent 走 bash 跑 skills/read-image/read_image.py，該腳本要 NEWAPI_API_KEY
// ＋外網。審計把 agent 的 bash/run_py 關進無秘密、無網路的沙箱後，那條 bash 路徑必然失效
// （這正是防秘密外洩與 SSRF 的代價）。讀圖是常用能力，故上移為原生工具：跑在受信的
// opencode 進程（有 env、有網），只經 new-api 中控通路（同 vision_analyze，暴君鐵律禁直連）。
//
// 與 vision_analyze 的分工：vision_analyze 是「毒蛇評審」（打分＋逐維點評），本工具是
// 「中性描述」（客觀說出畫面裡有什麼、風格/色彩/文字），對應舊 read-image 的職責。
//
// 路徑閘：只允許本會話可見範圍（uploads/<本會話 uuid>、workspace 內產物、/tmp）；
// 讀圖前用 checkAgentPath 驗，擋跨租戶與系統路徑。公網 URL 亦可（下載在受信進程內）。

const DESCRIBE_PROMPT =
  "请客观描述这张图片，用简洁中文：\n" +
  "1. 主体与场景：画面里有什么（人物/物体/环境/动作），布局与构图。\n" +
  "2. 风格与媒介：写实/插画/3D/摄影等，艺术风格取向。\n" +
  "3. 色彩与光线：主色调、光线方向与氛围。\n" +
  "4. 可见文字：如实抄录画面中的文字（无则说无）。\n" +
  "只描述能看到的事实，不臆测、不评分、不夸饰。"

export default tool({
  description:
    "读图：把一张图片的原图（本地路径或公网 URL）直接交给当前模型查看，一步完成——原图以附件形式进入你的上下文，你自己看画面内容（主体/场景/风格/色彩/光线/可见文字）。" +
    "用户上传图片、问「这张图里有什么/描述这张图/是什么风格」等看图需求用它，一步完成。" +
    "只接受图片文件（png/jpeg/webp/gif/bmp/avif/heic），音频/视频会被人话报错。" +
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
      if (image.bytes.byteLength > 20 * 1024 * 1024) {
        return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "image_too_large", hint: "图片超过 20MB，请先用 image_upscale 之外的方式压缩或改用 vision_analyze。" } }) }
      }
      const ext = image.mime.slice(image.mime.indexOf("/") + 1).replace(/[^a-z0-9]/gi, "") || "png"
      const filename = imagePath ? imagePath.split(/[\\/]/).pop() || `image.${ext}` : `image.${ext}`
      const label = imagePath ? filename : imageUrl!.startsWith("data:") ? `${image.mime} 数据` : imageUrl!.slice(0, 80)
      const question = args.question && args.question.trim() ? args.question.trim() : undefined
      const base64 = Buffer.from(image.bytes).toString("base64")
      return {
        title: `读图：${label}`,
        output: JSON.stringify({
          ok: true,
          attached: true,
          mime: image.mime,
          bytes: image.bytes.byteLength,
          bytes_approx: `${(image.bytes.byteLength / 1024 / 1024).toFixed(2)} MB`,
          note: "原图已随本次工具结果附上，请直接查看图像内容后作答。",
          duration_ms: Date.now() - t0,
          ...(question ? { user_focus: question } : {}),
        }),
        attachments: [{ type: "file", mime: image.mime, filename, url: `data:${image.mime};base64,${base64}` }],
      }
    } catch (e) {
      const hint = e instanceof VisionToolError ? e.message : e instanceof Error ? e.message : String(e)
      return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "read_image_failed", hint } }) }
    }
  },
})
