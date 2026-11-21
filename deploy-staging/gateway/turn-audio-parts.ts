// turn-audio-parts.ts — 把本轮用户讯息尾端 [ATTACHMENTS_BLOCK] 里的音频列转成 opencode
// prompt 的 content block（part type="file"，audio/*），让「原生能听音频」的模型直接听，
// 而不是被提示词牵去调 bash / video_transcribe（2026-11-22 暴君：按模型能力灵活切换，
// 原生音频读入时代的模型不该被旧提示词按在工具上）。
//
// 与 turn-image-parts.ts 同构（同一套安全闸：路径必须落在本会话上传目录、realpath 比对、
// 大小上限），但独立成档：音频的格式/上限/能力旗标都不同，且 gateway release 只打包本目录。
// 纯资料进出，不碰 network / session state，方便单测。
//
// 能力来源：registry（agent-models.json）models[modelID].audio === true，见 model-registry.ts
// isAudioModel；不在名单＝不读档、不产 parts，只把音频列以 reason=model_no_audio 回报，
// 由接线端注入「走 video_transcribe」的诚实提示。
import { readFileSync, realpathSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { UPLOADS_DIR } from "./constants-gateway.ts"

/** 单轮最多附几段音频（超出即 skip，不抛错）。 */
export const MAX_TURN_AUDIOS = 2
/** 单段原档大小上限（bytes）。内联 base64 会膨胀 1/3，15MB 原档 ≈ 20MB 请求体。 */
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024
/** 单轮音频合计上限（bytes）。 */
export const MAX_AUDIO_TOTAL_BYTES = 20 * 1024 * 1024

export type TurnAudioPart = { type: "file"; mime: string; filename: string; url: string }
export type SkippedAudio = { path: string; reason: string }
export type TurnAudioPartsResult = { parts: TurnAudioPart[]; skipped: SkippedAudio[] }

const EMPTY: TurnAudioPartsResult = { parts: [], skipped: [] }

/** 从档案 bytes 嗅探音频 mime；认不得回 null（呼叫方以清单 mime 后备）。 */
export function sniffAudioMime(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE") return "audio/wav"
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg"
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg"
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg"
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "fLaC") return "audio/flac"
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") return "audio/mp4"
  return null
}


// opencode 的 AI SDK（openai-compatible）只认 wav / mp3 两种音频，其余（m4a=audio/mp4、ogg、flac、aac…）
// 会抛 `'audio media type audio/mp4' functionality not supported`，故障转移链再一路掉到听不了音频的
// 回退模型（2026-11-22 真会话：用户传 m4a 音乐，agent 回「不支持原生听音频」）。
// 所以不在白名单内的格式一律先在网关用 ffmpeg 转成 mp3（立体声 44.1k 128k，听音乐够用）。
const NATIVE_AUDIO_MIMES = new Set(["audio/wav", "audio/mpeg"])
const TRANSCODE_TIMEOUT_MS = 90_000

function transcodeToMp3(inputPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-y", "-i", inputPath, "-vn", "-map_metadata", "-1", "-ac", "2", "-ar", "44100", "-b:a", "128k", "-f", "mp3", "pipe:1"],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    const finish = (b: Buffer | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(b)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null)
    }, TRANSCODE_TIMEOUT_MS)
    child.stdout.on("data", (c: Buffer) => {
      total += c.length
      if (total > MAX_AUDIO_BYTES) {
        child.kill("SIGKILL")
        finish(null)
        return
      }
      chunks.push(c)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code === 0 && total > 0 ? Buffer.concat(chunks) : null))
  })
}


/**
 * 读一个已通过路径/大小闸的本地音频档 → 模型可吃的 file part（非 wav/mp3 先转 mp3）。
 * 用户上传（buildTurnAudioParts）与 critic 评审（critic-audio-parts）共用，转码/上限只有一份。
 */
