// S8b：subtitle 执行器（确定性）。
// 输入 = shotlist 台词（rows[]）+ timeline 时间轴（clips[] 的顺序与有效时长）。
// 台词时间轴口径与作品轮子一致：clip 有效时长 = (outSec-inSec)/speed（timeline.ts clipLength）。
// 产物 = srt + ass 两路（§3.5 主口 srt）。params.burnIn 决定交付形态：true=由 export 节点烧录，
// false=外挂字幕文件；决定写进产物 meta.burnIn，export 执行器据此二选一。
// 序列化复用 editor/subtitleExport 的 toSrt/toAss（不新造字幕管线）。
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { toAss, toSrt } from "../../editor/subtitleExport"
import type { SubtitleCue } from "../../editor/adapter/editorStore"
import type { ExecContext, ExecResult, Json, NodeExecutor, Output } from "../types"
import { NODE_SPECS } from "../specs"
import { flattenInputs, isJson, isObj, projectScratchDir, readJsonOutput } from "./timeline"

const ROW_TEXT_KEYS = ["text", "dialogue", "line", "narration", "subtitle", "caption", "content"] as const

function rowText(row: Record<string, Json>): string {
  for (const k of ROW_TEXT_KEYS) {
    const v = row[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

interface TimelineClipLite { id: string; label?: string; duration?: number; inSec?: number; outSec?: number; speed?: number }

function clipIdOf(clip: TimelineClipLite): string {
  return String(clip?.id ?? "")
}

function rowMatchesClip(rowId: string, clip: TimelineClipLite): boolean {
  const cid = clipIdOf(clip)
  if (!rowId || !cid) return false
  return cid === rowId || cid.endsWith(`#${rowId}`) || cid.endsWith(`_${rowId}`) || String(clip.label ?? "") === rowId
}

/** 台词 → 字幕条目：行有 startSec/endSec 就用它，否则按镜头时间轴铺满整段。 */
function buildCues(rows: Record<string, Json>[], clips: TimelineClipLite[], fallback: SubtitleCue[]): SubtitleCue[] {
  if (!rows.length) return fallback.slice()
  const cues: SubtitleCue[] = []
  let cursor = 0
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i] ?? ({} as TimelineClipLite)
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
    const inS = clip.inSec ?? 0
    const outS = clip.outSec ?? clip.duration ?? 0
    const len = Math.max(0.1, (outS - inS) / speed)
    const row = rows.find((r) => rowMatchesClip(String(r.id ?? ""), clip)) ?? rows[i]
    const text = row ? rowText(row) : ""
    if (text) {
      const rawStart = row && typeof row.startSec === "number" ? row.startSec : null
      const rawEnd = row && typeof row.endSec === "number" ? row.endSec : null
      const startSec = rawStart !== null && rawStart >= 0 ? rawStart : cursor
      const endSec = rawEnd !== null && rawEnd > startSec ? rawEnd : startSec + len
      cues.push({ id: `cue_${i}`, startSec, endSec, text })
    }
    cursor += len
  }
  return cues
}

/** style 参数（J："default" 或对象）只覆盖 ASS 的 Default 样式行，不动轮子的其它部分。 */
function styleAss(ass: string, style: Json): string {
  if (!isObj(style)) return ass
  const fontName = typeof style.fontName === "string" ? style.fontName : null
  const fontSize = typeof style.fontSize === "number" ? style.fontSize : null
  const marginV = typeof style.marginV === "number" ? style.marginV : null
  const primary = typeof style.primaryColour === "string" ? style.primaryColour : null
  const alignment = typeof style.alignment === "number" ? style.alignment : null
  if (fontName === null && fontSize === null && marginV === null && primary === null && alignment === null) return ass
  return ass.split("\n").map((line) => {
    if (!line.startsWith("Style: Default,")) return line
    const parts = line.split(",")
    // toAss 的 Style 行：0 Name,1 Fontname,2 Fontsize,3 PrimaryColour,...,18 Alignment,21 MarginV
    if (fontName !== null) parts[1] = fontName
    if (fontSize !== null) parts[2] = String(fontSize)
    if (primary !== null) parts[3] = primary
    if (alignment !== null) parts[18] = String(alignment)
    if (marginV !== null) parts[21] = String(marginV)
    return parts.join(",")
  }).join("\n")
}

export const subtitleExecutor: NodeExecutor = {
  type: "subtitle",
  specVersion: NODE_SPECS.subtitle.specVersion,
  async estimate() { return 0 },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const params = ctx.params ?? {}
    const entries = flattenInputs(ctx)
    const jsonEntries = entries.filter((e) => isJson(e.output))
    const parsed: { e: typeof jsonEntries[number]; value: Record<string, Json> }[] = []
    for (const e of jsonEntries) {
      const v = await readJsonOutput(e.output)
      if (isObj(v)) parsed.push({ e, value: v })
    }
    const timelineValue = parsed.find((p) => Array.isArray(p.value.clips))?.value ?? null
    const shotlistValue = parsed.find((p) => Array.isArray(p.value.rows))?.value ?? null
    if (!timelineValue) {
      return { ok: false, code: "bad_input", message: "subtitle 需要 timeline 产物（json，含 clips 时间轴）作为输入", retryable: false }
    }
    const clips = (timelineValue.clips as unknown as TimelineClipLite[]) ?? []
    const rows = (shotlistValue?.rows as unknown as Record<string, Json>[]) ?? []
    const fallback = Array.isArray(timelineValue.subtitles) ? (timelineValue.subtitles as unknown as SubtitleCue[]) : []
    const cues = buildCues(rows, clips, fallback)
    if (!cues.length) {
      return { ok: false, code: "bad_input", message: "没有可生成字幕的台词：shotlist.rows 无 text/dialogue，时间线也没有字幕轨", retryable: false }
    }
    const aspect = (typeof timelineValue.aspect === "string" && timelineValue.aspect ? timelineValue.aspect : "16:9") as never
    const srt = toSrt(cues)
    const ass = styleAss(toAss(cues, aspect), params.style ?? null)
    const burnIn = params.burnIn === true
    const lang = typeof params.lang === "string" ? params.lang : null
    const scratch = projectScratchDir(ctx.sessionId, `subtitle-${ctx.node.id}`)
    await mkdir(scratch, { recursive: true })
    const srtPath = path.join(scratch, "subtitles.srt")
    const assPath = path.join(scratch, "subtitles.ass")
    await writeFile(srtPath, srt, "utf-8")
    await writeFile(assPath, ass, "utf-8")
    const srtOut = await ctx.ingest({ path: srtPath }, { port: "srt", mime: "application/x-subrip", origin: "derived" })
    const assOut = await ctx.ingest({ path: assPath }, { port: "ass", mime: "text/x-ass", origin: "derived" })
    const meta: Record<string, Json> = {
      burnIn,
      delivery: burnIn ? "burn_in" : "sidecar",
      lang,
      cueCount: cues.length,
      aspect: typeof timelineValue.aspect === "string" ? timelineValue.aspect : "16:9",
      lastEndSec: Math.round(cues[cues.length - 1].endSec * 1000) / 1000,
    }
    const outputs: Output[] = [
      { ...srtOut, port: "srt", meta },
      { ...assOut, port: "ass", meta },
    ]
    return { ok: true, costCoins: 0, outputs }
  },
}
