import * as fsp from "node:fs/promises"
import * as nodePath from "node:path"
import { createHash } from "node:crypto"
import { FlowMusicServiceError } from "./music_flowmusic"
import { YUE2_HMAC_SECRET_ENV, generateYue2Track, isYue2TransientFailure, yue2TransientCode, type GenerateYue2TrackOptions, type GenerateYue2TrackResult } from "./music_yue2"

// ── plumbing（ok/fail/resolveKey 同构 director-common.ts） ───────────────────

export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export type MusicToolResult = { title: string; output: string }

export function ok(data: Record<string, unknown>): MusicToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

export function fail(code: string, hint: string, extra?: Record<string, unknown>): MusicToolResult {
  // human_message（可选）＝用户侧短句，进 error 对象；hint 只给模型（可带诊断细节）。
  const { title, human_message, ...rest } = extra ?? {}
  const error = typeof human_message === "string" && human_message ? { code, hint, human_message } : { code, hint }
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error, ...rest }) }
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
  if (e instanceof FlowMusicServiceError) return fail(e.code, e.message)
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

// ── YuE2 瞬时故障：快速判败、交给回落链（2026-10-31 用户裁定）────────────────────
//
// 沿革：2026-10-11 曾因「瞬时故障被静默换到付费通路 FlowMusic 并扣费」改成瞬时不回落、退避
// 重试同一通路后直接 fail。2026-10-31 生产事故（ses_e7211ef0dffe7S6KleX7YB4F1Q）：反向隧道断，
// 三次 music_gen 全回 yue2_unreachable，agent 退成去掉歌词的器乐版、再拿 TTS 念白冒充演唱。
// 用户裁定：病根是**静默**，不是回落本身——回落必须恢复，且回执里明说换了通路。
//
// 规则：
// - yue2_unreachable／yue2_timeout／yue2_unavailable：不重试同一通路（隧道断了 20 秒内不会好；
//   超时重试＝重烧约 6 分钟 GPU，见 2026-10-05 超时风暴），首败即抛 Yue2TransientExhaustedError
//   （attempts=1），由工具层并入回落链（回执带 fallback_from／fallback_reason／channel）。
// - yue2_busy（HTTP 429，单槽被占）：保留 5s／15s 退避重试同一通路，仍忙再交给回落链。
// - 判定依据＝music_yue2.ts 的 isYue2TransientFailure（与实作同源，不在此重判）；
//   硬失败原样抛出，同走回落链。带 abc／翻唱的委托（hasScoreSemantics）仍不回落、如实 fail。

/** yue2_busy 的退避间隔（毫秒）：首败后 5s、再败后 15s＝最多重试 2 次（共 3 次尝试）。 */
const YUE2_BUSY_RETRY_DELAYS_MS = [5_000, 15_000] as const

/** YuE2 瞬时失败（已按规则重试/判败）标记错误：工具层据此并入回落链；带乐谱语义时如实 fail。 */
export class Yue2TransientExhaustedError extends Error {
  code: string
  attempts: number
  /** 用户侧短句（不含端点、内部通路与部署措辞）；message 给模型，保留诊断细节。 */
  humanMessage: string
  constructor(code: string, attempts: number, message: string, humanMessage = "") {
    super(message)
    this.code = code
    this.attempts = attempts
    this.humanMessage = humanMessage
    this.name = "Yue2TransientExhaustedError"
  }
}

/**
 * 生成一次 YuE2。瞬时错误中只有 yue2_busy 按 YUE2_BUSY_RETRY_DELAYS_MS 退避重试同一通路；
 * 不可达／超时／不可用首败即抛 Yue2TransientExhaustedError（工具层并入回落链）；
 * 硬失败原样抛出（工具层同走回落链）。
 */
export async function generateYue2TrackResilient(
  opts: GenerateYue2TrackOptions,
): Promise<GenerateYue2TrackResult> {
  let lastError: unknown
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return await generateYue2Track(opts)
    } catch (e) {
      if (!isYue2TransientFailure(e)) throw e
      lastError = e
      if (yue2TransientCode(e) !== "yue2_busy") break
      const delay = YUE2_BUSY_RETRY_DELAYS_MS[attempts - 1]
      if (delay === undefined) break
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  const code = yue2TransientCode(lastError)
  const retried = attempts > 1 ? `已退避重试 ${attempts - 1} 次仍失败` : "未重试同一通路"
  throw new Yue2TransientExhaustedError(
    code,
    attempts,
    `YuE2 瞬时不可用（${code}：${yue2FallbackReason(lastError)}）；${retried}。`,
    `音乐生成服务暂时${code === "yue2_busy" ? "繁忙" : code === "yue2_timeout" ? "响应超时" : "连不上"}，本次未扣费。稍后重试即可。`,
  )
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
