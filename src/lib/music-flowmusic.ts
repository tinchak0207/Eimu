/**
 * FlowMusic2API 音樂生成 client（死線3 music_gen 通路換血，2026-09-09）。
 *
 * 上游事實（已查證，2026-09-09 實彈探測 + genz27/FlowMusic2API README）：
 *   端點  POST {FLOWMUSIC2API_URL}/v1/chat/completions（OpenAI 兼容，非流式）
 *   鑑權  header `Authorization: Bearer $FLOWMUSIC2API_KEY`
 *   模型  lyria（Lyria 3.5 旗艦，整歌實測 162–182s）/ lyria-fast（與 lyria 規格全等，
 *         無短檔模式，僅是快速別名）
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

/** duration_hint → FlowMusic2API 模型映射（full=旗艦整歌；clip30=僅快速別名：上游 lyria-fast 與 lyria 規格全等、無短檔模式）。 */
export const FLOWMUSIC_MODELS = {
  full: "lyria",
  clip30: "lyria-fast",
} as const

export type FlowMusicModelId = (typeof FLOWMUSIC_MODELS)[keyof typeof FLOWMUSIC_MODELS]

/** 非流式生成超時（上游整歌實測 162–182s，300s 硬頂含下載餘量）。 */
export const FLOWMUSIC_TIMEOUT_MS = 300_000

/** 音頻檔下載超時。 */
const FLOWMUSIC_DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * 候選上限（上游響應 clips 實測多數回 2 個；病理響應不得放大下載/上傳成本）。
 * 超出即截斷，回執不靜默——被截斷的候選數由 extractFlowMusicAudioCandidates 全量解析、
 * 此處只決定下載幾個。
 */
export const FLOWMUSIC_MAX_CANDIDATES = 2

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

/** 上游 clips[] 的單一音頻候選（機器可讀欄位；index 0 = 既有單 URL 路徑的主交付）。 */
export interface FlowMusicAudioCandidate {
  url: string
  /** 上游 clips[] 內的下標（0 起；content markdown 後備路徑固定 0）。 */
  candidateIndex: number
  /** 音頻格式（clips[].audio.format，如 m4a/wav/mp3）。 */
  mimeHint?: string
  /** 上游自報時長（秒）。 */
  durationHint?: number
  /** 上游標題（clips[].title，缺省即無）。 */
  title?: string
}

/** 已下載的候選音頻（供工具層逐個上傳為平台 URL）。 */
export interface FlowMusicDownloadedCandidate {
  audioBase64: string
  mimeType: string
  upstreamUrl: string
  candidateIndex: number
  /** 上游自報時長提示（秒）。 */
  upstreamDurationHint?: number
}

/** 與 generateLyriaTrack 返回形狀同構，另帶 upstreamUrl（音頻原始公網 URL，交付兜底用）。 */
export interface GenerateFlowMusicTrackResult {
  audioBase64: string
  mimeType: string
  lyricsEcho?: string
  upstreamUrl: string
  upstreamDurationHint?: number
  /** 全部已下載候選（index 0 = 既有單 URL 主交付；已按 FLOWMUSIC_MAX_CANDIDATES 截斷）。 */
  candidates: FlowMusicDownloadedCandidate[]
  /** 次候選下載失敗如實回報（主候選失敗照舊拋錯；次要候選不拖垮整次交付＝誠實降級）。 */
  candidateErrors?: Array<{ candidateIndex: number; upstreamUrl: string; error: string }>
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
 * 從響應解析**全部**音頻候選：優先頂級 clips 陣列（機器可讀，逐項取
 * url/format/duration/title），後備 content markdown `- Audio: <url>` 行
 * （README 流式/文本形態的降級路徑，固定單候選）。找不到任何候選一律拋錯（不猜）。
 * 單 URL 提取器 extractFlowMusicAudioUrl 由此包裝——全檔只有這一個解析器。
 */
export function extractFlowMusicAudioCandidates(body: unknown): FlowMusicAudioCandidate[] {
  const clips = (body as { clips?: unknown })?.clips
  if (Array.isArray(clips)) {
    const out: FlowMusicAudioCandidate[] = []
    clips.forEach((clip, index) => {
      const entry = clip as Record<string, unknown> | null | undefined
      if (!entry || typeof entry !== "object") return
      const audio = entry.audio as Record<string, unknown> | undefined
      const direct = typeof entry.audio_url === "string" ? entry.audio_url : undefined
      const nested = typeof audio?.url === "string" ? (audio.url as string) : undefined
      const url = direct || nested
      if (!url) return
      const format = audio?.format
      const duration = typeof entry.duration === "number" ? entry.duration : undefined
      const title =
        typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined
      out.push({
        url,
        candidateIndex: index,
        ...(format !== undefined ? { mimeHint: String(format) } : {}),
        ...(duration !== undefined ? { durationHint: duration } : {}),
        ...(title !== undefined ? { title } : {}),
      })
    })
    if (out.length > 0) return out
  }
  const content = ((body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content) as unknown
  if (typeof content === "string") {
    const match = content.match(/- Audio:\s*(https?:\/\/\S+)/)
    if (match) return [{ url: match[1].replace(/[)\]]+$/, ""), candidateIndex: 0 }]
  }
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  throw new Error(`FlowMusic2API 響應中未找到音頻 URL（clips 陣列與 content markdown 均無 Audio 行）。原文摘錄：${excerpt}`)
}

