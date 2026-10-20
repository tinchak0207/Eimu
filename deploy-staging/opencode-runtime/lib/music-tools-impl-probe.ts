import * as fsp from "node:fs/promises"
import { classifyFlowMusicFailure, flowMusic2ApiUrl } from "./music_flowmusic"
import { LYRIA_MODELS, LYRIA_VERTEX_URL, LYRIA_VERTEX_MODEL, isVertexExpressKey, hasGeminiStudioApiKey } from "./music_lyria"
import { YUE2_HMAC_SECRET_ENV, isYue2ModalEnabled, yue2ModalUrl } from "./music_yue2"

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
  if ("error" in models || (models.status !== 200 && models.status !== 401 && models.status !== 403)) {
    return { channel, status: "unreachable", label: "FlowMusic2API 模型探针未通过，无法确认通路状态", evidence: "error" in models ? "GET /v1/models 请求失败（网络或超时）" : `GET /v1/models HTTP ${models.status}` }
  }
  if (!("error" in models) && (models.status === 401 || models.status === 403)) {
    return { channel, status: "config_disabled", label: "FlowMusic2API 拒绝本机 API key", evidence: `GET /v1/models HTTP ${models.status}` }
  }
  // 免费账号鉴权探针，不生成；由服务端现有 per-account 锁管理必要的续期。
  // credits 鉴权成功不证明生成额度或音频交付。CHAIN_DEAD 仅附加信号，可能为恢复前残留。
  const adminUser = (process.env.FLOWMUSIC_ADMIN_USER ?? "").trim()
  const adminPass = (process.env.FLOWMUSIC_ADMIN_PASSWORD ?? "").trim()
  const marker = (process.env.FLOWMUSIC_CHAIN_DEAD_MARKER ?? "").trim() || FLOWMUSIC_CHAIN_DEAD_MARKER_DEFAULT
  const dead = await fsp.readFile(marker, "utf8").catch(() => null)
  const deadEvidence = dead !== null ? "看门狗存在 CHAIN_DEAD 标记（需结合当前鉴权结果判定）" : ""
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
  if ("error" in login || login.status >= 500) {
    return { channel, status: "unreachable", label: "FlowMusic2API admin 服务不可达，无法确认上游登录状态", evidence: "error" in login ? "POST /api/admin/login 请求失败（网络或超时）" : `POST /api/admin/login HTTP ${login.status}` }
  }
  if (typeof token !== "string" || !token) {
    return {
      channel,
      status: "config_disabled",
      label: "FlowMusic2API admin 登录失败（FLOWMUSIC_ADMIN_USER／PASSWORD 不符）",
      evidence: `POST /api/admin/login HTTP ${login.status}${deadEvidence ? "；" + deadEvidence : ""}`,
    }
  }
  const credits = await probeFetch(`${base}/api/tokens/1/refresh-credits`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, 20_000)
  if ("error" in credits) {
    return {
      channel,
      status: "unreachable",
      label: "FlowMusic2API 真鉴权探针请求失败（服务/网络）",
      evidence: `POST /api/tokens/1/refresh-credits 请求失败（网络或超时）${deadEvidence ? "；" + deadEvidence : ""}`,
    }
  }
  const cr = (credits.body ?? {}) as { credits?: unknown; success?: unknown }
  if (credits.status === 200 && cr.success !== false && typeof cr.credits === "number" && Number.isFinite(cr.credits) && cr.credits >= 0) {
    return {
      channel,
      status: "ready",
      label: "FlowMusic2API 账号鉴权通过（生成额度与音频交付尚未验证）",
      evidence: `GET /health 200，/v1/models 通过，真鉴权 POST /api/tokens/1/refresh-credits 200 credits=${cr.credits}${deadEvidence ? "；" + deadEvidence : ""}`,
      capability: "支持人声整歌；成品实测 162–182 秒、不能精确控长，写词按「演唱字数预算 = 目标秒数 × BPM ÷ 60 × 每拍音节数」核算歌词字数（每拍音节数：慢板 ≤76 → 0.8／中速 77–119 → 1.0／快板 ≥120 → 1.4；目标秒数 = min(用户明确要求, 区间小值 165 秒)，用户未给时长用 165 秒、BPM 未定先定一个（缺省 88）；单曲演唱字数硬上限 ≤400 字），超预算上游只会压时值硬塞；credits 数值不能单独证明订阅方案是否允许生成，需实际生成确认",
    }
  }
  const failure = classifyFlowMusicFailure(credits.status, credits.body)
  return {
    channel,
    status: failure.status,
    label: failure.label,
    evidence: `POST /api/tokens/1/refresh-credits HTTP ${credits.status}${failure.upstreamCode ? `，${failure.upstreamCode}` : ""}${deadEvidence ? "；" + deadEvidence : ""}`,
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
  vocal_generation_ready: boolean
  blocking_reason: string | null
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
  // 2026-10-20：探针诚实性——真实路由以 YuE2 为首选，YuE2 瞬时不可达会直接 fail 且不回落，
  // 此时 first_ready 指向的 FlowMusic／Lyria 并不会接管带歌词的整歌。
  const yue2Probe = channels.find((c) => c.channel === "yue2_modal")
  const yue2RouteBlocked = isYue2ModalEnabled() && yue2Probe !== undefined && yue2Probe.status !== "ready"
  const vocalReady = canVocal && !yue2RouteBlocked
  const blockingReason = yue2RouteBlocked
    ? `YuE2 当前${yue2Probe.label}，而真实路由以 YuE2 为首选且瞬时故障不回落：带歌词的整歌会直接失败，FlowMusic2API／Lyria 不会接管。纯器乐或不带歌词的短档仍可走 ${firstReady ?? "无可用通路"}。`
    : null
  return {
    channels,
    can_generate_vocal_song: canVocal,
    can_generate_instrumental: canInstrumental,
    first_ready: firstReady,
    human_actions: humanActions,
    vocal_generation_ready: vocalReady,
    blocking_reason: blockingReason,
  }
}

/**
 * 情绪契约 → prompt（工具层薄组装：契约栏位从 prompt 文本解析不了，所以工具参数
 * 只收自由文本 prompt；结构标签/时间戳由调用方写进 prompt 文本。lyrics 缺省=纯器乐）。
 */
export function buildToolPrompt(rawPrompt: string, hasLyrics: boolean): string {
  if (hasLyrics) return rawPrompt.trim()
  // 无歌词 → 官方器乐写法收尾（若 prompt 已声明 vocal 意图则尊重原文不重复加）。
  if (/instrumental only|no vocals/i.test(rawPrompt)) return rawPrompt.trim()
  return `${rawPrompt.trim()} Instrumental only, no vocals.`
}

