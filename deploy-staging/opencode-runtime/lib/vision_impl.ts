/**
 * vision_analyze harness 工具 VPS staging 稿（beast-army R2→R2c，2026-09-10 機械導出）。
 *
 * 本檔由 tools/export-vision-tools-staging.ts 從行為真源 src/lib/vision-tools.ts
 * 機械導出：真源全文逐行保留（工具定義/ok-fail/讀圖白名單/new-api 中控通路/
 * 錯誤鐵律/60s 超時全在），零本地依賴（僅 node:fs/promises 內建模組），
 * 除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 `npx tsx tools/export-vision-tools-staging.ts` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/vision_impl.ts
 * env：NEWAPI_API_KEY（Bearer 鑑權，VPS /opt/image-control-plane/.env.control-plane
 * 已有同名對，harness 側同步注入）；NEWAPI_VISION_MODEL 可選覆蓋（默認
 * gemini-3-flash）。通路唯一 = new-api 中控 {NEWAPI_BASE_URL}/chat/completions
 * （暴君鐵律 vision-must-route-newapi-not-direct，R2c 起直連雙通路已刪）。
 * 薄入口：/opt/agent-harness/workspace/.opencode/tools/vision_analyze.ts
 */

/**
 * vision_analyze harness 工具（野獸模式多毒蛇評審的眼睛，beast-army R2→R2c，2026-09-10）。
 *
 * 定義形狀同構 src/lib/music-tools.ts 的 MusicToolDef（零依賴：
 * { id, description, args, execute } + ok()/fail() 契約，回 { title, output }，
 * output 為 JSON 字串）。
 *
 * 模型通路（R2c 遷移，暴君鐵律「模型調用禁直連必走 new-api」記憶
 * vision-must-route-newapi-not-direct）：唯一通路 = new-api 中控端點
 * POST {NEWAPI_BASE_URL}/chat/completions（OpenAI chat 形狀），Bearer 鑑權
 * env NEWAPI_API_KEY。多上游冗餘由中控渠道池原生承擔（failover/計費/冷卻），
 * 換上游只動中控配置，代碼零改。視覺模型 env NEWAPI_VISION_MODEL 可配，
 * 默認 gemini-3-flash（hub 實證唯一帶圖可用名；pro 家族已死路，見 R2c 實測）。
 *
 * 圖片以 chat content image_url（data URL）攜帶：支持 http(s) URL 下載 /
 * 本地路徑讀取 / data URL，非圖類（.m4a 音頻等）在讀取前按副檔名 fail-fast
 * 人話報錯，不浪費上游調用。
 *
 * 審核維度（aspect）內建三套毒蛇 prompt 模板（簡體，記憶 agent-gateway-copy-rules）：
 *   aesthetic   毒蛇藝術總監：構圖/光線/色彩/質感/敘事張力/鏡頭語言，1-10 分+逐維點評+最毒一句總結
 *   consistency 角色與場景一致性
 *   emotion     情緒表達與節奏
 *
 * 返回：verdict（1-10）＋逐維點評＋最毒總結；上游非 2xx / 響應解析失敗一律帶
 * 原文拋出（誠實鐵律，同 music-lyria.ts）。超時 60s。
 */

import * as fsp from "node:fs/promises"
import { safeFetch } from "./sandbox"

// ── plumbing（ok/fail 同構 music-tools.ts） ──────────────────────────────────

export type VisionToolResult = { title: string; output: string }

function ok(data: Record<string, unknown>): VisionToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): VisionToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

export class VisionToolError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "VisionToolError"
  }
}

