/**
 * Google Lyria 3.5 音乐生成 client（MOE 改革 Wave1 片B，2026-09-08；2026-10-02 契约换血）。
 *
 * 上游事实（2026-10-02 实测，新 `AIza` key = GEMINI_STUDIO_API_KEY）：
 *   端点  POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 *   鉴权  header `x-goog-api-key: $GEMINI_STUDIO_API_KEY`
 *   模型  lyria-3.5（整歌，带人声/时间戳歌词）／ lyria-3-clip-preview（固定 30 秒）
 *   输入  contents[0].parts = [{ text: <风格 prompt> }, { text: "Lyrics:\n<歌词>" }]，
 *         参考图走 parts[{ inlineData: { mimeType, data } }]（≤10 张＝图生乐）。
 *         歌词/人声＝把 lyrics 写进第二个 text part（Lyria 3.5 支持 vocals + timed lyrics）。
 *   响应  candidates[].content.parts[].inlineData.{ mimeType, data }（base64 音频）。
 *         （历史 interactions `steps` 形状已不可用：2026-10-02 实测 `POST /v1beta/interactions`
 *          回 404 "Method not found"，lyria-3.5 的 supportedGenerationMethods 只有
 *          generateContent／countTokens，故一律走 generateContent。）
 *
 * 降级后端（无 GEMINI_STUDIO_API_KEY 时）：
 *   Vertex AI express（GEMINI_API_KEY，`AQ.` 开头）：lyria-002 `:predict`，
 *   纯器乐、约 30 秒、48kHz WAV，不支持歌词/人声/参考图（歌词会被忽略并如实回报）。
 *
 * key 选择：有 `GEMINI_STUDIO_API_KEY` → generativelanguage lyria-3.5（人声整歌）；
 *   没有 → 退回 Vertex lyria-002（纯器乐 30 秒），回执标 `degraded:true` + `ignoredInputs`。
 *
 * 设计：
 *   - 零依赖（同构 blender-tools.ts 范式），仅用 fetch / env / 类型。
 *   - lyrics 与 style 分离成两个 text part（官方建议：风格描述与歌词分开表述）。
 *   - 错误铁律（诚实铁律）：非 2xx 带原文 body 抛出，绝不吞错、绝不静默降级；
 *     env key 缺失 fail-fast 人话报错。
 *   - 工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

/** Gemini API v1beta 基底（generateContent 契约）。 */
export const LYRIA_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
/** 旧 interactions 端点（仅保留常量给测试快照；实际已不走，2026-10-02 上游 404）。 */
export const LYRIA_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

/**
 * Vertex AI express 后端（2026-10-02 实测定案）：`GEMINI_API_KEY`（`AQ.` 开头）所属 GCP
 * 专案未启用 generativelanguage.googleapis.com（Gemini API 一律 403 SERVICE_DISABLED），
 * 且 Vertex 该专案对 lyria-3.5／lyria-3-*-preview 回 404（无权限）；唯一实测可出音频的是
 * lyria-002 `:predict`（纯器乐、固定约 30 秒、48kHz WAV；不支持歌词/人声/参考图）。
 */
export const LYRIA_VERTEX_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/lyria-002:predict"
export const LYRIA_VERTEX_MODEL = "lyria-002"
/** lyria-002 单次请求硬顶（实测 50–100s+）。 */
export const LYRIA_VERTEX_TIMEOUT_MS = 150_000

/** duration_hint → 模型 id 映射（full=整歌约 3 分钟；clip30=固定 30 秒片段）。 */
export const LYRIA_MODELS = {
  full: "lyria-3.5",
  clip30: "lyria-3-clip-preview",
} as const

export type LyriaModelId = (typeof LYRIA_MODELS)[keyof typeof LYRIA_MODELS]

/** 单次生成上限 10 张参考图（官方上限，图生乐/MV 分镜用）。 */
export const LYRIA_MAX_IMAGES = 10

/** 上游响应超时（整歌生成较慢，统一 120s 硬顶）。 */
export const LYRIA_TIMEOUT_MS = 120_000

