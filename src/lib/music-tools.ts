/**
 * music_gen harness 工具（MOE 改革 Wave1 片B 音樂 Expert，2026-09-08）。
 *
 * 定義形狀同構 src/lib/blender-tools.ts 的 BlenderToolDef（零依賴：
 * { id, description, args, execute } + ok()/fail() 契約，回 { title, output }，
 * output 為 JSON 字串）；ok/fail 與 resolveKey 逐行同構
 * src/vendor-bridges/lib/director-common.ts（VPS 落位範式：gateway
 * /internal/session-key 解 Bearer key，fallback env HARNESS_API_KEY）。
 *
 * 生成通路：Google Lyria（src/lib/music-lyria.ts，Gemini API v1beta/interactions，
 * env GEMINI_API_KEY）。duration_hint=full → lyria-3.5（整歌 ~3 分鐘）；
 * clip30 → lyria-3-clip-preview（固定 30 秒）。無歌詞默認按純器樂處理
 * （官方寫法 "Instrumental only, no vocals."），需要人声必须提供歌词。
 *
 * prompt 規則層：buildToolPrompt 組出完整文本（含器樂聲明）後，最後一關過
 * src/lib/music-prompt-director.ts 的 directMusicPrompt（偽標籤/時間戳剝除、
 * 六層補齊、通路長度上限），回執 prompt_director 如實回報改寫/警告/截斷。
 * 順序不可顛倒：220 runes 上限要算進器樂聲明等所有字元。
 *
 * 音頻資產通路（復用既有 gateway 平台存儲，與影片/TTS 同域）：生成成功的音頻經
 * gateway 素材入庫端點 POST {GATEWAY}/internal/media/upload?session_id=<id> 落盤
 * （JSON body {path_b64, filename}，鑑權 = session_id 解析＋loopback 門，請求形狀同
 * tools/video_upload.ts），回應 url 即平台公網直連 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>），直接交付。
 * uploadOverride 允許 VPS 接線時整體替換上傳入口（備用）。
 *
 * 時長：ffprobe 實測（同 audio_first_timeline 片4 先例，沙箱有 ffprobe）；
 * ffprobe 不可用時回退 model_hint（full≈180s / clip30=30s）並如實標注
 * duration_source，絕不把估算冒充实测。
 *
 * 錯誤鐵律（同 blender-tools）：所有失敗一律結構化 fail()，含人話 hint 與
 * 底層原因，絕不 throw 原始錯誤逃逸、絕不吞錯。
 * 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  FLOWMUSIC_MODELS,
  flowMusic2ApiUrl,
  generateFlowMusicTrack,
  isFlowMusic2ApiEnabled,
  type GenerateFlowMusicTrackResult,
} from "./music-flowmusic"
import {
  LYRIA_MODELS,
  LYRIA_VERTEX_URL,
  LYRIA_VERTEX_MODEL,
  isVertexExpressKey,
  hasGeminiStudioApiKey,
  buildLyriaStylePrompt,
  generateLyriaTrack,
  type LyriaMusicContract,
  type GenerateLyriaTrackResult,
} from "./music-lyria"
import {
  YUE2_HMAC_SECRET_ENV,
  YUE2_MODEL_ID,
  YUE2_TRANSCRIBE_ABC_MISSING_CODE,
  Yue2TranscribeError,
  generateYue2Track,
  isYue2ModalEnabled,
  transcribeYue2Score,
  yue2ModalUrl,
  type GenerateYue2TrackResult,
  type Yue2CotMode,
} from "./music-yue2"
import { directMusicPrompt } from "./music-prompt-director"

// ── plumbing（ok/fail/resolveKey 同構 director-common.ts） ───────────────────

export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export type MusicToolResult = { title: string; output: string }

function ok(data: Record<string, unknown>): MusicToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): MusicToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

/** 同構 director-common resolveKey：gateway /internal/session-key 解 Bearer，fallback HARNESS_API_KEY。 */
export async function resolveKey(sessionID: string, signal?: AbortSignal): Promise<string> {
  try {
    const resp = await fetch(`${GATEWAY}/internal/session-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID }),
      signal,
    })
    if (resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { api_key?: unknown }
      if (typeof body?.api_key === "string" && body.api_key) return body.api_key
    }
  } catch {
    // gateway 無法解析 → fallback
  }
  const fallback = process.env.HARNESS_API_KEY
  if (!fallback) throw new Error("无法解析 API key：gateway 无此 session 记录且无 HARNESS_API_KEY")
  return fallback
}

export class MusicToolError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "MusicToolError"
  }
}

function toFail(e: unknown): MusicToolResult {
  if (e instanceof MusicToolError) return fail(e.code, e.message)
  return fail("music_tool_error", `music_gen 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

// ── YuE2 失敗回落 FlowMusic（2026-09-19，片 G）───────────────────────────────

/** 回落原因摘要上限（截斷防上游長原文把 LLM 可見回執撐爆）。 */
const FALLBACK_REASON_MAX_CHARS = 500

/**
 * YuE2 拋錯的回落原因摘要：錯誤訊息壓平空白、以 env 密鑰值做防禦性遮蔽
 * （music-yue2 client 的錯誤訊息本就不含密鑰，這裡是第二道保險——secret 永不入回執）、
 * 超長截斷並如實標注。
 */
function yue2FallbackReason(e: unknown): string {
  let message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim()
  const secret = (process.env[YUE2_HMAC_SECRET_ENV] ?? "").trim()
  if (secret) message = message.split(secret).join("***")
  return message.length > FALLBACK_REASON_MAX_CHARS
    ? `${message.slice(0, FALLBACK_REASON_MAX_CHARS)}…（已截断，原文 ${message.length} 字符）`
    : message
}

// ── 參數整理助手（同構 blender-tools.ts 口徑） ────────────────────────────────

export interface MusicToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface MusicToolContext {
  abort?: AbortSignal
  /**
   * 會話 id（音頻落盤目標會話；缺省時跳過上傳，result 只帶 audio_base64）。
   * VPS harness 落位後由 adapter 從 opencode session 注入。
   */
  sessionId?: string
  /** 上傳入口整體替換（備用接線）；缺省走 gateway 會話上傳端點。 */
  uploadOverride?: (audio: { bytes: Uint8Array; mimeType: string; filename: string }) => Promise<string>
}

export interface MusicToolDef {
  id: string
  description: string
  args: Record<string, MusicToolArgSpec>
  execute: (args: Record<string, unknown>, context?: MusicToolContext) => Promise<MusicToolResult>
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

/**
 * source_audio 前綴剝除（2026-09-19 片 O）：工具參數允許 data: 前綴
 * （與 reference_images 同款處理模式——agent 從 data URL/附件拿到的音頻常帶前綴），
 * client 端 /transcribe 只收純 base64（服務端 b64decode 不認前綴）。
 * 一律取**最後一個逗號**之後（data:audio/flac;base64,XXXX）。
 */
function stripDataUrlPrefix(raw: string): string {
  const commaIndex = raw.lastIndexOf(",")
  return commaIndex >= 0 ? raw.slice(commaIndex + 1).trim() : raw.trim()
}

// ── 時長實測（ffprobe；同 audio_first_timeline 片4 先例） ─────────────────────

function runFfprobeDuration(
  filePath: string,
  timeoutMs: number,
): Promise<{ ok: true; seconds: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    let stdout = ""
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, error: `ffprobe 超时（${timeoutMs} ms）` })
    }, timeoutMs)
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.code === "ENOENT" ? "ffprobe 不存在（系统未安装）" : e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const seconds = Number(stdout.trim())
      if (code === 0 && Number.isFinite(seconds) && seconds > 0) resolve({ ok: true, seconds })
      else resolve({ ok: false, error: `ffprobe 退出码 ${code ?? "null"}，stdout：${stdout.trim().slice(0, 200)}` })
    })
  })
}

