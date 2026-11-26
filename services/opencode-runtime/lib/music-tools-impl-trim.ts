// <harness-only>
/**
 * music_gen 用户指定时长后处理（2026-11-04）。
 *
 * 背景：三条音乐通路（YuE2／FlowMusic2API／Lyria）都没有「秒数」入参，成品固定 160-180 秒整歌。
 * 用户说「10 秒轻音乐」时，唯一能兑现的办法是工具层后剪：ffmpeg 从 0:00 截到目标秒数 + 末尾淡出，
 * 再用 ffprobe 实测，交付与要求一致（±0.5 s）的文件。
 *
 * 全程只在工具自己的临时目录（os.tmpdir()，与 measureAudioDuration 同域）读写，
 * 不碰工作区，模型无需、也不应 glob／读外部文件。
 * 失败一律返回结构化结果，由调用方决定 fail（绝不冒充已裁好）。
 */
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawn } from "node:child_process"

/** 用户可指定的时长范围（秒）。下限太短没有音乐意义，上限防 ffmpeg 被滥用。 */
export const MIN_TARGET_SECONDS = 2
export const MAX_TARGET_SECONDS = 600
/** 交付时长与要求的允许偏差（秒）。 */
export const DURATION_TOLERANCE_SECONDS = 0.5
/** 淡出时长（秒）：0.4 在 0.3~0.5 区间内。 */
export const FADE_OUT_SECONDS = 0.4

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
}

const EXT_CODEC_ARGS: Readonly<Record<string, string[]>> = {
  m4a: ["-c:a", "aac", "-b:a", "192k"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "192k"],
  wav: ["-c:a", "pcm_s16le"],
  flac: ["-c:a", "flac"],
}

export type TrimStatus =
  | "trimmed" // 已裁到目标秒数（含淡出）
  | "within_tolerance" // 源时长本就在目标 ±0.5 s 内，原样交付
  | "requested_exceeds_source" // 要求比模型成品还长：不补静音、不循环，交付原长并如实标注

export interface TrimResult {
  ok: true
  status: TrimStatus
  /** 交付音频（base64，纯编码无 data: 前缀）。 */
  audioBase64: string
  mimeType: string
  /** 交付文件的 ffprobe 实测秒数。 */
  deliveredSeconds: number
  /** 裁剪前的 ffprobe 实测秒数。 */
  sourceSeconds: number
  fadeOutSeconds: number
}
export interface TrimFailure {
  ok: false
  code: string
  message: string
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-600)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, error: `${cmd} 超时（${timeoutMs} ms）` })
    }, timeoutMs)
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.code === "ENOENT" ? `${cmd} 不存在（系统未安装）` : e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, stdout })
      else resolve({ ok: false, error: `${cmd} 退出码 ${code ?? "null"}：${stderr.trim().slice(-300)}` })
    })
  })
}

async function probeSeconds(filePath: string): Promise<number | null> {
  const r = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    15_000,
  )
  if (!r.ok) return null
  const s = Number(r.stdout.trim())
  return Number.isFinite(s) && s > 0 ? s : null
}

/**
 * 把音频裁到 targetSeconds（带淡出）。源已在目标 ±0.5 s 内则原样返回；源比目标短则不动并标注。
 * 输入输出同一容器格式（m4a→m4a），URL 副档名与 mime 保持一致，不说谎。
 */
export async function trimAudioToDuration(
  audioBase64: string,
  mimeType: string,
  targetSeconds: number,
): Promise<TrimResult | TrimFailure> {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()]
  if (!ext) {
    return { ok: false, code: "trim_unsupported_mime", message: `不支持裁剪的音频格式 ${mimeType}（仅 mp3/m4a/wav/flac）。` }
  }
  const base = nodePath.join(os.tmpdir(), `music-trim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const inPath = `${base}-in.${ext}`
  const outPath = `${base}-out.${ext}`
  try {
    await fsp.writeFile(inPath, Buffer.from(audioBase64, "base64"))
    const sourceSeconds = await probeSeconds(inPath)
    if (sourceSeconds === null) {
      return { ok: false, code: "trim_probe_failed", message: "无法用 ffprobe 读取生成音频的时长，不能确认裁剪结果。" }
    }
    if (Math.abs(sourceSeconds - targetSeconds) <= DURATION_TOLERANCE_SECONDS) {
      return { ok: true, status: "within_tolerance", audioBase64, mimeType, deliveredSeconds: sourceSeconds, sourceSeconds, fadeOutSeconds: 0 }
    }
    if (sourceSeconds < targetSeconds) {
      return { ok: true, status: "requested_exceeds_source", audioBase64, mimeType, deliveredSeconds: sourceSeconds, sourceSeconds, fadeOutSeconds: 0 }
    }
    const fade = Math.min(FADE_OUT_SECONDS, targetSeconds / 2)
    const fadeStart = Math.max(0, targetSeconds - fade)
    const ff = await run(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inPath,
        "-vn", "-map_metadata", "-1",
        "-t", targetSeconds.toFixed(3),
        "-af", `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}`,
        ...(EXT_CODEC_ARGS[ext] ?? []),
        outPath,
      ],
      60_000,
    )
    if (!ff.ok) return { ok: false, code: "trim_ffmpeg_failed", message: `ffmpeg 裁剪失败：${ff.error}` }
    const deliveredSeconds = await probeSeconds(outPath)
    if (deliveredSeconds === null) {
      return { ok: false, code: "trim_probe_failed", message: "裁剪后无法用 ffprobe 读取成品时长，不能确认结果。" }
    }
    if (Math.abs(deliveredSeconds - targetSeconds) > DURATION_TOLERANCE_SECONDS) {
      return {
        ok: false,
        code: "trim_duration_mismatch",
        message: `裁剪后实测 ${deliveredSeconds.toFixed(2)} 秒，与目标 ${targetSeconds} 秒偏差超过 ${DURATION_TOLERANCE_SECONDS} 秒。`,
      }
    }
    const out = await fsp.readFile(outPath)
    return { ok: true, status: "trimmed", audioBase64: out.toString("base64"), mimeType, deliveredSeconds, sourceSeconds, fadeOutSeconds: fade }
  } catch (e) {
    return { ok: false, code: "trim_error", message: `裁剪异常：${(e as Error)?.message ?? String(e)}` }
  } finally {
    await fsp.rm(inPath, { force: true }).catch(() => {})
    await fsp.rm(outPath, { force: true }).catch(() => {})
  }
}
// </harness-only>