function toFail(e: unknown): VisionToolResult {
  if (e instanceof VisionToolError) return fail(e.code, e.message)
  return fail("vision_tool_error", `vision_analyze 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * new-api 中控 chat 端點（唯一模型通路；R2c 定案）。
 * 公網閘道 image.tinchak0207.xyz/v1 無 chat/completions 路由（站點自營
 * 圖/視頻 API，/v1/models 為站點自營清單 46 模型），視覺審核走 VPS 內網
 * http://127.0.0.1:3001/v1（與 new-api 內核同機，controller/worker 同款）。
 */
export const VISION_NEWAPI_CHAT_URL = "http://127.0.0.1:3001/v1/chat/completions"

/**
 * 視覺審核模型（new-api 公開名）。默認 gemini-3-flash：hub.linux.do 帶圖實證
 * 200@9.4s（prompt_tokens 1201、中文描述正確）；gemini-3-pro-high/low 回上游
 * 棄用告示、pro-medium 403（違規停用）、gemini-3.1-pro-high 422 不存在——
 * pro 檔全部死路，flash 即主模型。可用 env NEWAPI_VISION_MODEL 覆蓋
 * （中控註冊新視覺模型後零代碼切換）。
 */
export const VISION_MODEL_DEFAULT = "glm-5.3-flash" // 2026-09-29：hub 已下架 gemini-3-flash（422 no channel），glm-5.3-flash 帶圖實測可用

/** 上游響應超時（審核 prompt 較長，統一 60s 硬頂）。 */
export const VISION_TIMEOUT_MS = 60_000

/** 圖片下載超時。 */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000

/** data URL 請求體上限保護（請求 JSON 總量 ~20MB，留餘量）。 */
export const IMAGE_MAX_BYTES = 18 * 1024 * 1024

/** 認得的圖片副檔名 → mime（白名單外一律人話報錯，讀檔前攔截）。 */
export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
}

/** 錯誤訊息裡攜帶的原文 body 上限（防日誌爆炸；截斷時顯式標注）。 */
const ERROR_BODY_MAX_CHARS = 8000

// ── 審核 prompt 模板（aspect → 毒蛇視角，簡體文案） ──────────────────────────

export const VISION_ASPECTS = ["aesthetic", "consistency", "emotion"] as const
export type VisionAspect = (typeof VISION_ASPECTS)[number]

/** 響應 JSON 契約（要求模型只輸出這個形狀）。 */
export interface VisionReview {
  /** 總分 1-10（整數）。 */
  verdict: number
  /** 逐維點評。 */
  dimensions: Array<{ name: string; score: number; comment: string }>
  /** 最毒一句總結。 */
  venom: string
}

const ASPECT_TEMPLATES: Record<VisionAspect, { title: string; dimensions: string; body: string }> = {
  aesthetic: {
    title: "毒蛇艺术总监审美审核",
    dimensions: "构图、光线、色彩、质感、叙事张力、镜头语言",
    body: [
      "你是一位以刻薄著称的毒蛇艺术总监，正在审核一张图像。请从以下六个维度逐一打分并点评（每个维度 1-10 分）：",
      "构图（画面布局、视觉引导、留白与重心）、光线（光源逻辑、明暗对比、氛围塑造）、",
      "色彩（配色和谐度、情绪传达、脏色与廉价感）、质感（材质细节、颗粒与涂抹感、真实度）、",
      "叙事张力（画面是否讲述故事、悬念与冲突、第一眼冲击力）、镜头语言（焦段感、景深、视角选择、电影感）。",
      "点评必须具体到画面里的实际元素，禁止空话套话；对平庸之处毫不留情。",
    ].join(""),
  },
  consistency: {
    title: "角色与场景一致性审核",
    dimensions: "角色外形一致性、场景连贯性、风格统一、细节延续",
    body: [
      "你是一位以毒舌著称的连续性总监，正在审核一张图像的角色与场景一致性。请从以下四个维度逐一打分并点评（每个维度 1-10 分）：",
      "角色外形一致性（五官、发型、体型、服装是否符合既定设定，若有 prompt_hint 补充设定则以其为基准）、",
      "场景连贯性（场景元素、时间线、空间逻辑是否自洽）、",
      "风格统一（画风、渲染方式、色彩体系是否前后一致）、",
      "细节延续（道具、纹章、疤痕、配饰等记忆点是否延续）。",
      "点评必须具体到画面里的实际元素，直接点名穿帮与漂移之处。",
    ].join(""),
  },
  emotion: {
    title: "情绪表达与节奏审核",
    dimensions: "情绪强度、情绪层次、节奏感、氛围渲染",
    body: [
      "你是一位挑剔的情绪导演，正在审核一张图像的情绪表达。请从以下四个维度逐一打分并点评（每个维度 1-10 分）：",
      "情绪强度（主体情绪是否传达到位、是否有感染力）、",
      "情绪层次（表情/肢体/环境多重信号是否协同，还是单一符号硬撑）、",
      "节奏感（视觉重心起伏、画面呼吸感、动静对比）、",
      "氛围渲染（光影/色彩/氛围元素是否服务于情绪，有无出戏干扰）。",
      "点评必须具体到画面里的实际元素，对「假笑式表演」和「气氛组摆拍」绝不姑息。",
    ].join(""),
  },
}

/** 組裝審核 prompt（模板 + 輸出契約 + 可選 prompt_hint），確定性拼接可測。 */
export function buildVisionPrompt(aspect: VisionAspect, promptHint?: string): string {
  const tpl = ASPECT_TEMPLATES[aspect]
  const lines = [
    tpl.body,
    "",
    `本次审核维度标题：${tpl.title}。`,
    "打分完成后，严格只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），形状如下：",
    '{"verdict": <1-10 整数总分>, "dimensions": [{"name": "<维度名>", "score": <1-10 整数>, "comment": "<该维度的毒蛇点评，30-80字>"}], "venom": "<最毒的一句话总结，30-60字>"}',
    `dimensions 必须且只包含这些维度：${tpl.dimensions}。`,
  ]
  const hint = promptHint?.trim()
  if (hint) lines.push(`补充审核语境（调用方提供，优先参考）：${hint}`)
  return lines.join("\n")
}

// ── 圖片讀取（URL 下載 / 本地路徑 / data URL） ───────────────────────────────

function extMimeOf(pathOrUrl: string): { mime: string; ext: string } | null {
  const clean = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl
  const dot = clean.lastIndexOf(".")
  if (dot < 0) return null
  const ext = clean.slice(dot).toLowerCase()
  const mime = IMAGE_MIME_BY_EXT[ext]
  // 有擴展名但不在白名單 → mime 為空串（區別於「無擴展名」的 null），上層分兩種人話報錯。
  return { mime: mime ?? "", ext }
}

/**
 * 解析圖片來源為 { bytes, mime, source }。
 * 3 種來源：data URL（直接解碼）、http(s) URL（下載 + content-type 白名單）、本地路徑（副檔名白名單預檢）。
 * 非圖類（.m4a 等）在讀取/下載前人話報錯，錯誤帶具體類型說明。
 */
export async function readImageSource(
  imageUrl: string | undefined,
  imagePath: string | undefined,
): Promise<{ bytes: Uint8Array; mime: string; source: "url" | "path" | "data_url" }> {
  const dataUrlMatch = imageUrl ? /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(imageUrl.trim()) : null
  if (dataUrlMatch) {
    const bytes = Buffer.from(dataUrlMatch[2], "base64")
    if (bytes.length === 0) {
      throw new VisionToolError("invalid_image", "image_url 是 data URL 但 base64 解码结果为空，请检查图片数据是否完整。")
    }
    return { bytes, mime: dataUrlMatch[1].toLowerCase(), source: "data_url" }
  }

  if (imageUrl) {
    const guessed = extMimeOf(imageUrl)
    let response: Response
    try {
      response = await safeFetch(imageUrl.trim(), { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) })
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? `下载超时（${IMAGE_DOWNLOAD_TIMEOUT_MS} ms）` : (e as Error)?.message ?? String(e)
      throw new VisionToolError("image_download_failed", `图片下载失败：${reason}。请确认 URL 可公网访问。URL：${imageUrl.slice(0, 300)}`)
    }
    // 2026-09-29：原本 response.text() 再 Buffer.from(text,"binary")＝把二進位當 UTF-8 解碼，
    // 所有 URL 圖片位元組被破壞（上游回「图片输入格式/解析错误」）。一律按位元組讀。
    const raw = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
    if (!response.ok) {
      const bodyText = raw.toString("utf8")
      throw new VisionToolError(
        "image_download_failed",
        `图片下载返回 HTTP ${response.status}。原文 body：${bodyText.slice(0, 500) || "(空)"}。URL：${imageUrl.slice(0, 300)}`,
      )
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
    const effectiveMime = contentType.startsWith("image/") ? contentType : (guessed?.mime ?? "")
    if (!effectiveMime) {
      throw new VisionToolError(
        "invalid_image",
        `下载到的内容不是图片（content-type: ${contentType || "未知"}${guessed ? `，扩展名 ${guessed.ext} 也不是图片格式` : ""}）。vision_analyze 只接受图片（png/jpeg/webp/gif/bmp/avif/heic/heif）；如果是音频/视频文件请勿使用本工具。URL：${imageUrl.slice(0, 300)}`,
      )
    }
    const bytes = raw
    if (bytes.length === 0) throw new VisionToolError("invalid_image", "图片下载内容为空（HTTP 200 但 0 字节）。")
    return { bytes, mime: effectiveMime, source: "url" }
  }

  if (imagePath) {
    const guessed = extMimeOf(imagePath)
    if (!guessed) {
      throw new VisionToolError(
        "invalid_image",
        `无法识别的文件类型（无扩展名）：${imagePath.slice(0, 300)}。vision_analyze 只接受图片文件（png/jpeg/webp/gif/bmp/avif/heic/heif）。`,
      )
    }
    if (!guessed.mime) {
      throw new VisionToolError(
        "invalid_image",
        `${imagePath.slice(0, 300)} 不是图片文件（扩展名 ${guessed.ext} 不在图片白名单）。它看起来是音频/视频/其他类型文件，vision_analyze 无法读图；请先转成 png/jpg 再调用。`,
      )
    }
    let bytes: Buffer
    try {
      bytes = await fsp.readFile(imagePath)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === "ENOENT") {
        throw new VisionToolError("image_not_found", `图片文件不存在：${imagePath.slice(0, 300)}。请确认路径（沙箱内绝对路径）。`)
      }
      if (code === "EACCES") {
        throw new VisionToolError("image_not_found", `图片文件无读取权限：${imagePath.slice(0, 300)}。`)
      }
      throw new VisionToolError("image_not_found", `图片文件读取失败（${code ?? "未知错误"}）：${imagePath.slice(0, 300)}`)
    }
    if (bytes.length === 0) throw new VisionToolError("invalid_image", `图片文件为空（0 字节）：${imagePath.slice(0, 300)}`)
    return { bytes, mime: guessed.mime, source: "path" }
  }

  throw new VisionToolError("invalid_args", "缺少图片来源：参数 image_url 与 image_path 必须二选一提供。")
}

// ── new-api 中控上游（誠實鐵律：非 2xx 帶原文；解析失敗帶原文） ───────────────

/** env NEWAPI_API_KEY 缺失 fail-fast（人話報錯，同 music-lyria.ts requireGeminiApiKey 範式）。 */
export function requireNewapiKey(): string {
  const key = process.env.NEWAPI_API_KEY?.trim()
  if (!key) {
    throw new VisionToolError(
      "newapi_key_missing",
      "环境变量 NEWAPI_API_KEY 未设置，vision_analyze 无法调用 new-api 中控读图。请部署侧注入该 env（中控端點以 NEWAPI_BASE_URL 配置，默認 " +
        VISION_NEWAPI_CHAT_URL +
        "）。",
    )
  }
  return key
}

/** 視覺模型解析：env NEWAPI_VISION_MODEL 覆蓋 → 默認 gemini-3-flash。 */
export function resolveVisionModel(): string {
  return process.env.NEWAPI_VISION_MODEL?.trim() || VISION_MODEL_DEFAULT
}

/** 從 chat/completions 響應提取首選文本（choices[0].message.content，容忍 reasoning 欄位缺失）。 */
export function extractChatText(body: unknown): string {
  const choices = (body as { choices?: Array<Record<string, unknown>> })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const content = (choices[0]?.message as { content?: unknown })?.content
  return typeof content === "string" ? content.trim() : ""
}

/** 從模型文本解析審核 JSON（容忍 ```json 圍欄與前後雜訊）。 */
export function parseVisionReview(raw: string): VisionReview {
  let text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) text = text.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VisionToolError(
      "bad_response",
      `模型响应不是合法 JSON，无法解析审核结论。原文前 1500 字符：${raw.slice(0, 1500)}`,
    )
  }
  const obj = parsed as Record<string, unknown>
  const verdict = typeof obj?.verdict === "number" && Number.isFinite(obj.verdict) ? Math.round(obj.verdict) : NaN
  const dims = Array.isArray(obj?.dimensions)
    ? (obj.dimensions as Array<Record<string, unknown>>)
        .map((d) => ({
          name: typeof d?.name === "string" ? d.name : "",
          score: typeof d?.score === "number" && Number.isFinite(d.score) ? Math.round(d.score) : NaN,
          comment: typeof d?.comment === "string" ? d.comment : "",
        }))
        .filter((d) => d.name !== "")
    : []
  const venom = typeof obj?.venom === "string" ? obj.venom : ""
  if (!Number.isFinite(verdict) || verdict < 1 || verdict > 10 || dims.length === 0 || !venom) {
    throw new VisionToolError(
      "bad_response",
      `模型响应 JSON 缺少必要字段（verdict 1-10 / dimensions 非空 / venom），无法采信。原文前 1500 字符：${raw.slice(0, 1500)}`,
    )
  }
  return { verdict, dimensions: dims, venom }
}