export async function encodeAudioFile(
  real: string,
  totalBytesSoFar: number,
): Promise<{ part: TurnAudioPart; bytes: number; sha256: string } | { reason: string }> {
  let bytes: Buffer
  try {
    bytes = readFileSync(real)
  } catch {
    return { reason: "file_not_found" }
  }
  let mime = sniffAudioMime(bytes) ?? "" // 认不出容器＝不是确认的 wav/mp3，一律转码（ffmpeg 认得就能转）
  if (!NATIVE_AUDIO_MIMES.has(mime)) {
    const mp3 = await transcodeToMp3(real)
    if (!mp3) return { reason: "audio_transcode_failed" }
    bytes = mp3
    mime = "audio/mpeg"
  }
  if (totalBytesSoFar + bytes.length > MAX_AUDIO_TOTAL_BYTES) return { reason: "total_too_large" }
  return {
    part: {
      type: "file",
      mime,
      filename: mime === "audio/mpeg" ? path.basename(real).replace(/\.[^.]+$/, "") + ".mp3" : path.basename(real),
      url: `data:${mime};base64,${bytes.toString("base64")}`,
    },
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

type AudioRow = { path: string; mime: string }

/** 解析 [ATTACHMENTS_BLOCK] 的音频列；认不出回 []（绝不抛错）。 */
export function parseAudioRows(content: string): AudioRow[] {
  if (typeof content !== "string" || content.length === 0) return []
  const block = /\[ATTACHMENTS_BLOCK\]([\s\S]*?)\[\/ATTACHMENTS_BLOCK\]/.exec(content)
  if (!block) return []
  const rows: AudioRow[] = []
  for (const rawLine of block[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = /^(?:\d+[.)]\s*)?(.*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*$/.exec(line)
    if (!m) continue
    const p = m[1].trim()
    const mime = m[2].trim().toLowerCase()
    if (!p || !mime.startsWith("audio/")) continue
    rows.push({ path: p, mime })
  }
  return rows
}

/**
 * 建本轮的音频 parts。
 *
 * @param opts.audio       该轮模型是否原生支援音频输入；false 时不读档，只回报 model_no_audio
 * @param opts.uploadsRoot 上传根目录；预设 UPLOADS_DIR（仅单测注入 tmp 目录时覆写）
 */
export async function buildTurnAudioParts(opts: {
  sessionId: string
  content: string
  audio: boolean
  uploadsRoot?: string
}): Promise<TurnAudioPartsResult> {
  const rows = parseAudioRows(opts.content)
  if (rows.length === 0) return EMPTY
  if (!opts.audio) return { parts: [], skipped: rows.map((r) => ({ path: r.path, reason: "model_no_audio" })) }

  const uploadsRoot = path.resolve(opts.uploadsRoot ?? UPLOADS_DIR)
  let sessionRoot: string
  try {
    sessionRoot = realpathSync(path.join(uploadsRoot, opts.sessionId))
  } catch {
    sessionRoot = path.resolve(path.join(uploadsRoot, opts.sessionId))
  }

  const parts: TurnAudioPart[] = []
  const skipped: SkippedAudio[] = []
  let totalBytes = 0
  for (const row of rows) {
    if (parts.length >= MAX_TURN_AUDIOS) {
      skipped.push({ path: row.path, reason: "over_audio_limit" })
      continue
    }
    const rel = row.path.replace(/^\.?[\\/]+/, "").replace(/^uploads[\\/]/, "")
    const candidate = path.resolve(uploadsRoot, rel)
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      skipped.push({ path: row.path, reason: "file_not_found" })
      continue
    }
    if (real !== sessionRoot && !real.startsWith(sessionRoot + path.sep)) {
      skipped.push({ path: row.path, reason: "outside_session_uploads" })
      continue
    }
    let size: number
    try {
      size = statSync(real).size
    } catch {
      skipped.push({ path: row.path, reason: "file_not_found" })
      continue
    }
    if (size === 0) {
      skipped.push({ path: row.path, reason: "empty_file" })
      continue
    }
    if (size > MAX_AUDIO_BYTES) {
      skipped.push({ path: row.path, reason: "audio_too_large" })
      continue
    }
    if (totalBytes + size > MAX_AUDIO_TOTAL_BYTES) {
      skipped.push({ path: row.path, reason: "total_too_large" })
      continue
    }
    const enc = await encodeAudioFile(real, totalBytes)
    if ("reason" in enc) {
      skipped.push({ path: row.path, reason: enc.reason })
      continue
    }
    totalBytes += enc.bytes
    parts.push(enc.part)
  }
  return { parts, skipped }
}
