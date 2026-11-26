import {
  LinkiiClientError,
  hasLinkiiCachedToken,
  isLinkiiAuthRateLimited,
  isLinkiiConfigured,
  linkiiJson,
  pollLinkiiTaskAndWork,
  resolveLinkiiMediaUrl,
  withLinkiiAccountPool,
} from "./linkii-client"
import { MusicToolError } from "./music-tools-impl-core"

export const LINKII_MUSIC_MODELS = {
  "minimax-music-3.0": {
    deploymentId: 632,
    supportsInstrumental: false,
    label: "minimax-music-3.0（仅人声/需歌词）",
  },
  "gl-3.0-pro": {
    deploymentId: 663,
    supportsInstrumental: true,
    label: "gl-3.0-pro（人声与纯器乐均支持）",
  },
} as const

export type LinkiiMusicModelId = keyof typeof LINKII_MUSIC_MODELS

const LINKII_MUSIC_CAPABILITY =
  "可用模型：minimax-music-3.0（仅人声/需歌词）、gl-3.0-pro（人声与纯器乐均支持）"

const LINKII_MUSIC_TIMEOUT_MS = 600_000
const LINKII_MUSIC_POLL_MS = 5_000
const LINKII_DOWNLOAD_TIMEOUT_MS = 120_000

const AUDIO_EXT_MIME: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:$|[?#])/i
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|flac|ogg)(?:$|[?#])/i

export function isLinkiiMusicEnabled(): boolean {
  return isLinkiiConfigured()
}

export function isLinkiiMusicModelId(value: string): value is LinkiiMusicModelId {
  return value === "minimax-music-3.0" || value === "gl-3.0-pro"
}

export interface LinkiiMusicProbeResult {
  channel: "linkii_music"
  status: "ready" | "config_disabled" | "resource_insufficient" | "unreachable"
  label: string
  evidence: string
  capability?: string
}

function parseRemainingQuota(raw: unknown): { known: boolean; remaining: number | null; summary: string } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { known: true, remaining: raw, summary: String(raw) }
  }
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    const n = Number(raw.trim())
    return { known: true, remaining: n, summary: String(n) }
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { known: false, remaining: null, summary: "未知（空列表）" }
    let sum = 0
    let hasNum = false
    const parts: string[] = []
    for (const item of raw) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>
      const val = extractQuotaNumber(obj)
      const name =
        (typeof obj.modelName === "string" && obj.modelName) ||
        (typeof obj.modelCode === "string" && obj.modelCode) ||
        (typeof obj.name === "string" && obj.name) ||
        (typeof obj.deploymentId === "number" ? `#${obj.deploymentId}` : "")
      if (val !== null) {
        hasNum = true
        sum += val
        parts.push(name ? `${name}:${val}` : String(val))
      }
    }
    return hasNum
      ? { known: true, remaining: sum, summary: parts.join(", ") }
      : { known: false, remaining: null, summary: "已返回配额列表" }
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    for (const nestedKey of ["list", "items", "records", "models"]) {
      if (Array.isArray(obj[nestedKey])) {
        return parseRemainingQuota(obj[nestedKey])
      }
    }
    const val = extractQuotaNumber(obj)
    if (val !== null) {
      return { known: true, remaining: val, summary: String(val) }
    }
  }
  return { known: false, remaining: null, summary: "已返回（未含明确数值字段）" }
}

function extractQuotaNumber(obj: Record<string, unknown>): number | null {
  for (const key of ["remaining", "remainingTimes", "remainCount", "remainQuota", "availableCount", "count", "quota"]) {
    const v = obj[key]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v.trim())
  }
  return null
}