/**
 * 從響應解析主音頻 URL（既有單 URL 契約，向後兼容）：取全部候選的第一個。
 * 由 extractFlowMusicAudioCandidates 包裝，行為與舊版一致（同一個解析器）。
 */
export function extractFlowMusicAudioUrl(body: unknown): { url: string; mimeHint?: string; durationHint?: number } {
  const first = extractFlowMusicAudioCandidates(body)[0]
  return {
    url: first.url,
    ...(first.mimeHint !== undefined ? { mimeHint: first.mimeHint } : {}),
    ...(first.durationHint !== undefined ? { durationHint: first.durationHint } : {}),
  }
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

  const candidates = extractFlowMusicAudioCandidates(body)
  const primary = candidates[0]
  // 主候選失敗照舊拋錯（既有誠實鐵律）；次候選失敗只如實回報，不拖垮已到手的交付。
  const primaryAudio = await downloadAudio(primary.url, primary.mimeHint)
  const downloaded: FlowMusicDownloadedCandidate[] = [
    {
      audioBase64: primaryAudio.audioBase64,
      mimeType: primaryAudio.mimeType,
      upstreamUrl: primary.url,
      candidateIndex: primary.candidateIndex,
      ...(primary.durationHint !== undefined ? { upstreamDurationHint: primary.durationHint } : {}),
    },
  ]
  const candidateErrors: Array<{ candidateIndex: number; upstreamUrl: string; error: string }> = []
  for (const candidate of candidates.slice(1, FLOWMUSIC_MAX_CANDIDATES)) {
    try {
      const audio = await downloadAudio(candidate.url, candidate.mimeHint)
      downloaded.push({
        audioBase64: audio.audioBase64,
        mimeType: audio.mimeType,
        upstreamUrl: candidate.url,
        candidateIndex: candidate.candidateIndex,
        ...(candidate.durationHint !== undefined ? { upstreamDurationHint: candidate.durationHint } : {}),
      })
    } catch (e) {
      candidateErrors.push({
        candidateIndex: candidate.candidateIndex,
        upstreamUrl: candidate.url,
        error: (e as Error)?.message ?? String(e),
      })
    }
  }
  const contentStr = ((body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content) as unknown
  const lyricsEcho = typeof contentStr === "string" ? extractLyricsBlock(contentStr) : undefined

  return {
    audioBase64: primaryAudio.audioBase64,
    mimeType: primaryAudio.mimeType,
    upstreamUrl: primary.url,
    ...(primary.durationHint !== undefined ? { upstreamDurationHint: primary.durationHint } : {}),
    candidates: downloaded,
    ...(candidateErrors.length > 0 ? { candidateErrors } : {}),
    ...(lyricsEcho ? { lyricsEcho } : {}),
  }
}
