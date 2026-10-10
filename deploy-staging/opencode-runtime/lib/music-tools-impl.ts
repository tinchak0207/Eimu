// <harness-only>
/**
 * music_gen harness 工具 VPS staging 稿（MOE Wave1 片B，2026-09-08 机械导出）。
 *
 * 本档由 tools/export-music-tools-staging.ts 从行为真源 src/lib/music-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/resolveKey/ffprobe 时长/上传通路
 * 全在），除「环境适配」外与真源逐行等价。
 * 白名单 diff 仅六处：① 本注释头；②③④⑤⑥ 真源 `from "./music-lyria"` → `from "./music_lyria"`、
 * `from "./music-flowmusic"` → `from "./music_flowmusic"`、
 * `from "./music-prompt-director"` → `from "./music_prompt_director"`、
 * `from "./music-yue2"` → `from "./music_yue2"` 与
 * `from "./music-take-entropy"` → `from "./music_take_entropy"`（同目录落位档名惯例）。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-music-tools-staging.ts` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/music-tools-impl.ts
 * env：GATEWAY_URL（默认 http://127.0.0.1:8081）、HARNESS_API_KEY（fallback）、
 *      GEMINI_STUDIO_API_KEY（lyria-3.5 generateContent 主 key，音频落盘经 gateway 会话上传存储）、
 *      GEMINI_API_KEY（Vertex lyria-002 降级）、FLOWMUSIC_ADMIN_USER／FLOWMUSIC_ADMIN_PASSWORD
 *      （FlowMusic 真鉴权探针 /api/tokens/1/refresh-credits 用；缺失时探针降级为 unreachable 提示）。
 */
// </harness-only>

/**
 * music_gen harness 工具（MOE 改革 Wave1 片B 音乐 Expert，2026-09-08）。
 *
 * 定义形状同构 src/lib/blender-tools.ts 的 BlenderToolDef（零依赖：
 * { id, description, args, execute } + ok()/fail() 契约，回 { title, output }，
 * output 为 JSON 字串）；ok/fail 与 resolveKey 逐行同构
 * src/vendor-bridges/lib/director-common.ts（VPS 落位范式：gateway
 * /internal/session-key 解 Bearer key，fallback env HARNESS_API_KEY）。
 *
 * 生成通路：Google Lyria（src/lib/music-lyria.ts，Gemini API v1beta/interactions，
 * env GEMINI_API_KEY）。duration_hint=full → lyria-3.5（整歌 ~3 分钟）；
 * clip30 → lyria-3-clip-preview（固定 30 秒）。无歌词默认按纯器乐处理
 * （官方写法 "Instrumental only, no vocals."），需要人声必须提供歌词。
 *
 * prompt 规则层：buildToolPrompt 组出完整文本（含器乐声明）后，最后一关过
 * src/lib/music-prompt-director.ts 的 directMusicPrompt（伪标签/时间戳剥除、
 * 六层补齐、通路长度上限），回执 prompt_director 如实回报改写/警告/截断。
 * 顺序不可颠倒：220 runes 上限要算进器乐声明等所有字元。
 *
 * 音频资产通路（复用既有 gateway 平台存储，与影片/TTS 同域）：生成成功的音频经
 * gateway 素材入库端点 POST {GATEWAY}/internal/media/upload?session_id=<id> 落盘
 * （JSON body {path_b64, filename}，鉴权 = session_id 解析＋loopback 门，请求形状同
 * tools/video_upload.ts），回应 url 即平台公网直连 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>），直接交付。
 * uploadOverride 允许 VPS 接线时整体替换上传入口（备用）。
 *
 * 时长：ffprobe 实测（同 audio_first_timeline 片4 先例，沙箱有 ffprobe）；
 * ffprobe 不可用时回退 model_hint（full≈180s / clip30=30s）并如实标注
 * duration_source，绝不把估算冒充实测。
 *
 * 错误铁律（同 blender-tools）：所有失败一律结构化 fail()，含人话 hint 与
 * 底层原因，绝不 throw 原始错误逃逸、绝不吞错。
 * 工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  FLOWMUSIC_MODELS,
  FlowMusicServiceError,
  classifyFlowMusicFailure,
  flowMusic2ApiUrl,
  generateFlowMusicTrack,
  isFlowMusic2ApiEnabled,
  type GenerateFlowMusicTrackResult,
} from "./music_flowmusic"
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
} from "./music_lyria"
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
} from "./music_yue2"
import { describeRetainedParts, directMusicPrompt, stripLyricsTimestamps } from "./music_prompt_director"
import {
  buildMusicPreferenceQuestion,
  type MusicTakeFeature,
// <harness-only>
} from "./music_take_entropy"
import { WORKSPACE, checkAgentPath, looksLikeAgentPath } from "./sandbox"
// 音乐扣费（2026-10-10「音乐 1 币/次」）：平台扣费端点经既有 platformFetch 签章轮子，
// 不另造 fetch（同 image_generate／workflow 的调用范式）。
import { platformFetch, randomUUID } from "./client"
// </harness-only>

// ── plumbing（ok/fail/resolveKey 同构 director-common.ts） ───────────────────

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

function toFail(e: unknown): MusicToolResult {
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
function textFingerprint(text: string): { sha256: string; chars: number; runes: number } {
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
async function appendMusicPromptChain(record: Record<string, unknown>): Promise<string | null> {
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
function yue2FallbackReason(e: unknown): string {
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

/**
 * source_audio 前缀剥除（2026-09-19 片 O）：工具参数允许 data: 前缀
 * （与 reference_images 同款处理模式——agent 从 data URL/附件拿到的音频常带前缀），
 * client 端 /transcribe 只收纯 base64（服务端 b64decode 不认前缀）。
 * 一律取**最后一个逗号**之后（data:audio/flac;base64,XXXX）。
 */
function stripDataUrlPrefix(raw: string): string {
  const commaIndex = raw.lastIndexOf(",")
  return commaIndex >= 0 ? raw.slice(commaIndex + 1).trim() : raw.trim()
}

