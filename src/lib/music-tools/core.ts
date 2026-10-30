import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { flowMusic2ApiUrl } from "../music-flowmusic"
import { LYRIA_MODELS, LYRIA_VERTEX_URL, LYRIA_VERTEX_MODEL, isVertexExpressKey, hasGeminiStudioApiKey } from "../music-lyria"
import { YUE2_HMAC_SECRET_ENV, yue2ModalUrl, type Yue2CotMode } from "../music-yue2"

// ── plumbing（ok/fail/resolveKey 同构 director-common.ts） ───────────────────

export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export type MusicToolResult = { title: string; output: string }

export function ok(data: Record<string, unknown>): MusicToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

export function fail(code: string, hint: string, extra?: Record<string, unknown>): MusicToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

/** 同构 director-common resolveKey：gateway /internal/session-key 解 Bearer，fallback HARNESS_API_KEY。 */
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
    // gateway 无法解析 → fallback
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

export function toFail(e: unknown): MusicToolResult {
  if (e instanceof MusicToolError) return fail(e.code, e.message)
  return fail("music_tool_error", `music_gen 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

// ── prompt 链落档（2026-10-04 G1「提示词链可逐字对帐」）────────────────────────
//
// 背景（真实证据）：R3 判据 5 取不到 `prompt_used`——「我们送上游的 prompt」与
// 「上游实际吃的 sound_prompt」只活在 music_gen 回执里，而回执所在 part 未必落进
// opencode 库（子代理会话可能不落库：ses_ef89dfbb… 在库中不存在）。此处把两者逐次
// 追加进 workspace **既有 outputs 树**下一行 JSON，使链可复算：
//   送出的 style prompt（prompt_sent＝director 后的 prompt_used）
//   ↔ 上游回吐的 clips[].sound_prompt（upstream_sound_prompts）。
//
// 只落 prompt 与结构（sha256/长度/段落标签），绝不落任何 key/token；
// best-effort——落档失败静默，绝不影响生成交付。
const MUSIC_PROMPT_CHAIN_REL = "outputs/music-prompt-chain.jsonl"

/** prompt 链落档路径（workspace 既有 outputs 树；workspace 根口径同 lib/sandbox.ts）。 */
export function musicPromptChainPath(): string {
  const ws = (process.env.EIMU_WORKSPACE ?? "").trim() || "/opt/agent-harness/workspace"
  return nodePath.join(ws, MUSIC_PROMPT_CHAIN_REL)
}

/** 文本指纹与长度（落档只带结构；chars＝UTF-16 长度，runes＝码点长度）。 */
export function textFingerprint(text: string): { sha256: string; chars: number; runes: number } {
  return {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    chars: text.length,
    runes: Array.from(text).length,
  }
}

/**
 * 追加一行 prompt 链记录（best-effort）。成功返回落档相对路径，失败返回 null——
 * 落档失败绝不冒泡到生成交付。
 */
export async function appendMusicPromptChain(record: Record<string, unknown>): Promise<string | null> {
  try {
    const target = musicPromptChainPath()
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.appendFile(target, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8")
    return MUSIC_PROMPT_CHAIN_REL
  } catch {
    return null
  }
}

// ── YuE2 失败回落 FlowMusic（2026-09-19，片 G）───────────────────────────────

/** 回落原因摘要上限（截断防上游长原文把 LLM 可见回执撑爆）。 */
const FALLBACK_REASON_MAX_CHARS = 500

/**
 * YuE2 抛错的回落原因摘要：错误讯息压平空白、以 env 密钥值做防御性遮蔽
 * （music-yue2 client 的错误讯息本就不含密钥，这里是第二道保险——secret 永不入回执）、
 * 超长截断并如实标注。
 */
export function yue2FallbackReason(e: unknown): string {
  let message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim()
  const secret = (process.env[YUE2_HMAC_SECRET_ENV] ?? "").trim()
  if (secret) message = message.split(secret).join("***")
  return message.length > FALLBACK_REASON_MAX_CHARS
    ? `${message.slice(0, FALLBACK_REASON_MAX_CHARS)}…（已截断，原文 ${message.length} 字符）`
    : message
}

// ── 参数整理助手（同构 blender-tools.ts 口径） ────────────────────────────────

export interface MusicToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface MusicToolContext {
  abort?: AbortSignal
  /**
   * 会话 id（音频落盘目标会话；缺省时跳过上传，result 只带 audio_base64）。
   * VPS harness 落位后由 adapter 从 opencode session 注入。
   */
  sessionId?: string
  /** 上传入口整体替换（备用接线）；缺省走 gateway 会话上传端点。 */
  uploadOverride?: (audio: { bytes: Uint8Array; mimeType: string; filename: string }) => Promise<string>
}

export interface MusicToolDef {
  id: string
  description: string
  args: Record<string, MusicToolArgSpec>
  execute: (args: Record<string, unknown>, context?: MusicToolContext) => Promise<MusicToolResult>
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

/**
 * source_audio 前缀剥除（2026-09-19 片 O）：工具参数允许 data: 前缀
 * （与 reference_images 同款处理模式——agent 从 data URL/附件拿到的音频常带前缀），
 * client 端 /transcribe 只收纯 base64（服务端 b64decode 不认前缀）。
 * 一律取**最后一个逗号**之后（data:audio/flac;base64,XXXX）。
 */
export function stripDataUrlPrefix(raw: string): string {
  const commaIndex = raw.lastIndexOf(",")
  return commaIndex >= 0 ? raw.slice(commaIndex + 1).trim() : raw.trim()
}

// ── 时长实测（ffprobe；同 audio_first_timeline 片4 先例） ─────────────────────

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

/** 写临时档 → ffprobe 实测时长；任何失败回 null（调用方回退 model_hint，不冒充）。 */
export async function measureAudioDuration(audioBase64: string): Promise<number | null> {
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

// ── 音频上传（复用 gateway 会话上传存储，与 TTS/附件同域） ─────────────────────

const AUDIO_MIME_EXT: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  // YuE2 通路交付 FLAC（冻结合约 mime_type="audio/flac"）。缺这行副档名会回退成 .mp3
  // ＝档名标签说谎（同 2026-09-11 m4a 事故）；gateway contentTypeForExt 已收 .flac。
  "audio/flac": "flac",
}

/**
 * 工具层暴露的 YuE2 cot 模式白名单（2026-09-19 片 K 开放乐谱编辑）。
 * 契约三值 full/melody/off 中只暴露前两者：工具语义永远要乐谱回执（score_abc），
 * off 不回乐谱、对 agent 无用，收到 "off" 一律 invalid_args 如实报错。
 */
export const YUE2_TOOL_COT_MODES: readonly Yue2CotMode[] = ["full", "melody"]

/** gateway 素材入库端点（JSON 单笔位元组；请求形状同 tools/video_upload.ts 的 path_b64 分支）。 */
function uploadsEndpoint(sessionId: string): string {
  return `${GATEWAY}/internal/media/upload?session_id=${encodeURIComponent(sessionId)}`
}

/**
 * 上传音频入库 gateway 平台存储，返回平台公网直连 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>）。
 * 失败带 HTTP 状态与原文摘录抛 MusicToolError（诚实铁律，不吞错）。
 */
export async function uploadAudio(
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
  // 沙箱（PrivateTmp）内的位元组直传：网关读不到 agent FS，故 base64 内嵌 JSON body。
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
  // 平台公网 URL 由网关回传（store.tinchak0207.xyz/image-data/files/uploads/...），直接交付不再拼前缀。
  return url
}

// ── music_gen 工具 ───────────────────────────────────────────────────────────

// ── 免费通路健康探针（2026-09-30 R9 修复 D）─────────────────────────────────
//
// 起因：yuri OP MV 评测（SSE 5578/6098）agent 先写完歌词、再撞 music_all_channels_failed
// 三连败（YuE2 OOM／FlowMusic OAuth 401／Lyria 403 SERVICE_DISABLED）。探针让 agent 写歌词前
// 就知道「歌做不做得出来、卡在谁手上」。铁律：**不触发任何生成、不花钱**——只打
// /health、/v1/models、模型 metadata GET 与看门狗标记档；凭证永不入回执。
// 状态分类：ready／needs_human_login（需暴君真人登入）／config_disabled（配置/帐号设定未启用，
// 需暴君改配置）／resource_insufficient（资源不足：显存被占、GPU 忙、配额耗尽）／
// unreachable（服务不可达：笔电关机、隧道断、容器挂）。

export type MusicChannelProbeStatus =
  | "ready"
  | "needs_human_login"
  | "config_disabled"
  | "resource_insufficient"
  | "unreachable"

export interface MusicChannelProbe {
  channel: "yue2_modal" | "flowmusic2api" | "lyria_gemini"
  status: MusicChannelProbeStatus
  /** 人话结论（简体，给 agent/用户看）。 */
  label: string
  /** 探得的原始证据摘要（HTTP 码/上游错误 reason/显存数字），不含任何凭证。 */
  evidence: string
  /** 通路能力备注（例：YuE2 8GB 卡单首时长上限）。 */
  capability?: string
}

const PROBE_TIMEOUT_MS = 6_000
/** YuE2 在 8GB 卡的实测峰值 ≈7.3GiB（2026-09-30 R9：peak_alloc 7.32GiB）；空闲显存低于此＝被他人占用。 */
const YUE2_MIN_FREE_VRAM_MIB = 7_400
/** /health 未回报 ar_token_budget 时的诚实兜底：上限确实存在，但本次给不出精确秒数（不编数字）。 */
const YUE2_DURATION_CAP_FALLBACK =
  "YuE2 单首时长上限随歌词长度变化（歌词越长成片越短，超出部分在尾段截断并回报 yue2_truncated）；上游本次未回报 token 预算，无法给出精确秒数"
/** FlowMusic 看门狗在 Supabase 链被连坐吊销时写的标记档（/opt/flowmusic2api/watchdog.py DEAD_MARKER）。 */
const FLOWMUSIC_CHAIN_DEAD_MARKER_DEFAULT = "/opt/flowmusic2api/CHAIN_DEAD"
const LYRIA_MODELS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

export const PROBE_STATUS_LABEL: Record<MusicChannelProbeStatus, string> = {
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
    : YUE2_DURATION_CAP_FALLBACK
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
  // 真鉴权探针（2026-10-02 修假绿灯）：/health 200 与 /v1/models 只证明容器活著＋本机 API key 有效，
  // 不证明上游帐号 session 还能出曲。真 oracle = 用 admin 帐号打 POST /api/tokens/1/refresh-credits：
  // 唯读、不生成、比 /test 更省（任务 3b）。失败才判 unreachable/needs_human_login；CHAIN_DEAD 仅附加讯号。
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
    // Vertex express：POST 空 instances 的免费探针——鉴权通过回 400 "Empty instances"（不生成不计费），
    // key 无效回 401，限额回 429。注意 ready 只代表「纯器乐 30s 可出」，不等于能唱歌（见 capability）。
    const v = await probeFetch(LYRIA_VERTEX_URL, {
      method: "POST",
      headers: { "x-goog-api-key": vertexKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [] }),
    }, 25_000) // Vertex 对空请求的 400 实测也要 ~10s，6s 预设会把健康通路误判不可达
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

/** 三通路并发探针（免费、不生成）。回执供 agent 开局决策：写不写歌词、写多长、要不要先找暴君。 */
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
  // 诚实：无 GEMINI_STUDIO_API_KEY 时 Lyria 只剩 Vertex lyria-002（纯器乐 30s），不能算「能唱歌」。
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

