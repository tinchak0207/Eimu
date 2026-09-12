/**
 * FlowMusic2API client VPS staging 稿（死線3 music_gen 通路換血，2026-09-09 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-flowmusic.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/clips 解析/下載/錯誤鐵律/超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 `npx tsx tools/export-music-tools-staging.ts` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
 * env：FLOWMUSIC2API_URL（服務地址，缺省禁用本通路）、FLOWMUSIC2API_KEY（Bearer）。
 */

/**
 * FlowMusic2API 音樂生成 client（死線3 music_gen 通路換血，2026-09-09）。
 *
 * 上游事實（已查證，2026-09-09 實彈探測 + genz27/FlowMusic2API README）：
 *   端點  POST {FLOWMUSIC2API_URL}/v1/chat/completions（OpenAI 兼容，非流式）
 *   鑑權  header `Authorization: Bearer $FLOWMUSIC2API_KEY`
 *   模型  lyria（Lyria 3.5 旗艦，整歌 ~150s）/ lyria-fast（同模型快速別名）
 *   歌詞  無專用欄位——style prompt 與歌詞全部內嵌在 message content（README 範式）；
 *         歌詞段落標籤 [Verse]/[Chorus] 隨 content 傳遞，器樂在 prompt 註明 no vocals
 *   響應  頂級 clips 陣列（機器可讀：clip_id/audio_url/audio.format/duration）；
 *         choices[0].message.content 為 markdown（Audio/Duration/Lyrics 塊）——
 *         解析優先 clips 陣列，content markdown 作後備（誠實降級，不猜）
 *   實測  2026-09-09 VPS 實彈：HTTP 200，clips[0].audio_url 為
 *         storage.googleapis.com producer-app-public 公網 m4a（148.19s）
 *
 * 設計：
 *   - 零依賴（同構 music-lyria.ts 範式），僅用 fetch / env / 類型。
 *   - env：FLOWMUSIC2API_URL（缺省禁用本通路，工具回落 Gemini Lyria 直連）、
 *     FLOWMUSIC2API_KEY（Bearer 鑑權，缺缺失 fail-fast 人話報錯）。
 *   - 錯誤鐵律（誠實鐵律）：非 2xx / 無音頻 URL / 下載失敗一律帶原文摘錄拋出，
 *     絕不吞錯、絕不靜默降級、絕不偽造 URL。
 *   - 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** FlowMusic2API 服務地址 env 名（VPS 上為 http://127.0.0.1:8000，容器僅綁本機）。 */
const FLOWMUSIC2API_URL_ENV = "FLOWMUSIC2API_URL"

/** duration_hint → FlowMusic2API 模型映射（full=旗艦整歌；clip30=快速別名，上游無 30s 片段模式）。 */
export const FLOWMUSIC_MODELS = {
  full: "lyria",
  clip30: "lyria-fast",
} as const

export type FlowMusicModelId = (typeof FLOWMUSIC_MODELS)[keyof typeof FLOWMUSIC_MODELS]

/** 非流式生成超時（上游整歌實測 ~150s 內，300s 硬頂含下載餘量）。 */
export const FLOWMUSIC_TIMEOUT_MS = 300_000

/** 音頻檔下載超時。 */
const FLOWMUSIC_DOWNLOAD_TIMEOUT_MS = 120_000

