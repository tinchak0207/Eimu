// project/speech.ts — TTS 的单一实现（S8a，设计文档 §3.5 voice 行）。
//
// 来源：把 media-internal-routes.ts:362 的 handleTts 逐行搬到这里，供
//   - 旧的公共路由 POST /agent/v1/tts（handleTts 变成薄包装）
//   - 工程图 voice 执行器（executors/voice.ts）
// 共用同一份逻辑。旧路由的状态码、错误字符串、成功 body 键序全部照旧；
// workflow-gw-service.ts:153-176 的内联 audio 路径按设计文档 §4.2 冻结不动(旧 world2 路径)。
//
// 行为契约（逐字沿用 handleTts）：
// - trim 后空文本 → 400 bad_request "text is required"
// - trim 后 >2000 字 → 400 bad_request "text too long (max 2000 chars)"
// - 上游探测失败 → 503 tts_unavailable（消息里带 probe.note）
// - 行内实体 tag `@[音频:X]` 送上游前展开（fail-open，原文照送）
// - 上游非 2xx → 502 tts_upstream_error "TTS upstream error: <body 前 200 字>"
// - 上游 2xx 但 <64 字节 → 502 tts_empty_audio
// - 成功 → { ok, url, chars, cost_coins, format:"mp3" }；chars/cost 按 trim 后原文算，
//   上游 input 用 tag 展开后的文本。文件落 TTS_AUDIO_DIR，URL 前缀 TTS_PUBLIC_BASE。
//
// SpeechDeps 是测试接缝：生产缺省走环境变量与真实 fetch；只有测试传假上游/临时目录。
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { estimateTtsCoins } from "../pricing-and-validation"
import { resolveAudioEntityTokens } from "../entity-resolve.ts"
import { TTS_AUDIO_DIR, TTS_PUBLIC_BASE } from "../constants-gateway.ts"

/** 与 handleTts 相同的硬上限（specs.ts voice.text 的 2000 来自这里）。 */
export const TTS_MAX_CHARS = 2000
/** 计价口径：handleTts 一直用固定模型名 tts-zh 计费。 */
export const TTS_MODEL_ID = "tts-zh"

export interface TtsUpstreamConfig {
  base: string
  speechPath: string
  model: string
  voice: string
}

// 诚实原则（honest-error）：2026-08-30 起 TTS_UPSTREAM 指向本机 edge-tts-proxy(127.0.0.1:8893，
// /opt/edge-tts/，CosyVoice2 主路 + edge-tts 降级，免 key 中文音色)。此前 Groq playai-tts 已下架、
// orpheus 被 org 条款锁死；平台 /v1/models 无任何 TTS 条目。上游接入后只需改 TTS_UPSTREAM 一处。
export const TTS_UPSTREAM: TtsUpstreamConfig = {
  // Groq audio proxy（VPS 本机 8892，透传 api.groq.com，KEY 在 .env）
  base: process.env.TTS_UPSTREAM_BASE || "http://127.0.0.1:8892",
  speechPath: "/openai/v1/audio/speech",
  model: process.env.TTS_UPSTREAM_MODEL || "canopylabs/orpheus-v1-english",
  voice: process.env.TTS_UPSTREAM_VOICE || "tara",
}

export interface TtsProbeResult {
  available: boolean
  note: string
}

/** 探测依赖：只取上游配置与 fetch（测试可指向假服务器）。 */
export type TtsProbeDeps = Pick<SpeechDeps, "upstream" | "fetchImpl">

