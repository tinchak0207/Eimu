// L4 交换件。键来自上游，不搬 Python。
// 剪映 GuanYixuan/pyJianYingDraft（Apache-2.0）：script_file.py dumps() 在 DRAFT_CONTENT_TEMPLATE 上写
// fps/duration/config.maintrack_adsorb/canvas_config/materials/tracks；draft_folder.py 另拷 draft_meta_info.json。
// 模板原文在 ./jianying/。素材路径用包内相对路径，不用 abspath。
// FCPXML 1.10：交付物是 zip（export.fcpxml + media/<文件名>），src 相对，宽高与 hasAudio 只写调用方传入的值。
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ExecContext, Output } from "../types"

const SEC = 1_000_000
const hid = () => randomBytes(16).toString("hex")
const us = (sec: number) => Math.round(sec * SEC)

export interface InterchangeClip {
  id: string
  path: string
  durationSec?: number
  inSec?: number
  outSec?: number
  speed?: number
  width?: number
  height?: number
  hasAudio?: boolean
}
export interface InterchangeAudio { id: string; path: string; durationSec?: number }
export interface InterchangeCue { text: string; startSec?: number; endSec?: number }
export interface InterchangeInput { clips: InterchangeClip[]; audio?: InterchangeAudio[]; subtitles?: InterchangeCue[]; width?: number; height?: number; fps?: number }
export interface InterchangeBuild {
  draftJson: Record<string, unknown>
  draftMeta: Record<string, unknown>
  fcpxml: string
  zipBytes: Uint8Array
  fcpxmlZipBytes: Uint8Array
}
export interface AppendInterchangeSpec {
  clips: InterchangeClip[]
  audio: InterchangeAudio[]
  scratch: string
  width: number
  height: number
  fps?: number
  subtitleFiles?: { path: string; port: string }[]
  timelineSubtitles?: unknown
}

const CROP = { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 }
const VISUAL = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } }

