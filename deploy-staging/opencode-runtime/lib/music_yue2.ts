/**
 * YuE2 client VPS staging 稿（music_gen 第三通路，2026-09-19 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-yue2.ts
 * 机械导出：真源全文逐行保留（端点/鉴权/HMAC 签名/契约栏位/错误铁律/600s 超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-music-tools-staging.ts` 重导出。
 *
 * 落位：/opt/eimu-harness/workspace/.opencode/lib/music_yue2.ts
 * env：YUE2_MODAL_ENDPOINT（服务地址，缺省禁用本通路）、YUE2_HMAC_SECRET（HMAC 签名密钥）。
 */

/**
 * YuE2（Modal 服务）音乐生成 client（片 B：music_gen 第三通路，2026-09-18）。
 *
 * 上游事实（冻结合约，另一片 2026-09-18 查证，照它写、不自行更名）：
 *   端点  POST {YUE2_MODAL_ENDPOINT}/generate
 *   鉴权  header `X-Yue2-Signature: <hex hmac_sha256(secret, raw_request_body_bytes)>`
 *   body  {"id": str, "style": str, "lyrics": str, "cot": "full"|"melody"|"off", "seed"?: int, "abc"?: str}
 *   200   {"ok":true, "audio_b64", "audio_bytes", "audio_sha256", "mime_type":"audio/flac",
 *          "sample_rate":48000, "channels":2, "duration_s":float, "score_abc":str|null,
 *          "truncated":{...}, "artifacts":[{"name","bytes","sha256","b64"}],
 *          "timing":{"model_load_ms","generate_ms","rtf"}, "model":"m-a-p/YuE2-3B",
 *          "vae":"m-a-p/YuE2-Vae", "gpu":str}
 *   失败  非 2xx／缺音档／下载失败 → 带原文抛出 {"ok":false,"error","detail"}
 *
 * 能力边界（决定工具文案与 director 规则，勿美化）：
 *   支援 48kHz 立体声、白盒 ABC 乐谱（可编辑、可二次精修）、cot 三模式、
 *   cover（自备 abc ＋ cot=melody）、自订歌词需 [Verse]/[Chorus] 段落标签；
 *   不支援 image-to-music、不支援时间戳结构控制（`[0:00 - 0:10]` 只有 Lyria 认）、
 *   无 30 秒短档模式、一次一请求、生成较慢（分钟级）。
 *
 * 设计（逐段同构 src/lib/music-flowmusic.ts，白名单差异只有四处：端点、鉴权、
 * request/response 栏位、env 名；其余结构照抄：零依赖、requireXxx fail-fast 人话报错、
 * 错误必带原文摘录、繁体注释＋简体文案）：
 *   - env：YUE2_MODAL_ENDPOINT（缺省→本通路停用，工具回落 FlowMusic2API／Gemini Lyria）、
 *     YUE2_HMAC_SECRET（签名密钥，缺缺失 fail-fast 人话报错）。
 *   - 错误铁律（诚实铁律）：非 2xx／ok 非 true／缺 audio_b64／JSON 非法一律带原文摘录抛出，
 *     绝不吞错、绝不静默降级、绝不伪造音频。
 *   - 工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import { createHmac, randomUUID } from "node:crypto"

/** YuE2 Modal 服务地址 env 名（缺省＝本通路停用）。 */
export const YUE2_MODAL_ENDPOINT_ENV = "YUE2_MODAL_ENDPOINT"

/** 签名密钥 env 名（与 Modal 服务侧共用的 HMAC secret；只在签名时读取，永不入错误讯息／log）。 */
export const YUE2_HMAC_SECRET_ENV = "YUE2_HMAC_SECRET"

/** 冻结合约的生成路径（相对 YUE2_MODAL_ENDPOINT）。 */
const YUE2_GENERATE_PATH = "/generate"

/** 扒谱路径（相对 YUE2_MODAL_ENDPOINT；2026-09-19 片 L 笔电 local_service.py /transcribe）。 */
const YUE2_TRANSCRIBE_PATH = "/transcribe"