// <harness-only>
// ── source_audio 输入解析：接受工作区档案路径（2026-10-04 本地参考音档接线）─────────
//
// 背景：source_audio 原本只吃 base64／data: 前缀，模型得把几 MB 音档塞进工具参数，实务上
// 做不到。使用者附件其实已落盘在 agent 工作区 uploads/<session>/，工具端本来就能读档
// （既有流程已把 base64 写成暂存档喂 ffprobe）。故在此把「路径」统一解析成纯 base64，
// 下游扒谱／生成／计费流程一行不动。
//
// 判定顺序 fail-loud（不静默忽略）：
//   ① data: 前缀 → 剥前缀当 base64；
//   ② http(s):// → 本轮不支援，明确报错（不静默忽略）；
//   ③ 看似路径 → **必须**经 checkAgentPath 沙箱白名单（realpath 落 workspace 子树＋
//      uploads 只放行本会话），通过才读档；越权路径一律 path_denied；
//   ④ 其余 → 视为裸 base64。
// 档案大小上限沿用既有读档/音讯上限语义（20MB，同 read_image）；超限明确报错并说出
// 实际大小与上限，**绝不静默截断**（截断后的音讯＝扒谱垃圾）。

/** 源音档档案大小上限（同 read_image 的 20MB 读档口径）。 */
export const MAX_SOURCE_AUDIO_BYTES = 20 * 1024 * 1024

export type SourceAudioResolution = {
  /** 纯 base64（无 data: 前缀，喂 transcribeYue2Score）。 */
  base64: string
  /** 来源种类（除错/回执用，非契约栏位）。 */
  source: "base64" | "data_url" | "workspace_file"
  /** 读档时的音档位元组数（base64/data: 来源为 undefined）。 */
  bytes?: number
  /** 读档时的原始路径（仅 workspace_file）。 */
  path?: string
}

export type SourceAudioResolveResult =
  | { ok: true; value: SourceAudioResolution }
  | { ok: false; code: string; message: string }

/**
 * 把 source_audio 的原始输入（base64／data:／工作区路径）解析成纯 base64。
 * 纯函数语义外的唯一副作用＝读档（路径分支时，且已过沙箱闸）。错误一律回结构化 code/message，
 * 由呼叫端转 fail()（不 throw，保持工具 ok/fail 契约）。
 */
export async function resolveSourceAudio(raw: string, sessionId: string | undefined): Promise<SourceAudioResolveResult> {
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) {
    return {
      ok: false,
      code: "invalid_args",
      message:
        "source_audio 本轮不支持 http(s) 音频 URL。请改用工作区内的音频文件路径（用户上传的参考音频就在 uploads/<session>/ 下，直接传该路径即可），或直接传音频 base64／data: 前缀。",
    }
  }
  if (/^data:/i.test(s)) {
    return { ok: true, value: { base64: stripDataUrlPrefix(s), source: "data_url" } }
  }
  if (!looksLikeAgentPath(s)) {
    return { ok: true, value: { base64: stripDataUrlPrefix(s), source: "base64" } }
  }
  // 看似路径 → 必须经沙箱白名单闸（不得绕过、不得读工作区外的档）。
  const verdict = checkAgentPath(s, sessionId ?? "")
  if (!verdict.ok) {
    const reasonText: Record<string, string> = {
      outside_workspace: "路径不在创作工作区内",
      internal_state: "路径是平台内部状态目录，不对创作任务开放",
      internal_config: "路径是平台内部配置文件，不对创作任务开放",
      uploads_root: "不能指向全部上传目录",
      foreign_upload: "该附件不属于当前会话",
    }
    return {
      ok: false,
      code: "path_denied",
      message: `source_audio 路径被沙箱拒绝（${reasonText[verdict.reason] ?? verdict.reason}）：${s}。只能读本会话可见的音频文件（推荐 uploads/<session>/ 下的附件），或直接传音频 base64。`,
    }
  }
  const absPath = nodePath.resolve(WORKSPACE, s)
  const limitMb = MAX_SOURCE_AUDIO_BYTES / 1024 / 1024
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(absPath)
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)
    return {
      ok: false,
      code: "source_audio_read_failed",
      message: `source_audio 读取失败：无法访问文件 ${s}（${errno}）。请确认路径存在且是音频文件，或改传音频 base64。`,
    }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      code: "source_audio_read_failed",
      message: `source_audio 读取失败：${s} 不是文件（是目录或其他类型）。请指向具体音频文件。`,
    }
  }
  if (stat.size > MAX_SOURCE_AUDIO_BYTES) {
    return {
      ok: false,
      code: "source_audio_too_large",
      message: `source_audio 文件过大：${(stat.size / 1024 / 1024).toFixed(2)} MB，上限 ${limitMb} MB。请先压缩或裁剪源音频后再传（本工具绝不静默截断——截断后的音频会让扒谱失真）。`,
    }
  }
  let buf: Buffer
  try {
    buf = await fsp.readFile(absPath)
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)
    return { ok: false, code: "source_audio_read_failed", message: `source_audio 读取失败：${s}（${errno}）。` }
  }
  if (buf.byteLength > MAX_SOURCE_AUDIO_BYTES) {
    // stat 与 read 之间档案变大（竞态）；读后复核同样 fail-loud。
    return {
      ok: false,
      code: "source_audio_too_large",
      message: `source_audio 文件过大：${(buf.byteLength / 1024 / 1024).toFixed(2)} MB，上限 ${limitMb} MB（读取后复核，绝不静默截断）。`,
    }
  }
  return { ok: true, value: { base64: buf.toString("base64"), source: "workspace_file", bytes: buf.byteLength, path: s } }
}

/**
 * 音乐生成扣费（2026-10-10「音乐 1 币/次」）：契约＝平台控制面 `POST /v1/music/charges`
 * （biz key 鉴权，请求体只带 `{ ref }`；定价在服务端，1 币/次，同 ref 幂等不双扣；
 * 成功回 `{ ok:true, cost_coins:1 }`、重复回 `{ ..., deduped:true }`、余额不足 402）。
 *
 * 语义与调用纪律：
 * - **先出音频、后扣费**：本 helper 只在回执组装点被呼叫（音频已生成／已上传后才评估），
 *   绝不在生成前扣。
 * - **不双扣**：`ref` 在每次工具调用开始时生成一次（见 execute 内 `musicChargeRef`），
 *   同一次调用内的重试／回落通路沿用同一个 ref，平台按 ref 幂等。
 * - **免费路径不扣**：`probe=true` 与「三通路全失败」都提前 return／throw，到不了呼叫点。
 * - **失败不静默吞**：扣费失败如实回报（回 `cost_coins:null` ＋ `charge_error` ＋ `charge_note`），
 *   不虚报 0，也不因扣费失败丢掉已产出的音频。
 *
 * 账本归属（`takes` 参数）：本次调用只扣 1 次，但 gateway 的 collectToolOutputMediaUrls 会把
 * 顶层 cost_coins 回退贴到**每一张**音频卡（多 take 各一条账本行）。为避免账本合计（N 条 × 1 币）
 * 与实扣（1 币/调用）背离，成功扣费后把非主 take 的 cost_coins 显式标 0，使账本合计 = 实扣。
 */
