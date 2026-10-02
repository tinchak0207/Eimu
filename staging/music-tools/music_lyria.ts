/**
 * Lyria client VPS staging 稿（MOE Wave1 片B，2026-09-08 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-lyria.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/prompt 組裝/錯誤鐵律/超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 `npx tsx tools/export-music-tools-staging.ts` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_lyria.ts
 * env：GEMINI_STUDIO_API_KEY（generativelanguage lyria-3.5 generateContent，帶人聲整歌，付費）；
 *      GEMINI_API_KEY（無 studio key 時退回 Vertex lyria-002 :predict，純器樂 30s，degraded）。
 */

/**
 * Google Lyria 3.5 音樂生成 client（MOE 改革 Wave1 片B，2026-09-08；2026-10-02 契約換血）。
 *
 * 上游事實（2026-10-02 實測，新 `AIza` key = GEMINI_STUDIO_API_KEY）：
 *   端點  POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 *   鑑權  header `x-goog-api-key: $GEMINI_STUDIO_API_KEY`
 *   模型  lyria-3.5（整歌，帶人聲/時間戳歌詞）／ lyria-3-clip-preview（固定 30 秒）
 *   輸入  contents[0].parts = [{ text: <風格 prompt> }, { text: "Lyrics:\n<歌詞>" }]，
 *         參考圖走 parts[{ inlineData: { mimeType, data } }]（≤10 張＝圖生樂）。
 *         歌詞/人聲＝把 lyrics 寫進第二個 text part（Lyria 3.5 支持 vocals + timed lyrics）。
 *   響應  candidates[].content.parts[].inlineData.{ mimeType, data }（base64 音頻）。
 *         （歷史 interactions `steps` 形狀已不可用：2026-10-02 實測 `POST /v1beta/interactions`
 *          回 404 "Method not found"，lyria-3.5 的 supportedGenerationMethods 只有
 *          generateContent／countTokens，故一律走 generateContent。）
 *
 * 降級後端（無 GEMINI_STUDIO_API_KEY 時）：
 *   Vertex AI express（GEMINI_API_KEY，`AQ.` 開頭）：lyria-002 `:predict`，
 *   純器樂、約 30 秒、48kHz WAV，不支持歌詞/人聲/參考圖（歌詞會被忽略並如實回報）。
 *
 * key 選擇：有 `GEMINI_STUDIO_API_KEY` → generativelanguage lyria-3.5（人聲整歌）；
 *   沒有 → 退回 Vertex lyria-002（純器樂 30 秒），回執標 `degraded:true` + `ignoredInputs`。
 *
 * 設計：
 *   - 零依賴（同構 blender-tools.ts 範式），僅用 fetch / env / 類型。
 *   - lyrics 與 style 分離成兩個 text part（官方建議：風格描述與歌詞分開表述）。
 *   - 錯誤鐵律（誠實鐵律）：非 2xx 帶原文 body 拋出，絕不吞錯、絕不靜默降級；
 *     env key 缺失 fail-fast 人話報錯。
 *   - 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** Gemini API v1beta 基底（generateContent 契約）。 */
export const LYRIA_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
/** 舊 interactions 端點（僅保留常量給測試快照；實際已不走，2026-10-02 上游 404）。 */
export const LYRIA_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

/**
 * Vertex AI express 後端（2026-10-02 實測定案）：`GEMINI_API_KEY`（`AQ.` 開頭）所屬 GCP
 * 專案未啟用 generativelanguage.googleapis.com（Gemini API 一律 403 SERVICE_DISABLED），
 * 且 Vertex 該專案對 lyria-3.5／lyria-3-*-preview 回 404（無權限）；唯一實測可出音頻的是
 * lyria-002 `:predict`（純器樂、固定約 30 秒、48kHz WAV；不支持歌詞/人聲/參考圖）。
 */
export const LYRIA_VERTEX_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/lyria-002:predict"
export const LYRIA_VERTEX_MODEL = "lyria-002"
/** lyria-002 單次請求硬頂（實測 50–100s+）。 */
export const LYRIA_VERTEX_TIMEOUT_MS = 150_000

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

/** Gemini Studio（generativelanguage）付費 key 是否配置——決定走 lyria-3.5 還是 Vertex 降級。 */
export function hasGeminiStudioApiKey(): boolean {
  return Boolean(process.env.GEMINI_STUDIO_API_KEY?.trim())
}

/** `AQ.` 前綴＝Vertex express key（Gemini API key 是 `AIza` 前綴）。 */
export function isVertexExpressKey(key: string | undefined = process.env.GEMINI_API_KEY): boolean {
  return (key ?? "").trim().startsWith("AQ.")
}

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