export async function probeLinkiiMusic(): Promise<LinkiiMusicProbeResult> {
  const channel = "linkii_music" as const
  if (!isLinkiiMusicEnabled()) {
    return {
      channel,
      status: "config_disabled",
      label: "Linkii 音乐通路未启用（LINKII_USERNAME／LINKII_PASSWORD 与 LINKII_AUTH_TOKEN 均未配置）",
      evidence: "env LINKII_USERNAME／LINKII_PASSWORD／LINKII_AUTH_TOKEN 均为空",
    }
  }

  const hasToken = await hasLinkiiCachedToken()
  const rate = await isLinkiiAuthRateLimited()
  if (!hasToken && rate.limited) {
    const remainSec = Math.ceil(rate.remainingMs / 1000)
    return {
      channel,
      status: "resource_insufficient",
      label: `Linkii 登录挑战频控冷却中（剩余约 ${remainSec} 秒）`,
      evidence: `无缓存 token 且处于 C1015 冷却期（剩余 ${remainSec}s）`,
      capability: LINKII_MUSIC_CAPABILITY,
    }
  }

  try {
    const remainingRaw = await linkiiJson<unknown>("/web/model-usage/remaining?categoryCode=music", {
      method: "GET",
      timeoutMs: 8_000,
    })
    const quota = parseRemainingQuota(remainingRaw)
    if (quota.known && quota.remaining !== null && quota.remaining <= 0) {
      return {
        channel,
        status: "resource_insufficient",
        label: "Linkii 音乐可用次数已用尽",
        evidence: `GET /web/model-usage/remaining?categoryCode=music 剩余配额=${quota.summary}`,
        capability: `${LINKII_MUSIC_CAPABILITY}；剩余配额：${quota.summary}`,
      }
    }
    return {
      channel,
      status: "ready",
      label: "Linkii 音乐通路可用（支持 minimax-music-3.0 与 gl-3.0-pro）",
      evidence: `GET /web/model-usage/remaining?categoryCode=music 通过，剩余配额=${quota.summary}`,
      capability: `${LINKII_MUSIC_CAPABILITY}；剩余配额：${quota.summary}`,
    }
  } catch (e) {
    if (e instanceof LinkiiClientError) {
      if (e.code === "linkii_auth_rate_limited") {
        return {
          channel,
          status: "resource_insufficient",
          label: "Linkii 登录挑战触发频控（C1015），5 分钟冷却中",
          evidence: e.message,
          capability: LINKII_MUSIC_CAPABILITY,
        }
      }
      if (
        e.code === "linkii_not_configured" ||
        e.code === "linkii_auth_failed" ||
        e.code === "linkii_auth_expired" ||
        e.status === 401 ||
        e.status === 403
      ) {
        return {
          channel,
          status: "config_disabled",
          label: "Linkii 鉴权配置异常或权限被拒",
          evidence: e.message,
          capability: LINKII_MUSIC_CAPABILITY,
        }
      }
      return {
        channel,
        status: "unreachable",
        label: "Linkii 服务探针失败或不可达",
        evidence: e.message,
        capability: LINKII_MUSIC_CAPABILITY,
      }
    }
    return {
      channel,
      status: "unreachable",
      label: "Linkii 服务探针异常",
      evidence: (e as Error)?.message ?? String(e),
      capability: LINKII_MUSIC_CAPABILITY,
    }
  }
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  const s = value.trim()
  if (!s) return value
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s)
    } catch {
      return value
    }
  }
  return value
}

interface ExtractedAudioInfo {
  rawUrl: string
  durationSeconds?: number
}