async function musicChargeReceiptFields(
  ref: string,
  sessionID: string | undefined,
  takes?: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const resp = await platformFetch(
      "/music/charges",
      { method: "POST", body: JSON.stringify({ ref }) },
      sessionID ?? "",
    )
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    if (!resp.ok) {
      // 平台错误封套＝{ error: { message, type, code, param } }（见 src/app/api/v1/music/charges/
      // route.ts 的 errorResponse）——是**物件**不是字串；故先认 error.message，退回 error 字串／
      // 顶层 message，最后才落到 HTTP 码，避免把平台的明文原因吞成泛用「HTTP 4xx/5xx」。
      const errField = body?.error
      const detail =
        typeof errField === "string"
          ? errField
          : errField && typeof errField === "object" && typeof (errField as { message?: unknown }).message === "string"
            ? String((errField as { message?: unknown }).message)
            : typeof body?.message === "string"
              ? body.message
              : `HTTP ${resp.status}`
      return {
        cost_coins: null,
        charge_error: resp.status === 402 ? "余额不足（这笔未扣费）" : `扣费失败（HTTP ${resp.status}）`,
        charge_note: `本次音乐已生成，但平台扣费未完成：${detail}。费用状态以平台账本为准，不得对用户宣称已扣费，也不得当作免费。`,
      }
    }
    if (typeof body?.cost_coins !== "number") {
      return {
        cost_coins: null,
        charge_error: "平台扣费回应缺 cost_coins 字段",
        charge_note: "本次音乐已生成，但平台扣费回应未带 cost_coins，实际费用状态以平台账本为准。",
      }
    }
    // 非主 take 归 0：本次调用只扣 1 次，避免 gateway 把顶层价贴到每张卡使账本虚增（见上方说明）。
    if (takes && takes.length > 1) for (const t of takes.slice(1)) t.cost_coins = 0
    return {
      cost_coins: body.cost_coins,
      ...(body?.deduped === true ? { cost_deduped: true } : {}),
    }
  } catch (e: any) {
    return {
      cost_coins: null,
      charge_error: "扣费呼叫异常",
      charge_note: `本次音乐已生成，但扣费呼叫异常：${e?.message ?? String(e)}。费用状态以平台账本为准。`,
    }
  }
}
// </harness-only>

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
const YUE2_TOOL_COT_MODES: readonly Yue2CotMode[] = ["full", "melody"]

/** gateway 素材入库端点（JSON 单笔位元组；请求形状同 tools/video_upload.ts 的 path_b64 分支）。 */
function uploadsEndpoint(sessionId: string): string {
  return `${GATEWAY}/internal/media/upload?session_id=${encodeURIComponent(sessionId)}`
}

/**
 * 上传音频入库 gateway 平台存储，返回平台公网直连 URL
 * （https://store.tinchak0207.xyz/image-data/files/uploads/<name>）。
 * 失败带 HTTP 状态与原文摘录抛 MusicToolError（诚实铁律，不吞错）。
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

/**
 * 情绪契约 → prompt（工具层薄组装：契约栏位从 prompt 文本解析不了，所以工具参数
 * 只收自由文本 prompt；结构标签/时间戳由调用方写进 prompt 文本。lyrics 缺省=纯器乐）。
 */
function buildToolPrompt(rawPrompt: string, hasLyrics: boolean): string {
  if (hasLyrics) return rawPrompt.trim()
  // 无歌词 → 官方器乐写法收尾（若 prompt 已声明 vocal 意图则尊重原文不重复加）。
  if (/instrumental only|no vocals/i.test(rawPrompt)) return rawPrompt.trim()
  return `${rawPrompt.trim()} Instrumental only, no vocals.`
}

