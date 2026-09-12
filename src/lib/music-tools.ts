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
import {
  LYRIA_MODELS,
  buildLyriaStylePrompt,
  generateLyriaTrack,
  type LyriaMusicContract,
} from "./music-lyria"
import {
  FLOWMUSIC_MODELS,
  generateFlowMusicTrack,
  isFlowMusic2ApiEnabled,
} from "./music-flowmusic"
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
}

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
    "调用 Lyria 生成音乐（主题曲/插曲/配乐）。整歌约 2.5 分钟或快速生成，返回音频 URL、时长与歌词回显。无歌词时按纯器乐处理；需要人声必须提供歌词。",
  args: {
    prompt: {
      type: "string",
      required: true,
      description:
        "风格+情绪描述：genre/BPM/调性/编制/氛围。可写结构标签（[Verse]/[Chorus]）或时间戳结构（[0:00 - 0:10] Intro:）。例：cinematic orchestral, 90 BPM, key of D minor, mood: heroic and sweeping",
    },
    lyrics: {
      type: "string",
      required: false,
      description:
        "自定义歌词（可选）。支持 [Verse]/[Chorus]/[Bridge] 段落标签或 [0:00 - 0:10] 时间戳结构；歌词语言跟随 prompt 语言。缺省=纯器乐（Instrumental only, no vocals）。",
    },
    duration_hint: {
      type: "string",
      required: false,
      enum: ["full", "clip30"],
      description: "full=整歌（约 2.5 分钟），clip30=快速生成（上游无 30 秒片段模式，实际为快速整歌）。默认 full。",
    },
    reference_images: {
      type: "string",
      required: false,
      description:
        "MV 分镜/参考图（可选，图生乐）：base64（允许 data: 前缀），多张用英文逗号分隔，最多 10 张。注意：仅 Gemini 直连通路支持，主通路（FlowMusic2API）会忽略并如实标注。",
    },
  },
  async execute(rawArgs, context) {
    try {
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

      // 通路選擇（2026-09-09 換血）：env FLOWMUSIC2API_URL 配置即走 FlowMusic2API
      // （lyria 整歌 / lyria-fast 快速；上游無 30s 片段模式，clip30 映射快速別名）；
      // 未配置回落 Gemini Lyria interactions 直連。兩路返回形狀同構
      // （audioBase64/mimeType），下游上傳/ffprobe 實測/交付形狀完全不變。
      const flowMusicEnabled = isFlowMusic2ApiEnabled()
      const flowMusicModel = FLOWMUSIC_MODELS[durationHintRaw === "clip30" ? "clip30" : "full"]
      const lyriaModel = durationHintRaw === "clip30" ? LYRIA_MODELS.clip30 : LYRIA_MODELS.full
      const model: string = flowMusicEnabled ? flowMusicModel : lyriaModel

      // 確定性規則層（Music Prompt Director）必須是送上游前的最後一關：
      // 先讓 buildToolPrompt 組出含器樂聲明的完整文本，再過 director 做偽標籤/時間戳
      // 剝除、六層補齊與長度上限——220 runes 上限必須把器樂聲明等所有字元算進去，
      // 提前過 director 會讓後加的聲明把長度頂爆（且 strip-timestamps 只認 flowmusic）。
      const directorChannel = flowMusicEnabled ? "flowmusic" : "lyria"
      const directed = directMusicPrompt(toolPrompt, {
        channel: directorChannel,
        hasLyrics: Boolean(lyrics),
        durationSeconds: durationHintRaw === "clip30" ? 30 : undefined,
      })
      const finalPrompt = directed.prompt

      const imagesBase64 = (asString(rawArgs.reference_images) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")

      const generated = flowMusicEnabled
        ? await generateFlowMusicTrack({ prompt: finalPrompt, lyrics, model: flowMusicModel })
        : await generateLyriaTrack({ prompt: finalPrompt, lyrics, model: lyriaModel, imagesBase64 })
      const upstreamUrl = flowMusicEnabled ? (generated as unknown as { upstreamUrl: string }).upstreamUrl : null

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
      // （FlowMusic2API 帶上游 Duration 提示，Gemini 通路按 model_hint）。
      // 170 = 整歌實測區間 162–182s 的中位，僅為模型提示值非實測
      // （duration_source=model_hint 如實標注，不冒充 ffprobe）。
      const measured = await measureAudioDuration(generated.audioBase64)
      const hintSeconds = flowMusicEnabled
        ? ((generated as { upstreamDurationHint?: number }).upstreamDurationHint ?? 170)
        : durationHintRaw === "clip30"
          ? 30
          : 180
      const durationSeconds = measured ?? hintSeconds
      const durationSource = measured !== null ? "ffprobe" : "model_hint"

      return ok({
        title: "音乐生成完成",
        ...(url ? { url, path_source: "gateway_uploads" } : { audio_base64: generated.audioBase64, upload: uploadCode }),
        ...(upstreamUrl ? { upstream_url: upstreamUrl } : {}),
        channel: flowMusicEnabled ? "flowmusic2api" : "lyria_gemini",
        duration_seconds: Math.round(durationSeconds * 100) / 100,
        duration_source: durationSource,
        duration_hint: durationHintRaw,
        model,
        mime_type: generated.mimeType,
        audio_bytes: bytes.length,
        lyrics_echo: generated.lyricsEcho ?? null,
        prompt_used: finalPrompt,
        // 規則層如實回報：改了什麼/發現什麼/丟了什麼層，不粉飾（prompt_used 才是實送上游文本）。
        prompt_director: {
          channel: directorChannel,
          applied: directed.applied,
          warnings: directed.warnings,
          truncated: directed.truncated,
          layers: directed.layers,
        },
        reference_image_count: flowMusicEnabled ? 0 : imagesBase64.filter((i) => i !== "").length,
        ...(flowMusicEnabled && imagesBase64.some((i) => i !== "")
          ? { reference_images_note: "FlowMusic2API 通路暂不支持参考图（图生乐），本次已忽略" }
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