/** 错误讯息里携带的原文 body 上限（防日志爆炸；截断时显式标注）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** Gemini Studio（generativelanguage）付费 key 是否配置——决定走 lyria-3.5 还是 Vertex 降级。 */
export function hasGeminiStudioApiKey(): boolean {
  return Boolean(process.env.GEMINI_STUDIO_API_KEY?.trim())
}

/** `AQ.` 前缀＝Vertex express key（Gemini API key 是 `AIza` 前缀）。 */
export function isVertexExpressKey(key: string | undefined = process.env.GEMINI_API_KEY): boolean {
  return (key ?? "").trim().startsWith("AQ.")
}

/**
 * 情绪契约（orchestrator 心意 → 音乐描述的结构化形状）。
 * 所有模型都没有专用 emotion 参数——情绪契合靠 prompt 工程
 * （genre/BPM/key/mood/结构标签/时间戳，见记忆 music-gen-frontier-2026-09）。
 */
export interface LyriaMusicContract {
  /** 风格描述主体（编制/年代/制作质感，如 "warm acoustic ballad, fingerpicked guitar"）。 */
  style: string
  /** 流派（如 cinematic pop）。 */
  genre?: string
  /** 每分钟节拍数（非负整数，四舍五入）。 */
  bpm?: number
  /** 调性（如 "D minor"）。 */
  musicalKey?: string
  /** 情绪（如 "melancholic but hopeful"）。 */
  mood?: string
  /** 结构标签/时间戳说明（如 "[0:00-0:10] Intro, [0:10-0:40] Verse, ..."）。 */
  structure?: string
  /** true 时在 prompt 末尾追加 "Instrumental only, no vocals."（官方器乐写法）。 */
  instrumental?: boolean
}

/**
 * 把情绪契约拼成 Lyria 风格 prompt（确定性拼接，快照可测）。
 * 单行 comma-separated 描述 + Structure 行 + 器乐声明；lyrics 不在此函数内
 * （lyrics 与 style 分离，由 generateLyriaTrack 组成独立 text part）。
 */
export function buildLyriaStylePrompt(c: LyriaMusicContract): string {
  const segments: string[] = []
  const style = c.style?.trim() ?? ""
  if (style) segments.push(style)
  if (c.genre?.trim()) segments.push(c.genre.trim())
  if (typeof c.bpm === "number" && Number.isFinite(c.bpm) && c.bpm > 0) {
    segments.push(`${Math.round(c.bpm)} BPM`)
  }
  if (c.musicalKey?.trim()) segments.push(`key of ${c.musicalKey.trim()}`)
  if (c.mood?.trim()) segments.push(`mood: ${c.mood.trim()}`)

  let prompt = segments.join(", ")
  const structure = c.structure?.trim() ?? ""
  if (structure) {
    prompt += (prompt ? "\n" : "") + `Structure: ${structure}`
  }
  if (c.instrumental) {
    prompt += (prompt ? " " : "") + "Instrumental only, no vocals."
  }
  return prompt
}

/** 允许传 data URL 形式的图（自动剥前缀并取 mime）；否则默认 image/jpeg。 */
function normalizeImagePart(rawBase64: string): { inlineData: { mimeType: string; data: string } } {
  let data = rawBase64.trim()
  let mime = "image/jpeg"
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(data)
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase()
    data = data.slice(dataUrl[0].length)
  }
  return { inlineData: { mimeType: mime, data } }
}

/** 把 style prompt、可选歌词、可选参考图组成 generateContent 请求的 parts 数组。 */
function buildInputParts(opts: { prompt: string; lyrics?: string; imagesBase64?: string[] }): Array<
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
  parts.push({ text: opts.prompt })
  const lyrics = opts.lyrics?.trim()
  if (lyrics) {
    // 歌词独立成第二个 text part（style/lyrics 分离，官方建议）；Lyria 3.5 据此出人声。
    // 段落标签 [Verse]/[Chorus]/[Bridge] 与时间戳 [0:00 - 0:10] 由调用方按需携带，此处不加工。
    parts.push({ text: `Lyrics:\n${lyrics}` })
  }
  const images = opts.imagesBase64 ?? []
  for (const img of images) {
    if (!img.trim()) continue
    parts.push(normalizeImagePart(img))
  }
  return parts
}

