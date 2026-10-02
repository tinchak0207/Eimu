/**
 * YuE2 client VPS staging 稿（music_gen 第三通路，2026-09-19 機械導出）。
 *
 * 本檔由 tools/export-music-tools-staging.ts 從行為真源 src/lib/music-yue2.ts
 * 機械導出：真源全文逐行保留（端點/鑑權/HMAC 簽名/契約欄位/錯誤鐵律/600s 超時全在），
 * 零依賴、無 import，除本注釋頭外與真源逐行等價。
 * 禁止手改本檔——改真源後跑 `npx tsx tools/export-music-tools-staging.ts` 重導出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music_yue2.ts
 * env：YUE2_MODAL_ENDPOINT（服務地址，缺省禁用本通路）、YUE2_HMAC_SECRET（HMAC 簽名密鑰）。
 */

/**
 * YuE2（Modal 服務）音樂生成 client（片 B：music_gen 第三通路，2026-09-18）。
 *
 * 上游事實（凍結合約，另一片 2026-09-18 查證，照它寫、不自行更名）：
 *   端點  POST {YUE2_MODAL_ENDPOINT}/generate
 *   鑑權  header `X-Yue2-Signature: <hex hmac_sha256(secret, raw_request_body_bytes)>`
 *   body  {"id": str, "style": str, "lyrics": str, "cot": "full"|"melody"|"off", "seed"?: int, "abc"?: str}
 *   200   {"ok":true, "audio_b64", "audio_bytes", "audio_sha256", "mime_type":"audio/flac",
 *          "sample_rate":48000, "channels":2, "duration_s":float, "score_abc":str|null,
 *          "truncated":{...}, "artifacts":[{"name","bytes","sha256","b64"}],
 *          "timing":{"model_load_ms","generate_ms","rtf"}, "model":"m-a-p/YuE2-3B",
 *          "vae":"m-a-p/YuE2-Vae", "gpu":str}
 *   失敗  非 2xx／缺音檔／下載失敗 → 帶原文拋出 {"ok":false,"error","detail"}
 *
 * 能力邊界（決定工具文案與 director 規則，勿美化）：
 *   支援 48kHz 立體聲、白盒 ABC 樂譜（可編輯、可二次精修）、cot 三模式、
 *   cover（自備 abc ＋ cot=melody）、自訂歌詞需 [Verse]/[Chorus] 段落標籤；
 *   不支援 image-to-music、不支援時間戳結構控制（`[0:00 - 0:10]` 只有 Lyria 認）、
 *   無 30 秒短檔模式、一次一請求、生成較慢（分鐘級）。
 *
 * 設計（逐段同構 src/lib/music-flowmusic.ts，白名單差異只有四處：端點、鑑權、
 * request/response 欄位、env 名；其餘結構照抄：零依賴、requireXxx fail-fast 人話報錯、
 * 錯誤必帶原文摘錄、繁體註釋＋簡體文案）：
 *   - env：YUE2_MODAL_ENDPOINT（缺省→本通路停用，工具回落 FlowMusic2API／Gemini Lyria）、
 *     YUE2_HMAC_SECRET（簽名密鑰，缺缺失 fail-fast 人話報錯）。
 *   - 錯誤鐵律（誠實鐵律）：非 2xx／ok 非 true／缺 audio_b64／JSON 非法一律帶原文摘錄拋出，
 *     絕不吞錯、絕不靜默降級、絕不偽造音頻。
 *   - 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

import { createHmac, randomUUID } from "node:crypto"

/** YuE2 Modal 服務地址 env 名（缺省＝本通路停用）。 */
export const YUE2_MODAL_ENDPOINT_ENV = "YUE2_MODAL_ENDPOINT"

/** 簽名密鑰 env 名（與 Modal 服務側共用的 HMAC secret；只在簽名時讀取，永不入錯誤訊息／log）。 */
export const YUE2_HMAC_SECRET_ENV = "YUE2_HMAC_SECRET"

/** 凍結合約的生成路徑（相對 YUE2_MODAL_ENDPOINT）。 */
const YUE2_GENERATE_PATH = "/generate"

/** 扒譜路徑（相對 YUE2_MODAL_ENDPOINT；2026-09-19 片 L 筆電 local_service.py /transcribe）。 */
const YUE2_TRANSCRIBE_PATH = "/transcribe"