export const musicGenTool: MusicToolDef = {
  id: "music_gen",
  description:
    // <harness-only>
    "调用 Lyria／FlowMusic2API／YuE2 生成音乐（主题曲/插曲/配乐）。整歌或快速生成，返回音频 URL、时长与歌词回显；YuE2 通路另返回可编辑的白盒 ABC 乐谱 score_abc（可二次精修），且支持带谱重渲染——传入 abc（自备/已编辑的 ABC 乐谱）＋cot_mode 即以该乐谱为约束重新生成录音（乐谱编辑＝改和弦/改谱后重渲染出新版本，仅 YuE2 通路有效），或传入 source_audio（源音频：base64／data: 前缀／工作区文件路径——推荐直接传附件路径 uploads/<session>/ref.mp3）走翻唱工作流——先自动扒谱（SheetSage2 提取旋律骨干）再以新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式，伴奏自由适配新风格；显式传 full 则保留原曲和声重渲染）。无歌词时按纯器乐处理；需要人声必须提供歌词。风格 prompt 按六层公式写全（顺序即优先级）：GENRE（流派/年代或场景，放最前）→ 决定性参数（BPM／调性 key／和弦进行／段落结构，写在最前 1/3，如 96 BPM, key of C major, Am7-Dm7-G7-Cmaj7, verse-chorus-bridge；上游摘要只逐字保留前段，写在尾部会被丢）→ MOOD（最多两个相容情绪词）→ INSTRUMENTATION（2-3 件主导乐器＋演奏法）→ VOCAL（谁唱、怎么唱）→ PRODUCTION（年代/混音/空间等修饰性描述，放最后、可被裁）。提示词会先过规则层（补缺层/剥死时间码/前置决定性参数/整句裁长度），结果在回执 prompt_director 如实回报。长度硬上限（runes）：FlowMusic2API 无歌词单行分支 220、带歌词/段落标签保版面分支 3000；YuE2 style 600；Lyria 不设上限。无歌词器乐分支最紧——超 220 时规则层整句丢弃低优先的描述性修饰子句（混音／空间／年代感），保住 GENRE 与前置的决定性参数（BPM／调性／和弦进行／段落结构），绝不切半句，被丢的层在回执 prompt_director.truncated 列出；想保住完整描述就压进 220，或给歌词走 3000 分支。写歌词前先传 probe=true 做免费通路体检（不生成、不计费），确认 can_generate_vocal_song 再动笔。通路由环境配置固定（优先序 YuE2 > FlowMusic2API > Gemini Lyria 直连），三通路能力有差异，见各参数说明。音乐生成按次统一计价：1 币/次（不分通路、不分 take 数——每次成功的 music_gen 调用各计 1 币，probe=true 免费不扣，未产出音频不扣）；生成前先用 quote_bundle（kind:\"music\"）报价，报价与实扣同源（平台目录 x_coins_per_music），最终以回执 cost_coins 为准。",
    // </harness-only>
  args: {
    probe: {
      type: "boolean",
      required: false,
      description:
        "true=只做免费通路健康探针（不生成音乐、不花钱、不需要 prompt），返回每条通路状态：ready 可用／needs_human_login 需人工登录／config_disabled 配置未启用／resource_insufficient 资源不足（显存/GPU 忙/配额）／unreachable 服务不可达，以及 can_generate_vocal_song、can_generate_instrumental、first_ready、human_actions 与各通路 capability 备注（YuE2 可用时此处给单首时长上限，或说明上游未回报预算）。写歌词前先调一次。",
    },
    prompt: {
      type: "string",
      // 生成时必填（execute 内校验并回 invalid_args）；schema 放宽是为了 probe=true 可单独调用。
      required: false,
      description:
        "生成时必填（probe=true 时可省略）。风格描述按六层公式写全（顺序即优先级）：GENRE（流派/年代或场景，放最前）→ 决定性参数（BPM／调性 key／和弦进行／段落结构，写在最前 1/3，如 96 BPM, key of C major, Am7-Dm7-G7-Cmaj7, verse-chorus-bridge）→ MOOD（≤2 个相容情绪词）→ INSTRUMENTATION（2-3 件乐器＋演奏法）→ VOCAL（谁唱/怎么唱）→ PRODUCTION（年代/混音/空间等修饰性描述，放最后、可被裁）。例：cinematic orchestral, 90 BPM, key of D minor, mood: heroic and sweeping（速度／调性紧接流派，写在最前）。可写 [Verse]/[Chorus] 段落标签或 [0:00 - 0:10] Intro: 时间戳结构。长度硬上限（runes）：FlowMusic2API 无歌词单行分支 220／带歌词保版面分支 3000、YuE2 600、Lyria 无限制；超限时规则层整句丢低优先的描述性修饰子句（保住 GENRE 与前置的 BPM／调性／和弦进行／段落结构，绝不切半句），丢掉的层见回执 prompt_director.truncated/warnings。注意：时间戳结构只对 Gemini Lyria 直连通路生效，FlowMusic2API 与 YuE2 通路不认时间戳（会被剥除并如实标注）。",
    },
    lyrics: {
      type: "string",
      required: false,
      description:
        "自定义歌词（可选）。支持 [Verse]/[Chorus]/[Bridge] 段落标签或 [0:00 - 0:10] 时间戳结构；中文歌词一律简体（用户给繁体中文歌词先转成简体再送，不写繁体字形）；非中文歌词按内容语言（英文歌英文、日文歌日文），不强制汉化。YuE2 通路要求自定义歌词带 [Verse]/[Chorus] 段落标签（上游语法必需）。时间码只有 Gemini Lyria 直连认：FlowMusic2API 与 YuE2 会剥除歌词里的 [0:00 - 0:10] 时间码（段落标签原样保留），并在回执 notes 用大白话说明。缺省=纯器乐（Instrumental only, no vocals）。演唱正文不要用空格当停顿记号（会被读成演唱停顿、产生机械切分），停顿用标点或段落标签。字数须与目标时长×BPM 匹配：按「演唱字数预算 = 目标秒数 × BPM ÷ 60 × 每拍音节数」核算（每拍音节数：慢板 ≤76 → 0.8／中速 77–119 → 1.0／快板 ≥120 → 1.4；目标秒数 = min(用户明确要求, FlowMusic2API 实测区间小值 165 秒)，用户未给时长用 165 秒、BPM 未定先定一个（缺省 88）；单曲演唱字数硬上限 ≤400 字；非中文按音节数计，英文按音节、1 个英文词约 1.5 音节），超预算上游不会拒收，只会压时值、砍长音硬塞（听感 rap 化）。",
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
        // <harness-only>
        "翻唱工作流：源音频（可选，仅 YuE2 通路有效）。三种给法：①工作区内的音频文件路径（推荐——用户上传的参考音频就在 uploads/<session>/ 下，直接传该路径即可，无需自己读成几 MB 的 base64）；②音频 base64；③data: 前缀的 base64（data:audio/mpeg;base64,…）。本轮不支持 http(s) 音频 URL（传了会明确报错）。传入即走翻唱——先自动扒谱（SheetSage2 从源音频提取旋律骨干 ABC，回执 transcribed_abc_sha256/transcribe_warnings 如实回报），再以 prompt 描述的新风格重新演绎（cot_mode 缺省 melody＝官方翻唱模式：只保留旋律骨干，伴奏自由适配新风格）。源音频文件上限 20MB（超限明确报错并说明实际大小，绝不静默截断）；路径必须落在工作区内并经沙箱白名单校验（越权路径报 path_denied）。传 source_audio 前建议先 probe=true 做免费通路体检，确认 YuE2 可用再动。与 abc 参数互斥（一个要现扒谱、一个已自备乐谱，同传报错）。其他通路（FlowMusic2API／Gemini Lyria）不支持翻唱，传了会直接报错（不静默忽略）；扒谱/生成失败也直接报错不回落（翻唱语义不可被无谱通路顶替）。",
        // </harness-only>
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
      // 歌词时间码剥除（2026-10-04 F-06）：FlowMusic2API／YuE2 不认 `[0:00 - 0:10]` 时间码
      // （只认 `[Verse]`/`[Chorus]` 段落标签），剥除后如实回报；Lyria 直连认时间码，原样保留。
      // 与 style prompt 同一政策（段落标签保留、文字不动）。
      const rawLyrics = lyrics ?? ""
      const strippedLyrics = stripLyricsTimestamps(rawLyrics)
      const lyricsForChannel = (channel: "yue2" | "flowmusic" | "lyria") =>
        channel === "lyria" ? rawLyrics : strippedLyrics.lyrics
      const durationHintRaw = asString(rawArgs.duration_hint) ?? "full"
      if (durationHintRaw !== "full" && durationHintRaw !== "clip30") {
        return fail("invalid_args", `duration_hint 只接受 "full" 或 "clip30"，收到 "${durationHintRaw}"。`)
      }
      const toolPrompt = buildToolPrompt(prompt, Boolean(lyrics))

      // ── 乐谱编辑参数（片 K，2026-09-19）────────────────────────────────────
      // abc＝自备/已编辑 ABC 乐谱（官方 editing.md 语义：同生成器、带修改后的乐谱再渲染
      // 一次）；cot_mode＝乐谱约束模式（full=旋律+和弦都约束／melody=只约束旋律、伴奏
      // 自由适配＝翻唱模式）。仅 YuE2 通路有效——其他通路不认乐谱，如实报错不静默忽略
      //（静默忽略＝让 agent 误以为带谱语义已生效，比报错更糟）。
      const abc = asString(rawArgs.abc)
      // ── 翻唱参数（片 O，2026-09-19）────────────────────────────────────────
      // source_audio＝源音频 base64（允 data: 前缀，同 reference_images 处理模式）。
      // 语义＝翻唱：先 transcribeYue2Score 扒出旋律骨干 ABC，再带 abc 生成。
      // 互斥：source_audio 与 abc 同传＝语义冲突（一个要现扒、一个已自备）→ invalid_args。
      const sourceAudioRaw = asString(rawArgs.source_audio)
      if (sourceAudioRaw && abc) {
        return fail(
          "invalid_args",
          "source_audio 与 abc 互斥：source_audio＝现场扒谱（从源音频提取旋律骨干），abc＝已自备/已编辑的乐谱，两者同传语义冲突。请只传其一。",
        )
      }
      // <harness-only>
      // 本地参考音档接线（2026-10-04）：base64／data:／工作区档案路径统一解析成纯 base64。
      // 越权路径（沙箱闸拒）、http(s) URL、超限档在此 fail-loud，之后流程零改动。
      let sourceAudioBase64: string | undefined
      if (sourceAudioRaw) {
        const resolved = await resolveSourceAudio(sourceAudioRaw, context?.sessionId)
        if (!resolved.ok) return fail(resolved.code, resolved.message)
        sourceAudioBase64 = resolved.value.base64
      }
      // 音乐扣费 ref（2026-10-10「音乐 1 币/次」）：**每次工具调用生成一次**，同一次调用内的
      // 通路重试／回落全部沿用同一个 ref（平台按 ref 幂等 ⇒ 绝不双扣）。此处位于任何生成副作用
      // 之前；probe=true 已提前 return、三通路全失败在下游 throw，都到不了扣费点。
      const musicChargeRef = `music:${context?.sessionId ?? "anon"}:${randomUUID()}`
      // </harness-only>
      // cot_mode 缺省：常规＝full；翻唱（带 source_audio）＝melody（官方翻唱模式：
      // 只保留旋律骨干、伴奏自由适配新风格）；显式传 full 也允许＝保留原和声的重渲染。
      const cotModeExplicit = asString(rawArgs.cot_mode)
      const cotModeRaw = cotModeExplicit ?? (sourceAudioRaw ? "melody" : "full")
      if (!YUE2_TOOL_COT_MODES.includes(cotModeRaw as Yue2CotMode)) {
        return fail(
          "invalid_args",
          `cot_mode 只接受 "full" 或 "melody"，收到 "${cotModeRaw}"（"off" 不对工具开放：工具语义永远要求乐谱回执 score_abc，off 模式不回乐谱且对编辑工作流无用）。`,
        )
      }
      const cotMode = cotModeRaw as Yue2CotMode
      // melody 无乐谱来源（既无 abc 也无 source_audio）＝语义不成立；带 source_audio
      // 时 abc 由扒谱补上，不适用本规则。
      if (cotMode === "melody" && !abc && !sourceAudioRaw) {
        return fail(
          "invalid_args",
          'cot_mode="melody" 必须搭配 abc 参数：melody 模式的语义就是「以传入的 ABC 乐谱为旋律骨干（伴奏自由适配）」，没有 abc 无意义。请补传 abc，或改用默认 full。',
        )
      }
      const abcSha256 = abc ? createHash("sha256").update(abc, "utf8").digest("hex") : null

      // 通路选择（2026-09-09 换血，2026-09-18 加第三通路）：env YUE2_MODAL_ENDPOINT 非空
      // → YuE2 Modal（白盒 ABC 乐谱、cot、无时长控制）；否则 FLOWMUSIC2API_URL 配置即走
      // FlowMusic2API（lyria 整歌 / lyria-fast 快速；上游无 30s 片段模式，clip30 映射快速别名）；
      // 两者皆未配置回落 Gemini Lyria interactions 直连。三路返回形状同构
      // （audioBase64/mimeType），下游上传/ffprobe 实测/交付形状完全不变。
      // 2026-09-19 加失败回落：YuE2 服务跑在笔电上（反向隧道进 VPS），笔电关机/隧道
      // 断线时 generateYue2Track 抛错（网路层/超时/非 2xx）→ 自动回落 FlowMusic 完整
      // 重跑一次，音乐管线不因单通路故障而坏（见下方生成段）。
      // YuE2 是「歌词→整歌」：纯器乐（无歌词）或 30 秒短档它兑现不了（上游 400「lyrics must be
      // a non-empty string」／无时长栏位）。有别的通路在场就让位给它们，而不是先撞 YuE2 再报错
      //（2026-09-29 e2e：「咖啡店背景音乐 30 秒」两种都撞墙）。abc／翻唱委托仍必走 YuE2。
      const otherMusicChannel = isFlowMusic2ApiEnabled() || hasGeminiStudioApiKey() || Boolean(process.env.GEMINI_API_KEY?.trim())
      const yue2Enabled =
        isYue2ModalEnabled() &&
        (abc !== undefined || sourceAudioRaw !== undefined || !otherMusicChannel || (Boolean(lyrics) && durationHintRaw !== "clip30"))
      const flowMusicEnabled = isFlowMusic2ApiEnabled()
      const flowMusicModel = FLOWMUSIC_MODELS[durationHintRaw === "clip30" ? "clip30" : "full"]
      const lyriaModel = durationHintRaw === "clip30" ? LYRIA_MODELS.clip30 : LYRIA_MODELS.full

      // YuE2 无 30 秒短档模式（冻结合约根本没有时长栏位）：如实报错，绝不静默生成整歌再
      // 假装是 30 秒。理由：clip30 的委托语义是「短档对时」（MV 对点），上游产不出来；
      // 硬吞会让回执 duration_hint=clip30 与实际成品互相矛盾＝说谎，且 YuE2 一次生成是
      // 分钟级，先失败比烧完才报废便宜；hint 直接给可执行的下一步。
      // 注意：这是参数性 fail（委托本身不合法，我们在上游前自己拒的），不是 YuE2 服务
      // 抛错——不触发回落，语义与「隧道断线」不同。
      if (yue2Enabled && durationHintRaw === "clip30") {
        return fail(
          "unsupported_duration_hint",
          'YuE2 通路无 30 秒短档模式（上游契约无时长控制）；请改传 duration_hint="full" 走整歌，或改用 FlowMusic2API／Gemini Lyria 通路。',
        )
      }

      // 带 abc 的委托在非 YuE2 通路＝通路能力不匹配，如实报错不静默忽略（clip30 同款
      // 参数性 fail 语义：委托本身带了通路兑现不了的语义，上游前自己拒，不触发回落）。
      if (abc && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_abc",
          "abc（ABC 乐谱重渲染）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 abc 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 不认乐谱，静默忽略会让乐谱语义凭空丢失。",
        )
      }

      // 带 source_audio 的委托（翻唱）同样仅 YuE2 通路：扒谱（/transcribe）与带谱生成
      // 都是 YuE2 服务能力，其他通路兑现不了「以这首歌的旋律骨干重新演绎」的语义。
      // 同款参数性 fail（上游前自己拒，零上游请求，不触发回落）。
      if (sourceAudioRaw && !yue2Enabled) {
        return fail(
          "unsupported_channel_for_source_audio",
          "source_audio（翻唱：扒谱＋重演绎）仅 YuE2 通路支持，当前环境未启用 YuE2（YUE2_MODAL_ENDPOINT 未配置）。请去掉 source_audio 后重试，或等 YuE2 通路可用。FlowMusic2API／Gemini Lyria 无扒谱能力，静默忽略会让翻唱语义凭空丢失。",
        )
      }

      // 确定性规则层（Music Prompt Director）必须是送上游前的最后一关：
      // 先让 buildToolPrompt 组出含器乐声明的完整文本，再过 director 做伪标签/时间戳
      // 剥除、六层补齐与长度上限——220 runes 上限必须把器乐声明等所有字元算进去，
      // 提前过 director 会让后加的声明把长度顶爆（且 strip-timestamps 只认 flowmusic/yue2）。
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

      // ── 翻唱：先扒谱（片 O，2026-09-19）──────────────────────────────────
      // source_audio → transcribeYue2Score 得旋律骨干 ABC（melodyOnly=true 与 cot=melody
      // 语义对齐）。扒谱抛错（含 422 abc_missing 确定性失败）→ 带专属错误码 fail，
      // **不回落**（翻唱语义不可被无谱通路顶替，同带 abc 不回落的诚实铁律）。
      let effectiveAbc: string | undefined = abc
      let transcribedAbcSha256: string | null = null
      let transcribeWarnings: string[] | null = null
      if (sourceAudioRaw) {
        let transcribed: Awaited<ReturnType<typeof transcribeYue2Score>>
        try {
          transcribed = await transcribeYue2Score({
            // <harness-only>
            audioBase64: sourceAudioBase64 ?? stripDataUrlPrefix(sourceAudioRaw),
            // </harness-only>
            melodyOnly: true,
          })
        } catch (e) {
          if (e instanceof Yue2TranscribeError) {
            // abc_missing（422）＝这份音频扒不出旋律，重试同一份不会变好，hint 如实说。
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
      // 实际送生成的乐谱指纹：带 abc＝委托谱；翻唱＝扒谱产物（与 transcribed_abc_sha256 同值）。
      const effectiveAbcSha256 = effectiveAbc
        ? createHash("sha256").update(effectiveAbc, "utf8").digest("hex")
        : null

      // ── 生成＋失败回落（2026-09-19）────────────────────────────────────────
      // yue2 启用且 generateYue2Track 抛错（网路层/超时/非 2xx）→ 若 FlowMusic 已配置，
      // 回落走 generateFlowMusicTrack 完整重跑一次；回执 channel 用实际通路字串，
      // additive 加 fallback_from/fallback_reason。回落时 prompt 必须用 flowmusic 通道
      // **重新过 director**（yue2 与 flowmusic 的规则层不同：剥时间戳 vs 压单行/220 上限），
      // 不能拿 yue2 版面直接送 flowmusic——director 是纯函数，可重复呼叫。
      // 2026-09-28 改为整条链回落：YuE2 → FlowMusic → Gemini Lyria 直连（Lyria 仅在
      // GEMINI_API_KEY 已配置时入链）。起因＝漫剧评测实锤：纯器乐 BGM 送 YuE2 被冻结合约
      // 400（lyrics 必填）→ 回落 FlowMusic 又遇帐号鉴权 502 → 整集无 BGM，而 Lyria 金钥
      // 在场却从未被尝试。回落只在「已选通路抛错」时发生，全链失败 fail 带每一路原因。
      // 2026-09-19 片 K 例外：带 abc 的委托 YuE2 抛错**不触发回落**，直接 fail 带原文。
      // 理由＝语义完整性优先：FlowMusic 不认 abc，回落会静静丢失「以这份乐谱为约束」的
      // 委托语义，agent 拿到的是一首语义无关的歌却以为编辑已生效——比直接失败更糟
      //（诚实铁律：能力不匹配要如实报错，绝不静默降级）。
      // 2026-09-19 片 O 同款：带 source_audio（翻唱）的委托抛错同样不回落。
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
          // 换通路必须用该通路**重新过 director**（各通路规则层不同），director 是纯函数可重复呼叫。
          directorChannel = channel
          // Vertex lyria-002 纯器乐：含人声/歌词措辞的 prompt 会被上游 500「Could not generate audio」，
          // 故落到它时按纯器乐重组 prompt（歌词丢弃会在回执 degraded/ignored_inputs 明说）。
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
                  lyrics: lyricsForChannel("yue2"),
                  cot: cotMode,
                  ...(effectiveAbc !== undefined ? { abc: effectiveAbc } : {}),
                })
              : channel === "flowmusic"
                ? await generateFlowMusicTrack({ prompt: finalPrompt, lyrics: lyricsForChannel("flowmusic"), model: flowMusicModel })
                : await generateLyriaTrack({ prompt: finalPrompt, lyrics: lyricsForChannel("lyria"), model: lyriaModel, imagesBase64 })
          break
        } catch (e) {
          if (hasScoreSemantics) throw e
          if (i === channelChain.length - 1) {
            // 单通路失败照旧抛原错误；多通路全灭则每一路原因都要在回执里看得见。
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
      // 诚实降级：要人声(有歌词)或要整歌(full)却落到 Vertex lyria-002（纯器乐 30s）＝降级交付，必须明说。
      const degradedReasons: string[] = []
      if (lyriaVertex && lyrics) degradedReasons.push("请求含歌词/人声，但最终通路 Vertex lyria-002 仅纯器乐，成品无人声、歌词未使用")
      if (lyriaVertex && durationHintRaw !== "clip30") degradedReasons.push("请求整歌，但 lyria-002 仅出约 30 秒片段")
      const upstreamUrl =
        activeChannel === "flowmusic" ? (generated as unknown as { upstreamUrl: string }).upstreamUrl : null

      // 音频落盘：复用 gateway 会话上传存储（与 TTS/附件同域）。无 sessionId 时
      // 跳过上传、result 如实带 audio_base64（不伪造 URL）。
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
              // <harness-only>
              // 音频已产出（上游已生成）才走到这里 ⇒ 照「先出音频、后扣费」仍扣一次，费用如实回报。
              ...(await musicChargeReceiptFields(musicChargeRef, context?.sessionId)),
              // </harness-only>
            })
          }
          throw e
        }
      }

      // 时长：ffprobe 实测优先；不可用回退通路提示值并如实标注
      // （YuE2 带上游自报 duration_s＝上游端真量测值 → duration_source=upstream_reported；
      //  FlowMusic2API 带上游 Duration 提示、Gemini 通路按 model_hint → model_hint）。
      // 170/180 = 整歌实测区间 162–182s 的中位，仅为模型提示值非实测
      // （duration_source=model_hint 如实标注，不冒充 ffprobe；YuE2 契约保证回 duration_s，
      //  180 只在该栏缺失时才走到，且照样标 model_hint）。
      // 2026-09-19 回落后这段以 activeChannel 为准（回落成功＝实际通路是 flowmusic，
      //  时长语义照 flowmusic：上游 Duration 提示 → model_hint）。
      const yue2Track = activeChannel === "yue2" ? (generated as GenerateYue2TrackResult) : null
      // 上游自报时长（YuE2 duration_s，>0 才是可用量测值；契约保证有，缺了照样标 model_hint）。
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

      // 多候选交付（2026-10-02）：FlowMusic 上游多数回 2 个 clips。主候选照旧走既有
      // url/upstream_url 单数栏位（向后兼容零改动），其余候选经同一上传通路落成平台
      // URL，以 gateway 既已消费的 audios[] 形状 additive 带出（每笔一个 audio.done）。
      // 诚实降级：次候选下载/上传失败只记进 candidate_errors，绝不拖垮主候选交付。
      const flowResult = activeChannel === "flowmusic" ? (generated as GenerateFlowMusicTrackResult) : null
      const candidateErrors: Array<{ candidate_index: number; upstream_url: string; error: string }> = (
        flowResult?.candidateErrors ?? []
      ).map((e) => ({ candidate_index: e.candidateIndex, upstream_url: e.upstreamUrl, error: e.error }))
      // title/sound_prompt（2026-10-03 多 take 偏好闸 additive）：上游 clips[].title 与
      // 回吐的 clips[].sound_prompt 逐候选带出（缺省不带键，既有键零改动），供熵决策层
      // 判「这几版听起来一不一样」。
      const audios: Array<{
        url: string
        upstream_url?: string
        duration_seconds?: number
        candidate_index: number
        title?: string
        sound_prompt?: string
      }> = []
      if (flowResult && url) {
        const primaryCandidate = flowResult.candidates[0]
        // 主候选（index 0）沿用既有 url：同一份位元组不重复上传。
        audios.push({
          url,
          ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
          duration_seconds: Math.round(durationSeconds * 100) / 100,
          candidate_index: 0,
          ...(primaryCandidate?.title !== undefined ? { title: primaryCandidate.title } : {}),
          ...(primaryCandidate?.soundPrompt !== undefined ? { sound_prompt: primaryCandidate.soundPrompt } : {}),
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
              ...(candidate.title !== undefined ? { title: candidate.title } : {}),
              ...(candidate.soundPrompt !== undefined ? { sound_prompt: candidate.soundPrompt } : {}),
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

      // 多版本偏好闸（2026-10-03 additive）：≥2 个候选时呼叫熵决策层，把偏好问题带进
      // 回执（键名 preference_question，只在 ≥2 候选时在场；< 2 时回执形状零变化）。
      // 音档已随各 take 的 audio.done 卡交付，问题卡只「指认」；label → 音频 URL 的
      // 对照见 optionTakeUrls，供导演在拿到答覆后翻译成定版 URL。
      const preferenceQuestion =
        audios.length >= 2
          ? buildMusicPreferenceQuestion(
              audios.map((audio): MusicTakeFeature => ({
                url: audio.url,
                candidateIndex: audio.candidate_index,
                durationSeconds: audio.duration_seconds,
                title: audio.title,
                soundPrompt: audio.sound_prompt,
                lyricsEcho: flowResult?.lyricsEcho,
              })),
            )
          : undefined

      // 人话回执（2026-10-04 F-06／220）：把规则层「动了什么」用人能懂的话带出，
      // 不只丢内部 tag（使用者看不到 agent 的 tool part 细节，这条要 agent 能直接转述）。
      const notes: string[] = []
      if (strippedLyrics.hadTimestamp && activeChannel !== "lyria") {
        notes.push(
          "歌词里的时间码（如 [0:00 - 0:10]）这次没有送进模型——当前通路不认时间码，已按段落标签处理（[Verse]/[Chorus] 等原样保留），除时间码外的歌词文字未改动。",
        )
      }
      // 压缩是事实，回执必须由**实际被丢的层**与**最终 prompt_used 的实际内容**反推，
      // 不得写死成功句（2026-10-04 F2：旧版在 genre 被丢、句子被硬截时仍宣称「保住了流派…没有截半句」）。
      if (directed.compressedClauses !== undefined || directed.hardTruncated) {
        const dropped = directed.compressedLayers ?? []
        const kept = describeRetainedParts(finalPrompt)
        notes.push(
          "风格描述超出了当前通路的长度上限" +
            (dropped.length > 0
              ? `，已按优先级整段丢掉了不重要的子句（丢掉的核心子句层：${dropped.join("、")}）`
              : "，且已无更低优先级的整句子句可丢") +
            `，最终 prompt 里保住：${kept.length > 0 ? kept.join("、") : "（无完整子句）"}。` +
            (directed.hardTruncated ? "结尾为硬截，可能被切成半句。" : "其余为整句处理，没有把句子截成半截。"),
        )
      }

      // prompt 链落档（2026-10-04 G1，best-effort）：把「送上游的 prompt」（＝director
      // 后的 finalPrompt，即回执 prompt_used）与「上游回吐的 sound_prompt」逐次写进
      // workspace 既有 outputs/music-prompt-chain.jsonl，使链在回执 part 未必落库时仍可复算。
      const lyricsForLog = lyricsForChannel(activeChannel)
      const lyricsEchoForLog = (generated as { lyricsEcho?: string }).lyricsEcho
      const promptChainRef = await appendMusicPromptChain({
        session_id: context?.sessionId ?? null,
        channel: activeChannel === "yue2" ? "yue2_modal" : activeChannel === "flowmusic" ? "flowmusic2api" : "lyria_gemini",
        model,
        duration_hint: durationHintRaw,
        // 站 1：agent 自己交给 music_gen 的原始 style prompt（director 前）。
        prompt_input: prompt,
        prompt_input_fingerprint: textFingerprint(prompt),
        // 站 2/3：规则层输出（实送上游文本；＝回执 prompt_used）。
        prompt_sent: finalPrompt,
        prompt_sent_fingerprint: textFingerprint(finalPrompt),
        director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
          compressed_layers: directed.compressedLayers ?? null,
          hard_truncated: directed.hardTruncated ?? false,
        },
        // 歌词只落结构（指纹＋段落标签），不落正文。
        lyrics: {
          ...textFingerprint(lyricsForLog),
          sections: Array.from(new Set(lyricsForLog.match(/\[[^\]]+\]/g) ?? [])),
        },
        lyrics_echo: lyricsEchoForLog ? textFingerprint(lyricsEchoForLog) : null,
        // 站 4：上游 clips[].sound_prompt（逐候选；缺省 null）。
        upstream_sound_prompts: audios.map((a) => a.sound_prompt ?? null),
        upstream_titles: audios.map((a) => a.title ?? null),
      })

      return ok({
        title: "音乐生成完成",
        // <harness-only>
        // 先出音频、后扣费（2026-10-10「音乐 1 币/次」）：走到这里时音频已生成、（有会话时）
        // 各候选已上传。经平台控制面按 musicChargeRef 幂等扣一次，回执带 cost_coins（顶层栏位，
        // 供 audio.done 卡与 gateway 账本消费）；扣费失败如实回 charge_error，绝不静默吞。
        // 传 audios：非主 take 归 0，账本合计 = 实扣 1 币/调用（多 take 不虚增）。
        ...(await musicChargeReceiptFields(musicChargeRef, context?.sessionId, audios)),
        // </harness-only>
        ...(promptChainRef ? { prompt_chain_ref: promptChainRef } : {}),
        ...(url ? { url, path_source: "gateway_uploads" } : { audio_base64: generated.audioBase64, upload: uploadCode }),
        ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
        ...(audios.length > 0 ? { audios } : {}),
        ...(preferenceQuestion !== undefined ? { preference_question: preferenceQuestion } : {}),
        ...(candidateErrors.length > 0 ? { candidate_errors: candidateErrors } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        // 通路如实回报实际生成通路（回落时 flowmusic2api＝真的走 flowmusic，不虚报 yue2）。
        channel: activeChannel === "yue2" ? "yue2_modal" : activeChannel === "flowmusic" ? "flowmusic2api" : "lyria_gemini",
        // 回落事实 additive 回报（只在真的发生回落时在场；既有键零改动）。
        ...(degradedReasons.length > 0 ? { degraded: true, degraded_reason: degradedReasons.join("；") } : {}),
        ...(lyriaIgnored.length > 0 ? { ignored_inputs: lyriaIgnored } : {}),
        ...(fallbackFrom !== null ? { fallback_from: fallbackFrom, fallback_reason: fallbackReason } : {}),
        duration_seconds: Math.round(durationSeconds * 100) / 100,
        duration_source: durationSource,
        duration_hint: durationHintRaw,
        model,
        mime_type: generated.mimeType,
        audio_bytes: bytes.length,
        // 白盒乐谱入交付契约的接点（additive 栏位）：YuE2 通路带可编辑 ABC 乐谱，
        // 其余通路固定 null（栏位一律在场，前端/Expert 契约相容）。
        score_abc: yue2Track?.scoreAbc ?? null,
        // 乐谱编辑回执（片 K additive）：实际生效的 cot 模式（仅 YuE2 通路在场——
        // 其余通路无乐谱语义，回报反而误导）＋带谱委托的乐谱指纹（有传 abc 时在场，
        // 长乐谱不重复回传，agent 比对指纹即知编辑版是否被采用）。
        ...(activeChannel === "yue2" ? { cot_mode: cotMode } : {}),
        ...(abcSha256 !== null ? { abc_sha256: abcSha256 } : {}),
        // 翻唱回执（片 O additive）：扒谱产物的乐谱指纹（＝本次送入生成的旋律骨干）＋
        // 扒谱警告如实透传（空数组＝无警告）。仅带 source_audio 的委托在场——
        // 与 abc_sha256 独立：abc_sha256 指委托自备谱、transcribed_abc_sha256 指扒谱产物，
        // 互斥规则保证两者不同时在场。
        ...(transcribedAbcSha256 !== null ? { transcribed_abc_sha256: transcribedAbcSha256 } : {}),
        ...(transcribeWarnings !== null ? { transcribe_warnings: transcribeWarnings } : {}),
        // 上游如实回报的截断资讯（冻结合约 truncated）：只有 YuE2 会有，不静默吞掉。
        ...(yue2Track?.truncated ? { yue2_truncated: yue2Track.truncated } : {}),
        lyrics_echo: (generated as { lyricsEcho?: string }).lyricsEcho ?? null,
        prompt_used: finalPrompt,
        // 规则层如实回报：改了什么/发现什么/丢了什么层，不粉饰（prompt_used 才是实送上游文本）。
        // 回落时 director 以 flowmusic 通道重跑，channel 如实回报实际版面。
        prompt_director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
          // 压缩事实一并透传（2026-10-04 F2）：agent 才判得出是「整句丢子句」还是「被迫硬截」，
          // 不再只能从 truncated 猜。缺省＝null/false（未压缩）。
          compressedClauses: directed.compressedClauses ?? null,
          compressedLayers: directed.compressedLayers ?? null,
          hardTruncated: directed.hardTruncated ?? false,
          // P0-11 结构化校验账一并透传（2026-10-06）：agent/使用者才看得到「BPM 与段落秒数是否
          // 落在小节线上」「声明的段数与给出的个数是否一致」这类可判定结论，而非只有人话 warnings。
          // 输入不足的判据 ok:true 且 detail 写明跳过，不虚报。
          checks: directed.checks,
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

/** 情绪契约组装导出（Expert spec 模板用：orchestrator 心意 → 契约 → prompt）。 */
export type { LyriaMusicContract }
export { buildLyriaStylePrompt }

/** harness-tool-registry.ts 登记用 id 元组（同 BLENDER_HARNESS_TOOL_IDS 范式）。 */
export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"] as const
