/**
 * FlowMusic2API client VPS staging 稿（死线3 music_gen 通路换血，2026-09-09 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-flowmusic.ts
 * 机械导出：真源全文逐行保留（端点/鉴权/clips 解析/下载/错误铁律/超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-music-tools-staging.ts` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_flowmusic.ts
 * env：FLOWMUSIC2API_URL（服务地址，缺省禁用本通路）、FLOWMUSIC2API_KEY（Bearer）。
 */

/**
 * FlowMusic2API 音乐生成 client（死线3 music_gen 通路换血，2026-09-09）。
 *
 * 上游事实（已查证，2026-09-09 实弹探测 + genz27/FlowMusic2API README）：
 *   端点  POST {FLOWMUSIC2API_URL}/v1/chat/completions（OpenAI 兼容，非流式）
 *   鉴权  header `Authorization: Bearer $FLOWMUSIC2API_KEY`
 *   模型  lyria（Lyria 3.5 旗舰，整歌实测 162–182s）/ lyria-fast（与 lyria 规格全等，
 *         无短档模式，仅是快速别名）
 *   歌词  无专用栏位——style prompt 与歌词全部内嵌在 message content（README 范式）；
 *         歌词段落标签 [Verse]/[Chorus] 随 content 传递，器乐在 prompt 注明 no vocals
 *   响应  顶级 clips 阵列（机器可读：clip_id/audio_url/audio.format/duration）；
 *         choices[0].message.content 为 markdown（Audio/Duration/Lyrics 块）——
 *         解析优先 clips 阵列，content markdown 作后备（诚实降级，不猜）
 *   实测  2026-09-09 VPS 实弹：HTTP 200，clips[0].audio_url 为
 *         storage.googleapis.com producer-app-public 公网 m4a（148.19s）
 *
 * 设计：
 *   - 零依赖（同构 music-lyria.ts 范式），仅用 fetch / env / 类型。
 *   - env：FLOWMUSIC2API_URL（缺省禁用本通路，工具回落 Gemini Lyria 直连）、
 *     FLOWMUSIC2API_KEY（Bearer 鉴权，缺缺失 fail-fast 人话报错）。
 *   - 错误铁律（诚实铁律）：非 2xx / 无音频 URL / 下载失败一律带原文摘录抛出，
 *     绝不吞错、绝不静默降级、绝不伪造 URL。
 *   - 工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

/** FlowMusic2API 服务地址 env 名（VPS 上为 http://127.0.0.1:8000，容器仅绑本机）。 */
const FLOWMUSIC2API_URL_ENV = "FLOWMUSIC2API_URL"

/** duration_hint → FlowMusic2API 模型映射（full=旗舰整歌；clip30=仅快速别名：上游 lyria-fast 与 lyria 规格全等、无短档模式）。 */
export const FLOWMUSIC_MODELS = {
  full: "lyria",
  clip30: "lyria-fast",
} as const

export type FlowMusicModelId = (typeof FLOWMUSIC_MODELS)[keyof typeof FLOWMUSIC_MODELS]

/** 上游错误只用于分类；账号记录、cookie 与响应原文不能进入工具回执。 */
export function classifyFlowMusicFailure(status: number, body: unknown): {
  code: string
  status: "needs_human_login" | "resource_insufficient" | "unreachable" | "config_disabled"
  label: string
  upstreamCode?: string
} {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {}
  const text = [value.code, value.detail, value.message, typeof value.error === "string" ? value.error : null, error.message, error.code]
    .filter((v): v is string => typeof v === "string").join(" ")
  const refreshCode = text.match(/\brefresh_token_(?:already_used|not_found|revoked|expired)\b/i)?.[0].toLowerCase()
  if (refreshCode || /invalid refresh token|no active FlowMusic account with usable Bearer|session.*(?:expired|revoked)|jwt.*expired/i.test(text)) {
    return { code: "flowmusic_session_expired", status: "needs_human_login", label: "FlowMusic 账号登录已失效，需要重新登录并将工作阶段交给服务器独占续期", ...(refreshCode ? { upstreamCode: refreshCode } : {}) }
  }
  if (status === 429 || /quota|resource_exhausted|insufficient (?:credits|tokens)|credits? (?:exhausted|depleted)|配额耗尽|额度不足/i.test(text)) {
    return { code: "flowmusic_resource_insufficient", status: "resource_insufficient", label: "FlowMusic 上游配额或限流不足" }
  }
  if (/invalid api key|unauthorized api key/i.test(text)) {
    return { code: "flowmusic_config_disabled", status: "config_disabled", label: "FlowMusic2API 拒绝本机 API key" }
  }
  if (/\b403\b|permission denied|forbidden|access denied/i.test(text) || status === 401 || status === 403) {
    return { code: "flowmusic_config_disabled", status: "config_disabled", label: "FlowMusic 鉴权或权限被拒绝，需检查本机 key 与上游账号权限" }
  }
  return { code: "flowmusic_unreachable", status: "unreachable", label: "FlowMusic 上游服务不可达或探针返回异常，登录状态未得到确认" }
}

