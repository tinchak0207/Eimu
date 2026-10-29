// 首句硬约束。短语与时长正则按导出任务写死；镜头固定的阈值由静止帧 / 红蓝切换标定（见同名测试）。
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export interface SentenceConstraints {
  noSubtitles: boolean
  fixedCamera: boolean
  durationSec: number | null
  mute: boolean
}

/** 静止色块均值差为 0，红切蓝约 168。8 落在两者之间，压过编码噪声，挡不住换色。 */
export const FIXED_CAMERA_MAX_MEAN_DELTA = 8

const NO_SUBTITLES = ["没有字幕", "无字幕", "不要字幕", "不加字幕", "无需字幕"]
const FIXED_CAMERA = ["镜头固定", "固定镜头", "机位固定", "镜头不动", "静止镜头"]
const MUTE = ["静音", "无声", "不要声音", "没有声音"]

export function parseSentenceConstraints(text: string): SentenceConstraints {
  const matched = text.match(/(\d+(?:\.\d+)?)\s*秒/)
  const durationSec = matched ? Number(matched[1]) : null
  return {
    noSubtitles: NO_SUBTITLES.some((p) => text.includes(p)),
    fixedCamera: FIXED_CAMERA.some((p) => text.includes(p)),
    durationSec: durationSec !== null && Number.isFinite(durationSec) ? durationSec : null,
    mute: MUTE.some((p) => text.includes(p)),
  }
}

function shq(v: string): string {
  return `'${String(v).replace(/'/g, "'\\''")}'`
}

function meanAbs(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i])
  return sum / n
}

export async function measureFixedCameraDelta(file: string, durationSec: number): Promise<{ ok: true; maxMeanDelta: number } | { ok: false; message: string }> {
  const { invoke } = await import("../../editor/adapter/tauri-adapter")
  const { detectFfmpeg } = await import("../../editor/canvas/videoCompose")
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { ok: false, message: "ffmpeg 不可用" }
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return { ok: false, message: "成片时长无效，无法抽首中尾帧" }
  const times = [0, durationSec / 2, Math.max(0, durationSec - 0.04)]
  const dir = await mkdtemp(path.join(tmpdir(), "fixed-cam-"))
  const frames: Buffer[] = []
  try {
    for (let i = 0; i < times.length; i++) {
      const out = path.join(dir, `f${i}.rgb`)
      const command = `${ffmpeg} -y -ss ${times[i].toFixed(3)} -i ${shq(file)} -frames:v 1 -vf scale=32:32 -f rawvideo -pix_fmt rgb24 ${shq(out)}`
      const ran = await invoke<{ stdout: string; stderr: string; exit_code: number }>("execute_command", { command, timeoutMs: 20000 }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }))
      if (ran.exit_code !== 0) return { ok: false, message: `抽帧失败：${(ran.stderr || ran.stdout || "").slice(-160)}` }
      const buf = await readFile(out)
      if (buf.length < 32 * 32 * 3) return { ok: false, message: "抽帧不完整" }
      frames.push(buf.subarray(0, 32 * 32 * 3))
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  const deltas = [meanAbs(frames[0], frames[1]), meanAbs(frames[1], frames[2]), meanAbs(frames[0], frames[2])]
  return { ok: true, maxMeanDelta: Math.max(...deltas) }
}

function zipEntry(buf: Buffer, name: string): Buffer | null {
  let o = 0
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const comp = buf.readUInt32LE(o + 18)
    const nameLen = buf.readUInt16LE(o + 26)
    const extra = buf.readUInt16LE(o + 28)
    const found = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8")
    const data = buf.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + comp)
    if (found === name) return Buffer.from(data)
    o += 30 + nameLen + extra + comp
  }
  return null
}

function timelineHasWords(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((item) => {
    if (!item || typeof item !== "object") return false
    const text = (item as { text?: unknown }).text
    return typeof text === "string" && text.trim().length > 0
  })
}

async function subtitleFilesHaveWords(files: { path: string; port: string }[]): Promise<boolean> {
  for (const file of files) {
    let text = ""
    try { text = await readFile(file.path, "utf8") } catch { continue }
    if (file.port === "ass") {
      for (const line of text.split(/\n/)) {
        if (!line.startsWith("Dialogue:")) continue
        const body = line.split(",").slice(9).join(",").replace(/\\N/g, "").trim()
        if (body) return true
      }
      continue
    }
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean)
      const idx = lines.findIndex((l) => l.includes("-->"))
      if (idx >= 0 && lines.slice(idx + 1).join("").trim()) return true
    }
  }
  return false
}

function zipTextHasTitle(zipPath: string | undefined): boolean {
  if (!zipPath) return false
  try {
    const xml = zipEntry(readFileSync(zipPath), "export.fcpxml")
    return Boolean(xml && /<title\b/.test(xml.toString("utf8")))
  } catch {
    return false
  }
}

function zipDraftHasWords(zipPath: string | undefined): boolean {
  if (!zipPath) return false
  try {
    const raw = zipEntry(readFileSync(zipPath), "draft_content.json")
    if (!raw) return false
    const draft = JSON.parse(raw.toString("utf8")) as { materials?: { texts?: { content?: unknown }[] } }
    for (const item of draft.materials?.texts ?? []) {
      if (typeof item.content !== "string" || !item.content.trim()) continue
      try {
        const body = JSON.parse(item.content) as { text?: unknown }
        if (typeof body.text === "string" && body.text.trim()) return true
      } catch {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

export async function evaluateSentenceConstraints(args: {
  text: string
  videoPath: string
  durationSec: number
  subtitleBurnIn: boolean
  subtitleFiles: { path: string; port: string }[]
  timelineSubtitles: unknown
  fcpxmlZipPath?: string
  jianyingZipPath?: string
}): Promise<string | null> {
  const c = parseSentenceConstraints(args.text)
  if (c.noSubtitles) {
    const burned = args.subtitleBurnIn
    const inFile = await subtitleFilesHaveWords(args.subtitleFiles)
    const inTimeline = timelineHasWords(args.timelineSubtitles)
    const inXml = zipTextHasTitle(args.fcpxmlZipPath)
    const inDraft = zipDraftHasWords(args.jianyingZipPath)
    if (burned || inFile || inTimeline || inXml || inDraft) return "首句要求没有字幕，产物里仍有字幕"
  }
  if (c.durationSec !== null && c.durationSec > 0) {
    const measured = args.durationSec
    if (!(measured > 0) || Math.abs(measured - c.durationSec) / c.durationSec > 0.1) {
      return `首句要求 ${c.durationSec} 秒，成片 ${Number.isFinite(measured) ? measured.toFixed(3) : "未知"} 秒，偏离超过 10%`
    }
  }
  if (c.fixedCamera) {
    const measured = await measureFixedCameraDelta(args.videoPath, args.durationSec)
    if (!measured.ok) return `首句要求镜头固定，${measured.message}`
    if (measured.maxMeanDelta > FIXED_CAMERA_MAX_MEAN_DELTA) {
      return `首句要求镜头固定，首中尾帧像素差 ${measured.maxMeanDelta.toFixed(1)} 超过 ${FIXED_CAMERA_MAX_MEAN_DELTA}`
    }
  }
  return null
}