/** 凍結合約的上游模型 id（響應 model 欄位；工具回執 model 用它，勿改）。 */
export const YUE2_MODEL_ID = "m-a-p/YuE2-3B"

/**
 * cot 三模式（凍結合約）：
 *   full   = 完整思維鏈，**唯一**會回白盒樂譜 score_abc 的模式（本片交付契約的接點）；
 *   melody = 以自備 abc 當旋律骨幹（cover 改編）；
 *   off    = 關閉思維鏈（最快，不回樂譜）。
 */
export const YUE2_COT_MODES = ["full", "melody", "off"] as const
export type Yue2CotMode = (typeof YUE2_COT_MODES)[number]

/**
 * 非流式生成超時。YuE2-3B 在 Modal 上生成較慢（分鐘級）＋冷啟需載模型
 * （響應 timing.model_load_ms 自報此段），600s 硬頂；FlowMusic2API 的 300s 對本通路不夠。
 */
export const YUE2_TIMEOUT_MS = 600_000

/**
 * 扒譜超時（2026-09-19 片 O）。SheetSage2 實測：載入 4.5s＋54s 歌 14–18s（片 L），
 * 但首請求含 HF 權重載入與慢速音頻時餘量要留足；服務端 worker 超時 900s（env
 * YUE2_LOCAL_TRANSCRIBE_TIMEOUT 缺省），client 120s 是任務書指定的最小值，
 * 取 120s 對齊 spec（超時 ≥120s）。
 */
export const YUE2_TRANSCRIBE_TIMEOUT_MS = 120_000

