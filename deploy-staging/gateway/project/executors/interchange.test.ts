import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendInterchangeOutputs, buildInterchange } from "./interchange"
import type { Output } from "../types"

const contentTemplate = JSON.parse(readFileSync(new URL("./jianying/draft_content_template.json", import.meta.url), "utf8")) as {
  materials: Record<string, unknown>
  platform: { app_id: number; app_source: string; app_version: string }
}
const metaTemplate = JSON.parse(readFileSync(new URL("./jianying/draft_meta_info.json", import.meta.url), "utf8")) as Record<string, unknown>

function zipEntry(buf: Buffer, name: string): Buffer {
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
  throw new Error(`zip 里没有 ${name}`)
}

function attr(xml: string, tag: string, name: string, key: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\bname="${name}"[^>]*>`)
  const m = xml.match(re)
  if (!m) return null
  const a = m[0].match(new RegExp(`\\b${key}="([^"]*)"`))
  return a ? a[1] : null
}

function formatAttr(xml: string, id: string, key: string): string | null {
  const re = new RegExp(`<format\\b[^>]*\\bid="${id}"[^>]*>`)
  const m = xml.match(re)
  if (!m) return null
  const a = m[0].match(new RegExp(`\\b${key}="([^"]*)"`))
  return a ? a[1] : null
}