export class FlowMusicServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = "FlowMusicServiceError"
  }
}

/** 非流式生成超时（上游整歌实测 162–182s，300s 硬顶含下载余量）。 */
export const FLOWMUSIC_TIMEOUT_MS = 300_000

/** 音频档下载超时。 */
const FLOWMUSIC_DOWNLOAD_TIMEOUT_MS = 120_000

/**
 * 候选上限（上游响应 clips 实测多数回 2 个；病理响应不得放大下载/上传成本）。
 * 超出即截断，回执不静默——被截断的候选数由 extractFlowMusicAudioCandidates 全量解析、
 * 此处只决定下载几个。
 */
export const FLOWMUSIC_MAX_CANDIDATES = 2

/** 读 FlowMusic2API 服务地址（未配置 → null，调用方回落 Lyria 直连通路）。 */
export function flowMusic2ApiUrl(): string | null {
  const raw = (process.env[FLOWMUSIC2API_URL_ENV] ?? "").trim()
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

/** 本通路是否启用（env FLOWMUSIC2API_URL 非空即启用）。 */
export function isFlowMusic2ApiEnabled(): boolean {
  return flowMusic2ApiUrl() !== null
}

export interface GenerateFlowMusicTrackOptions {
  prompt: string
  /** 自订歌词（[Verse]/[Chorus] 段落标签）；缺省=随 style prompt 意图（器乐需 prompt 注明）。 */
  lyrics?: string
  model: FlowMusicModelId
}

/** 上游 clips[] 的单一音频候选（机器可读栏位；index 0 = 既有单 URL 路径的主交付）。 */
export interface FlowMusicAudioCandidate {
  url: string
  /** 上游 clips[] 内的下标（0 起；content markdown 后备路径固定 0）。 */
  candidateIndex: number
  /** 音频格式（clips[].audio.format，如 m4a/wav/mp3）。 */
  mimeHint?: string
  /** 上游自报时长（秒）。 */
  durationHint?: number
  /** 上游标题（clips[].title，缺省即无）。 */
  title?: string
  /**
   * 上游回吐的风格字串（clips[].sound_prompt，实测 Lyria 会把模糊需求扩写成
   * 完整英文 Sound Prompt 后回吐；缺省不带此键）。多 take 熵决策的 soundPrompt 轴来源。
   */
  soundPrompt?: string
}

/** 已下载的候选音频（供工具层逐个上传为平台 URL）。 */
export interface FlowMusicDownloadedCandidate {
  audioBase64: string
  mimeType: string
  upstreamUrl: string
  candidateIndex: number
  /** 上游自报时长提示（秒）。 */
  upstreamDurationHint?: number
  /** 上游 clips[].title（供工具层带进 audios[] 与熵决策；缺省不带键）。 */
  title?: string
  /** 上游 clips[].sound_prompt（供工具层带进 audios[] 与熵决策；缺省不带键）。 */
  soundPrompt?: string
}

/** 与 generateLyriaTrack 返回形状同构，另带 upstreamUrl（音频原始公网 URL，交付兜底用）。 */
export interface GenerateFlowMusicTrackResult {
  audioBase64: string
  mimeType: string
  lyricsEcho?: string
  upstreamUrl: string
  upstreamDurationHint?: number
  /** 全部已下载候选（index 0 = 既有单 URL 主交付；已按 FLOWMUSIC_MAX_CANDIDATES 截断）。 */
  candidates: FlowMusicDownloadedCandidate[]
  /** 次候选下载失败如实回报（主候选失败照旧抛错；次要候选不拖垮整次交付＝诚实降级）。 */
  candidateErrors?: Array<{ candidateIndex: number; upstreamUrl: string; error: string }>
}

function requireApiKey(): string {
  const key = (process.env.FLOWMUSIC2API_KEY ?? "").trim()
  if (!key) {
    throw new Error(
      "缺少 FLOWMUSIC2API_KEY（FlowMusic2API 通路 Bearer 鉴权）。请在 harness 环境配置后重试，或取消 FLOWMUSIC2API_URL 回落 Gemini Lyria 直连通路。",
    )
  }
  return key
}

/** style prompt + 歌词合并为单条 message content（README 范式：无专用歌词栏位）。 */
export function buildFlowMusicContent(prompt: string, lyrics?: string): string {
  const parts = [prompt.trim()]
  if (lyrics && lyrics.trim()) {
    parts.push(`歌词（严格按以下段落标签与文本演唱）：\n${lyrics.trim()}`)
  }
  return parts.join("\n\n")
}

/** clips[].audio.format → MIME（m4a 实测主格式；未知格式按 content-type 后备）。 */
function formatToMime(format: unknown, fallback: string): string {
  if (format === "m4a") return "audio/mp4"
  if (format === "wav") return "audio/wav"
  if (format === "mp3") return "audio/mpeg"
  return fallback
}

/**
 * 从响应解析**全部**音频候选：优先顶级 clips 阵列（机器可读，逐项取
 * url/format/duration/title），后备 content markdown `- Audio: <url>` 行
 * （README 流式/文本形态的降级路径，固定单候选）。找不到任何候选一律抛错（不猜）。
 * 单 URL 提取器 extractFlowMusicAudioUrl 由此包装——全档只有这一个解析器。
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
      const soundPrompt =
        typeof entry.sound_prompt === "string" && entry.sound_prompt.trim()
          ? entry.sound_prompt.trim()
          : undefined
      out.push({
        url,
        candidateIndex: index,
        ...(format !== undefined ? { mimeHint: String(format) } : {}),
        ...(duration !== undefined ? { durationHint: duration } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(soundPrompt !== undefined ? { soundPrompt } : {}),
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
  throw new Error("FlowMusic2API 响应中未找到音频 URL（clips 阵列与 content markdown 均无 Audio 行）。原素材可在通路恢复后原样重交。")
}

/**
 * 从响应解析主音频 URL（既有单 URL 契约，向后兼容）：取全部候选的第一个。
 * 由 extractFlowMusicAudioCandidates 包装，行为与旧版一致（同一个解析器）。
 */
export function extractFlowMusicAudioUrl(body: unknown): { url: string; mimeHint?: string; durationHint?: number } {
  const first = extractFlowMusicAudioCandidates(body)[0]
  return {
    url: first.url,
    ...(first.mimeHint !== undefined ? { mimeHint: first.mimeHint } : {}),
    ...(first.durationHint !== undefined ? { durationHint: first.durationHint } : {}),
  }
}

/** 从 content 提取首个 ```text 歌词块作 lyrics_echo（无则 undefined）。 */
function extractLyricsBlock(content: string): string | undefined {
  const match = content.match(/```text\n([\s\S]*?)```/)
  const block = match?.[1]?.trim()
  return block ? block : undefined
}

/** 下载音频档 → base64；MIME 取 clips format，content-type 后备。 */
async function downloadAudio(
  url: string,
  mimeHint: string | undefined,
): Promise<{ audioBase64: string; mimeType: string }> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FLOWMUSIC_DOWNLOAD_TIMEOUT_MS) })
  } catch (e) {
    throw new Error(`FlowMusic2API 音频下载失败（网络层，URL=${url}）：${(e as Error)?.message ?? String(e)}`)
  }
  if (!response.ok) {
    throw new Error(`FlowMusic2API 音频下载返回 HTTP ${response.status}（URL=${url}）。`)
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length === 0) throw new Error(`FlowMusic2API 音频下载为空档（URL=${url}）。`)
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mp4"
  return { audioBase64: buf.toString("base64"), mimeType: formatToMime(mimeHint, contentType) }
}