/**
 * 从 generateContent 响应体提取音频与文本。上游契约：candidates[].content.parts[].inlineData
 * { mimeType, data }。上游形状可能微调 → 递归容错扫描（认 type/data/text/inline_data/inlineData
 * 栏位形状，兼容历史 interactions `steps`），找不到音频块时带原文摘录抛错（诚实铁律，不猜不编）。
 */
export function extractLyriaOutput(body: unknown): { audioBase64: string; mimeType: string; lyricsEcho?: string } {
  const audioBlock = { data: "", mime: "" } as { data: string; mime: string }
  const textChunks: string[] = []

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    const type = typeof obj.type === "string" ? obj.type : ""
    if ((type === "audio" || type === "audio_block") && typeof obj.data === "string" && obj.data && !audioBlock.data) {
      const mime = typeof obj.mime_type === "string" && obj.mime_type ? obj.mime_type : "audio/mpeg"
      audioBlock.data = obj.data
      audioBlock.mime = mime
      return
    }
    // generateContent 的 text part 无 `type` 栏位（{ text }），legacy interactions 带 type:"text"。
    if (typeof obj.text === "string" && obj.text && !("inlineData" in obj) && !("inline_data" in obj)) {
      textChunks.push(obj.text)
      return
    }
    // generateContent 主形状：inlineData/inline_data（Gemini 家族通用音频块）。
    const inline = (obj.inline_data ?? obj.inlineData) as Record<string, unknown> | undefined
    if (inline && !audioBlock.data) {
      const mime = (inline.mime_type ?? inline.mimeType) as unknown
      const data = inline.data
      if (typeof data === "string" && data && (typeof mime !== "string" || mime.startsWith("audio/"))) {
        audioBlock.data = data
        audioBlock.mime = typeof mime === "string" && mime ? mime : "audio/mpeg"
        return
      }
    }
    for (const key of ["candidates", "content", "parts", "output", "model_output", "steps", "blocks", "input"]) {
      if (key in obj) visit(obj[key], depth + 1)
    }
  }
  const root = body as Record<string, unknown> | undefined
  visit(root?.candidates ?? root?.steps ?? body, 0)

  if (!audioBlock.data) {
    const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? String(body)
    throw new Error(`Lyria 响应中未找到音频块（candidates/parts 内无 inlineData 音频块）。原文摘录：${excerpt}`)
  }
  const lyricsEcho = textChunks.length > 0 ? textChunks.join("\n").trim() : undefined
  return { audioBase64: audioBlock.data, mimeType: audioBlock.mime, ...(lyricsEcho ? { lyricsEcho } : {}) }
}

/** 读取 Gemini Studio（generativelanguage）key；缺失时 fail-fast 人话报错（禁静默、禁编 key）。 */
export function requireGeminiStudioApiKey(): string {
  const key = process.env.GEMINI_STUDIO_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "GEMINI_STUDIO_API_KEY 未配置：Lyria 3.5（含歌词人声整歌）需要 Gemini API 付费 key（x-goog-api-key 鉴权）。" +
        "请在运行环境设置 GEMINI_STUDIO_API_KEY；key 属秘密信息，禁止写入日志或提交代码。",
    )
  }
  return key
}

/** 读取 Vertex express key（降级后端用）；缺失时 fail-fast。 */
function requireVertexApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY 未配置：无 GEMINI_STUDIO_API_KEY 时 Lyria 回退到 Vertex lyria-002，需要 GEMINI_API_KEY。" +
        "请在运行环境设置 GEMINI_API_KEY；key 属秘密信息，禁止写入日志或提交代码。",
    )
  }
  return key
}

export interface GenerateLyriaTrackOptions {
  /** 风格/情绪 prompt（可用 buildLyriaStylePrompt 从情绪契约拼出）。 */
  prompt: string
  /** 自订歌词（含 [Verse]/[Chorus]/[Bridge] 段落标签或 [0:00-0:10] 时间戳）。缺省=纯器乐倾向。 */
  lyrics?: string
  /** 模型 id；缺省 lyria-3.5（整歌）。 */
  model?: LyriaModelId
  /** MV 分镜/参考图 base64（≤10 张，图生乐）。允许 data URL 形式。 */
  imagesBase64?: string[]
}