/** 冻结合约的上游模型 id（响应 model 栏位；工具回执 model 用它，勿改）。 */
export const YUE2_MODEL_ID = "m-a-p/YuE2-3B"

/**
 * cot 三模式（冻结合约）：
 *   full   = 完整思维链，**唯一**会回白盒乐谱 score_abc 的模式（本片交付契约的接点）；
 *   melody = 以自备 abc 当旋律骨干（cover 改编）；
 *   off    = 关闭思维链（最快，不回乐谱）。
 */
export const YUE2_COT_MODES = ["full", "melody", "off"] as const
export type Yue2CotMode = (typeof YUE2_COT_MODES)[number]

/**
 * 非流式生成超时。YuE2-3B 在 Modal 上生成较慢（分钟级）＋冷启需载模型
 * （响应 timing.model_load_ms 自报此段），600s 硬顶；FlowMusic2API 的 300s 对本通路不够。
 */
export const YUE2_TIMEOUT_MS = 600_000

/**
 * 扒谱超时（2026-09-19 片 O）。SheetSage2 实测：载入 4.5s＋54s 歌 14–18s（片 L），
 * 但首请求含 HF 权重载入与慢速音频时余量要留足；服务端 worker 超时 900s（env
 * YUE2_LOCAL_TRANSCRIBE_TIMEOUT 缺省），client 120s 是任务书指定的最小值，
 * 取 120s 对齐 spec（超时 ≥120s）。
 */
export const YUE2_TRANSCRIBE_TIMEOUT_MS = 120_000

/** 错误讯息里携带的原文 body 上限（同 music-flowmusic.ts 口径）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** 读 YuE2 Modal 服务地址（未配置 → null，调用方回落 FlowMusic2API／Lyria）。 */
export function yue2ModalUrl(): string | null {
  const raw = (process.env[YUE2_MODAL_ENDPOINT_ENV] ?? "").trim()
  if (!raw) return null
  return raw.replace(/\/+$/, "")
}

/** 本通路是否启用（env YUE2_MODAL_ENDPOINT 非空即启用；仅判断端点，不验密钥）。 */
export function isYue2ModalEnabled(): boolean {
  return yue2ModalUrl() !== null
}

export interface GenerateYue2TrackOptions {
  /** 风格散文描述（本通路的 style 栏；允许换行，上游无公开字数上限）。 */
  style: string
  /**
   * 歌词（冻结合约必填栏位）。空字串＝无歌词：契约**无** is_instrumental 开关，
   * 器乐只能靠 style 描述（推断，非臆造栏位）。
   */
  lyrics: string
  cot: Yue2CotMode
  /** 随机种子（整数；契约选填）。 */
  seed?: number
  /** 白盒 ABC 乐谱（契约选填；cover＝自备 abc ＋ cot="melody"；cot="off" 时不接受）。 */
  abc?: string
}

/**
 * 工件元信息。上游 artifacts[].b64 的位元组**刻意不进本结构**：下游 tool 回执是
 * LLM 可见的 JSON 字串，百 MB 级 base64 会直接炸上下文；本片交付契约的白盒产物
 * ＝ scoreAbc（专用栏位），其余工件的位元组留待后续片按需取用（契约形状已冻结，
 * 取用时不必改上游）。
 */
export interface Yue2Artifact {
  name: string
  bytes: number
  sha256: string
}