/** 上游通路標識（結果如實回報，誠實鐵律；R2c 起唯一通路 = new-api 中控）。 */
export type VisionChannel = "newapi"

/** 單次 chat/completions POST（成功/非 2xx 都帶原文回來，網路層異常直接拋）。 */
async function postChat(
  url: string,
  apiKey: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(VISION_TIMEOUT_MS),
    })
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? `超时（${VISION_TIMEOUT_MS} ms）` : (e as Error)?.message ?? String(e)
    throw new VisionToolError("newapi_request_failed", `new-api 中控读图请求失败（网络层）：${reason}。端点：${url}`)
  }
  const bodyText = await response.text().catch(() => "")
  return { ok: response.ok, status: response.status, body: bodyText }
}

/** 調用 new-api 中控讀圖審核（唯一通路），返回解析結論＋實際通路。 */
export async function callNewapiVision(opts: {
  base64: string
  mime: string
  prompt: string
  model?: string
  signal?: AbortSignal
}): Promise<{ review: VisionReview; channel: VisionChannel }> {
  const key = requireNewapiKey()
  const model = opts.model?.trim() || resolveVisionModel()
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: opts.prompt },
          { type: "image_url", image_url: { url: `data:${opts.mime};base64,${opts.base64}` } },
        ],
      },
    ],
    max_tokens: 4096,
  }

  const { ok, status, body } = await postChat(VISION_NEWAPI_CHAT_URL, key, payload, opts.signal)
  if (!ok) {
    throw new VisionToolError(
      "newapi_http_error",
      `new-api 中控返回 HTTP ${status}（模型 ${model}）。原文 body：${body.slice(0, ERROR_BODY_MAX_CHARS) || "(空)"}`,
    )
  }

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(body)
  } catch {
    throw new VisionToolError("newapi_bad_response", `new-api 中控响应不是合法 JSON。原文前 800 字符：${body.slice(0, 800)}`)
  }
  const rawText = extractChatText(parsedBody)
  if (!rawText) {
    throw new VisionToolError(
      "newapi_bad_response",
      `new-api 中控响应没有文本候选（可能被上游安全策略拦截或渠道剝圖）。原文前 1500 字符：${body.slice(0, 1500)}`,
    )
  }
  return { review: parseVisionReview(rawText), channel: "newapi" }
}