export interface GenerateLyriaTrackResult {
  /** 音频字节（base64，无 data: 前缀）。 */
  audioBase64: string
  /** 音频 MIME（默认 audio/mpeg）。 */
  mimeType: string
  /** 模型回传的歌词/结构文本（可能为空）。 */
  lyricsEcho?: string
  /** 实际使用的后端：gemini_studio（lyria-3.5，可人声）／vertex_express（lyria-002，纯器乐 30s）。 */
  backend?: "gemini_studio" | "vertex_express"
  /** 实际生效的模型 id（vertex 后端恒为 lyria-002，与请求的 model 不同）。 */
  effectiveModel?: string
  /** 被后端忽略的输入（如 lyrics/reference_images），诚实回报不静默吞。 */
  ignoredInputs?: string[]
  /** true＝原委托（人声/整歌）未能兑现、走了降级后端。 */
  degraded?: boolean
}

/**
 * 去掉「WAV 双 RIFF 头」：lyria-002 产物实测出现外层 44-byte RIFF 包住一个完整内层 WAV
 * （外层 size 栏位还被算成两倍 → ffprobe 只能靠 bitrate 估时长）。侦测到 offset 44 又是
 * RIFF/WAVE 时，剥掉外层，回传内层（真实可解码的 WAV）。
 */
function stripDoubleWavHeader(bytes: Buffer): Buffer {
  if (
    bytes.length > 48 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 && // WAVE
    bytes[44] === 0x52 && bytes[45] === 0x49 && bytes[46] === 0x46 && bytes[47] === 0x46 // 内层 RIFF
  ) {
    return bytes.subarray(44)
  }
  return bytes
}

/** Vertex express lyria-002：纯器乐 30s。歌词/参考图无法兑现 → 回报 ignoredInputs，不假装。 */
async function generateLyriaVertexTrack(
  apiKey: string,
  opts: { prompt: string; lyrics?: string; imagesBase64: string[] },
): Promise<GenerateLyriaTrackResult> {
  const ignored: string[] = []
  if (opts.lyrics?.trim()) ignored.push("lyrics（lyria-002 仅纯器乐，无人声）")
  if (opts.imagesBase64.some((i) => i.trim())) ignored.push("reference_images（lyria-002 不支持图生乐）")
  // lyria-002 以 negative_prompt 排除人声；prompt 内「no vocals」这类否定句实测更易触发 500/超时，剥掉改走参数。
  const vertexPrompt = opts.prompt.replace(/\s*Instrumental only,? no vocals\.?/gi, "").trim() || opts.prompt
  const reqBody = JSON.stringify({
    instances: [{ prompt: vertexPrompt, negative_prompt: "vocals, singing, voice, lyrics" }],
    parameters: { sample_count: 1 },
  })
  // lyria-002 实测延迟 50–100s+ 且偶发 500「Could not generate audio」：5xx／超时各重试一次（上限 2 次），仍失败照实抛错。
  let response!: Response
  let lastErr = ""
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LYRIA_VERTEX_TIMEOUT_MS)
    try {
      response = await fetch(LYRIA_VERTEX_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: reqBody,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.status >= 500 && attempt < 3) {
        lastErr = `HTTP ${response.status}`
        continue
      }
      break
    } catch (e) {
      clearTimeout(timer)
      lastErr = controller.signal.aborted ? `超时 ${LYRIA_VERTEX_TIMEOUT_MS} ms` : `网络层：${(e as Error)?.message ?? String(e)}`
      if (attempt >= 3) throw new Error(`Lyria(Vertex ${LYRIA_VERTEX_MODEL}) 请求失败（已重试 2 次）：${lastErr}`)
    }
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    const shown = bodyText.length > ERROR_BODY_MAX_CHARS ? `${bodyText.slice(0, ERROR_BODY_MAX_CHARS)}…（原文共 ${bodyText.length} 字符，已截断）` : bodyText
    throw new Error(`Lyria(Vertex ${LYRIA_VERTEX_MODEL}) 返回 HTTP ${response.status}。原文 body：${shown || "(空)"}`)
  }
  let body: { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> }
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error(`Lyria(Vertex) 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`)
  }
  const pred = body.predictions?.[0]
  if (!pred?.bytesBase64Encoded) {
    throw new Error(`Lyria(Vertex) 响应中无 predictions[0].bytesBase64Encoded（可能被安全过滤）。原文摘录：${bodyText.slice(0, 1500)}`)
  }
  const mime = pred.mimeType || "audio/wav"
  const raw = Buffer.from(pred.bytesBase64Encoded, "base64")
  // 剥双 RIFF 头后重新编码（修正实测到的外层重复头；非双头则原样）。
  const audioBase64 = mime.includes("wav") ? stripDoubleWavHeader(raw).toString("base64") : pred.bytesBase64Encoded
  return {
    audioBase64,
    mimeType: mime,
    backend: "vertex_express",
    effectiveModel: LYRIA_VERTEX_MODEL,
    ignoredInputs: ignored,
    degraded: true,
  }
}