/** 与 generateFlowMusicTrack 返回形状同构（audioBase64/mimeType），另带白盒乐谱与工件。 */
export interface GenerateYue2TrackResult {
  audioBase64: string
  /** 上游回报 MIME（契约为 audio/flac；缺失时按契约预设值，不猜格式）。 */
  mimeType: string
  /** 白盒 ABC 乐谱（可编辑、可二次精修）；上游回 null 表示本次未产出。 */
  scoreAbc: string | null
  /** 上游截断资讯（{...}）；null＝未回报。如实透传，不粉饰。 */
  truncated: Record<string, unknown> | null
  /** 上游自报成品时长（秒）；0＝上游未回 duration_s（契约保证有，0 不得当成 0 秒档）。 */
  durationSeconds: number
  /** 本通路无公网音频 URL（音频以 base64 回传），固定 null（形状与他路对齐用）。 */
  upstreamUrl: null
  artifacts: Yue2Artifact[]
  /** 上游自报的音频 sha256（交付校验用；缺失则 undefined）。 */
  audioSha256?: string
  /** 上游自报模型 id（缺失则 undefined）。 */
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

/** 冻结合约 request body 形状（纯函数，可单测；栏位名一个字都不许改）。 */
export interface Yue2RequestBody {
  id: string
  style: string
  lyrics: string
  cot: Yue2CotMode
  seed?: number
  abc?: string
}

/**
 * 组 request body 并做契约级校验（纯函数）。
 * 校验失败一律带人话抛出，不让非法 cot／abc 组合出门（契约 enum 只有三值）。
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
 * 冻结合约签名：hex hmac_sha256(secret, **原始 request body bytes**)。
 * 呼叫方必须签「即将送出的那一串位元组」（本档用同一个 rawBody 字串签名与发送），
 * 重新序列化后签名会对不上。
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

/** 失败讯息：HTTP 状态＋上游 error/detail（若有）＋原文摘录（永远带，诚实铁律）。 */
function upstreamFailureText(status: number, bodyText: string): string {
  const failure = asRecord(parseJsonOrNull(bodyText))
  const parts = [failure?.error, failure?.detail].filter((v): v is string => typeof v === "string" && v !== "")
  const shown = bodyText.slice(0, ERROR_BODY_MAX_CHARS)
  return `YuE2 Modal 返回 HTTP ${status}${parts.length > 0 ? `（${parts.join("；")}）` : ""}。原文 body：${shown || "(空)"}`
}

/** artifacts → 元信息（形状不符的条目整条丢弃；工件是辅助产物，不为它猜栏位）。 */
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

// ── 生成失败分型：瞬时 vs 硬（2026-10-11 事故修复）────────────────────────────
//
// 事故：YuE2 的**瞬时**故障（HTTP 429 busy／服务不可达／超时）被工具层当成硬失败，
// 静默换到付费通路 FlowMusic 并扣币（累计 5 币）。用户口径＝音乐只走 YuE2。
//
// 判定依据一律来自**实作事实**（不是猜）：
//   瞬时 transient（不得触发付费回落，应重试同一通路）：
//     · HTTP 429 —— 服务端 `busy`：本机 8GB 一次一歌，生成中拒收新请求
//       （local_service.py 生成锁未取到即 `429 err_response("busy", ...)`）；亦兼容
//       响应体 error=="busy"（等值语义，防服务端/代理变体）。
//     · HTTP 502/503/504 —— 反向隧道／网关暂时不可用，属传输层而非语义错误。
//     · 网络层失败 —— ECONNREFUSED（笔电关机/隧道断＝服务不可达）／ECONNRESET／
//       ETIMEDOUT／ENOTFOUND／fetch failed／socket hang up／不可达／请求超时
//       （AbortSignal.timeout(YUE2_TIMEOUT_MS) 触发）。
//   硬 hard（保持既有回落链不变）：其余 4xx/5xx 语义错误（400 参数错误、422、500
//     generation_failed 等）与响应契约破损（非 JSON／ok!==true／缺 audio_b64）。
//
// 客户端此前一律 `throw new Error(...)`（裸 Error，不带 status/code），工具层无从分辨，
// 只能一概回落。本次改为带 code/status/kind 的 Yue2GenerateError，使分型有可判定的
// 实作依据；同时导出 isYue2TransientFailure／yue2TransientCode 供工具层与验证使用。
export type Yue2FailureKind = "transient" | "hard"

/** YuE2 生成失败：带对外错误码、HTTP 状态与瞬时/硬分类。 */
export class Yue2GenerateError extends Error {
  code: string
  status: number
  kind: Yue2FailureKind
  constructor(code: string, status: number, kind: Yue2FailureKind, message: string) {
    super(message)
    this.code = code
    this.status = status
    this.kind = kind
    this.name = "Yue2GenerateError"
  }
}

/** HTTP 状态 → 瞬时/硬判定（429＝busy；502/503/504＝传输层暂时不可用；其余＝硬失败）。 */
export function classifyYue2HttpStatus(status: number): { kind: Yue2FailureKind; code: string } {
  if (status === 429) return { kind: "transient", code: "yue2_busy" }
  if (status === 502 || status === 503 || status === 504) return { kind: "transient", code: "yue2_unavailable" }
  return { kind: "hard", code: "yue2_upstream_error" }
}

/**
 * 瞬时判定（工具层回落前必过）。typed error 走 kind；裸 Error（旧式/外部抛）以错误讯息
 * 里既有的可辨识字串兜底——兜底依据即上方分类的落点（HTTP 429/50x、网络层关键字、
 * 服务端 busy 的「繁忙」措辞），不是凭空猜。
 */
export function isYue2TransientFailure(e: unknown): boolean {
  if (e instanceof Yue2GenerateError) return e.kind === "transient"
  const message = e instanceof Error ? e.message : String(e)
  if (/\bHTTP 429\b/.test(message)) return true
  if (/\bHTTP 50[234]\b/.test(message)) return true
  if (/繁忙|busy/i.test(message)) return true
  return /请求失败（网络层|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|不可达|timed out|timeout|aborted/i.test(
    message,
  )
}

/** 瞬时失败的对外错误码（回执用）：优先 typed code，其次按讯息分类。 */
export function yue2TransientCode(e: unknown): string {
  if (e instanceof Yue2GenerateError) return e.code
  const message = e instanceof Error ? e.message : String(e)
  if (/\bHTTP 429\b/.test(message)) return "yue2_busy"
  if (/\bHTTP 50[234]\b/.test(message)) return "yue2_unavailable"
  if (/timeout|aborted/i.test(message)) return "yue2_timeout"
  return "yue2_unreachable"
}

/**
 * 调 YuE2 Modal 生成整曲（音频以 base64 直接回传，无公网 URL 可下载）；
 * 工具层拿到 base64 后走既有上传／ffprobe 实测通路。
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
    // 网路层失败（含 AbortSignal.timeout 触发的请求超时）一律瞬时：笔电关机/隧道断＝服务不可达。
    const cause = e as Error
    const isTimeout = cause?.name === "TimeoutError" || /abort|timeout/i.test(cause?.message ?? "")
    throw new Yue2GenerateError(
      isTimeout ? "yue2_timeout" : "yue2_unreachable",
      0,
      "transient",
      `YuE2 Modal 请求失败（网络层，端点 ${baseUrl}${YUE2_GENERATE_PATH}）：${cause?.message ?? String(e)}`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    // 429 busy／502-504 传输层暂时不可用＝瞬时（不回落，重试同一通路）；其余 4xx/5xx＝硬失败（回落）。
    const { kind, code } = classifyYue2HttpStatus(response.status)
    throw new Yue2GenerateError(code, response.status, kind, upstreamFailureText(response.status, bodyText))
  }
  const parsed = parseJsonOrNull(bodyText)
  if (parsed === null) {
    throw new Yue2GenerateError(
      "yue2_bad_response",
      response.status,
      "hard",
      `YuE2 Modal 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const payload = asRecord(parsed)
  if (payload?.ok !== true) {
    const failure = [payload?.error, payload?.detail].filter(
      (v): v is string => typeof v === "string" && v !== "",
    )
    // 防御：服务端若以 HTTP 200＋{ok:false,error:"busy"} 回报「生成中」（与 429 等值语义），照样归瞬时。
    const busy = payload?.error === "busy"
    throw new Yue2GenerateError(
      busy ? "yue2_busy" : "yue2_upstream_error",
      response.status,
      busy ? "transient" : "hard",
      `YuE2 Modal 响应 ok 不为 true${failure.length > 0 ? `（${failure.join("；")}）` : ""}（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
    )
  }
  const audioBase64 = typeof payload.audio_b64 === "string" ? payload.audio_b64 : ""
  if (!audioBase64) {
    throw new Yue2GenerateError(
      "yue2_bad_response",
      response.status,
      "hard",
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

// ── 扒谱（SheetSage2 → ABC，2026-09-19 片 O：翻唱工作流前半段）────────────────

/**
 * 扒谱请求选项。audioBase64＝原始音频位元组的 base64（**不**带 data: 前缀——
 * 前缀剥除是 music-tools 工具层职责，client 只吃纯 base64，与服务端 b64decode 对齐）。
 */
export interface TranscribeYue2ScoreOptions {
  audioBase64: string
  /**
   * 只扒旋律骨干（剥和弦）。服务端缺省 true；cover 工作流（cot=melody）正是
   * melody-only 语义，故工具层带 source_audio 时固定传 true。
   */
  melodyOnly?: boolean
}

/** 扒谱结果（服务端 200 回应的白名单栏位；timing 为辅助诊断资讯不入工具回执）。 */
export interface TranscribeYue2ScoreResult {
  abc: string
  /** 服务端 warnings（如音频截断提示）；空阵列＝无警告，如实透传不粉饰。 */
  warnings: string[]
  /** 源音频时长（秒）；0＝服务端未回 source_duration_s。 */
  sourceDurationSeconds: number
}

/**
 * 错误码映射：服务端 422 `abc_missing`（音频里找不到可扒的旋律素材）是**确定性失败**
 * ——重试同一份音频不会变好，映射为专属错误码 `yue2_transcribe_abc_missing`，
 * 让上层（工具／agent）勿盲目重试（片 L 给并行片的契约：422 abc_missing 勿重试）。
 * 其余 4xx/5xx 一律 `yue2_transcribe_failed` 带原文（诚实铁律）。
 */
export const YUE2_TRANSCRIBE_ABC_MISSING_CODE = "yue2_transcribe_abc_missing"
export const YUE2_TRANSCRIBE_FAILED_CODE = "yue2_transcribe_failed"

/** 扒谱专用错误：带专属 code（422 abc_missing／其余失败），工具层以 code 决定重试语义。 */
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

/** 组扒谱 request body（纯函数；服务端只认 audio_b64／melody_only 两键，多键会被忽略但禁加）。 */
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
 * 调 YuE2 服务 /transcribe 把音频扒成 chord-free ABC 乐谱（SheetSage2）。
 * 同款 HMAC（X-Yue2-Signature = hex hmac_sha256(secret, raw body bytes)）。
 * 失败一律带原文抛 Yue2TranscribeError：422 abc_missing → 专属错误码（勿重试）；
 * 其余非 2xx／ok 非 true／缺 abc → yue2_transcribe_failed。
 */
export async function transcribeYue2Score(
  opts: TranscribeYue2ScoreOptions,
): Promise<TranscribeYue2ScoreResult> {
  const baseUrl = yue2ModalUrl()
  if (!baseUrl) throw new Error("YUE2_MODAL_ENDPOINT 未配置，YuE2 Modal 通路未启用（扒谱与生成共用同一端点）。")
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
    // 网路层／超时：与生成共用端点与隧道，带人话抛出（仍归 yue2_transcribe_failed）。
    throw new Yue2TranscribeError(
      YUE2_TRANSCRIBE_FAILED_CODE,
      0,
      `YuE2 /transcribe 请求失败（网络层，端点 ${baseUrl}${YUE2_TRANSCRIBE_PATH}）：${(e as Error)?.message ?? String(e)}`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    // 422 abc_missing＝确定性失败（这份音频扒不出旋律），映射专属错误码让上层勿重试。
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
    // 200 但无 abc＝服务端违反契约，与 422 同样是「扒不出乐谱」的确定性失败面。
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
