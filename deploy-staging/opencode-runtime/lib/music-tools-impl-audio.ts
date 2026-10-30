import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"
import type { Yue2CotMode } from "./music_yue2"
import { GATEWAY, MusicToolError, type MusicToolContext } from "./music-tools-impl-core"

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
