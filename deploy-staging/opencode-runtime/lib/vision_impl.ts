/**
 * vision_analyze harness 工具 VPS staging 稿（beast-army R2→R2c，2026-09-10 机械导出）。
 *
 * 本档由 tools/export-vision-tools-staging.ts 从行为真源 src/lib/vision-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/读图白名单/new-api 中控通路/
 * 错误铁律/60s 超时全在），零本地依赖（仅 node:fs/promises 内建模组），
 * 除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-vision-tools-staging.ts` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/vision_impl.ts
 * env：NEWAPI_API_KEY（Bearer 鉴权，VPS /opt/image-control-plane/.env.control-plane
 * 已有同名对，harness 侧同步注入）；NEWAPI_VISION_MODEL 可选覆盖（默认
 * gemini-3-flash）。通路唯一 = new-api 中控 {NEWAPI_BASE_URL}/chat/completions
 * （暴君铁律 vision-must-route-newapi-not-direct，R2c 起直连双通路已删）。
 * 薄入口：/opt/agent-harness/workspace/.opencode/tools/vision_analyze.ts
 */

/**
 * vision_analyze harness 工具（野兽模式多毒蛇评审的眼睛，beast-army R2→R2c，2026-09-10）。
 *
 * 定义形状同构 src/lib/music-tools.ts 的 MusicToolDef（零依赖：
 * { id, description, args, execute } + ok()/fail() 契约，回 { title, output }，
 * output 为 JSON 字串）。
 *
 * 模型通路（R2c 迁移，暴君铁律「模型调用禁直连必走 new-api」记忆
 * vision-must-route-newapi-not-direct）：唯一通路 = new-api 中控端点
 * POST {NEWAPI_BASE_URL}/chat/completions（OpenAI chat 形状），Bearer 鉴权
 * env NEWAPI_API_KEY。多上游冗余由中控渠道池原生承担（failover/计费/冷却），
 * 换上游只动中控配置，代码零改。视觉模型 env NEWAPI_VISION_MODEL 可配，
 * 默认 gemini-3-flash（hub 实证唯一带图可用名；pro 家族已死路，见 R2c 实测）。
 *
 * 图片以 chat content image_url（data URL）携带：支持 http(s) URL 下载 /
 * 本地路径读取 / data URL，非图类（.m4a 音频等）在读取前按副档名 fail-fast
 * 人话报错，不浪费上游调用。
 *
 * 审核维度（aspect）内建三套毒蛇 prompt 模板（简体，记忆 agent-gateway-copy-rules）：
 *   aesthetic   毒蛇艺术总监：构图/光线/色彩/质感/叙事张力/镜头语言，1-10 分+逐维点评+最毒一句总结
 *   consistency 角色与场景一致性
 *   emotion     情绪表达与节奏
 *
 * 返回：verdict（1-10）＋逐维点评＋最毒总结；上游非 2xx / 响应解析失败一律带
 * 原文抛出（诚实铁律，同 music-lyria.ts）。超时 60s。
 */

import * as fsp from "node:fs/promises"
import { safeFetch } from "./sandbox"

// ── plumbing（ok/fail 同构 music-tools.ts） ──────────────────────────────────

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
 * new-api 中控 chat 端点（唯一模型通路；R2c 定案）。
 * 公网闸道 image.tinchak0207.xyz/v1 无 chat/completions 路由（站点自营
 * 图/视频 API，/v1/models 为站点自营清单 46 模型），视觉审核走 VPS 内网
 * http://127.0.0.1:3001/v1（与 new-api 内核同机，controller/worker 同款）。
 */
export const VISION_NEWAPI_CHAT_URL = "http://127.0.0.1:3001/v1/chat/completions"

/**
 * 视觉审核模型（new-api 公开名）。默认 gemini-3-flash：hub.linux.do 带图实证
 * 200@9.4s（prompt_tokens 1201、中文描述正确）；gemini-3-pro-high/low 回上游
 * 弃用告示、pro-medium 403（违规停用）、gemini-3.1-pro-high 422 不存在——
 * pro 档全部死路，flash 即主模型。可用 env NEWAPI_VISION_MODEL 覆盖
 * （中控注册新视觉模型后零代码切换）。
 */
export const VISION_MODEL_DEFAULT = "glm-5.3-flash" // 2026-09-29：hub 已下架 gemini-3-flash（422 no channel），glm-5.3-flash 带图实测可用

/** 上游响应超时（审核 prompt 较长，统一 60s 硬顶）。 */
export const VISION_TIMEOUT_MS = 60_000

/** 图片下载超时。 */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000