// ── vision_analyze 工具定義 ──────────────────────────────────────────────────

export interface VisionToolArgSpec {
  type: "string"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface VisionToolContext {
  abort?: AbortSignal
}

export interface VisionToolDef {
  id: string
  description: string
  args: Record<string, VisionToolArgSpec>
  execute: (args: Record<string, unknown>, context?: VisionToolContext) => Promise<VisionToolResult>
}

export const visionAnalyzeTool: VisionToolDef = {
  id: "vision_analyze",
  description:
    "读图审核工具（毒蛇评审的眼睛）：用视觉模型审看一张图片并给出结构化评审结论。三种审核维度：aesthetic=审美（构图/光线/色彩/质感/叙事张力/镜头语言，1-10 分+逐维点评+最毒总结）、consistency=角色与场景一致性、emotion=情绪表达与节奏。图片来源支持本地路径或 URL（二选一）。评审结果是返工依据，请如实引用。",
  args: {
    image_url: {
      type: "string",
      required: false,
      description:
        "图片公网 URL（与 image_path 二选一必填）。支持 http(s) 链接或 data:image/...;base64, 形式的内联图片。",
    },
    image_path: {
      type: "string",
      required: false,
      description:
        "图片本地路径（与 image_url 二选一必填），如 /tmp/storyboard-01.png。仅接受图片文件（png/jpeg/webp/gif/bmp/avif/heic/heif），音频/视频文件会被人话报错拒绝。",
    },
    aspect: {
      type: "string",
      required: false,
      enum: VISION_ASPECTS,
      description: "审核维度：aesthetic=审美（默认）、consistency=角色与场景一致性、emotion=情绪表达与节奏。",
    },
    prompt_hint: {
      type: "string",
      required: false,
      description:
        "补充审核语境（可选）：把分镜设定、角色 DNA、风格锚点或你想让评审重点盯防的点写在这里，评审会优先参考。",
    },
  },
  async execute(rawArgs, context) {
    const startedAt = Date.now()
    try {
      const imageUrl = asString(rawArgs.image_url)
      const imagePath = asString(rawArgs.image_path)
      if (!imageUrl && !imagePath) {
        return fail("invalid_args", "缺少必填参数：image_url 与 image_path 必须二选一提供（图片公网 URL 或本地路径）。")
      }
      if (imageUrl && imagePath) {
        return fail("invalid_args", "参数冲突：image_url 与 image_path 只能二选一，请删除其中一个。")
      }
      const aspectRaw = asString(rawArgs.aspect) ?? "aesthetic"
      if (!(VISION_ASPECTS as readonly string[]).includes(aspectRaw)) {
        return fail(
          "invalid_args",
          `aspect 只接受 ${VISION_ASPECTS.map((a) => `"${a}"`).join("/")}（审美/一致性/情绪），收到 "${aspectRaw}"。`,
        )
      }
      const aspect = aspectRaw as VisionAspect
      const promptHint = asString(rawArgs.prompt_hint)

      // 缺 key fail-fast：先於讀圖與上游調用（同 music-lyria.ts require 範式）。
      requireNewapiKey()

      const image = await readImageSource(imageUrl, imagePath)
      if (image.bytes.byteLength > IMAGE_MAX_BYTES) {
        return fail(
          "image_too_large",
          `图片过大（${(image.bytes.byteLength / 1024 / 1024).toFixed(1)} MB，上限 ${IMAGE_MAX_BYTES / 1024 / 1024} MB）。请压缩或降分辨率后重试。`,
        )
      }

      const prompt = buildVisionPrompt(aspect, promptHint)
      const { review, channel } = await callNewapiVision({
        base64: Buffer.from(image.bytes).toString("base64"),
        mime: image.mime,
        prompt,
        signal: context?.abort,
      })

      return ok({
        title: `${ASPECT_TEMPLATES[aspect].title}完成`,
        aspect,
        image_source: image.source,
        image_mime: image.mime,
        image_bytes: image.bytes.byteLength,
        verdict: review.verdict,
        dimensions: review.dimensions,
        venom: review.venom,
        model: resolveVisionModel(),
        channel,
        prompt_hint_used: promptHint ?? null,
        elapsed_ms: Date.now() - startedAt,
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** harness-tool-registry.ts 登記用 id 元組（同 MUSIC_HARNESS_TOOL_IDS 範式）。 */
export const VISION_HARNESS_TOOL_IDS = ["vision_analyze"] as const