/** 探测 TTS 上游。负缓存只覆盖网络连接失败，且不超过 5 秒；HTTP 403 不缓存。 */
const TTS_PROBE_NEGATIVE_TTL_MS = 5_000
// 键 = 上游地址：生产只有一个键（行为与旧的单槽缓存相同）；测试注入不同假上游互不污染。
const ttsProbeCache = new Map<string, { at: number; ttl: number; result: TtsProbeResult }>()
export async function probeTtsUpstream(signal?: AbortSignal, deps: TtsProbeDeps = {}): Promise<TtsProbeResult> {
  const upstream = deps.upstream ?? TTS_UPSTREAM
  const doFetch = deps.fetchImpl ?? fetch
  const cacheKey = `${upstream.base}${upstream.speechPath}`
  const cached = ttsProbeCache.get(cacheKey)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result
  let result: TtsProbeResult
  let cacheNegative = false
  try {
    const res = await doFetch(`${upstream.base}${upstream.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: upstream.model,
        input: "测",
        voice: upstream.voice,
        response_format: "mp3",
      }),
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const head = new Uint8Array(buf.slice(0, 3))
      const looksLikeAudio = buf.byteLength > 64 && (head[0] === 0x49 || head[0] === 0x52 || head[0] === 0xff)
      result = looksLikeAudio
        ? { available: true, note: "上游可用" }
        : { available: false, note: "上游返回 200 但载荷不是音频" }
    } else {
      const bodyText = await res.text().catch(() => "")
      let msg = bodyText.slice(0, 200)
      try {
        const j = JSON.parse(bodyText)
        msg = (j?.error?.message || msg).slice(0, 200)
      } catch { /* keep raw */ }
      result = { available: false, note: `上游 HTTP ${res.status}: ${msg}` }
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : ""
    const aborted = name === "AbortError" || name === "TimeoutError"
    result = { available: false, note: `上游不可达: ${e instanceof Error ? e.message : String(e)}` }
    cacheNegative = !aborted
  }
  if (result.available) ttsProbeCache.set(cacheKey, { at: Date.now(), ttl: 60_000, result })
  else if (cacheNegative) ttsProbeCache.set(cacheKey, { at: Date.now(), ttl: TTS_PROBE_NEGATIVE_TTL_MS, result })
  else ttsProbeCache.delete(cacheKey)
  return result
}

/** 测试接缝：清空探测缓存（生产不需要呼叫）。 */
export function clearTtsProbeCache(): void {
  ttsProbeCache.clear()
}

export interface SpeechDeps {
  /** 缺省 TTS_UPSTREAM（环境变量在模块载入时读取，与旧行为一致）。 */
  upstream?: TtsUpstreamConfig
  fetchImpl?: typeof fetch
  /** 缺省 TTS_AUDIO_DIR；测试指向临时目录。 */
  audioDir?: string
  /** 缺省 TTS_PUBLIC_BASE（已去掉尾部斜杠）。 */
  publicBase?: string
  /** 缺省调用 probeTtsUpstream；测试注入固定结果。 */
  probe?: (signal?: AbortSignal) => Promise<TtsProbeResult>
  /** 缺省 resolveAudioEntityTokens；测试注入直通。 */
  resolveEntityTokens?: (text: string, signal: AbortSignal | undefined, apiKey: string | undefined) => Promise<{ prompt: string }>
  /** 上游请求超时；缺省 60_000（旧 handleTts 相同）。 */
  upstreamTimeoutMs?: number
  /** 文件 id 的时间源/随机源（测试注入以取得确定性 URL）。 */
  now?: () => number
  random?: () => number
}

export interface SynthesizeSpeechInput {
  text: string
  voice?: string
  /** 语速（OpenAI speech 参数）。旧 /tts 路由不传，行为不变；仅 voice 执行器使用。 */
  speed?: number
  /** 行内实体 tag 展开所需的使用者 key（同 handleTts 第一参数）。 */
  apiKey?: string
  /** 执行器取消信号；旧路由不传，行为不变。 */
  signal?: AbortSignal
}

export type SynthesisErrorCode = "bad_request" | "tts_unavailable" | "tts_upstream_error" | "tts_empty_audio" | "cancelled"

export type SynthesizeSpeechResult =
  | { ok: true; url: string; path: string; chars: number; costCoins: number; format: "mp3"; bytes: number }
  | { ok: false; status: 400 | 502 | 503; code: SynthesisErrorCode; message: string }

/**
 * 合成一句配音。旧 handleTts 的全部行为都在这里；handleTts 只做 JSON 解析与响应包装。
 * 成功时同时返回本地文件路径（执行器经 ctx.ingest 入库）与公网 URL（旧路由原样回给工具）。
 */
export async function synthesizeSpeech(input: SynthesizeSpeechInput, deps: SpeechDeps = {}): Promise<SynthesizeSpeechResult> {
  const upstream = deps.upstream ?? TTS_UPSTREAM
  const doFetch = deps.fetchImpl ?? fetch
  const text = typeof input.text === "string" ? input.text.trim() : ""
  if (!text) return { ok: false, status: 400, code: "bad_request", message: "text is required" }
  if (text.length > TTS_MAX_CHARS) return { ok: false, status: 400, code: "bad_request", message: "text too long (max 2000 chars)" }

  const probe = deps.probe
    ? await deps.probe(input.signal)
    : await probeTtsUpstream(input.signal, { upstream, fetchImpl: doFetch })
  if (!probe.available) {
    return {
      ok: false,
      status: 503,
      code: "tts_unavailable",
      message: `配音（TTS）上游暂不可用：${probe.note}。台词已收到，但当前无法真实生成音轨；请如实告知用户，勿编造音频链接。`,
    }
  }

  // 行内实体 tag（`@[音频:夜雨环境音]`）展开（2026-09-25，音频卡接线）。
  // **fail-open 硬契约**：解析失败／逾时／形状不符／缺 key → 原文照送，永不阻断配音。
  const resolveEntity = deps.resolveEntityTokens
    ?? ((t: string, signal: AbortSignal | undefined, apiKey: string | undefined) => resolveAudioEntityTokens(t, signal, { apiKey }))
  const ttsText = await resolveEntity(text, input.signal, input.apiKey)
  if (ttsText.prompt !== text) {
    console.info(`[tts] 已展开行内实体 tag：prompt_length=${text.length}→${ttsText.prompt.length}`)
  }

  // 上游可用路径。
  try {
    const timeout = AbortSignal.timeout(deps.upstreamTimeoutMs ?? 60_000)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    const res = await doFetch(`${upstream.base}${upstream.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: upstream.model,
        input: ttsText.prompt,
        voice: input.voice || upstream.voice,
        // speed 只在显式传入且 ≠1 时下发：旧路由从不传，请求体与旧实现逐字节相同；
        // 1 是 OpenAI speech 的缺省值，省略它避免对严格校验的上游产生无意义差异。
        ...(typeof input.speed === "number" && Number.isFinite(input.speed) && input.speed !== 1 ? { speed: input.speed } : {}),
        response_format: "mp3",
      }),
      signal,
    })
    if (!res.ok) {
      const msg = (await res.text().catch(() => "")).slice(0, 200)
      return { ok: false, status: 502, code: "tts_upstream_error", message: `TTS upstream error: ${msg}` }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 64) {
      return { ok: false, status: 502, code: "tts_empty_audio", message: "TTS upstream returned empty audio" }
    }
    const now = deps.now ?? Date.now
    const random = deps.random ?? Math.random
    const id = `tts_${now().toString(36)}_${random().toString(36).slice(2, 10)}`
    const fileName = `${id}.mp3`
    const audioDir = deps.audioDir ?? TTS_AUDIO_DIR
    await mkdir(audioDir, { recursive: true })
    const filePath = path.join(audioDir, fileName)
    await Bun.write(filePath, buf)
    const costCoins = estimateTtsCoins(TTS_MODEL_ID, text)
    const publicBase = deps.publicBase ?? TTS_PUBLIC_BASE
    const url = `${publicBase.replace(/\/+$/, "")}/${fileName}`
    return { ok: true, url, path: filePath, chars: text.length, costCoins, format: "mp3", bytes: buf.byteLength }
  } catch (e) {
    if (input.signal?.aborted) {
      return { ok: false, status: 502, code: "cancelled", message: "TTS 调用被中止" }
    }
    return {
      ok: false,
      status: 502,
      code: "tts_upstream_error",
      message: `TTS upstream error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