/** 錯誤訊息裡攜帶的原文 body 上限（同 music-flowmusic.ts 口徑）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** 讀 YuE2 Modal 服務地址（未配置 → null，調用方回落 FlowMusic2API／Lyria）。 */
export function yue2ModalUrl(): string | null {
  const raw = (process.env[YUE2_MODAL_ENDPOINT_ENV] ?? "").trim()
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

/** 本通路是否啟用（env YUE2_MODAL_ENDPOINT 非空即啟用；僅判斷端點，不驗密鑰）。 */
export function isYue2ModalEnabled(): boolean {
  return yue2ModalUrl() !== null
}

export interface GenerateYue2TrackOptions {
  /** 風格散文描述（本通路的 style 欄；允許換行，上游無公開字數上限）。 */
  style: string
  /**
   * 歌詞（凍結合約必填欄位）。空字串＝無歌詞：契約**無** is_instrumental 開關，
   * 器樂只能靠 style 描述（推斷，非臆造欄位）。
   */
  lyrics: string
  cot: Yue2CotMode
  /** 隨機種子（整數；契約選填）。 */
  seed?: number
  /** 白盒 ABC 樂譜（契約選填；cover＝自備 abc ＋ cot="melody"；cot="off" 時不接受）。 */
  abc?: string
}

/**
 * 工件元信息。上游 artifacts[].b64 的位元組**刻意不進本結構**：下游 tool 回執是
 * LLM 可見的 JSON 字串，百 MB 級 base64 會直接炸上下文；本片交付契約的白盒產物
 * ＝ scoreAbc（專用欄位），其餘工件的位元組留待後續片按需取用（契約形狀已凍結，
 * 取用時不必改上游）。
 */
export interface Yue2Artifact {
  name: string
  bytes: number
  sha256: string
}

/** 與 generateFlowMusicTrack 返回形狀同構（audioBase64/mimeType），另帶白盒樂譜與工件。 */
export interface GenerateYue2TrackResult {
  audioBase64: string
  /** 上游回報 MIME（契約為 audio/flac；缺失時按契約預設值，不猜格式）。 */
  mimeType: string
  /** 白盒 ABC 樂譜（可編輯、可二次精修）；上游回 null 表示本次未產出。 */
  scoreAbc: string | null
  /** 上游截斷資訊（{...}）；null＝未回報。如實透傳，不粉飾。 */
  truncated: Record<string, unknown> | null
  /** 上游自報成品時長（秒）；0＝上游未回 duration_s（契約保證有，0 不得當成 0 秒檔）。 */
  durationSeconds: number
  /** 本通路無公網音頻 URL（音頻以 base64 回傳），固定 null（形狀與他路對齊用）。 */
  upstreamUrl: null
  artifacts: Yue2Artifact[]
  /** 上游自報的音頻 sha256（交付校驗用；缺失則 undefined）。 */
  audioSha256?: string
  /** 上游自報模型 id（缺失則 undefined）。 */
  model?: string
}

function requireYue2Secret(): string {
  const secret = (process.env[YUE2_HMAC_SECRET_ENV] ?? "").trim()
  if (!secret) {
    throw new Error(
      "缺少 YUE2_HMAC_SECRET（YuE2 Modal 通路 HMAC 签名密钥）。请在 harness 环境配置后重试，或清空 YUE2_MODAL_ENDPOINT 回落 FlowMusic2API／Gemini Lyria 通路。",
    )
  }
  return secret
}

/** 凍結合約 request body 形狀（純函數，可單測；欄位名一個字都不許改）。 */
export interface Yue2RequestBody {
  id: string
  style: string
  lyrics: string
  cot: Yue2CotMode
  seed?: number
  abc?: string
}

/**
 * 組 request body 並做契約級校驗（純函數）。
 * 校驗失敗一律帶人話拋出，不讓非法 cot／abc 組合出門（契約 enum 只有三值）。
 */
export function buildYue2RequestBody(opts: GenerateYue2TrackOptions): Yue2RequestBody {
  const style = opts.style?.trim()
  if (!style) {
    throw new Error("style 不能为空：请提供风格散文描述（genre/BPM/调性/编制/氛围）。")
  }
  const cot = opts.cot
  if (!YUE2_COT_MODES.includes(cot)) {
    throw new Error(`cot 只接受 "full"/"melody"/"off"，收到 "${String(cot)}"。`)
  }
  const lyrics = typeof opts.lyrics === "string" ? opts.lyrics : ""
  const abc = typeof opts.abc === "string" && opts.abc.trim() !== "" ? opts.abc : undefined
  if (abc !== undefined && cot === "off") {
    throw new Error(
      'cot="off" 时上游不接受 abc（白盒乐谱只在 "full"/"melody" 模式生效，cover 需 cot="melody"）。',
    )
  }
  if (opts.seed !== undefined && !Number.isInteger(opts.seed)) {
    throw new Error(`seed 只接受整数，收到 "${String(opts.seed)}"。`)
  }
  const body: Yue2RequestBody = { id: `yue2-${randomUUID()}`, style, lyrics, cot }
  if (opts.seed !== undefined) body.seed = opts.seed
  if (abc !== undefined) body.abc = abc
  return body
}

/**
 * 凍結合約簽名：hex hmac_sha256(secret, **原始 request body bytes**)。
 * 呼叫方必須簽「即將送出的那一串位元組」（本檔用同一個 rawBody 字串簽名與發送），
 * 重新序列化後簽名會對不上。
 */
export function signYue2Body(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 失敗訊息：HTTP 狀態＋上游 error/detail（若有）＋原文摘錄（永遠帶，誠實鐵律）。 */
function upstreamFailureText(status: number, bodyText: string): string {
  const failure = asRecord(parseJsonOrNull(bodyText))
  const parts = [failure?.error, failure?.detail].filter((v): v is string => typeof v === "string" && v !== "")
  const shown = bodyText.slice(0, ERROR_BODY_MAX_CHARS)
  return `YuE2 Modal 返回 HTTP ${status}${parts.length > 0 ? `（${parts.join("；")}）` : ""}。原文 body：${shown || "(空)"}`
}

/** artifacts → 元信息（形狀不符的條目整條丟棄；工件是輔助產物，不為它猜欄位）。 */
function pickArtifacts(raw: unknown): Yue2Artifact[] {
  if (!Array.isArray(raw)) return []
  const out: Yue2Artifact[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue
    const name = typeof record.name === "string" ? record.name : ""
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : ""
    const bytes = typeof record.bytes === "number" && Number.isFinite(record.bytes) ? record.bytes : 0
    if (!name && !sha256) continue
    out.push({ name, bytes, sha256 })
  }
  return out
}

/**
 * 調 YuE2 Modal 生成整曲（音頻以 base64 直接回傳，無公網 URL 可下載）；
 * 工具層拿到 base64 後走既有上傳／ffprobe 實測通路。
 */
export async function generateYue2Track(
  opts: GenerateYue2TrackOptions,
): Promise<GenerateYue2TrackResult> {
  const baseUrl = yue2ModalUrl()
  if (!baseUrl) throw new Error("YUE2_MODAL_ENDPOINT 未配置，YuE2 Modal 通路未启用。")
  const body = buildYue2RequestBody(opts)
  const secret = requireYue2Secret()
  const rawBody = JSON.stringify(body)
  const signature = signYue2Body(secret, rawBody)

  let response: Response
  try {
    response = await fetch(`${baseUrl}${YUE2_GENERATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Yue2-Signature": signature },
      body: rawBody,
      signal: AbortSignal.timeout(YUE2_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(
      `YuE2 Modal 请求失败（网络层，端点 ${baseUrl}${YUE2_GENERATE_PATH}）：${(e as Error)?.message ?? String(e)}`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(upstreamFailureText(response.status, bodyText))
  }
  const parsed = parseJsonOrNull(bodyText)
  if (parsed === null) {
    throw new Error(
      `YuE2 Modal 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const payload = asRecord(parsed)
  if (payload?.ok !== true) {
    const failure = [payload?.error, payload?.detail].filter(
      (v): v is string => typeof v === "string" && v !== "",
    )
    throw new Error(
      `YuE2 Modal 响应 ok 不为 true${failure.length > 0 ? `（${failure.join("；")}）` : ""}（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const audioBase64 = typeof payload.audio_b64 === "string" ? payload.audio_b64 : ""
  if (!audioBase64) {
    throw new Error(
      `YuE2 Modal 响应缺少 audio_b64（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const durationRaw = payload.duration_s
  const durationSeconds =
    typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0
  const mimeType = typeof payload.mime_type === "string" && payload.mime_type ? payload.mime_type : "audio/flac"
  const scoreAbc = typeof payload.score_abc === "string" && payload.score_abc !== "" ? payload.score_abc : null
  const truncated = asRecord(payload.truncated)

  return {
    audioBase64,
    mimeType,
    scoreAbc,
    truncated,
    durationSeconds,
    upstreamUrl: null,
    artifacts: pickArtifacts(payload.artifacts),
    ...(typeof payload.audio_sha256 === "string" && payload.audio_sha256
      ? { audioSha256: payload.audio_sha256 }
      : {}),
    ...(typeof payload.model === "string" && payload.model ? { model: payload.model } : {}),
  }
}

// ── 扒譜（SheetSage2 → ABC，2026-09-19 片 O：翻唱工作流前半段）────────────────

/**
 * 扒譜請求選項。audioBase64＝原始音頻位元組的 base64（**不**帶 data: 前綴——
 * 前綴剝除是 music-tools 工具層職責，client 只吃純 base64，與服務端 b64decode 對齊）。
 */
export interface TranscribeYue2ScoreOptions {
  audioBase64: string
  /**
   * 只扒旋律骨幹（剝和弦）。服務端缺省 true；cover 工作流（cot=melody）正是
   * melody-only 語義，故工具層帶 source_audio 時固定傳 true。
   */
  melodyOnly?: boolean
}

/** 扒譜結果（服務端 200 回應的白名單欄位；timing 為輔助診斷資訊不入工具回執）。 */
export interface TranscribeYue2ScoreResult {
  abc: string
  /** 服務端 warnings（如音頻截斷提示）；空陣列＝無警告，如實透傳不粉飾。 */
  warnings: string[]
  /** 源音頻時長（秒）；0＝服務端未回 source_duration_s。 */
  sourceDurationSeconds: number
}

/**
 * 錯誤碼映射：服務端 422 `abc_missing`（音頻裡找不到可扒的旋律素材）是**確定性失敗**
 * ——重試同一份音頻不會變好，映射為專屬錯誤碼 `yue2_transcribe_abc_missing`，
 * 讓上層（工具／agent）勿盲目重試（片 L 給並行片的契約：422 abc_missing 勿重試）。
 * 其餘 4xx/5xx 一律 `yue2_transcribe_failed` 帶原文（誠實鐵律）。
 */
export const YUE2_TRANSCRIBE_ABC_MISSING_CODE = "yue2_transcribe_abc_missing"
export const YUE2_TRANSCRIBE_FAILED_CODE = "yue2_transcribe_failed"

/** 扒譜專用錯誤：帶專屬 code（422 abc_missing／其餘失敗），工具層以 code 決定重試語義。 */
export class Yue2TranscribeError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
    this.name = "Yue2TranscribeError"
  }
}

/** 組扒譜 request body（純函數；服務端只認 audio_b64／melody_only 兩鍵，多鍵會被忽略但禁加）。 */
export function buildYue2TranscribeBody(opts: TranscribeYue2ScoreOptions): string {
  const audioBase64 = opts.audioBase64?.trim()
  if (!audioBase64) {
    throw new Error("audioBase64 不能为空：翻唱工作流需要源音频的 base64（纯 base64，不带 data: 前缀）。")
  }
  const body: { audio_b64: string; melody_only?: boolean } = { audio_b64: audioBase64 }
  if (opts.melodyOnly !== undefined) body.melody_only = opts.melodyOnly
  return JSON.stringify(body)
}

/**
 * 調 YuE2 服務 /transcribe 把音頻扒成 chord-free ABC 樂譜（SheetSage2）。
 * 同款 HMAC（X-Yue2-Signature = hex hmac_sha256(secret, raw body bytes)）。
 * 失敗一律帶原文拋 Yue2TranscribeError：422 abc_missing → 專屬錯誤碼（勿重試）；
 * 其餘非 2xx／ok 非 true／缺 abc → yue2_transcribe_failed。
 */
export async function transcribeYue2Score(
  opts: TranscribeYue2ScoreOptions,
): Promise<TranscribeYue2ScoreResult> {
  const baseUrl = yue2ModalUrl()
  if (!baseUrl) throw new Error("YUE2_MODAL_ENDPOINT 未配置，YuE2 Modal 通路未启用（扒譜與生成共用同一端點）。")
  const rawBody = buildYue2TranscribeBody(opts)
  const secret = requireYue2Secret()
  const signature = signYue2Body(secret, rawBody)

  let response: Response
  try {
    response = await fetch(`${baseUrl}${YUE2_TRANSCRIBE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Yue2-Signature": signature },
      body: rawBody,
      signal: AbortSignal.timeout(YUE2_TRANSCRIBE_TIMEOUT_MS),
    })
  } catch (e) {
    // 網路層／超時：與生成共用端點與隧道，帶人話拋出（仍歸 yue2_transcribe_failed）。
    throw new Yue2TranscribeError(
      YUE2_TRANSCRIBE_FAILED_CODE,
      0,
      `YuE2 /transcribe 请求失败（网络层，端点 ${baseUrl}${YUE2_TRANSCRIBE_PATH}）：${(e as Error)?.message ?? String(e)}`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    // 422 abc_missing＝確定性失敗（這份音頻扒不出旋律），映射專屬錯誤碼讓上層勿重試。
    const code = response.status === 422 ? YUE2_TRANSCRIBE_ABC_MISSING_CODE : YUE2_TRANSCRIBE_FAILED_CODE
    throw new Yue2TranscribeError(code, response.status, upstreamFailureText(response.status, bodyText))
  }
  const parsed = parseJsonOrNull(bodyText)
  if (parsed === null) {
    throw new Yue2TranscribeError(
      YUE2_TRANSCRIBE_FAILED_CODE,
      response.status,
      `YuE2 /transcribe 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const payload = asRecord(parsed)
  if (payload?.ok !== true) {
    const failure = [payload?.error, payload?.detail].filter(
      (v): v is string => typeof v === "string" && v !== "",
    )
    throw new Yue2TranscribeError(
      YUE2_TRANSCRIBE_FAILED_CODE,
      response.status,
      `YuE2 /transcribe 响应 ok 不为 true${failure.length > 0 ? `（${failure.join("；")}）` : ""}（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const abc = typeof payload.abc === "string" ? payload.abc : ""
  if (!abc) {
    // 200 但無 abc＝服務端違反契約，與 422 同樣是「扒不出樂譜」的確定性失敗面。
    throw new Yue2TranscribeError(
      YUE2_TRANSCRIBE_ABC_MISSING_CODE,
      response.status,
      `YuE2 /transcribe 响应缺少 abc（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === "string")
    : []
  const sourceDurationRaw = payload.source_duration_s
  const sourceDurationSeconds =
    typeof sourceDurationRaw === "number" && Number.isFinite(sourceDurationRaw) && sourceDurationRaw > 0
      ? sourceDurationRaw
      : 0
  return { abc, warnings, sourceDurationSeconds }
}