function readTemplate(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./jianying/${name}`, import.meta.url), "utf8")) as Record<string, unknown>
}
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }
function xmlEsc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }
function fcpxTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s"
  const ms = Math.round(sec * 1000)
  if (ms % 1000 === 0) return `${ms / 1000}s`
  const g = gcd(ms, 1000)
  return `${ms / g}/${1000 / g}s`
}
function span(c: { durationSec?: number; inSec?: number; outSec?: number; speed?: number }) {
  const speed = c.speed && c.speed > 0 ? c.speed : 1
  const inSec = typeof c.inSec === "number" && c.inSec > 0 ? c.inSec : 0
  const sourceSec = typeof c.outSec === "number" ? Math.max(0, c.outSec - inSec) : (typeof c.durationSec === "number" && c.durationSec > 0 ? c.durationSec : 0)
  return { inSec, sourceSec, targetSec: sourceSec / speed, speed }
}
function safeBase(p: string): string {
  const base = path.basename(p).replace(/[^A-Za-z0-9._-]/g, "_")
  return base && base !== "." && base !== ".." ? base : "media.bin"
}
function mediaName(id: string, filePath: string, used: Set<string>): string {
  let name = safeBase(filePath)
  if (used.has(name)) name = `${safeBase(id)}__${name}`
  used.add(name)
  return name
}
function audioAttr(hasAudio: boolean | undefined): string {
  if (hasAudio === true) return ' hasAudio="1"'
  if (hasAudio === false) return ' hasAudio="0"'
  return ""
}
function knownSize(width?: number, height?: number): { width: number; height: number } | null {
  if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) return { width, height }
  return null
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return (c ^ 0xffffffff) >>> 0
}
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8")
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26)
    const chunk = Buffer.concat([local, name, f.data])
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(f.data.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42)
    locals.push(chunk); centrals.push(Buffer.concat([cen, name])); offset += chunk.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}
function speedOf(speed: number) { const id = hid(); return { id, json: { curve_speed: null, id, mode: 0, speed, type: "speed" } } }
function seg(id: string, materialId: string, startUs: number, durUs: number, source: { start: number; duration: number } | null, speed: number, speedId: string) {
  return {
    enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true, enable_color_match_adjust: false,
    enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false, last_nonzero_volume: 1, reverse: false,
    track_attribute: 0, track_render_index: 0, visible: true, id, material_id: materialId,
    target_timerange: { start: startUs, duration: durUs }, common_keyframes: [], keyframe_refs: [],
    source_timerange: source, speed, volume: 1, extra_material_refs: [speedId], is_tone_modify: false,
  }
}
function track(type: "video" | "audio" | "text", segments: Record<string, unknown>[]) {
  return { attribute: 0, flag: 0, id: hid(), is_default_name: false, name: type, segments, type }
}
function textMaterial(id: string, text: string) {
  const content = { styles: [{ fill: { alpha: 1, content: { render_type: "solid", solid: { alpha: 1, color: [1, 1, 1] } } }, range: [0, text.length], size: 8, bold: false, italic: false, underline: false, strokes: [] }], text }
  return { id, content: JSON.stringify(content), typesetting: 0, alignment: 0, letter_spacing: 0, line_spacing: 0.02, line_feed: 1, line_max_width: 0.82, force_apply_line_max_width: false, check_flag: 7, type: "text", global_alpha: 1 }
}
function readCopy(filePath: string, rel: string, zip: { name: string; data: Buffer }[]) {
  if (existsSync(filePath)) zip.push({ name: rel, data: readFileSync(filePath) })
}

interface PlacedClip { id: string; media: string; inSec: number; sourceSec: number; targetSec: number; startSec: number; width?: number; height?: number; hasAudio?: boolean }

export function buildInterchange(input: InterchangeInput): InterchangeBuild {
  const fps = input.fps && input.fps > 0 ? input.fps : 30
  const canvasW = input.width && input.width > 0 ? input.width : 0
  const canvasH = input.height && input.height > 0 ? input.height : 0
  const videos: Record<string, unknown>[] = []
  const audios: Record<string, unknown>[] = []
  const texts: Record<string, unknown>[] = []
  const speeds: Record<string, unknown>[] = []
  const jianyingFiles: { name: string; data: Buffer }[] = []
  const fcpxFiles: { name: string; data: Buffer }[] = []
  const used = new Set<string>()
  const cues = (input.subtitles ?? []).filter((c) => c.text.length > 0)
  const videoSegments: Record<string, unknown>[] = []
  const placed: PlacedClip[] = []
  let cursorUs = 0
  for (const clip of input.clips) {
    const t = span(clip)
    const name = mediaName(clip.id, clip.path, used)
    const mat = `materials/${name}`
    const media = `media/${name}`
    const sp = speedOf(t.speed)
    speeds.push(sp.json)
    const size = knownSize(clip.width, clip.height)
    const video: Record<string, unknown> = {
      audio_fade: null, category_id: "", category_name: "local", check_flag: 63487, crop: CROP, crop_ratio: "free", crop_scale: 1,
      duration: us(t.sourceSec), id: clip.id, local_material_id: clip.id, material_id: clip.id, material_name: clip.id,
      media_path: "", path: mat, type: "video",
    }
    if (size) { video.width = size.width; video.height = size.height }
    videos.push(video)
    videoSegments.push({ ...seg(clip.id, clip.id, cursorUs, us(t.targetSec), { start: us(t.inSec), duration: us(t.sourceSec) }, t.speed, sp.id), clip: VISUAL, uniform_scale: { on: true, value: 1 }, hdr_settings: { intensity: 1, mode: 1, nits: 1000 } })
    readCopy(clip.path, mat, jianyingFiles)
    readCopy(clip.path, media, fcpxFiles)
    placed.push({
      id: clip.id, media, inSec: t.inSec, sourceSec: t.sourceSec, targetSec: t.targetSec, startSec: cursorUs / SEC,
      ...(size ? { width: size.width, height: size.height } : {}),
      ...(typeof clip.hasAudio === "boolean" ? { hasAudio: clip.hasAudio } : {}),
    })
    cursorUs += us(t.targetSec)
  }
  const audioPlaced: { id: string; media: string; durationSec: number }[] = []
  const audioTracks = (input.audio ?? []).map((a) => {
    const durSec = typeof a.durationSec === "number" && a.durationSec > 0 ? a.durationSec : 0
    const name = mediaName(a.id, a.path, used)
    const mat = `materials/${name}`
    const media = `media/${name}`
    const sp = speedOf(1)
    speeds.push(sp.json)
    audios.push({
      app_id: 0, category_id: "", category_name: "local", check_flag: 3, copyright_limit_type: "none", duration: us(durSec),
      effect_id: "", formula_id: "", id: a.id, local_material_id: a.id, music_id: a.id, name: a.id, path: mat,
      source_platform: 0, type: "extract_music", wave_points: [],
    })
    readCopy(a.path, mat, jianyingFiles)
    readCopy(a.path, media, fcpxFiles)
    audioPlaced.push({ id: a.id, media, durationSec: durSec })
    return track("audio", [{ ...seg(a.id, a.id, 0, us(durSec), { start: 0, duration: us(durSec) }, 1, sp.id), clip: null, hdr_settings: null }])
  })
  const totalSec = cursorUs / SEC
  const textSegments = cues.map((cue, i) => {
    const startSec = typeof cue.startSec === "number" ? cue.startSec : 0
    const endSec = typeof cue.endSec === "number" && cue.endSec > startSec ? cue.endSec : (totalSec > startSec ? totalSec : startSec)
    const id = `cue_${i}`
    const sp = speedOf(1)
    speeds.push(sp.json)
    texts.push(textMaterial(id, cue.text))
    return { ...seg(id, id, us(startSec), us(endSec - startSec), null, 1, sp.id), clip: VISUAL, uniform_scale: { on: true, value: 1 } }
  })
  const audioEnd = audioTracks.flatMap((t) => t.segments.map((s) => (s.target_timerange as { start: number; duration: number }).start + (s.target_timerange as { duration: number }).duration))
  const duration = Math.max(cursorUs, ...audioEnd, 0)
  const content = readTemplate("draft_content_template.json")
  content.fps = fps
  content.duration = duration
  const config = content.config
  if (config && typeof config === "object" && !Array.isArray(config)) (config as Record<string, unknown>).maintrack_adsorb = true
  if (canvasW > 0 && canvasH > 0) content.canvas_config = { width: canvasW, height: canvasH, ratio: "original" }
  const materials = content.materials
  if (!materials || typeof materials !== "object" || Array.isArray(materials)) throw new Error("剪映模板 materials 不是对象")
  const bag = materials as Record<string, unknown>
  bag.videos = videos
  bag.audios = audios
  bag.texts = texts
  bag.speeds = speeds
  content.tracks = [track("video", videoSegments), ...audioTracks, track("text", textSegments)]
  const meta = readTemplate("draft_meta_info.json")
  meta.draft_id = randomUUID()
  meta.draft_name = "export"
  meta.tm_duration = duration
  const fcpxml = renderFcpxml(placed, audioPlaced, cues, canvasW, canvasH, fps)
  const zipBytes = zipStore([
    { name: "draft_content.json", data: Buffer.from(JSON.stringify(content), "utf8") },
    { name: "draft_meta_info.json", data: Buffer.from(JSON.stringify(meta), "utf8") },
    ...jianyingFiles,
  ])
  const fcpxmlZipBytes = zipStore([{ name: "export.fcpxml", data: Buffer.from(fcpxml, "utf8") }, ...fcpxFiles])
  return { draftJson: content, draftMeta: meta, fcpxml, zipBytes, fcpxmlZipBytes }
}

function renderFcpxml(placed: PlacedClip[], audioPlaced: { id: string; media: string; durationSec: number }[], cues: InterchangeCue[], canvasW: number, canvasH: number, fps: number): string {
  const frame = fps === 30 ? "100/3000s" : `1/${fps}s`
  const formatName = (h: number) => h === 1080 ? `FFVideoFormat1080p${fps}` : h === 720 ? `FFVideoFormat720p${fps}` : h > 0 ? `FFVideoFormat${h}p${fps}` : `FFVideoFormat${fps}`
  let n = 1
  const formats: string[] = []
  const seqId = `r${n++}`
  const seqDims = canvasW > 0 && canvasH > 0 ? ` width="${canvasW}" height="${canvasH}"` : ""
  formats.push(`<format id="${seqId}" frameDuration="${frame}"${seqDims} name="${formatName(canvasH)}"/>`)
  const nativeFormat = (w?: number, h?: number): string => {
    if (!(w && w > 0 && h && h > 0)) return ""
    if (w === canvasW && h === canvasH) return seqId
    const id = `r${n++}`
    formats.push(`<format id="${id}" frameDuration="${frame}" width="${w}" height="${h}" name="${formatName(h)}"/>`)
    return id
  }
  const resources: string[] = []
  const audioRefs = audioPlaced.map((a) => {
    const id = `r${n++}`
    resources.push(`<asset name="${xmlEsc(a.id)}" src="${xmlEsc(a.media)}" id="${id}" duration="${fcpxTime(a.durationSec)}" start="0s" hasAudio="1" hasVideo="0"/>`)
    return { id, durationSec: a.durationSec }
  })
  const spine: string[] = []
  placed.forEach((clip, i) => {
    const id = `r${n++}`
    const fid = nativeFormat(clip.width, clip.height)
    const formatAttr = fid ? ` format="${fid}"` : ""
    resources.push(`<asset name="${xmlEsc(clip.id)}" src="${xmlEsc(clip.media)}"${formatAttr} id="${id}" duration="${fcpxTime(clip.sourceSec)}" start="${fcpxTime(clip.inSec)}"${audioAttr(clip.hasAudio)} hasVideo="1"/>`)
    const kids: string[] = []
    if (i === 0) for (const a of audioRefs) kids.push(`<audio offset="0s" ref="${a.id}" duration="${fcpxTime(a.durationSec)}" lane="-1"/>`)
    for (const cue of cues) {
      const timed = typeof cue.startSec === "number"
      if (!timed && i !== 0) continue
      const start = timed ? cue.startSec ?? 0 : clip.startSec
      const end = typeof cue.endSec === "number" && cue.endSec > start ? cue.endSec : clip.startSec + clip.targetSec
      const slotEnd = clip.startSec + clip.targetSec
      if (!(start < slotEnd && end > clip.startSec)) continue
      const off = Math.max(0, start - clip.startSec)
      const dur = Math.max(0, Math.min(end, slotEnd) - Math.max(start, clip.startSec))
      const eid = `r${n++}`
      const ts = `ts${n}`
      resources.push(`<effect id="${eid}" name="Basic Title" uid="/Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`)
      kids.push(`<title ref="${eid}" name="${xmlEsc(clip.id)}" lane="1" offset="${fcpxTime(off)}" duration="${fcpxTime(dur)}"><text><text-style ref="${ts}">${xmlEsc(cue.text)}</text-style></text><text-style-def id="${ts}"><text-style font="Helvetica" fontSize="52" fontColor="1 1 1 1"/></text-style-def></title>`)
    }
    const tail = kids.length ? `>${kids.join("")}</asset-clip>` : "/>"
    spine.push(`<asset-clip name="${xmlEsc(clip.id)}" format="${seqId}" ref="${id}" offset="${fcpxTime(clip.startSec)}" duration="${fcpxTime(clip.targetSec)}" start="${fcpxTime(clip.inSec)}"${tail}`)
  })
  const seqDur = fcpxTime(placed.reduce((s, c) => s + c.targetSec, 0))
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">\n<resources>\n${[...formats, ...resources].join("\n")}\n</resources>\n<project name="export">\n<sequence duration="${seqDur}" format="${seqId}">\n<spine>\n${spine.join("\n")}\n</spine>\n</sequence>\n</project>\n</fcpxml>\n`
}

