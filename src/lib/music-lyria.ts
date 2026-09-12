/**
 * Google Lyria 3.5 音樂生成 client（MOE 改革 Wave1 片B，2026-09-08）。
 *
 * 上游事實（已查證，2026-09）：
 *   端點  POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   鑑權  header `x-goog-api-key: $GEMINI_API_KEY`
 *   模型  lyria-3.5（整歌 ~3 分鐘，MP3 默認）／ lyria-3-clip-preview（固定 30 秒 MP3）
 *   輸入  input = 字串 prompt 或 parts 數組：
 *         { type:"text",  text:... }
 *         { type:"image", mime_type:"image/jpeg", data:<base64> }（最多 10 張 = 圖生樂）
 *   歌詞  自訂歌詞用 [Verse]/[Chorus]/[Bridge] 段落標籤；時間戳結構 [0:00 - 0:10] Intro:；
 *         純器樂在 prompt 寫明 "Instrumental only, no vocals"；歌詞語言跟隨 prompt 語言
 *   響應  steps 數組，model_output 步含 audio（base64）與 text（歌詞/結構）塊；
 *         單輪、非確定性、SynthID 水印
 *
 * 設計：
 *   - 零依賴（同構 blender-tools.ts 範式），僅用 fetch / env / 類型。
 *   - lyrics 與 style 分離成兩個 text part（官方建議：風格描述與歌詞分開表述）。
 *   - 錯誤鐵律（誠實鐵律）：非 2xx 帶原文 body 拋出，絕不吞錯、絕不靜默降級；
 *     env key 缺失 fail-fast 人話報錯。
 *   - 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** Lyria interactions 端點（Gemini API v1beta）。 */
export const LYRIA_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

/** duration_hint → 模型 id 映射（full=整歌約 3 分鐘；clip30=固定 30 秒片段）。 */
export const LYRIA_MODELS = {
  full: "lyria-3.5",
  clip30: "lyria-3-clip-preview",
} as const

export type LyriaModelId = (typeof LYRIA_MODELS)[keyof typeof LYRIA_MODELS]

/** 單次生成上限 10 張參考圖（官方上限，圖生樂/MV 分鏡用）。 */
export const LYRIA_MAX_IMAGES = 10

/** 上游響應超時（整歌生成較慢，統一 120s 硬頂）。 */
export const LYRIA_TIMEOUT_MS = 120_000

/** 錯誤訊息裡攜帶的原文 body 上限（防日誌爆炸；截斷時顯式標注）。 */
const ERROR_BODY_MAX_CHARS = 8000

/**
 * 情緒契約（orchestrator 心意 → 音樂描述的結構化形狀）。
 * 所有模型都沒有專用 emotion 參數——情緒契合靠 prompt 工程
 * （genre/BPM/key/mood/結構標籤/時間戳，見記憶 music-gen-frontier-2026-09）。
 */
export interface LyriaMusicContract {
  /** 風格描述主體（編制/年代/製作質感，如 "warm acoustic ballad, fingerpicked guitar"）。 */
  style: string
  /** 流派（如 cinematic pop）。 */
  genre?: string
  /** 每分鐘節拍數（非負整數，四捨五入）。 */
  bpm?: number
  /** 調性（如 "D minor"）。 */
  musicalKey?: string
  /** 情緒（如 "melancholic but hopeful"）。 */
  mood?: string
  /** 結構標籤/時間戳說明（如 "[0:00-0:10] Intro, [0:10-0:40] Verse, ..."）。 */
  structure?: string
  /** true 時在 prompt 末尾追加 "Instrumental only, no vocals."（官方器樂寫法）。 */
  instrumental?: boolean
}

/**
 * 把情緒契約拼成 Lyria 風格 prompt（確定性拼接，快照可測）。
 * 單行 comma-separated 描述 + Structure 行 + 器樂聲明；lyrics 不在此函數內
 * （lyrics 與 style 分離，由 generateLyriaTrack 組成獨立 text part）。
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

/** 允許傳 data URL 形式的圖（自動剝前綴並取 mime）；否則默認 image/jpeg。 */
function normalizeImagePart(rawBase64: string): { type: "image"; mime_type: string; data: string } {
  let data = rawBase64.trim()
  let mime = "image/jpeg"
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(data)
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase()
    data = data.slice(dataUrl[0].length)
  }
  return { type: "image", mime_type: mime, data }
}