/** 寫臨時檔 → ffprobe 實測時長；任何失敗回 null（調用方回退 model_hint，不冒充）。 */
async function measureAudioDuration(audioBase64: string): Promise<number | null> {
  const tmpPath = nodePath.join(os.tmpdir(), `music-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fsp.writeFile(tmpPath, Buffer.from(audioBase64, "base64"))
    const probe = await runFfprobeDuration(tmpPath, 15_000)
    return probe.ok ? probe.seconds : null
  } catch {
    return null
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
  }
}

// ── 音頻上傳（復用 gateway 會話上傳存儲，與 TTS/附件同域） ─────────────────────

const AUDIO_MIME_EXT: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  // YuE2 通路交付 FLAC（凍結合約 mime_type="audio/flac"）。缺這行副檔名會回退成 .mp3
  // ＝檔名標籤說謊（同 2026-09-11 m4a 事故）；gateway contentTypeForExt 已收 .flac。
  "audio/flac": "flac",
}

/**
 * 工具層暴露的 YuE2 cot 模式白名單（2026-09-19 片 K 開放樂譜編輯）。
 * 契約三值 full/melody/off 中只暴露前兩者：工具語義永遠要樂譜回執（score_abc），
 * off 不回樂譜、對 agent 無用，收到 "off" 一律 invalid_args 如實報錯。
 */
const YUE2_TOOL_COT_MODES: readonly Yue2CotMode[] = ["full", "melody"]

/** gateway 素材入庫端點（JSON 單筆位元組；請求形狀同 tools/video_upload.ts 的 path_b64 分支）。 */
function uploadsEndpoint(sessionId: string): string {
  return `${GATEWAY}/internal/media/upload?session_id=${encodeURIComponent(sessionId)}`
}

/**
 * 上傳音頻入庫 gateway 平台存儲，返回平台公網直連 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>）。
 * 失敗帶 HTTP 狀態與原文摘錄拋 MusicToolError（誠實鐵律，不吞錯）。
 */
async function uploadAudio(
  audio: { bytes: Uint8Array; mimeType: string },
  context: MusicToolContext | undefined,
): Promise<string> {
  if (context?.uploadOverride) {
    return context.uploadOverride({
      bytes: audio.bytes,
      mimeType: audio.mimeType,
      filename: "",
    })
  }
  const sessionId = context?.sessionId
  if (!sessionId) {
    throw new MusicToolError("upload_no_session", "未提供 sessionId（音频落盘目标会话），无法上传音频资产。")
  }
  const ext = AUDIO_MIME_EXT[audio.mimeType] ?? "mp3"
  const filename = `music-gen-${Date.now()}.${ext}`
  // 沙箱（PrivateTmp）內的位元組直傳：網關讀不到 agent FS，故 base64 內嵌 JSON body。
  const payload = { path_b64: Buffer.from(audio.bytes).toString("base64"), filename }
  let response: Response
  try {
    response = await fetch(uploadsEndpoint(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: context?.abort,
    })
  } catch (e) {
    throw new MusicToolError(
      "upload_request_failed",
      `音频上传 gateway 失败（网络层）：${(e as Error)?.message ?? String(e)}。请确认 GATEWAY_URL=${GATEWAY} 可达。`,
    )
  }
  const bodyText = await response.text().catch(() => "")
  if (!response.ok) {
    throw new MusicToolError(
      "upload_http_error",
      `音频上传 gateway 返回 HTTP ${response.status}。原文 body：${bodyText.slice(0, 2000) || "(空)"}`,
    )
  }
  let body: Record<string, unknown> | null
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    throw new MusicToolError("upload_bad_response", `音频上传响应不是合法 JSON。原文前 500 字符：${bodyText.slice(0, 500)}`)
  }
  if (body?.ok !== true) {
    throw new MusicToolError(
      "upload_bad_response",
      `音频入库 gateway 未回 ok:true（HTTP 200）。原文前 500 字符：${bodyText.slice(0, 500)}`,
    )
  }
  const url = typeof body.url === "string" && body.url ? body.url : ""
  if (!url) {
    throw new MusicToolError(
      "upload_bad_response",
      `音频入库响应缺少 url 字段（HTTP 200）。原文前 500 字符：${bodyText.slice(0, 500)}`,
    )
  }
  // 平台公網 URL 由網關回傳（store.tinchak0207.xyz/image-data/files/uploads/...），直接交付不再拼前綴。
  return url
}

// ── music_gen 工具 ───────────────────────────────────────────────────────────

// ── 免費通路健康探針（2026-09-30 R9 修復 D）─────────────────────────────────
//
// 起因：yuri OP MV 評測（SSE 5578/6098）agent 先寫完歌詞、再撞 music_all_channels_failed
// 三連敗（YuE2 OOM／FlowMusic OAuth 401／Lyria 403 SERVICE_DISABLED）。探針讓 agent 寫歌詞前
// 就知道「歌做不做得出來、卡在誰手上」。鐵律：**不觸發任何生成、不花錢**——只打
// /health、/v1/models、模型 metadata GET 與看門狗標記檔；憑證永不入回執。
// 狀態分類：ready／needs_human_login（需暴君真人登入）／config_disabled（配置/帳號設定未啟用，
// 需暴君改配置）／resource_insufficient（資源不足：顯存被佔、GPU 忙、配額耗盡）／
// unreachable（服務不可達：筆電關機、隧道斷、容器掛）。

export type MusicChannelProbeStatus =
  | "ready"
  | "needs_human_login"
  | "config_disabled"
  | "resource_insufficient"
  | "unreachable"

export interface MusicChannelProbe {
  channel: "yue2_modal" | "flowmusic2api" | "lyria_gemini"
  status: MusicChannelProbeStatus
  /** 人話結論（簡體，給 agent/用戶看）。 */
  label: string
  /** 探得的原始證據摘要（HTTP 碼/上游錯誤 reason/顯存數字），不含任何憑證。 */
  evidence: string
  /** 通路能力備註（例：YuE2 8GB 卡單首時長上限）。 */
  capability?: string
}

const PROBE_TIMEOUT_MS = 6_000
/** YuE2 在 8GB 卡的實測峰值 ≈7.3GiB（2026-09-30 R9：peak_alloc 7.32GiB）；空閒顯存低於此＝被他人佔用。 */
const YUE2_MIN_FREE_VRAM_MIB = 7_400
/** FlowMusic 看門狗在 Supabase 鏈被連坐吊銷時寫的標記檔（/opt/flowmusic2api/watchdog.py DEAD_MARKER）。 */
const FLOWMUSIC_CHAIN_DEAD_MARKER_DEFAULT = "/opt/flowmusic2api/CHAIN_DEAD"
const LYRIA_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

const PROBE_STATUS_LABEL: Record<MusicChannelProbeStatus, string> = {
  ready: "可用",
  needs_human_login: "需人工登录",
  config_disabled: "配置未启用",
  resource_insufficient: "资源不足",
  unreachable: "服务不可达",
}

async function probeFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ status: number; body: unknown; text: string } | { error: string }> {
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await resp.text().catch(() => "")
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: resp.status, body, text: text.slice(0, 300) }
  } catch (e) {
    return { error: (e as Error)?.name === "TimeoutError" ? `超时 ${timeoutMs}ms` : String((e as Error)?.message ?? e) }
  }
}

async function probeYue2(): Promise<MusicChannelProbe> {
  const channel = "yue2_modal" as const
  const base = yue2ModalUrl()
  if (!base) {
    return { channel, status: "config_disabled", label: "YuE2 通路未启用（YUE2_MODAL_ENDPOINT 未配置）", evidence: "env YUE2_MODAL_ENDPOINT 为空" }
  }
  if (!(process.env[YUE2_HMAC_SECRET_ENV] ?? "").trim()) {
    return { channel, status: "config_disabled", label: "YuE2 通路缺少签名密钥（YUE2_HMAC_SECRET 未配置）", evidence: "env YUE2_HMAC_SECRET 为空" }
  }
  const r = await probeFetch(`${base}/health`)
  if ("error" in r) {
    return {
      channel,
      status: "unreachable",
      label: "YuE2 服务不可达（笔电关机/休眠或反向隧道断开）",
      evidence: `GET /health 失败：${r.error}`,
    }
  }
  const h = (r.body ?? {}) as Record<string, unknown>
  if (r.status !== 200 || h.ok !== true) {
    return { channel, status: "unreachable", label: "YuE2 健康检查异常", evidence: `GET /health HTTP ${r.status}：${r.text}` }
  }
  if (h.hmac_key_set !== true) {
    return { channel, status: "config_disabled", label: "YuE2 服务端未配置签名密钥", evidence: "health.hmac_key_set=false" }
  }
  const budget = typeof h.ar_token_budget === "number" ? h.ar_token_budget : null
  const capability = budget
    ? `8GB 显卡单首时长上限约 ${Math.round((budget - 1035) / 25)}–${Math.round((budget - 814) / 25)} 秒（歌词越长上限越短，超出部分在尾段截断并回报 truncated）；MV/片头曲请写 TV-size 歌词（Intro+Verse+Pre-Chorus+Chorus，约 250 字以内）`
    : undefined
  if (h.state !== "idle") {
    return {
      channel,
      status: "resource_insufficient",
      label: "YuE2 显卡正忙（本机一次一首，约 2.5 分钟后再试）",
      evidence: `health.state=${String(h.state)}`,
      capability,
    }
  }
  const free = typeof h.gpu_mem_free_mib === "number" ? h.gpu_mem_free_mib : null
  const total = typeof h.gpu_mem_total_mib === "number" ? h.gpu_mem_total_mib : null
  if (free !== null && free < YUE2_MIN_FREE_VRAM_MIB) {
    return {
      channel,
      status: "resource_insufficient",
      label: `YuE2 显存不足（空闲 ${free}MiB < 需要 ${YUE2_MIN_FREE_VRAM_MIB}MiB，显卡被其他进程占用）`,
      evidence: `gpu_mem_free_mib=${free} total=${total}`,
      capability,
    }
  }
  return {
    channel,
    status: "ready",
    label: "YuE2 可用（带人声整歌，含可编辑 ABC 乐谱）",
    evidence: `health idle，gpu=${String(h.gpu)}，显存空闲 ${free ?? "未知"}/${total ?? "未知"}MiB`,
    capability,
  }
}

async function probeFlowMusic(): Promise<MusicChannelProbe> {
  const channel = "flowmusic2api" as const
  const base = flowMusic2ApiUrl()
  if (!base) {
    return { channel, status: "config_disabled", label: "FlowMusic2API 通路未启用（FLOWMUSIC2API_URL 未配置）", evidence: "env FLOWMUSIC2API_URL 为空" }
  }
  const key = (process.env.FLOWMUSIC2API_KEY ?? "").trim()
  if (!key) {
    return { channel, status: "config_disabled", label: "FlowMusic2API 缺少 FLOWMUSIC2API_KEY", evidence: "env FLOWMUSIC2API_KEY 为空" }
  }
  const health = await probeFetch(`${base}/health`)
  if ("error" in health || health.status !== 200) {
    return {
      channel,
      status: "unreachable",
      label: "FlowMusic2API 服务不可达（容器未运行）",
      evidence: "error" in health ? `GET /health 失败：${health.error}` : `GET /health HTTP ${health.status}`,
    }
  }
  const models = await probeFetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!("error" in models) && (models.status === 401 || models.status === 403)) {
    return { channel, status: "config_disabled", label: "FlowMusic2API 拒绝本机 API key", evidence: `GET /v1/models HTTP ${models.status}` }
  }
  // 真鑑權探針（2026-10-02 修假綠燈）：/health 200 與 /v1/models 只證明容器活著＋本機 API key 有效，
  // 不證明上游帳號 session 還能出曲。真 oracle = 用 admin 帳號打 POST /api/tokens/1/refresh-credits：
  // 唯讀、不生成、比 /test 更省（任務 3b）。失敗才判 unreachable/needs_human_login；CHAIN_DEAD 僅附加訊號。
  const adminUser = (process.env.FLOWMUSIC_ADMIN_USER ?? "").trim()
  const adminPass = (process.env.FLOWMUSIC_ADMIN_PASSWORD ?? "").trim()
  const marker = (process.env.FLOWMUSIC_CHAIN_DEAD_MARKER ?? "").trim() || FLOWMUSIC_CHAIN_DEAD_MARKER_DEFAULT
  const dead = await fsp.readFile(marker, "utf8").catch(() => null)
  const deadEvidence = dead !== null ? `看门狗标记 ${marker}：${dead.replace(/\s+/g, " ").trim().slice(0, 120)}` : ""
  if (!adminUser || !adminPass) {
    return {
      channel,
      status: "unreachable",
      label: "FlowMusic2API 无法做真鉴权探针（缺少 FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD）",
      evidence: `GET /health 200，/v1/models 通过，但缺 admin 凭据无法验证上游账号会话${deadEvidence ? "；" + deadEvidence : ""}`,
      capability: "配置 FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD 后探针会打 /api/tokens/1/refresh-credits 做真鉴权验证",
    }
  }
  const login = await probeFetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPass }),
  })
  const token = !("error" in login) && login.status === 200 ? (login.body as { token?: unknown })?.token : null
  if (typeof token !== "string" || !token) {
    return {
      channel,
      status: "config_disabled",
      label: "FlowMusic2API admin 登录失败（FLOWMUSIC_ADMIN_USER／PASSWORD 不符）",
      evidence: `POST /api/admin/login ${"error" in login ? `失败：${login.error}` : `HTTP ${login.status}`}${deadEvidence ? "；" + deadEvidence : ""}`,
    }
  }
  const credits = await probeFetch(`${base}/api/tokens/1/refresh-credits`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, 20_000)
  if ("error" in credits) {
    return {
      channel,
      status: "unreachable",
      label: "FlowMusic2API 真鉴权探针请求失败（服务/网络）",
      evidence: `POST /api/tokens/1/refresh-credits 失败：${credits.error}${deadEvidence ? "；" + deadEvidence : ""}`,
    }
  }
  const cr = (credits.body ?? {}) as { credits?: unknown; success?: unknown }
  if (credits.status === 200 && typeof cr.credits === "number" && cr.credits >= 0) {
    return {
      channel,
      status: "ready",
      label: "FlowMusic2API 可用（Lyria 3.5 整歌，带人声）",
      evidence: `GET /health 200，/v1/models 通过，真鉴权 POST /api/tokens/1/refresh-credits 200 credits=${cr.credits}${deadEvidence ? "；" + deadEvidence : ""}`,
    }
  }
  // refresh-credits 非 200 ⇒ 上游账号会话失效（比 CHAIN_DEAD 更早、更真）；CHAIN_DEAD 只是附加证据。
  return {
    channel,
    status: "needs_human_login",
    label: "FlowMusic 账号会话已失效，需要暴君在真实 Chrome 重新登录 flowmusic.app 并导出 cookie 换血",
    evidence: `真鉴权 POST /api/tokens/1/refresh-credits HTTP ${credits.status}：${JSON.stringify(cr).slice(0, 200)}${deadEvidence ? "；" + deadEvidence : ""}`,
  }
}

async function probeLyria(): Promise<MusicChannelProbe> {
  const channel = "lyria_gemini" as const
  const studioKey = (process.env.GEMINI_STUDIO_API_KEY ?? "").trim()
  const vertexKey = (process.env.GEMINI_API_KEY ?? "").trim()
  const vocalCap = "Gemini Lyria 3.5：带歌词人声整歌（lyria-3.5）；clip30 走 lyria-3-clip-preview"
  if (studioKey) {
    // Gemini Studio（generativelanguage）lyria-3.5：能出带歌词人声整歌。GET 模型元数据免费。
    // 注意：GET 200 只证明 key/模型可达，不代表付费配额可用（无付费额度时真实生成才回 429 RESOURCE_EXHAUSTED）。
    const r = await probeFetch(`${LYRIA_MODELS_BASE_URL}/${LYRIA_MODELS.full}`, { headers: { "x-goog-api-key": studioKey } })
    if ("error" in r) {
      return { channel, status: "unreachable", label: "Gemini API 不可达", evidence: `GET models/${LYRIA_MODELS.full} 失败：${r.error}`, capability: vocalCap }
    }
    const err = ((r.body ?? {}) as { error?: { status?: string; message?: string; details?: Array<{ reason?: string }> } }).error
    const reasons = (err?.details ?? []).map((d) => d?.reason).filter(Boolean).join(",")
    const evidence = `GET models/${LYRIA_MODELS.full} HTTP ${r.status}${err ? ` ${err.status ?? ""} ${reasons}`.trimEnd() : ""}（元数据探针；付费配额需真实生成才可证）`
    if (r.status === 200) {
      return { channel, status: "ready", label: "Gemini Lyria 3.5 可用（lyria-3.5，带人声整歌，按量付费）", evidence, capability: vocalCap }
    }
    if (r.status === 403 && /SERVICE_DISABLED/.test(`${reasons} ${err?.message ?? ""}`)) {
      const project = /project (\d+)/.exec(err?.message ?? "")?.[1]
      return {
        channel,
        status: "config_disabled",
        label: `Gemini API 未在 GCP 项目${project ? ` ${project}` : ""} 启用（需暴君在 Google Cloud 控制台启用 generativelanguage.googleapis.com）`,
        evidence,
        capability: vocalCap,
      }
    }
    if (r.status === 429) return { channel, status: "resource_insufficient", label: "Gemini Lyria 配额/限流耗尽", evidence, capability: vocalCap }
    return { channel, status: "config_disabled", label: "Gemini API key 或项目权限异常", evidence, capability: vocalCap }
  }
  if (vertexKey && isVertexExpressKey(vertexKey)) {
    // Vertex express：POST 空 instances 的免費探針——鑑權通過回 400 "Empty instances"（不生成不計費），
    // key 無效回 401，限額回 429。注意 ready 只代表「純器樂 30s 可出」，不等於能唱歌（見 capability）。
    const v = await probeFetch(LYRIA_VERTEX_URL, {
      method: "POST",
      headers: { "x-goog-api-key": vertexKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [] }),
    }, 25_000) // Vertex 對空請求的 400 實測也要 ~10s，6s 預設會把健康通路誤判不可達
    const vcap = `Vertex ${LYRIA_VERTEX_MODEL}：仅纯器乐、约 30 秒、WAV；不支持歌词/人声/参考图（歌词会被忽略并在回执标注）`
    if ("error" in v) return { channel, status: "unreachable", label: "Vertex AI 不可达", evidence: `POST ${LYRIA_VERTEX_MODEL}:predict 失败：${v.error}`, capability: vcap }
    const verr = ((v.body ?? {}) as { error?: { status?: string } }).error
    const vev = `POST ${LYRIA_VERTEX_MODEL}:predict(空 instances) HTTP ${v.status}${verr?.status ? ` ${verr.status}` : ""}`
    if (v.status === 400 && verr?.status === "INVALID_ARGUMENT") {
      return { channel, status: "ready", label: "Vertex Lyria-002 可用（仅纯器乐 30 秒，无人声）", evidence: vev, capability: vcap }
    }
    if (v.status === 429) return { channel, status: "resource_insufficient", label: "Vertex Lyria 配额/限流耗尽", evidence: vev, capability: vcap }
    return { channel, status: "config_disabled", label: "Vertex express key 无效或项目权限异常", evidence: vev, capability: vcap }
  }
  return {
    channel,
    status: "config_disabled",
    label: "Gemini Lyria 通路未启用（GEMINI_STUDIO_API_KEY 与 GEMINI_API_KEY 均未配置）",
    evidence: "env GEMINI_STUDIO_API_KEY 与 GEMINI_API_KEY 均为空",
  }
}

/** 三通路並發探針（免費、不生成）。回執供 agent 開局決策：寫不寫歌詞、寫多長、要不要先找暴君。 */
export async function probeMusicChannels(): Promise<{
  channels: MusicChannelProbe[]
  can_generate_vocal_song: boolean
  first_ready: MusicChannelProbe["channel"] | null
  can_generate_instrumental: boolean
  human_actions: string[]
}> {
  const channels = await Promise.all([probeYue2(), probeFlowMusic(), probeLyria()])
  const firstReady = channels.find((c) => c.status === "ready")?.channel ?? null
  const humanActions = channels
    .filter((c) => c.status === "needs_human_login" || c.status === "config_disabled")
    .map((c) => `${c.channel}：${c.label}`)
  // 誠實：無 GEMINI_STUDIO_API_KEY 時 Lyria 只剩 Vertex lyria-002（純器樂 30s），不能算「能唱歌」。
  const vocalCapable = (c: MusicChannelProbe) =>
    c.status === "ready" && !(c.channel === "lyria_gemini" && !hasGeminiStudioApiKey())
  const canVocal = channels.some(vocalCapable)
  const canInstrumental = channels.some((c) => c.status === "ready")
  return {
    channels,
    can_generate_vocal_song: canVocal,
    can_generate_instrumental: canInstrumental,
    first_ready: firstReady,
    human_actions: humanActions,
  }
}

/**
 * 情緒契約 → prompt（工具層薄組裝：契約欄位從 prompt 文本解析不了，所以工具參數
 * 只收自由文本 prompt；結構標籤/時間戳由調用方寫進 prompt 文本。lyrics 缺省=純器樂）。
 */
function buildToolPrompt(rawPrompt: string, hasLyrics: boolean): string {
  if (hasLyrics) return rawPrompt.trim()
  // 無歌詞 → 官方器樂寫法收尾（若 prompt 已聲明 vocal 意圖則尊重原文不重複加）。
  if (/instrumental only|no vocals/i.test(rawPrompt)) return rawPrompt.trim()
  return `${rawPrompt.trim()} Instrumental only, no vocals.`
}

export const musicGenTool: MusicToolDef = {
  id: "music_gen",
  description:
    "调用 Lyria／FlowMusic2API／YuE2 生成音乐（主题曲/插曲/配乐）。整歌或快速生成，返回音频 URL、时长与歌词回显；YuE2 通路另返回可编辑的白盒 ABC 乐谱 score_abc（可二次精修），且支持带谱重渲染——传入 abc（自备/已编辑的 ABC 乐谱）＋cot_mode 即以该乐谱为约束重新生成录音（乐谱编辑＝改和弦/改谱后重渲染出新版本，仅 YuE2 通路有效），或传入 source_audio（源音频 base64，可带 data: 前缀）走翻唱工作流——先自动扒谱（SheetSage2 提取旋律骨干）再以新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式，伴奏自由适配新风格；显式传 full 则保留原曲和声重渲染）。无歌词时按纯器乐处理；需要人声必须提供歌词。写歌词前先传 probe=true 做免费通路体检（不生成、不计费），确认 can_generate_vocal_song 再动笔。通路由环境配置固定（优先序 YuE2 > FlowMusic2API > Gemini Lyria 直连），三通路能力有差异，见各参数说明。",
  args: {
    probe: {
      type: "boolean",
      required: false,
      description:
        "true=只做免费通路健康探针（不生成音乐、不花钱、不需要 prompt），返回每条通路状态：ready 可用／needs_human_login 需人工登录／config_disabled 配置未启用／resource_insufficient 资源不足（显存/GPU 忙/配额）／unreachable 服务不可达，以及 can_generate_vocal_song 与 YuE2 时长上限。写歌词前先调一次。",
    },
    prompt: {
      type: "string",
      // 生成時必填（execute 內校驗並回 invalid_args）；schema 放寬是為了 probe=true 可單獨調用。
      required: false,
      description:
        "生成时必填（probe=true 时可省略）。风格+情绪描述：genre/BPM/调性/编制/氛围。可写结构标签（[Verse]/[Chorus]）或时间戳结构（[0:00 - 0:10] Intro:）。例：cinematic orchestral, 90 BPM, key of D minor, mood: heroic and sweeping。注意：时间戳结构只对 Gemini Lyria 直连通路生效，FlowMusic2API 与 YuE2 通路不认时间戳（会被剥除并如实标注）。",
    },
    lyrics: {
      type: "string",
      required: false,
      description:
        "自定义歌词（可选）。支持 [Verse]/[Chorus]/[Bridge] 段落标签或 [0:00 - 0:10] 时间戳结构；歌词语言跟随 prompt 语言。YuE2 通路要求自定义歌词带 [Verse]/[Chorus] 段落标签（上游语法必需）。缺省=纯器乐（Instrumental only, no vocals）。",
    },
    duration_hint: {
      type: "string",
      required: false,
      enum: ["full", "clip30"],
      description:
        "full=整歌（约 2.5 分钟），clip30=快速生成（上游无 30 秒片段模式，实际为快速整歌）。默认 full。YuE2 通路无时长控制（成品长度由模型决定，回执 duration_seconds 为上游自报实测值）且不支持 clip30——传 clip30 会直接报错，请改传 full。",
    },
    reference_images: {
      type: "string",
      required: false,
      description:
        "MV 分镜/参考图（可选，图生乐）：base64（允许 data: 前缀），多张用英文逗号分隔，最多 10 张。注意：仅 Gemini 直连通路支持，FlowMusic2API 与 YuE2 通路会忽略并如实标注（YuE2 上游不支持图生乐）。",
    },
    abc: {
      type: "string",
      required: false,
      description:
        '自备/已编辑的 ABC 乐谱（可选，仅 YuE2 通路有效）：传入即以该乐谱为约束重新渲染（乐谱编辑工作流——改和弦/改谱 → 新录音）。来源通常是上一次 music_gen 回执的 score_abc（可先编辑再传回）。编辑建议守住不变量：vocal/instrumental 旋律音符、时值、小节线、段落顺序、tempo（除非刻意改，改 tempo 用显式声明）。注意：编辑不是降噪重绘——不保证相同演唱/音色/波形，每次编辑都会生成新版本；其他通路（FlowMusic2API／Gemini Lyria）不认乐谱，传了会直接报错（不静默忽略）。',
    },
    cot_mode: {
      type: "string",
      required: false,
      enum: ["full", "melody"],
      description:
        'YuE2 乐谱约束模式（可选，默认 full，仅 YuE2 通路有效）：full=旋律与和弦都被乐谱约束（编辑工作流）；melody=只约束旋律，伴奏自由适配新风格（翻唱/改编模式）。melody 模式必须传 abc（其语义就是「以 abc 为旋律骨干」）。仅在与 abc 搭配时有意义；无 abc 时保持默认 full。注意：传 source_audio（翻唱）时本参数缺省自动取 melody（官方翻唱模式），显式传 full 则保留原曲和声重渲染。',
    },
    source_audio: {
      type: "string",
      required: false,
      description:
        "翻唱工作流：源音频 base64（可选，可带 data: 前缀，仅 YuE2 通路有效）。传入即走翻唱——先自动扒谱（SheetSage2 从源音频提取旋律骨干 ABC，回执 transcribed_abc_sha256/transcribe_warnings 如实回报），再以 prompt 描述的新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式：只保留旋律骨干，伴奏自由适配新风格）。与 abc 参数互斥（一个要现扒谱、一个已自备乐谱，同传报错）。其他通路（FlowMusic2API／Gemini Lyria）不支持翻唱，传了会直接报错（不静默忽略）；扒谱/生成失败也直接报错不回落（翻唱语义不可被无谱通路顶替）。",
    },
  },
  async execute(rawArgs, context) {
    try {
      if (rawArgs.probe === true || rawArgs.probe === "true") {
        const report = await probeMusicChannels()
        const summary = report.channels.map((c) => `${c.channel}=${PROBE_STATUS_LABEL[c.status]}`).join("，")
        return ok({
          title: report.can_generate_vocal_song
            ? `音乐通路可用（${report.first_ready}）`
            : report.can_generate_instrumental
              ? `仅纯器乐可用（${report.first_ready}），不能出人声歌曲`
              : "音乐通路全部不可用",
          mode: "probe",
          summary,
          ...report,
          hint: report.can_generate_vocal_song
            ? `可以写歌：生成会先走 ${report.first_ready}。${report.channels.find((c) => c.channel === report.first_ready)?.capability ?? ""}`
            : report.can_generate_instrumental
              ? `现在只能出纯器乐（无人声）。需要人声歌曲先别写歌词；把 human_actions 原样告诉用户。纯器乐/BGM 需求可直接生成。`
              : `现在做不出带人声的歌，先别写歌词；把 human_actions 原样告诉用户，等其处理后再探针。`,
        })
      }
      const prompt = asString(rawArgs.prompt)
      if (!prompt) {
        return fail("invalid_args", "缺少必填参数 prompt：需要风格+情绪描述（genre/BPM/调性/编制/氛围）。")
      }
      const lyrics = asString(rawArgs.lyrics)
      const durationHintRaw = asString(rawArgs.duration_hint) ?? "full"
      if (durationHintRaw !== "full" && durationHintRaw !== "clip30") {
        return fail("invalid_args", `duration_hint 只接受 "full" 或 "clip30"，收到 "${durationHintRaw}"。`)
      }
      const toolPrompt = buildToolPrompt(prompt, Boolean(lyrics))

      // ── 樂譜編輯參數（片 K，2026-09-19）────────────────────────────────────
      // abc＝自備/已編輯 ABC 樂譜（官方 editing.md 語義：同生成器、帶修改後的樂譜再渲染
      // 一次）；cot_mode＝樂譜約束模式（full=旋律+和弦都約束／melody=只約束旋律、伴奏
      // 自由適配＝翻唱模式）。僅 YuE2 通路有效——其他通路不認樂譜，如實報錯不靜默忽略
      //（靜默忽略＝讓 agent 誤以為帶譜語義已生效，比報錯更糟）。
      const abc = asString(rawArgs.abc)
      // ── 翻唱參數（片 O，2026-09-19）────────────────────────────────────────
      // source_audio＝源音頻 base64（允 data: 前綴，同 reference_images 處理模式）。
      // 語義＝翻唱：先 transcribeYue2Score 扒出旋律骨幹 ABC，再帶 abc 生成。
      // 互斥：source_audio 與 abc 同傳＝語義衝突（一個要現扒、一個已自備）→ invalid_args。
      const sourceAudioRaw = asString(rawArgs.source_audio)
      if (sourceAudioRaw && abc) {
        return fail(
          "invalid_args",
          "source_audio 与 abc 互斥：source_audio＝现场扒谱（从源音频提取旋律骨干），abc＝已自备/已编辑的乐谱，两者同传语义冲突。请只传其一。",
        )
      }
      // cot_mode 缺省：常規＝full；翻唱（帶 source_audio）＝melody（官方翻唱模式：
      // 只保留旋律骨幹、伴奏自由適配新風格）；顯式傳 full 也允許＝保留原和聲的重渲染。
      const cotModeExplicit = asString(rawArgs.cot_mode)
      const cotModeRaw = cotModeExplicit ?? (sourceAudioRaw ? "melody" : "full")
      if (!YUE2_TOOL_COT_MODES.includes(cotModeRaw as Yue2CotMode)) {
        return fail(
          "invalid_args",
          `cot_mode 只接受 "full" 或 "melody"，收到 "${cotModeRaw}"（"off" 不对工具开放：工具语义永远要求乐谱回执 score_abc，off 模式不回乐谱且对编辑工作流无用）。`,
        )
      }
      const cotMode = cotModeRaw as Yue2CotMode
      // melody 無樂譜來源（既無 abc 也無 source_audio）＝語義不成立；帶 source_audio
      // 時 abc 由扒譜補上，不適用本規則。
      if (cotMode === "melody" && !abc && !sourceAudioRaw) {
        return fail(
          "invalid_args",
          'cot_mode="melody" 必须搭配 abc 参数：melody 模式的语义就是「以传入的 ABC 乐谱为旋律骨干（伴奏自由适配）」，没有 abc 无意义。请补传 abc，或改用默认 full。',
        )
      }
      const abcSha256 = abc ? createHash("sha256").update(abc, "utf8").digest("hex") : null

      // 通路選擇（2026-09-09 換血，2026-09-18 加第三通路）：env YUE2_MODAL_ENDPOINT 非空
      // → YuE2 Modal（白盒 ABC 樂譜、cot、無時長控制）；否則 FLOWMUSIC2API_URL 配置即走
      // FlowMusic2API（lyria 整歌 / lyria-fast 快速；上游無 30s 片段模式，clip30 映射快速別名）；
      // 兩者皆未配置回落 Gemini Lyria interactions 直連。三路返回形狀同構
      // （audioBase64/mimeType），下游上傳/ffprobe 實測/交付形狀完全不變。
      // 2026-09-19 加失敗回落：YuE2 服務跑在筆電上（反向隧道進 VPS），筆電關機/隧道
      // 斷線時 generateYue2Track 拋錯（網路層/超時/非 2xx）→ 自動回落 FlowMusic 完整
      // 重跑一次，音樂管線不因單通路故障而壞（見下方生成段）。
      // YuE2 是「歌詞→整歌」：純器樂（無歌詞）或 30 秒短檔它兌現不了（上游 400「lyrics must be
      // a non-empty string」／無時長欄位）。有別的通路在場就讓位給它們，而不是先撞 YuE2 再報錯
      //（2026-09-29 e2e：「咖啡店背景音樂 30 秒」兩種都撞牆）。abc／翻唱委託仍必走 YuE2。
      const otherMusicChannel = isFlowMusic2ApiEnabled() || hasGeminiStudioApiKey() || Boolean(process.env.GEMINI_API_KEY?.trim())
      const yue2Enabled =
        isYue2ModalEnabled() &&
        (abc !== undefined || sourceAudioRaw !== undefined || !otherMusicChannel || (Boolean(lyrics) && durationHintRaw !== "clip30"))
      const flowMusicEnabled = isFlowMusic2ApiEnabled()
      const flowMusicModel = FLOWMUSIC_MODELS[durationHintRaw === "clip30" ? "clip30" : "full"]
      const lyriaModel = durationHintRaw === "clip30" ? LYRIA_MODELS.clip30 : LYRIA_MODELS.full

      // YuE2 無 30 秒短檔模式（凍結合約根本沒有時長欄位）：如實報錯，絕不靜默生成整歌再
      // 假裝是 30 秒。理由：clip30 的委託語義是「短檔對時」（MV 對點），上游產不出來；
      // 硬吞會讓回執 duration_hint=clip30 與實際成品互相矛盾＝說謊，且 YuE2 一次生成是
      // 分鐘級，先失敗比燒完才報廢便宜；hint 直接給可執行的下一步。
      // 注意：這是參數性 fail（委託本身不合法，我們在上游前自己拒的），不是 YuE2 服務
      // 拋錯——不觸發回落，語義與「隧道斷線」不同。
      if (yue2Enabled && durationHintRaw === "clip30") {
        return fail(
          "unsupported_duration_hint",
          'YuE2 通路无 30 秒短档模式（上游契约无时长控制）；请改传 duration_hint="full" 走整歌，或改用 FlowMusic2API／Gemini Lyria 通路。',
        )
      }

      // 帶 abc 的委託在非 YuE2 通路＝通路能力不匹配，如實報錯不靜默忽略（clip30 同款
      // 參數性 fail 語義：委託本身帶了通路兌現不了的語義，上游前自己拒，不觸發回落）。
      if (abc && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_abc",
          "abc（ABC 乐谱重渲染）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 abc 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 不认乐谱，静默忽略会让乐谱语义凭空丢失。",
        )
      }

      // 帶 source_audio 的委託（翻唱）同樣僅 YuE2 通路：扒譜（/transcribe）與帶譜生成
      // 都是 YuE2 服務能力，其他通路兌現不了「以這首歌的旋律骨幹重新演繹」的語義。
      // 同款參數性 fail（上游前自己拒，零上游請求，不觸發回落）。
      if (sourceAudioRaw && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_source_audio",
          "source_audio（翻唱：扒谱＋重演绎）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 source_audio 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 无扒谱能力，静默忽略会让翻唱语义凭空丢失。",
        )
      }

      // 確定性規則層（Music Prompt Director）必須是送上游前的最後一關：
      // 先讓 buildToolPrompt 組出含器樂聲明的完整文本，再過 director 做偽標籤/時間戳
      // 剝除、六層補齊與長度上限——220 runes 上限必須把器樂聲明等所有字元算進去，
      // 提前過 director 會讓後加的聲明把長度頂爆（且 strip-timestamps 只認 flowmusic/yue2）。
      let directorChannel: "yue2" | "flowmusic" | "lyria" = yue2Enabled
        ? "yue2"
        : flowMusicEnabled
          ? "flowmusic"
          : "lyria"
      const initialLyriaInstrumental = directorChannel === "lyria" && !hasGeminiStudioApiKey()
      let directed = directMusicPrompt(initialLyriaInstrumental ? buildToolPrompt(prompt, false) : toolPrompt, {
        channel: directorChannel,
        hasLyrics: initialLyriaInstrumental ? false : Boolean(lyrics),
        durationSeconds: durationHintRaw === "clip30" ? 30 : undefined,
      })
      let finalPrompt = directed.prompt

      const imagesBase64 = (asString(rawArgs.reference_images) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")

      // ── 翻唱：先扒譜（片 O，2026-09-19）──────────────────────────────────
      // source_audio → transcribeYue2Score 得旋律骨幹 ABC（melodyOnly=true 與 cot=melody
      // 語義對齊）。扒譜拋錯（含 422 abc_missing 確定性失敗）→ 帶專屬錯誤碼 fail，
      // **不回落**（翻唱語義不可被無譜通路頂替，同帶 abc 不回落的誠實鐵律）。
      let effectiveAbc: string | undefined = abc
      let transcribedAbcSha256: string | null = null
      let transcribeWarnings: string[] | null = null
      if (sourceAudioRaw) {
        let transcribed: Awaited<ReturnType<typeof transcribeYue2Score>>
        try {
          transcribed = await transcribeYue2Score({
            audioBase64: stripDataUrlPrefix(sourceAudioRaw),
            melodyOnly: true,
          })
        } catch (e) {
          if (e instanceof Yue2TranscribeError) {
            // abc_missing（422）＝這份音頻扒不出旋律，重試同一份不會變好，hint 如實說。
            return fail(
              e.code,
              e.code === YUE2_TRANSCRIBE_ABC_MISSING_CODE
                ? `翻唱扒谱失败（源音频中找不到可提取的旋律素材，服务端 422 abc_missing——确定性失败，换源音频或改传 abc，勿重试同一份音频）：${e.message}`
                : `翻唱扒谱失败（/transcribe）：${e.message}`,
            )
          }
          throw e
        }
        effectiveAbc = transcribed.abc
        transcribedAbcSha256 = createHash("sha256").update(transcribed.abc, "utf8").digest("hex")
        transcribeWarnings = transcribed.warnings
      }
      // 實際送生成的樂譜指紋：帶 abc＝委託譜；翻唱＝扒譜產物（與 transcribed_abc_sha256 同值）。
      const effectiveAbcSha256 = effectiveAbc
        ? createHash("sha256").update(effectiveAbc, "utf8").digest("hex")
        : null

      // ── 生成＋失敗回落（2026-09-19）────────────────────────────────────────
      // yue2 啟用且 generateYue2Track 拋錯（網路層/超時/非 2xx）→ 若 FlowMusic 已配置，
      // 回落走 generateFlowMusicTrack 完整重跑一次；回執 channel 用實際通路字串，
      // additive 加 fallback_from/fallback_reason。回落時 prompt 必須用 flowmusic 通道
      // **重新過 director**（yue2 與 flowmusic 的規則層不同：剝時間戳 vs 壓單行/220 上限），
      // 不能拿 yue2 版面直接送 flowmusic——director 是純函數，可重複呼叫。
      // 2026-09-28 改為整條鏈回落：YuE2 → FlowMusic → Gemini Lyria 直連（Lyria 僅在
      // GEMINI_API_KEY 已配置時入鏈）。起因＝漫劇評測實錘：純器樂 BGM 送 YuE2 被凍結合約
      // 400（lyrics 必填）→ 回落 FlowMusic 又遇帳號鑑權 502 → 整集無 BGM，而 Lyria 金鑰
      // 在場卻從未被嘗試。回落只在「已選通路拋錯」時發生，全鏈失敗 fail 帶每一路原因。
      // 2026-09-19 片 K 例外：帶 abc 的委託 YuE2 拋錯**不觸發回落**，直接 fail 帶原文。
      // 理由＝語義完整性優先：FlowMusic 不認 abc，回落會靜靜丟失「以這份樂譜為約束」的
      // 委託語義，agent 拿到的是一首語義無關的歌卻以為編輯已生效——比直接失敗更糟
      //（誠實鐵律：能力不匹配要如實報錯，絕不靜默降級）。
      // 2026-09-19 片 O 同款：帶 source_audio（翻唱）的委託拋錯同樣不回落。
      const hasScoreSemantics = abc !== undefined || sourceAudioRaw !== undefined
      const lyriaEnabled = hasGeminiStudioApiKey() || Boolean(process.env.GEMINI_API_KEY?.trim())
      const channelChain: Array<"yue2" | "flowmusic" | "lyria"> = []
      if (yue2Enabled) channelChain.push("yue2")
      if (flowMusicEnabled) channelChain.push("flowmusic")
      if (lyriaEnabled || channelChain.length === 0) channelChain.push("lyria")
      const channelLabel = { yue2: "yue2_modal", flowmusic: "flowmusic2api", lyria: "lyria_gemini" } as const
      let activeChannel: "yue2" | "flowmusic" | "lyria" = channelChain[0]
      let generated: GenerateYue2TrackResult | GenerateFlowMusicTrackResult | GenerateLyriaTrackResult | undefined
      let fallbackFrom: string | null = null
      let fallbackReason: string | null = null
      const channelFailures: string[] = []
      for (let i = 0; i < channelChain.length; i += 1) {
        const channel = channelChain[i]
        activeChannel = channel
        if (channel !== directorChannel) {
          // 換通路必須用該通路**重新過 director**（各通路規則層不同），director 是純函數可重複呼叫。
          directorChannel = channel
          // Vertex lyria-002 純器樂：含人聲/歌詞措辭的 prompt 會被上游 500「Could not generate audio」，
          // 故落到它時按純器樂重組 prompt（歌詞丟棄會在回執 degraded/ignored_inputs 明說）。
          const lyriaInstrumentalOnly = channel === "lyria" && !hasGeminiStudioApiKey()
          directed = directMusicPrompt(lyriaInstrumentalOnly ? buildToolPrompt(prompt, false) : toolPrompt, {
            channel,
            hasLyrics: lyriaInstrumentalOnly ? false : Boolean(lyrics),
            durationSeconds: durationHintRaw === "clip30" ? 30 : undefined,
          })
          finalPrompt = directed.prompt
        }
        try {
          generated =
            channel === "yue2"
              ? await generateYue2Track({
                  style: finalPrompt,
                  lyrics: lyrics ?? "",
                  cot: cotMode,
                  ...(effectiveAbc !== undefined ? { abc: effectiveAbc } : {}),
                })
              : channel === "flowmusic"
                ? await generateFlowMusicTrack({ prompt: finalPrompt, lyrics, model: flowMusicModel })
                : await generateLyriaTrack({ prompt: finalPrompt, lyrics, model: lyriaModel, imagesBase64 })
          break
        } catch (e) {
          if (hasScoreSemantics) throw e
          if (i === channelChain.length - 1) {
            // 單通路失敗照舊拋原錯誤；多通路全滅則每一路原因都要在回執裡看得見。
            if (channelFailures.length === 0) throw e
            throw new MusicToolError(
              "music_all_channels_failed",
              `音乐生成全部通路失败：${[...channelFailures, `${channelLabel[channel]}：${yue2FallbackReason(e)}`].join("；")}`,
            )
          }
          channelFailures.push(`${channelLabel[channel]}：${yue2FallbackReason(e)}`)
          if (fallbackFrom === null) fallbackFrom = channelLabel[channel]
          fallbackReason = channelFailures.join("；")
        }
      }
      if (generated === undefined) throw new MusicToolError("music_tool_error", "音乐生成没有可用通路")
      const model: string =
        activeChannel === "yue2"
          ? YUE2_MODEL_ID
          : activeChannel === "flowmusic"
            ? flowMusicModel
            : ((generated as GenerateLyriaTrackResult).effectiveModel ?? lyriaModel)
      const lyriaVertex = activeChannel === "lyria" && (generated as GenerateLyriaTrackResult).backend === "vertex_express"
      const lyriaIgnored = lyriaVertex ? ((generated as GenerateLyriaTrackResult).ignoredInputs ?? []) : []
      // 誠實降級：要人聲(有歌詞)或要整歌(full)卻落到 Vertex lyria-002（純器樂 30s）＝降級交付，必須明說。
      const degradedReasons: string[] = []
      if (lyriaVertex && lyrics) degradedReasons.push("请求含歌词/人声，但最终通路 Vertex lyria-002 仅纯器乐，成品无人声、歌词未使用")
      if (lyriaVertex && durationHintRaw !== "clip30") degradedReasons.push("请求整歌，但 lyria-002 仅出约 30 秒片段")
      const upstreamUrl =
        activeChannel === "flowmusic" ? (generated as unknown as { upstreamUrl: string }).upstreamUrl : null

      // 音頻落盤：復用 gateway 會話上傳存儲（與 TTS/附件同域）。無 sessionId 時
      // 跳過上傳、result 如實帶 audio_base64（不偽造 URL）。
      const bytes = Buffer.from(generated.audioBase64, "base64")
      let url: string | null = null
      let uploadCode = "skipped_no_session"
      if (context?.sessionId || context?.uploadOverride) {
        try {
          url = await uploadAudio({ bytes, mimeType: generated.mimeType }, context)
          uploadCode = "uploaded"
        } catch (e) {
          if (e instanceof MusicToolError) {
            return fail(e.code, e.message, {
              title: "音乐生成完成但上传失败",
              model,
              audio_bytes: bytes.length,
              mime_type: generated.mimeType,
              audio_base64: generated.audioBase64,
            })
          }
          throw e
        }
      }

      // 時長：ffprobe 實測優先；不可用回退通路提示值並如實標注
      // （YuE2 帶上游自報 duration_s＝上游端真量測值 → duration_source=upstream_reported；
      //  FlowMusic2API 帶上游 Duration 提示、Gemini 通路按 model_hint → model_hint）。
      // 170/180 = 整歌實測區間 162–182s 的中位，僅為模型提示值非實測
      // （duration_source=model_hint 如實標注，不冒充 ffprobe；YuE2 契約保證回 duration_s，
      //  180 只在該欄缺失時才走到，且照樣標 model_hint）。
      // 2026-09-19 回落後這段以 activeChannel 為準（回落成功＝實際通路是 flowmusic，
      //  時長語義照 flowmusic：上游 Duration 提示 → model_hint）。
      const yue2Track = activeChannel === "yue2" ? (generated as GenerateYue2TrackResult) : null
      // 上游自報時長（YuE2 duration_s，>0 才是可用量測值；契約保證有，缺了照樣標 model_hint）。
      const yue2Duration = yue2Track?.durationSeconds ?? 0
      const measured = await measureAudioDuration(generated.audioBase64)
      const hintSeconds =
        activeChannel === "yue2"
          ? yue2Duration > 0
            ? yue2Duration
            : 180
          : activeChannel === "flowmusic"
            ? ((generated as { upstreamDurationHint?: number }).upstreamDurationHint ?? 170)
            : durationHintRaw === "clip30" || lyriaVertex
              ? 30
              : 180
      const durationSeconds = measured ?? hintSeconds
      const durationSource =
        measured !== null
          ? "ffprobe"
          : activeChannel === "yue2" && yue2Duration > 0
            ? "upstream_reported"
            : "model_hint"

      // 多候選交付（2026-10-02）：FlowMusic 上游多數回 2 個 clips。主候選照舊走既有
      // url/upstream_url 單數欄位（向後兼容零改動），其餘候選經同一上傳通路落成平台
      // URL，以 gateway 既已消費的 audios[] 形狀 additive 帶出（每筆一個 audio.done）。
      // 誠實降級：次候選下載/上傳失敗只記進 candidate_errors，絕不拖垮主候選交付。
      const flowResult = activeChannel === "flowmusic" ? (generated as GenerateFlowMusicTrackResult) : null
      const candidateErrors: Array<{ candidate_index: number; upstream_url: string; error: string }> = (
        flowResult?.candidateErrors ?? []
      ).map((e) => ({ candidate_index: e.candidateIndex, upstream_url: e.upstreamUrl, error: e.error }))
      const audios: Array<{ url: string; upstream_url?: string; duration_seconds?: number; candidate_index: number }> = []
      if (flowResult && url) {
        // 主候選（index 0）沿用既有 url：同一份位元組不重複上傳。
        audios.push({
          url,
          ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
          duration_seconds: Math.round(durationSeconds * 100) / 100,
          candidate_index: 0,
        })
        for (const candidate of flowResult.candidates.slice(1)) {
          try {
            const candidateUrl = await uploadAudio(
              { bytes: Buffer.from(candidate.audioBase64, "base64"), mimeType: candidate.mimeType },
              context,
            )
            audios.push({
              url: candidateUrl,
              upstream_url: candidate.upstreamUrl,
              ...(candidate.upstreamDurationHint !== undefined
                ? { duration_seconds: Math.round(candidate.upstreamDurationHint * 100) / 100 }
                : {}),
              candidate_index: candidate.candidateIndex,
            })
          } catch (e) {
            candidateErrors.push({
              candidate_index: candidate.candidateIndex,
              upstream_url: candidate.upstreamUrl,
              error: (e as Error)?.message ?? String(e),
            })
          }
        }
      }

      return ok({
        title: "音乐生成完成",
        ...(url ? { url, path_source: "gateway_uploads" } : { audio_base64: generated.audioBase64, upload: uploadCode }),
        ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
        ...(audios.length > 0 ? { audios } : {}),
        ...(candidateErrors.length > 0 ? { candidate_errors: candidateErrors } : {}),
        // 通路如實回報實際生成通路（回落時 flowmusic2api＝真的走 flowmusic，不虛報 yue2）。
        channel: activeChannel === "yue2" ? "yue2_modal" : activeChannel === "flowmusic" ? "flowmusic2api" : "lyria_gemini",
        // 回落事實 additive 回報（只在真的發生回落時在場；既有鍵零改動）。
        ...(degradedReasons.length > 0 ? { degraded: true, degraded_reason: degradedReasons.join("；") } : {}),
        ...(lyriaIgnored.length > 0 ? { ignored_inputs: lyriaIgnored } : {}),
        ...(fallbackFrom !== null ? { fallback_from: fallbackFrom, fallback_reason: fallbackReason } : {}),
        duration_seconds: Math.round(durationSeconds * 100) / 100,
        duration_source: durationSource,
        duration_hint: durationHintRaw,
        model,
        mime_type: generated.mimeType,
        audio_bytes: bytes.length,
        // 白盒樂譜入交付契約的接點（additive 欄位）：YuE2 通路帶可編輯 ABC 樂譜，
        // 其餘通路固定 null（欄位一律在場，前端/Expert 契約相容）。
        score_abc: yue2Track?.scoreAbc ?? null,
        // 樂譜編輯回執（片 K additive）：實際生效的 cot 模式（僅 YuE2 通路在場——
        // 其餘通路無樂譜語義，回報反而誤導）＋帶譜委託的樂譜指紋（有傳 abc 時在場，
        // 長樂譜不重複回傳，agent 比對指紋即知編輯版是否被採用）。
        ...(activeChannel === "yue2" ? { cot_mode: cotMode } : {}),
        ...(abcSha256 !== null ? { abc_sha256: abcSha256 } : {}),
        // 翻唱回執（片 O additive）：扒譜產物的樂譜指紋（＝本次送入生成的旋律骨幹）＋
        // 扒譜警告如實透傳（空數組＝無警告）。僅帶 source_audio 的委託在場——
        // 與 abc_sha256 獨立：abc_sha256 指委託自備譜、transcribed_abc_sha256 指扒譜產物，
        // 互斥規則保證兩者不同時在場。
        ...(transcribedAbcSha256 !== null ? { transcribed_abc_sha256: transcribedAbcSha256 } : {}),
        ...(transcribeWarnings !== null ? { transcribe_warnings: transcribeWarnings } : {}),
        // 上游如實回報的截斷資訊（凍結合約 truncated）：只有 YuE2 會有，不靜默吞掉。
        ...(yue2Track?.truncated ? { yue2_truncated: yue2Track.truncated } : {}),
        lyrics_echo: (generated as { lyricsEcho?: string }).lyricsEcho ?? null,
        prompt_used: finalPrompt,
        // 規則層如實回報：改了什麼/發現什麼/丟了什麼層，不粉飾（prompt_used 才是實送上游文本）。
        // 回落時 director 以 flowmusic 通道重跑，channel 如實回報實際版面。
        prompt_director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
        },
        reference_image_count:
          activeChannel === "lyria" && !lyriaVertex ? imagesBase64.filter((i) => i !== "").length : 0,
        ...((activeChannel !== "lyria" || lyriaVertex) && imagesBase64.some((i) => i !== "")
          ? {
              reference_images_note:
                activeChannel === "yue2"
                  ? "YuE2 通路不支持参考图（图生乐），本次已忽略"
                  : activeChannel === "lyria"
                    ? "Vertex lyria-002 通路不支持参考图（图生乐），本次已忽略"
                    : "FlowMusic2API 通路暂不支持参考图（图生乐），本次已忽略",
            }
          : {}),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** 情緒契約組裝導出（Expert spec 模板用：orchestrator 心意 → 契約 → prompt）。 */
export type { LyriaMusicContract }
export { buildLyriaStylePrompt }

/** harness-tool-registry.ts 登記用 id 元組（同 BLENDER_HARNESS_TOOL_IDS 範式）。 */
export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"] as const