function parseStamp(raw: string): number {
  const m = raw.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4].length === 3 ? Number(m[4]) / 1000 : Number(m[4]) / 100)
}
function parseSrt(text: string): InterchangeCue[] {
  const cues: InterchangeCue[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean)
    const idx = lines.findIndex((l) => l.includes("-->"))
    if (idx < 0) continue
    const [a, b] = lines[idx].split("-->")
    const body = lines.slice(idx + 1).join("\n").trim()
    if (body) cues.push({ text: body, startSec: parseStamp(a ?? ""), endSec: parseStamp(b ?? "") })
  }
  return cues
}
function parseAss(text: string): InterchangeCue[] {
  const cues: InterchangeCue[] = []
  for (const line of text.split(/\n/)) {
    if (!line.startsWith("Dialogue:")) continue
    const parts = line.split(",")
    if (parts.length < 10) continue
    const body = parts.slice(9).join(",").replace(/\\N/g, "\n").trim()
    if (body) cues.push({ text: body, startSec: parseStamp(parts[1] ?? ""), endSec: parseStamp(parts[2] ?? "") })
  }
  return cues
}
function cuesFromTimeline(value: unknown): InterchangeCue[] {
  if (!Array.isArray(value)) return []
  const cues: InterchangeCue[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.text !== "string" || !o.text.trim()) continue
    cues.push({ text: o.text, ...(typeof o.startSec === "number" ? { startSec: o.startSec } : {}), ...(typeof o.endSec === "number" ? { endSec: o.endSec } : {}) })
  }
  return cues
}
async function loadCues(files: { path: string; port: string }[] | undefined, timelineSubtitles: unknown): Promise<InterchangeCue[]> {
  const file = files?.find((f) => f.port === "srt") ?? files?.find((f) => f.port === "ass")
  if (file) {
    try {
      const text = await readFile(file.path, "utf8")
      const cues = file.port === "ass" ? parseAss(text) : parseSrt(text)
      if (cues.length) return cues
    } catch { /* 读不到就退回时间线字幕，再没有就空轨 */ }
  }
  return cuesFromTimeline(timelineSubtitles)
}