/** 把 style prompt、可選歌詞、可選參考圖組成 interactions 請求的 parts 數組。 */
function buildInputParts(opts: { prompt: string; lyrics?: string; imagesBase64?: string[] }): Array<
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string }
> {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; mime_type: string; data: string }> = []
  parts.push({ type: "text", text: opts.prompt })
  const lyrics = opts.lyrics?.trim()
  if (lyrics) {
    // 歌詞獨立成第二個 text part（style/lyrics 分離，官方建議）；
    // 段落標籤 [Verse]/[Chorus]/[Bridge] 與時間戳 [0:00 - 0:10] 由調用方按需攜帶，此處不加工。
    parts.push({ type: "text", text: `Lyrics:\n${lyrics}` })
  }
  const images = opts.imagesBase64 ?? []
  for (const img of images) {
    if (!img.trim()) continue
    parts.push(normalizeImagePart(img))
  }
  return parts
}

/**
 * 從 interactions 響應體提取音頻與文本。上游契約：steps 數組、model_output 步含
 * audio（base64）與 text 塊。上游形狀可能微調 → 遞歸容錯掃描（認 type/data/text
 * 欄位形狀），找不到音頻塊時帶原文摘錄拋錯（誠實鐵律，不猜不編）。
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
    if (type === "text" && typeof obj.text === "string" && obj.text) {
      textChunks.push(obj.text)
      return
    }
    // 兼容 inline_data / inlineData 形狀（Gemini 家族通用音頻塊）。
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
    for (const key of ["output", "model_output", "steps", "parts", "content", "blocks", "input"]) {
      if (key in obj) visit(obj[key], depth + 1)
    }
  }
  visit((body as Record<string, unknown>)?.steps ?? body, 0)

  if (!audioBlock.data) {
    const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? String(body)
    throw new Error(`Lyria 響應中未找到音頻塊（steps 內無 audio/inline_data 塊）。原文摘錄：${excerpt}`)
  }
  const lyricsEcho = textChunks.length > 0 ? textChunks.join("\n").trim() : undefined
  return { audioBase64: audioBlock.data, mimeType: audioBlock.mime, ...(lyricsEcho ? { lyricsEcho } : {}) }
}

/** 讀取 Gemini API key；缺失時 fail-fast 人話報錯（禁靜默、禁編 key）。 */
export function requireGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY 未配置：Lyria 生成需要 Gemini API key（付费额度，x-goog-api-key 鉴权）。" +
        "请在运行环境设置 GEMINI_API_KEY 后重试；key 属秘密信息，禁止写入日志或提交代码。",
    )
  }
  return key
}

export interface GenerateLyriaTrackOptions {
  /** 風格/情緒 prompt（可用 buildLyriaStylePrompt 從情緒契約拼出）。 */
  prompt: string
  /** 自訂歌詞（含 [Verse]/[Chorus]/[Bridge] 段落標籤或 [0:00-0:10] 時間戳）。缺省=純器樂傾向。 */
  lyrics?: string
  /** 模型 id；缺省 lyria-3.5（整歌）。 */
  model?: LyriaModelId
  /** MV 分鏡/參考圖 base64（≤10 張，圖生樂）。允許 data URL 形式。 */
  imagesBase64?: string[]
}

export interface GenerateLyriaTrackResult {
  /** 音頻字節（base64，無 data: 前綴）。 */
  audioBase64: string
  /** 音頻 MIME（默認 audio/mpeg）。 */
  mimeType: string
  /** 模型回傳的歌詞/結構文本（可能為空）。 */
  lyricsEcho?: string
}

/**
 * 生成一首 Lyria 曲目。非 2xx 帶原文 body 拋出；120s 超時；key 缺失 fail-fast。
 * input 採 parts 數組形（字串 prompt 的超集；style 與 lyrics 分離為兩個 text part）。
 */
export async function generateLyriaTrack(opts: GenerateLyriaTrackOptions): Promise<GenerateLyriaTrackResult> {
  const apiKey = requireGeminiApiKey()

  const prompt = opts.prompt?.trim() ?? ""
  if (!prompt) {
    throw new Error("prompt 不能为空：请提供风格+情绪描述（genre/BPM/调性/编制/氛围）。")
  }
  const images = opts.imagesBase64 ?? []
  const imageCount = images.filter((i) => i.trim() !== "").length
  if (imageCount > LYRIA_MAX_IMAGES) {
    throw new Error(`参考图最多 ${LYRIA_MAX_IMAGES} 张（图生乐上限），收到 ${imageCount} 张。`)
  }

  const model = opts.model ?? LYRIA_MODELS.full
  const payload = {
    model,
    input: buildInputParts({ prompt, lyrics: opts.lyrics, imagesBase64: images }),
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LYRIA_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(LYRIA_INTERACTIONS_URL, {
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
    // 誠實鐵律：帶原文 body 拋出（超限截斷時顯式標注），絕不吞錯誤。
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
  return extractLyriaOutput(body)
}
