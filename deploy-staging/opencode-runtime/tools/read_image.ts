import { tool } from "@opencode-ai/plugin/tool"
import {
  readImageSource,
  requireNewapiKey,
  resolveVisionModel,
  extractChatText,
  VISION_NEWAPI_CHAT_URL,
  VISION_TIMEOUT_MS,
  VisionToolError,
} from "../lib/vision_impl"
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
    "中性读图：读取一张图片（本地路径或公网 URL）并客观描述其内容（主体/场景/风格/色彩/光线/可见文字）。" +
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
      .describe("可选：针对这张图想知道的具体问题（如「背景是什么建筑风格」），附加在客观描述之后回答。"),
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
      const key = requireNewapiKey()
      const model = resolveVisionModel()
      const image = await readImageSource(imageUrl, imagePath)
      const base64 = Buffer.from(image.bytes).toString("base64")
      const prompt = args.question && args.question.trim() ? `${DESCRIBE_PROMPT}\n\n用户额外想知道：${args.question.trim()}` : DESCRIBE_PROMPT
      const payload = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${image.mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 2048,
      }
      const res = await fetch(VISION_NEWAPI_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: context.abort ?? AbortSignal.timeout(VISION_TIMEOUT_MS),
      })
      const bodyText = await res.text().catch(() => "")
      if (!res.ok) {
        return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "newapi_http_error", hint: `读图上游返回 HTTP ${res.status}（模型 ${model}）。` }, body: bodyText.slice(0, 500) }) }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyText)
      } catch {
        return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "newapi_parse_error", hint: "读图上游响应无法解析。" } }) }
      }
      const desc = extractChatText(parsed)
      if (!desc) {
        return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "empty_description", hint: "读图上游返回空描述。" } }) }
      }
      return { title: "读图完成", output: JSON.stringify({ ok: true, model, description: desc, duration_ms: Date.now() - t0 }) }
    } catch (e) {
      const hint = e instanceof VisionToolError ? e.message : e instanceof Error ? e.message : String(e)
      return { title: "读图失败", output: JSON.stringify({ ok: false, error: { code: "read_image_failed", hint } }) }
    }
  },
})