/** 调 FlowMusic2API 生成整曲并下载音频（工具层拿到 base64 后走既有上传/实测通路）。 */
export async function generateFlowMusicTrack(
  opts: GenerateFlowMusicTrackOptions,
): Promise<GenerateFlowMusicTrackResult> {
  const baseUrl = flowMusic2ApiUrl()
  if (!baseUrl) throw new Error("FLOWMUSIC2API_URL 未配置，FlowMusic2API 通路未启用。")
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
  } catch {
    throw new FlowMusicServiceError("flowmusic_unreachable",
      "FlowMusic2API 请求失败（网络或超时）。原素材可在通路恢复后原样重交。",
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    let body: unknown = { detail: bodyText }
    try { body = JSON.parse(bodyText) } catch { /* 非 JSON 错误体也仅内部分类 */ }
    const failure = classifyFlowMusicFailure(response.status, body)
    throw new FlowMusicServiceError(failure.code, `${failure.label}（HTTP ${response.status}${failure.upstreamCode ? `，${failure.upstreamCode}` : ""}）。原素材可在通路恢复后原样重交。`)
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new FlowMusicServiceError("flowmusic_unreachable", `FlowMusic2API 响应不是合法 JSON（HTTP ${response.status}）。原素材可在通路恢复后原样重交。`)
  }

  const candidates = extractFlowMusicAudioCandidates(body)
  const primary = candidates[0]
  // 主候选失败照旧抛错（既有诚实铁律）；次候选失败只如实回报，不拖垮已到手的交付。
  const primaryAudio = await downloadAudio(primary.url, primary.mimeHint)
  const downloaded: FlowMusicDownloadedCandidate[] = [
    {
      audioBase64: primaryAudio.audioBase64,
      mimeType: primaryAudio.mimeType,
      upstreamUrl: primary.url,
      candidateIndex: primary.candidateIndex,
      ...(primary.durationHint !== undefined ? { upstreamDurationHint: primary.durationHint } : {}),
      ...(primary.title !== undefined ? { title: primary.title } : {}),
      ...(primary.soundPrompt !== undefined ? { soundPrompt: primary.soundPrompt } : {}),
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
        ...(candidate.title !== undefined ? { title: candidate.title } : {}),
        ...(candidate.soundPrompt !== undefined ? { soundPrompt: candidate.soundPrompt } : {}),
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
