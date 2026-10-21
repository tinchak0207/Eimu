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

// ── YuE2 瞬时故障不回落（2026-10-11 事故修复）────────────────────────────────
//
// 事故：YuE2 的**瞬时**故障（HTTP 429 busy／服务不可达／超时）被工具层当硬失败，静默
// 换到付费通路 FlowMusic 出货并扣 1 币（累计 5 币全花在这种回落上）。用户口径＝音乐只走 YuE2。
//
// 规则：YuE2 抛**瞬时**错误（判定依据＝music_yue2.ts 的 isYue2TransientFailure：429 busy／
// 502-504／网络层／超时，与实作同源）→ 按退避**重试同一通路**，绝不触发付费回落；
// 仍失败则如实 fail（错误码 yue2_busy／yue2_unreachable／yue2_timeout／yue2_unavailable），
// 回执明写「未回落、未扣费」。YuE2 抛**硬**错误（语义错误等）→ 既有回落链保持不变。
// 带 abc／翻唱的委托（hasScoreSemantics）本就从不回落，本次亦同受退避保护。

/** 瞬时故障重试间隔（毫秒）：首败后 5s、再败后 15s＝最多重试 2 次（共 3 次尝试）。 */
const YUE2_TRANSIENT_RETRY_DELAYS_MS = [5_000, 15_000] as const

/** 瞬时穷尽标记错误：工具层据此**不回落**、直接 fail（带诚实码与文案）。 */
export class Yue2TransientExhaustedError extends Error {
  code: string
  attempts: number
  constructor(code: string, attempts: number, message: string) {
    super(message)
    this.code = code
    this.attempts = attempts
    this.name = "Yue2TransientExhaustedError"
  }
}

/**
 * 生成一次 YuE2；抛出**瞬时**错误则按 YUE2_TRANSIENT_RETRY_DELAYS_MS 退避重试同一通路。
 * 瞬时穷尽 → 抛 Yue2TransientExhaustedError（工具层不回落、直接 fail）；
 * 硬失败 → 原样抛出（工具层走既有回落链）。
 */
export async function generateYue2TrackResilient(
  opts: GenerateYue2TrackOptions,
): Promise<GenerateYue2TrackResult> {
  const attempts = YUE2_TRANSIENT_RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await generateYue2Track(opts)
    } catch (e) {
      if (!isYue2TransientFailure(e)) throw e
      lastError = e
      const delay = YUE2_TRANSIENT_RETRY_DELAYS_MS[attempt - 1]
      if (delay === undefined) break
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  const code = yue2TransientCode(lastError)
  throw new Yue2TransientExhaustedError(
    code,
    attempts,
    `YuE2 瞬时不可用（${code}：${yue2FallbackReason(lastError)}）；已按退避重试 ${attempts - 1} 次仍失败。` +
      "按「音乐只走 YuE2」的要求，本次未回落 FlowMusic／Lyria、未扣费。请稍候（等本机当前生成结束或反向隧道恢复）后原样重试。",
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