function extractAudioFromValue(value: unknown, depth = 0): ExtractedAudioInfo | null {
  if (depth > 6 || value === null || value === undefined) return null
  const parsed = tryParseJson(value)

  if (typeof parsed === "string") {
    const s = parsed.trim()
    if (!s) return null
    if ((/^https?:\/\//i.test(s) || s.includes("/")) && !IMAGE_EXT_RE.test(s)) {
      return { rawUrl: s }
    }
    return null
  }

  if (Array.isArray(parsed)) {
    // 优先选带音频字段或音频扩展名的项
    let fallback: ExtractedAudioInfo | null = null
    for (const item of parsed) {
      const hit = extractAudioFromValue(item, depth + 1)
      if (!hit) continue
      if (AUDIO_EXT_RE.test(hit.rawUrl)) return hit
      if (!fallback) fallback = hit
    }
    return fallback
  }

  if (typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>
    const durationVal =
      typeof obj.duration === "number" && Number.isFinite(obj.duration) && obj.duration > 0
        ? obj.duration
        : typeof obj.durationSeconds === "number" && Number.isFinite(obj.durationSeconds) && obj.durationSeconds > 0
          ? obj.durationSeconds
          : undefined

    // 显式音频字段优先
    for (const key of ["audioUrl", "musicUrl"]) {
      const v = obj[key]
      if (typeof v === "string" && v.trim()) {
        return { rawUrl: v.trim(), ...(durationVal ? { durationSeconds: durationVal } : {}) }
      }
    }

    for (const key of ["resultUrl", "fileUrl", "url", "objectName"]) {
      const v = obj[key]
      if (typeof v === "string" && v.trim() && !IMAGE_EXT_RE.test(v.trim())) {
        return { rawUrl: v.trim(), ...(durationVal ? { durationSeconds: durationVal } : {}) }
      }
    }

    for (const nestedKey of ["resultFiles", "resultContent", "files", "items", "list", "clips", "audios", "data", "result"]) {
      if (obj[nestedKey] !== undefined) {
        const hit = extractAudioFromValue(obj[nestedKey], depth + 1)
        if (hit) {
          return durationVal && !hit.durationSeconds ? { ...hit, durationSeconds: durationVal } : hit
        }
      }
    }
  }

  return null
}

function detectAudioMimeType(url: string, contentTypeHeader: string | null): string {
  const extMatch = AUDIO_EXT_RE.exec(url)
  if (extMatch) {
    const mapped = AUDIO_EXT_MIME[extMatch[1].toLowerCase()]
    if (mapped) return mapped
  }
  const ct = (contentTypeHeader ?? "").split(";")[0].trim().toLowerCase()
  if (ct === "audio/mp3" || ct === "audio/mpeg") return "audio/mpeg"
  if (ct === "audio/wav" || ct === "audio/x-wav" || ct === "audio/wave") return "audio/wav"
  if (ct === "audio/mp4" || ct === "audio/m4a" || ct === "audio/x-m4a") return "audio/mp4"
  if (ct === "audio/flac" || ct === "audio/x-flac") return "audio/flac"
  if (ct === "audio/ogg" || ct === "application/ogg") return "audio/ogg"
  if (ct.startsWith("audio/")) return ct
  return "audio/mpeg"
}

export interface GenerateLinkiiMusicTrackOptions {
  prompt: string
  lyrics?: string
  model: LinkiiMusicModelId
  signal?: AbortSignal
}

export interface GenerateLinkiiMusicTrackResult {
  audioBase64: string
  mimeType: string
  upstreamUrl: string
  effectiveModel: LinkiiMusicModelId
  durationSeconds?: number
}

export async function generateLinkiiMusicTrack(
  opts: GenerateLinkiiMusicTrackOptions,
): Promise<GenerateLinkiiMusicTrackResult> {
  const { prompt, lyrics, model, signal } = opts
  if (!isLinkiiMusicModelId(model)) {
    throw new MusicToolError(
      "invalid_args",
      `不支持的 Linkii 音乐模型 "${String(model)}"，仅支持 minimax-music-3.0 与 gl-3.0-pro。`,
    )
  }

  const hasLyrics = Boolean(lyrics?.trim())
  if (model === "minimax-music-3.0" && !hasLyrics) {
    throw new MusicToolError(
      "unsupported_instrumental",
      "MiniMax-Music 3.0 不支持纯器乐，请提供歌词或改用 gl-3.0-pro。",
    )
  }

  if (!isLinkiiMusicEnabled()) {
    throw new MusicToolError(
      "config_disabled",
      "Linkii 音乐通路未配置（缺少 LINKII_USERNAME／LINKII_PASSWORD 或 LINKII_AUTH_TOKEN）。",
    )
  }

  const spec = LINKII_MUSIC_MODELS[model]
  const composedPrompt = hasLyrics ? `${prompt.trim()}\n\n[歌词]\n${lyrics!.trim()}` : prompt.trim()

  // 号池：创建＋轮询整段在一个账号作用域内；创建阶段忙/限流/额度/鉴权失败换号，已创建的任务不换号。
  const { work, taskId, creationId } = await withLinkiiAccountPool(async () => {
    const created = await linkiiJson<Record<string, unknown>>(
      "/web/ai/music/create",
      {
        method: "POST",
        body: JSON.stringify({
          deploymentId: spec.deploymentId,
          prompt: composedPrompt,
          params: JSON.stringify({
            instrument: "樂器不限",
            style: "風格不限",
            instrumental: !hasLyrics,
            imageUrls: [],
            audioUrls: [],
          }),
        }),
        timeoutMs: 30_000,
      },
      signal,
    )

    const taskId = created?.id ?? created?.taskId
    const creationId = created?.creationId ?? created?.workId
    if (
      (typeof taskId !== "string" && typeof taskId !== "number") ||
      taskId === "" ||
      (typeof creationId !== "string" && typeof creationId !== "number") ||
      creationId === ""
    ) {
      throw new MusicToolError(
        "linkii_bad_response",
        `Linkii /web/ai/music/create 未返回有效的 id 与 creationId：${JSON.stringify(created).slice(0, 400)}`,
      )
    }

    const polled = await pollLinkiiTaskAndWork(taskId, creationId, {
      timeoutMs: LINKII_MUSIC_TIMEOUT_MS,
      pollMs: LINKII_MUSIC_POLL_MS,
      signal,
    })
    return { work: polled.work, taskId, creationId }
  })

  const extracted =
    extractAudioFromValue(work?.resultFiles) ?? extractAudioFromValue(work?.resultContent)
  const upstreamUrl = extracted ? resolveLinkiiMediaUrl(extracted.rawUrl) : ""
  if (!upstreamUrl) {
    throw new MusicToolError(
      "linkii_no_audio_url",
      `Linkii 任务已完成但未在作品中提取到音频 URL（creationId=${String(creationId)}）：${JSON.stringify({
        resultFiles: work?.resultFiles ?? null,
        resultContent: work?.resultContent ?? null,
      }).slice(0, 500)}`,
    )
  }

  const dlController = new AbortController()
  const onAbort = () => dlController.abort(signal?.reason ?? new Error("下载已取消"))
  if (signal) {
    if (signal.aborted) dlController.abort(signal.reason ?? new Error("下载已取消"))
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const dlTimer = setTimeout(() => {
    dlController.abort(new DOMException(`音频下载超时（${LINKII_DOWNLOAD_TIMEOUT_MS}ms）`, "TimeoutError"))
  }, LINKII_DOWNLOAD_TIMEOUT_MS)

  let bytes: Uint8Array
  let contentType: string | null = null
  try {
    const resp = await fetch(upstreamUrl, { method: "GET", signal: dlController.signal })
    if (!resp.ok) {
      throw new MusicToolError(
        "linkii_download_failed",
        `下载 Linkii 音频失败（HTTP ${resp.status}）：${upstreamUrl}`,
      )
    }
    contentType = resp.headers.get("content-type")
    const buf = await resp.arrayBuffer()
    bytes = new Uint8Array(buf)
  } catch (e) {
    if (e instanceof MusicToolError) throw e
    throw new MusicToolError(
      "linkii_download_failed",
      `下载 Linkii 音频异常：${(e as Error)?.message ?? String(e)}`,
    )
  } finally {
    clearTimeout(dlTimer)
    signal?.removeEventListener("abort", onAbort)
  }

  if (bytes.byteLength === 0) {
    throw new MusicToolError("linkii_empty_audio", `Linkii 音频内容为空：${upstreamUrl}`)
  }

  return {
    audioBase64: Buffer.from(bytes).toString("base64"),
    mimeType: detectAudioMimeType(upstreamUrl, contentType),
    upstreamUrl,
    effectiveModel: model,
    ...(extracted?.durationSeconds !== undefined ? { durationSeconds: extracted.durationSeconds } : {}),
  }
}