/** mp4 门已过后调用。两件都入库才返回；任一失败只写 meta.interchangeError。 */
export async function appendInterchangeOutputs(ctx: Pick<ExecContext, "ingest">, mp4: Output, spec: AppendInterchangeSpec): Promise<Output[]> {
  try {
    const built = buildInterchange({
      clips: spec.clips, audio: spec.audio, subtitles: await loadCues(spec.subtitleFiles, spec.timelineSubtitles),
      width: spec.width, height: spec.height, fps: spec.fps ?? 30,
    })
    await mkdir(spec.scratch, { recursive: true })
    const zipPath = path.join(spec.scratch, "jianying_draft.zip")
    const xmlZipPath = path.join(spec.scratch, "export.fcpxml.zip")
    await writeFile(zipPath, built.zipBytes)
    await writeFile(xmlZipPath, built.fcpxmlZipBytes)
    const zipIn = await ctx.ingest({ path: zipPath }, { port: "jianying", mime: "application/zip", origin: "derived" })
    const xmlIn = await ctx.ingest({ path: xmlZipPath }, { port: "fcpxml", mime: "application/zip", origin: "derived" })
    return [
      { ...zipIn, port: "jianying", meta: { kind: "jianying_draft" } },
      { ...xmlIn, port: "fcpxml", meta: { kind: "fcpxml" } },
    ]
  } catch (err) {
    mp4.meta = { ...(mp4.meta ?? {}), interchangeError: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
    return []
  }
}