describe("buildInterchange", () => {
  test("两个镜头：草稿顶层键、轨道名、zip 副本、fcpxml 1.10 与字幕", () => {
    const dir = mkdtempSync(join(tmpdir(), "ix-"))
    const mp4a = join(dir, "a.mp4")
    const mp4b = join(dir, "b.mp4")
    const wav = join(dir, "mix.wav")
    const aBytes = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex")
    const bBytes = Buffer.from("ftypmp42-shot-b")
    const wBytes = Buffer.from("RIFFwav-mix")
    writeFileSync(mp4a, aBytes)
    writeFileSync(mp4b, bBytes)
    writeFileSync(wav, wBytes)
    const built = buildInterchange({
      width: 1920, height: 1080, fps: 30,
      clips: [
        { id: "shot_a", path: mp4a, durationSec: 1.5, width: 1344, height: 768, hasAudio: true },
        { id: "shot_b", path: mp4b, durationSec: 2.5, width: 1344, height: 768, hasAudio: false },
      ],
      audio: [{ id: "mix", path: wav, durationSec: 4 }],
      subtitles: [{ text: "第三镜", startSec: 0, endSec: 1.5 }],
    })
    const zip = Buffer.from(built.zipBytes)
    const draft = JSON.parse(zipEntry(zip, "draft_content.json").toString("utf8")) as {
      materials: { videos: { path: string; material_name: string; width?: number; height?: number }[]; audios: { id: string }[]; texts: { content: string }[] } & Record<string, unknown>
      tracks: { type: string; segments: { id: string; target_timerange: { duration: number } }[] }[]
      duration: number
      platform: { app_id: number }
    } & Record<string, unknown>
    for (const key of Object.keys(contentTemplate)) expect(draft).toHaveProperty(key)
    for (const key of Object.keys(contentTemplate.materials)) expect(draft.materials).toHaveProperty(key)
    expect(draft.platform.app_id).toBe(3704)
    expect(draft.platform).toEqual(contentTemplate.platform)
    const meta = JSON.parse(zipEntry(zip, "draft_meta_info.json").toString("utf8")) as Record<string, unknown>
    expect(Object.keys(meta).sort()).toEqual(Object.keys(metaTemplate).sort())
    expect(meta.draft_name).toBe("export")
    expect(meta.tm_duration).toBe(4_000_000)
    expect(meta.draft_id).not.toBe(metaTemplate.draft_id)
    expect(draft.materials.videos.map((v) => [v.width, v.height])).toEqual([[1344, 768], [1344, 768]])
    expect(draft.materials.texts.some((t) => t.content.includes('"size":8'))).toBe(true)
    const fcpxZip = Buffer.from(built.fcpxmlZipBytes)
    expect(zipEntry(fcpxZip, "export.fcpxml").toString("utf8")).toBe(built.fcpxml)
    expect(zipEntry(fcpxZip, "media/a.mp4").equals(aBytes)).toBe(true)
    expect(zipEntry(fcpxZip, "media/mix.wav").equals(wBytes)).toBe(true)
    expect(draft.materials).toBeTruthy()
    expect(draft.tracks).toBeTruthy()
    expect(draft.duration).toBe(4_000_000)
    const video = draft.tracks.find((t) => t.type === "video")
    expect(video?.segments.map((s) => s.id)).toEqual(["shot_a", "shot_b"])
    expect(video?.segments.map((s) => s.target_timerange.duration)).toEqual([1_500_000, 2_500_000])
    expect(draft.tracks.some((t) => t.type === "audio" && t.segments.some((s) => s.id === "mix"))).toBe(true)
    expect(draft.tracks.some((t) => t.type === "text")).toBe(true)
    expect(draft.materials.texts.some((t) => t.content.includes("第三镜"))).toBe(true)
    expect(zipEntry(zip, "materials/a.mp4").equals(aBytes)).toBe(true)
    expect(zipEntry(zip, "materials/b.mp4").equals(bBytes)).toBe(true)
    expect(zipEntry(zip, "materials/mix.wav").equals(wBytes)).toBe(true)
    expect(built.fcpxml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(built.fcpxml).toContain('<fcpxml version="1.10">')
    expect(built.fcpxml).not.toContain("file://")
    expect(attr(built.fcpxml, "asset", "shot_a", "src")).toBe("media/a.mp4")
    expect(attr(built.fcpxml, "asset", "shot_b", "src")).toBe("media/b.mp4")
    expect(attr(built.fcpxml, "asset", "mix", "src")).toBe("media/mix.wav")
    expect(attr(built.fcpxml, "asset", "shot_a", "hasAudio")).toBe("1")
    expect(attr(built.fcpxml, "asset", "shot_b", "hasAudio")).toBe("0")
    expect(attr(built.fcpxml, "asset", "mix", "hasAudio")).toBe("1")
    const shotFormat = attr(built.fcpxml, "asset", "shot_a", "format")
    expect(shotFormat).toBeTruthy()
    expect(formatAttr(built.fcpxml, shotFormat ?? "", "width")).toBe("1344")
    expect(formatAttr(built.fcpxml, shotFormat ?? "", "height")).toBe("768")
    expect(attr(built.fcpxml, "asset-clip", "shot_a", "duration")).toBe("3/2s")
    expect(attr(built.fcpxml, "asset-clip", "shot_b", "duration")).toBe("5/2s")
    expect(built.fcpxml).toContain('hasAudio="1"')
    expect(built.fcpxml).toMatch(/<audio\b[^>]*\bref="r/)
    expect(built.fcpxml).toMatch(/<title\b[\s\S]*第三镜[\s\S]*<\/title>/)
  })

  test("媒体不存在仍保留名字，没有字幕就只有空文本轨", () => {
    const missing = join(tmpdir(), "no-such-interchange", "gone.mp4")
    const built = buildInterchange({
      clips: [
        { id: "n1", path: missing, durationSec: 1 },
        { id: "n2", path: missing + ".b", durationSec: 1 },
      ],
    })
    const draft = built.draftJson as { materials: { videos: { path: string; width?: number; height?: number }[] }; tracks: { type: string; segments: { id: string }[] }[] }
    expect(draft.materials.videos.map((v) => v.path)).toEqual(["materials/gone.mp4", "materials/gone.mp4.b"])
    expect(draft.tracks.find((t) => t.type === "video")?.segments.map((s) => s.id)).toEqual(["n1", "n2"])
    expect(draft.tracks.find((t) => t.type === "text")?.segments).toEqual([])
    expect(draft.materials.videos.every((v) => v.width === undefined && v.height === undefined)).toBe(true)
    expect(built.fcpxml).not.toContain("<title")
    expect(built.fcpxml).not.toContain("第三镜")
    expect(built.fcpxml).not.toContain("file://")
    expect(built.fcpxml).not.toContain('hasAudio="0"')
    expect(built.fcpxml).not.toContain('width="1920"')
    expect(built.fcpxml).not.toContain('height="1080"')
    expect(attr(built.fcpxml, "asset", "n1", "src")).toBe("media/gone.mp4")
    expect(() => zipEntry(Buffer.from(built.zipBytes), "materials/gone.mp4")).toThrow()
  })
})

describe("appendInterchangeOutputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ix-append-"))
  const clip = join(dir, "c.mp4")
  writeFileSync(clip, Buffer.from("mp4"))
  const spec = {
    clips: [
      { id: "shot_a", path: clip, durationSec: 1, width: 1344, height: 768, hasAudio: true },
      { id: "shot_b", path: clip, durationSec: 1, width: 1344, height: 768, hasAudio: false },
    ],
    audio: [] as { id: string; path: string; durationSec?: number }[],
    scratch: dir,
    width: 1920,
    height: 1080,
    subtitleFiles: [] as { path: string; port: string }[],
    timelineSubtitles: [{ text: "第三镜", startSec: 0, endSec: 1 }],
  }
  const mp4 = (): Output => ({
    port: "out", artifactId: "art_" + "a".repeat(16), sha256: "b".repeat(64), path: clip,
    mime: "video/mp4", bytes: 3, origin: "derived", meta: { preset: "landscape_169" },
  })

  test("两件都成功才多两条 output", async () => {
    const out = mp4()
    const extra = await appendInterchangeOutputs({
      ingest: async (src, hint) => ({
        port: hint.port, artifactId: "art_" + "c".repeat(16), sha256: "d".repeat(64),
        path: "path" in src ? src.path : "", mime: hint.mime ?? "", bytes: 1, origin: hint.origin,
      }),
    }, out, spec)
    expect(extra.map((o) => o.port)).toEqual(["jianying", "fcpxml"])
    expect(extra.map((o) => o.meta?.kind)).toEqual(["jianying_draft", "fcpxml"])
    expect(extra[0].mime).toBe("application/zip")
    expect(extra[1].mime).toBe("application/zip")
    expect(out.meta?.interchangeError).toBeUndefined()
    const xmlZip = readFileSync(extra[1].path)
    const xml = zipEntry(xmlZip, "export.fcpxml").toString("utf8")
    expect(xml).toContain("第三镜")
    expect(xml).toContain('version="1.10"')
    expect(xml).toContain('src="media/c.mp4"')
    expect(xml).not.toContain("file://")
    expect(zipEntry(xmlZip, "media/c.mp4").toString("utf8")).toBe("mp4")
    const draftZip = readFileSync(extra[0].path)
    expect(zipEntry(draftZip, "draft_meta_info.json").length).toBeGreaterThan(0)
    const packed = JSON.parse(zipEntry(draftZip, "draft_content.json").toString("utf8")) as Record<string, unknown>
    for (const key of Object.keys(contentTemplate)) expect(packed).toHaveProperty(key)
  })

  test("入库失败不增加 output，错误写在 mp4 meta", async () => {
    const out = mp4()
    const extra = await appendInterchangeOutputs({
      ingest: async () => { throw new Error("ingest boom ".repeat(30)) },
    }, out, spec)
    expect(extra).toEqual([])
    expect(out.mime).toBe("video/mp4")
    expect(out.port).toBe("out")
    const err = String(out.meta?.interchangeError)
    expect(err.startsWith("ingest boom")).toBe(true)
    expect(err.length).toBeLessThanOrEqual(200)
  })
})