/** data URL 请求体上限保护（请求 JSON 总量 ~20MB，留余量）。 */
export const IMAGE_MAX_BYTES = 18 * 1024 * 1024

/** 认得的图片副档名 → mime（白名单外一律人话报错，读档前拦截）。 */
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

/** 错误讯息里携带的原文 body 上限（防日志爆炸；截断时显式标注）。 */
const ERROR_BODY_MAX_CHARS = 8000

// ── 审核 prompt 模板（aspect → 毒蛇视角，简体文案） ──────────────────────────

export const VISION_ASPECTS = ["aesthetic", "consistency", "emotion"] as const
export type VisionAspect = (typeof VISION_ASPECTS)[number]

/** 响应 JSON 契约（要求模型只输出这个形状）。 */
export interface VisionReview {
  /** 总分 1-10（整数）。 */
  verdict: number
  /** 逐维点评。 */
  dimensions: Array<{ name: string; score: number; comment: string }>
  /** 最毒一句总结。 */
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

/** 组装审核 prompt（模板 + 输出契约 + 可选 prompt_hint），确定性拼接可测。 */
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

// ── 图片读取（URL 下载 / 本地路径 / data URL） ───────────────────────────────

function extMimeOf(pathOrUrl: string): { mime: string; ext: string } | null {
  const clean = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl
  const dot = clean.lastIndexOf(".")
  if (dot < 0) return null
  const ext = clean.slice(dot).toLowerCase()
  const mime = IMAGE_MIME_BY_EXT[ext]
  // 有扩展名但不在白名单 → mime 为空串（区别于「无扩展名」的 null），上层分两种人话报错。
  return { mime: mime ?? "", ext }
}

/**
 * 解析图片来源为 { bytes, mime, source }。
 * 3 种来源：data URL（直接解码）、http(s) URL（下载 + content-type 白名单）、本地路径（副档名白名单预检）。
 * 非图类（.m4a 等）在读取/下载前人话报错，错误带具体类型说明。
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
    // 2026-09-29：原本 response.text() 再 Buffer.from(text,"binary")＝把二进位当 UTF-8 解码，
    // 所有 URL 图片位元组被破坏（上游回「图片输入格式/解析错误」）。一律按位元组读。
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

// ── new-api 中控上游（诚实铁律：非 2xx 带原文；解析失败带原文） ───────────────

/** env NEWAPI_API_KEY 缺失 fail-fast（人话报错，同 music-lyria.ts requireGeminiApiKey 范式）。 */
export function requireNewapiKey(): string {
  const key = process.env.NEWAPI_API_KEY?.trim()
  if (!key) {
    throw new VisionToolError(
      "newapi_key_missing",
      "环境变量 NEWAPI_API_KEY 未设置，vision_analyze 无法调用 new-api 中控读图。请部署侧注入该 env（中控端点以 NEWAPI_BASE_URL 配置，默认 " +
        VISION_NEWAPI_CHAT_URL +
        "）。",
    )
  }
  return key
}

/** 视觉模型解析：env NEWAPI_VISION_MODEL 覆盖 → 默认 gemini-3-flash。 */
export function resolveVisionModel(): string {
  return process.env.NEWAPI_VISION_MODEL?.trim() || VISION_MODEL_DEFAULT
}

/** 从 chat/completions 响应提取首选文本（choices[0].message.content，容忍 reasoning 栏位缺失）。 */
export function extractChatText(body: unknown): string {
  const choices = (body as { choices?: Array<Record<string, unknown>> })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const content = (choices[0]?.message as { content?: unknown })?.content
  return typeof content === "string" ? content.trim() : ""
}

/** 从模型文本解析审核 JSON（容忍 ```json 围栏与前后杂讯）。 */
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

/** 上游通路标识（结果如实回报，诚实铁律；R2c 起唯一通路 = new-api 中控）。 */
export type VisionChannel = "newapi"

/** 单次 chat/completions POST（成功/非 2xx 都带原文回来，网路层异常直接抛）。 */
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

/** 调用 new-api 中控读图审核（唯一通路），返回解析结论＋实际通路。 */
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
      `new-api 中控响应没有文本候选（可能被上游安全策略拦截或渠道剥图）。原文前 1500 字符：${body.slice(0, 1500)}`,
    )
  }
  return { review: parseVisionReview(rawText), channel: "newapi" }
}

// ── vision_analyze 工具定义 ──────────────────────────────────────────────────

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

      // 缺 key fail-fast：先于读图与上游调用（同 music-lyria.ts require 范式）。
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

/** harness-tool-registry.ts 登记用 id 元组（同 MUSIC_HARNESS_TOOL_IDS 范式）。 */
export const VISION_HARNESS_TOOL_IDS = ["vision_analyze"] as const