/** generativelanguage lyria-3.5／lyria-3-clip-preview：`POST models/<model>:generateContent`。 */
async function generateLyriaStudioTrack(
  apiKey: string,
  opts: { prompt: string; lyrics?: string; model: LyriaModelId; imagesBase64: string[] },
): Promise<GenerateLyriaTrackResult> {
  const model = opts.model
  const payload = {
    contents: [{ role: "user", parts: buildInputParts({ prompt: opts.prompt, lyrics: opts.lyrics, imagesBase64: opts.imagesBase64 }) }],
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LYRIA_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${LYRIA_API_BASE_URL}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (controller.signal.aborted) {
      throw new Error(`Lyria 生成超时（上限 ${LYRIA_TIMEOUT_MS} ms，模型 ${model}）。整歌生成较慢，可改用 duration_hint="clip30" 的 30 秒片段重试。`)
    }
    throw new Error(`Lyria 请求失败（网络层）：${(e as Error)?.message ?? String(e)}`)
  }
  clearTimeout(timer)

  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    // 诚实铁律：带原文 body 抛出（超限截断时显式标注），绝不吞错误。
    const shown =
      bodyText.length > ERROR_BODY_MAX_CHARS
        ? `${bodyText.slice(0, ERROR_BODY_MAX_CHARS)}…（原文共 ${bodyText.length} 字符，已截断）`
        : bodyText
    throw new Error(`Lyria API 返回 HTTP ${response.status}（模型 ${model}）。原文 body：${shown || "(空)"}`)
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error(`Lyria 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`)
  }
  return { ...extractLyriaOutput(body), backend: "gemini_studio", effectiveModel: model }
}

/**
 * 生成一首 Lyria 曲目。key 选择：有 `GEMINI_STUDIO_API_KEY` 走 generativelanguage
 * lyria-3.5（人声整歌）／lyria-3-clip-preview；否则退回 Vertex lyria-002（纯器乐 30s，
 * degraded:true）。非 2xx 带原文 body 抛出；key 缺失 fail-fast。
 */
export async function generateLyriaTrack(opts: GenerateLyriaTrackOptions): Promise<GenerateLyriaTrackResult> {
  const prompt = opts.prompt?.trim() ?? ""
  if (!prompt) {
    throw new Error("prompt 不能为空：请提供风格+情绪描述（genre/BPM/调性/编制/氛围）。")
  }
  const images = opts.imagesBase64 ?? []
  const imageCount = images.filter((i) => i.trim() !== "").length
  if (imageCount > LYRIA_MAX_IMAGES) {
    throw new Error(`参考图最多 ${LYRIA_MAX_IMAGES} 张（图生乐上限），收到 ${imageCount} 张。`)
  }

  if (hasGeminiStudioApiKey()) {
    const apiKey = requireGeminiStudioApiKey()
    return generateLyriaStudioTrack(apiKey, { prompt, lyrics: opts.lyrics, model: opts.model ?? LYRIA_MODELS.full, imagesBase64: images })
  }
  // 无 Gemini Studio 付费 key → Vertex lyria-002 降级（纯器乐 30s，回执 degraded:true）。
  return generateLyriaVertexTrack(requireVertexApiKey(), { prompt, lyrics: opts.lyrics, imagesBase64: images })
}