/** 錯誤訊息裡攜帶的原文 body 上限（同 music-lyria.ts 口徑）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** 讀 FlowMusic2API 服務地址（未配置 → null，調用方回落 Lyria 直連通路）。 */
export function flowMusic2ApiUrl(): string | null {
  const raw = (process.env[FLOWMUSIC2API_URL_ENV] ?? "").trim()
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

/** 本通路是否啟用（env FLOWMUSIC2API_URL 非空即啟用）。 */
export function isFlowMusic2ApiEnabled(): boolean {
  return flowMusic2ApiUrl() !== null
}

export interface GenerateFlowMusicTrackOptions {
  prompt: string
  /** 自訂歌詞（[Verse]/[Chorus] 段落標籤）；缺省=隨 style prompt 意圖（器樂需 prompt 註明）。 */
  lyrics?: string
  model: FlowMusicModelId
}

/** 與 generateLyriaTrack 返回形狀同構，另帶 upstreamUrl（音頻原始公網 URL，交付兜底用）。 */
export interface GenerateFlowMusicTrackResult {
  audioBase64: string
  mimeType: string
  lyricsEcho?: string
  upstreamUrl: string
  upstreamDurationHint?: number
}

function requireApiKey(): string {
  const key = (process.env.FLOWMUSIC2API_KEY ?? "").trim()
  if (!key) {
    throw new Error(
      "缺少 FLOWMUSIC2API_KEY（FlowMusic2API 通路 Bearer 鑑權）。請在 harness 環境配置後重試，或取消 FLOWMUSIC2API_URL 回落 Gemini Lyria 直連通路。",
    )
  }
  return key
}

/** style prompt + 歌詞合併為單條 message content（README 範式：無專用歌詞欄位）。 */
export function buildFlowMusicContent(prompt: string, lyrics?: string): string {
  const parts = [prompt.trim()]
  if (lyrics && lyrics.trim()) {
    parts.push(`歌词（严格按以下段落标签与文本演唱）：\n${lyrics.trim()}`)
  }
  return parts.join("\n\n")
}

/** clips[].audio.format → MIME（m4a 實測主格式；未知格式按 content-type 後備）。 */
function formatToMime(format: unknown, fallback: string): string {
  if (format === "m4a") return "audio/mp4"
  if (format === "wav") return "audio/wav"
  if (format === "mp3") return "audio/mpeg"
  return fallback
}

/**
 * 從響應解析音頻 URL：優先頂級 clips 陣列（機器可讀），後備 content markdown
 * `- Audio: <url>` 行（README 流式/文本形態的降級路徑）。找不到一律拋錯（不猜）。
 */
export function extractFlowMusicAudioUrl(body: unknown): { url: string; mimeHint?: string; durationHint?: number } {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const clips = (body as { clips?: unknown })?.clips
  if (Array.isArray(clips) && clips.length > 0) {
    const first = clips[0] as Record<string, unknown>
    const direct = typeof first?.audio_url === "string" ? first.audio_url : undefined
    const nested = typeof (first?.audio as Record<string, unknown> | undefined)?.url === "string"
      ? ((first.audio as Record<string, unknown>).url as string)
      : undefined
    const url = direct || nested
    if (url) {
      const format = (first?.audio as Record<string, unknown> | undefined)?.format
      const duration = typeof first?.duration === "number" ? first.duration : undefined
      return { url, ...(format !== undefined ? { mimeHint: String(format) } : {}), ...(duration !== undefined ? { durationHint: duration } : {}) }
    }
  }
  const content = ((body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content) as unknown
  if (typeof content === "string") {
    const match = content.match(/- Audio:\s*(https?:\/\/\S+)/)
    if (match) return { url: match[1].replace(/[)\]]+$/, "") }
  }
  throw new Error(`FlowMusic2API 響應中未找到音頻 URL（clips 陣列與 content markdown 均無 Audio 行）。原文摘錄：${excerpt}`)
}

/** 從 content 提取首個 ```text 歌詞塊作 lyrics_echo（無則 undefined）。 */
function extractLyricsBlock(content: string): string | undefined {
  const match = content.match(/```text\n([\s\S]*?)```/)
  const block = match?.[1]?.trim()
  return block ? block : undefined
}

/** 下載音頻檔 → base64；MIME 取 clips format，content-type 後備。 */
async function downloadAudio(
  url: string,
  mimeHint: string | undefined,
): Promise<{ audioBase64: string; mimeType: string }> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FLOWMUSIC_DOWNLOAD_TIMEOUT_MS) })
  } catch (e) {
    throw new Error(`FlowMusic2API 音頻下載失敗（網絡層，URL=${url}）：${(e as Error)?.message ?? String(e)}`)
  }
  if (!response.ok) {
    throw new Error(`FlowMusic2API 音頻下載返回 HTTP ${response.status}（URL=${url}）。`)
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length === 0) throw new Error(`FlowMusic2API 音頻下載為空檔（URL=${url}）。`)
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mp4"
  return { audioBase64: buf.toString("base64"), mimeType: formatToMime(mimeHint, contentType) }
}

/** 調 FlowMusic2API 生成整曲並下載音頻（工具層拿到 base64 後走既有上傳/實測通路）。 */
export async function generateFlowMusicTrack(
  opts: GenerateFlowMusicTrackOptions,
): Promise<GenerateFlowMusicTrackResult> {
  const baseUrl = flowMusic2ApiUrl()
  if (!baseUrl) throw new Error("FLOWMUSIC2API_URL 未配置，FlowMusic2API 通路未啟用。")
  const prompt = opts.prompt?.trim()
  if (!prompt) throw new Error("prompt 不能为空：请提供风格+情绪描述（genre/BPM/调性/编制/氛围）。")
  const apiKey = requireApiKey()

  const content = buildFlowMusicContent(prompt, opts.lyrics)
  const payload = {
    model: opts.model,
    messages: [{ role: "user", content }],
    stream: false,
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FLOWMUSIC_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(
      `FlowMusic2API 请求失败（网络层，端点 ${baseUrl}/v1/chat/completions）：${(e as Error)?.message ?? String(e)}`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    const shown = bodyText.slice(0, ERROR_BODY_MAX_CHARS)
    throw new Error(`FlowMusic2API 返回 HTTP ${response.status}（模型 ${opts.model}）。原文 body：${shown || "(空)"}`)
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error(`FlowMusic2API 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`)
  }

  const picked = extractFlowMusicAudioUrl(body)
  const audio = await downloadAudio(picked.url, picked.mimeHint)
  const contentStr = ((body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content) as unknown
  const lyricsEcho = typeof contentStr === "string" ? extractLyricsBlock(contentStr) : undefined

  return {
    audioBase64: audio.audioBase64,
    mimeType: audio.mimeType,
    upstreamUrl: picked.url,
    ...(picked.durationHint !== undefined ? { upstreamDurationHint: picked.durationHint } : {}),
    ...(lyricsEcho ? { lyricsEcho } : {}),
  }
}