/** 把 style prompt、可選歌詞、可選參考圖組成 generateContent 請求的 parts 數組。 */
function buildInputParts(opts: { prompt: string; lyrics?: string; imagesBase64?: string[] }): Array<
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
  parts.push({ text: opts.prompt })
  const lyrics = opts.lyrics?.trim()
  if (lyrics) {
    // 歌詞獨立成第二個 text part（style/lyrics 分離，官方建議）；Lyria 3.5 據此出人聲。
    // 段落標籤 [Verse]/[Chorus]/[Bridge] 與時間戳 [0:00 - 0:10] 由調用方按需攜帶，此處不加工。
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
 * 從 generateContent 響應體提取音頻與文本。上游契約：candidates[].content.parts[].inlineData
 * { mimeType, data }。上游形狀可能微調 → 遞歸容錯掃描（認 type/data/text/inline_data/inlineData
 * 欄位形狀，兼容歷史 interactions `steps`），找不到音頻塊時帶原文摘錄拋錯（誠實鐵律，不猜不編）。
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
    // generateContent 的 text part 無 `type` 欄位（{ text }），legacy interactions 帶 type:"text"。
    if (typeof obj.text === "string" && obj.text && !("inlineData" in obj) && !("inline_data" in obj)) {
      textChunks.push(obj.text)
      return
    }
    // generateContent 主形狀：inlineData/inline_data（Gemini 家族通用音頻塊）。
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
    throw new Error(`Lyria 響應中未找到音頻塊（candidates/parts 內無 inlineData 音頻塊）。原文摘錄：${excerpt}`)
  }
  const lyricsEcho = textChunks.length > 0 ? textChunks.join("\n").trim() : undefined
  return { audioBase64: audioBlock.data, mimeType: audioBlock.mime, ...(lyricsEcho ? { lyricsEcho } : {}) }
}

/** 讀取 Gemini Studio（generativelanguage）key；缺失時 fail-fast 人話報錯（禁靜默、禁編 key）。 */
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

/** 讀取 Vertex express key（降級後端用）；缺失時 fail-fast。 */
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
  /** 實際使用的後端：gemini_studio（lyria-3.5，可人聲）／vertex_express（lyria-002，純器樂 30s）。 */
  backend?: "gemini_studio" | "vertex_express"
  /** 實際生效的模型 id（vertex 後端恆為 lyria-002，與請求的 model 不同）。 */
  effectiveModel?: string
  /** 被後端忽略的輸入（如 lyrics/reference_images），誠實回報不靜默吞。 */
  ignoredInputs?: string[]
  /** true＝原委託（人聲/整歌）未能兌現、走了降級後端。 */
  degraded?: boolean
}

/**
 * 去掉「WAV 雙 RIFF 頭」：lyria-002 產物實測出現外層 44-byte RIFF 包住一個完整內層 WAV
 * （外層 size 欄位還被算成兩倍 → ffprobe 只能靠 bitrate 估時長）。偵測到 offset 44 又是
 * RIFF/WAVE 時，剝掉外層，回傳內層（真實可解碼的 WAV）。
 */
function stripDoubleWavHeader(bytes: Buffer): Buffer {
  if (
    bytes.length > 48 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 && // WAVE
    bytes[44] === 0x52 && bytes[45] === 0x49 && bytes[46] === 0x46 && bytes[47] === 0x46 // 內層 RIFF
  ) {
    return bytes.subarray(44)
  }
  return bytes
}

/** Vertex express lyria-002：純器樂 30s。歌詞/參考圖無法兌現 → 回報 ignoredInputs，不假裝。 */
async function generateLyriaVertexTrack(
  apiKey: string,
  opts: { prompt: string; lyrics?: string; imagesBase64: string[] },
): Promise<GenerateLyriaTrackResult> {
  const ignored: string[] = []
  if (opts.lyrics?.trim()) ignored.push("lyrics（lyria-002 仅纯器乐，无人声）")
  if (opts.imagesBase64.some((i) => i.trim())) ignored.push("reference_images（lyria-002 不支持图生乐）")
  // lyria-002 以 negative_prompt 排除人聲；prompt 內「no vocals」這類否定句實測更易觸發 500/超時，剝掉改走參數。
  const vertexPrompt = opts.prompt.replace(/\s*Instrumental only,? no vocals\.?/gi, "").trim() || opts.prompt
  const reqBody = JSON.stringify({
    instances: [{ prompt: vertexPrompt, negative_prompt: "vocals, singing, voice, lyrics" }],
    parameters: { sample_count: 1 },
  })
  // lyria-002 實測延遲 50–100s+ 且偶發 500「Could not generate audio」：5xx／超時各重試一次（上限 2 次），仍失敗照實拋錯。
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
  // 剝雙 RIFF 頭後重新編碼（修正實測到的外層重複頭；非雙頭則原樣）。
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
  return { ...extractLyriaOutput(body), backend: "gemini_studio", effectiveModel: model }
}

/**
 * 生成一首 Lyria 曲目。key 選擇：有 `GEMINI_STUDIO_API_KEY` 走 generativelanguage
 * lyria-3.5（人聲整歌）／lyria-3-clip-preview；否則退回 Vertex lyria-002（純器樂 30s，
 * degraded:true）。非 2xx 帶原文 body 拋出；key 缺失 fail-fast。
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
  // 無 Gemini Studio 付費 key → Vertex lyria-002 降級（純器樂 30s，回執 degraded:true）。
  return generateLyriaVertexTrack(requireVertexApiKey(), { prompt, lyrics: opts.lyrics, imagesBase64: images })
}
