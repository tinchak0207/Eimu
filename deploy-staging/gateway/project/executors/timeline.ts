// S8b：timeline 执行器（确定性）。
// 轮子：套 timeline.ts 的 TimelineOp 语义（applyOps 全量验证＋版本快照）；本档只做
// 「工程图输入 → IR ops」的翻译，产物 = 该会话时间线的 current.json 快照（内容寻址入库）。
// 镜头顺序来自 params.order（图的 timeline 节点参数），不是 id 字符串排序。
import { readFile, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyOps, type AudioClip, type AudioTrack, type Timeline, type TimelineClip, type TimelineOp } from "../../timeline.ts"
import type { ExecContext, ExecResult, Json, NodeExecutor, Output } from "../types"
import { NODE_SPECS } from "../specs"
import { workspaceDir } from "../store.ts"

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"

// ---------------------------------------------------------------- 共用工具（本切片四个执行器共用，导出给同切片）
export interface FlatInput { name: string; from?: string; port: string; output: Output }

/** ctx.inputs 摊平；顺带带上产生它的上游节点 id（节点 inputs 边）。 */
export function flattenInputs(ctx: Pick<ExecContext, "inputs" | "node">): FlatInput[] {
  const out: FlatInput[] = []
  const edges = (ctx.node.inputs ?? {}) as Record<string, { from: string; port?: string } | undefined>
  for (const [name, outs] of Object.entries(ctx.inputs ?? {})) {
    const from = edges[name]?.from
    for (const output of outs ?? []) out.push({ name, from, port: output.port, output })
  }
  return out
}

export const mimeOf = (o: Output): string => (o.mime ?? "").toLowerCase()
export const isVideo = (o: Output): boolean => mimeOf(o).startsWith("video/")
export const isAudio = (o: Output): boolean => mimeOf(o).startsWith("audio/")
export const isJson = (o: Output): boolean => mimeOf(o).includes("json")

/** 工程目录下本切片的暂存区（ctx.ingest 的 allowed roots 是项目目录）。 */
export function projectScratchDir(sessionId: string, tag: string): string {
  const safe = (sessionId || "session").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session"
  return path.join(workspaceDir(), "projects", safe, "tmp", tag.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40))
}

export function safeNodeKey(...parts: string[]): string {
  return parts.join("_").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)
}

export async function readJsonOutput(o: Output): Promise<Json | null> {
  try {
    return JSON.parse(await readFile(o.path, "utf-8")) as Json
  } catch {
    return null
  }
}

export function isObj(v: unknown): v is Record<string, Json> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

/** ffprobe 时长（秒）；失败 0。 */
export async function probeDurationSec(file: string): Promise<number> {
  const { invoke } = await import("../../editor/adapter/tauri-adapter")
  const { detectFfmpeg } = await import("../../editor/canvas/videoCompose")
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return 0
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
  const r = await invoke<{ stdout: string; stderr: string; exit_code: number }>("execute_command", {
    command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(file)}`,
    timeoutMs: 15000,
  }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }))
  const n = Number.parseFloat((r.stdout || "").trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 稳定 clip id：上游节点 id（order 参数就按它匹配）→ 去重后缀。 */
function uniqueClipId(base: string, used: Set<string>): string {
  let id = base || "clip"
  let n = 2
  while (used.has(id)) id = `${base || "clip"}_${n++}`
  used.add(id)
  return id
}

interface TransitionRule { after?: string; type?: string; duration?: number }

function transitionFor(rules: TransitionRule[], keys: string[]): { type: string; duration: number } {
  for (const r of rules) {
    if (!r || typeof r.after !== "string") continue
    if (!keys.includes(r.after)) continue
    const type = typeof r.type === "string" && r.type ? r.type : "cut"
    const duration = typeof r.duration === "number" && Number.isFinite(r.duration) ? Math.max(0, r.duration) : 0
    if (type === "none") return { type: "cut", duration: 0 }
    return { type, duration }
  }
  return { type: "cut", duration: 0 }
}

/** 按 order 重排输入（匹配上游节点 id / artifactId / 文件名）。 */
export function orderInputs(entries: FlatInput[], order: Json | undefined): FlatInput[] {
  if (!Array.isArray(order) || order.length === 0) return entries.slice()
  const keysOf = (e: FlatInput): string[] => {
    const base = path.basename(e.output.path ?? "")
    return [e.from ?? "", e.output.artifactId, base, base.replace(/\.[^.]+$/, "")].filter(Boolean)
  }
  const used = new Set<number>()
  const out: FlatInput[] = []
  for (const raw of order) {
    if (typeof raw !== "string") continue
    const idx = entries.findIndex((e, i) => !used.has(i) && keysOf(e).includes(raw))
    if (idx >= 0) { used.add(idx); out.push(entries[idx]) }
  }
  for (let i = 0; i < entries.length; i += 1) if (!used.has(i)) out.push(entries[i])
  return out
}

// ---------------------------------------------------------------- 执行器
export const timelineExecutor: NodeExecutor = {
  type: "timeline",
  specVersion: NODE_SPECS.timeline.specVersion,
  async estimate() { return 0 },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const params = ctx.params ?? {}
    const entries = flattenInputs(ctx)
    const videos = orderInputs(entries.filter((e) => isVideo(e.output)), params.order)
    if (!videos.length) {
      return { ok: false, code: "bad_input", message: "timeline 没有视频输入：先接上 clip 产物（每个镜头一段）", retryable: false }
    }
    const transitions = Array.isArray(params.transitions) ? (params.transitions as unknown as TransitionRule[]) : []

    const ops: TimelineOp[] = []
    const used = new Set<string>()
    for (const e of videos) {
      const sec = e.output.durationSec && e.output.durationSec > 0 ? e.output.durationSec : await probeDurationSec(e.output.path)
      if (!(sec > 0)) return { ok: false, code: "bad_input", message: `镜头产物无有效时长：${e.output.artifactId}`, retryable: false }
      const id = uniqueClipId(e.from ?? e.output.artifactId, used)
      const transition = transitionFor(transitions, [e.from ?? "", id, e.output.artifactId])
      const clip: TimelineClip = {
        id,
        path: e.output.path,
        label: e.from ?? e.output.artifactId,
        duration: sec,
        inSec: 0,
        outSec: sec,
        speed: 1,
        transitionAfter: transition,
      }
      ops.push({ type: "add", clip, index: ops.filter((o) => o.type === "add").length })
    }

    // 音频输入：voice 逐条顺序铺放；music/bgm 从 0 起铺（时间线里各自成轨，混音节点再调电平）。
    const audioEntries = entries.filter((e) => isAudio(e.output))
    const tracks: AudioTrack[] = []
    let voiceCursor = 0
    let audioIdx = 0
    for (const e of audioEntries) {
      const sec = e.output.durationSec && e.output.durationSec > 0 ? e.output.durationSec : await probeDurationSec(e.output.path)
      if (!(sec > 0)) continue
      const label = `${e.name} ${e.from ?? ""}`.toLowerCase()
      const isMusic = /music|bgm|score/.test(label)
      const trackId = isMusic ? "music" : "voice"
      if (!tracks.some((t) => t.id === trackId)) tracks.push({ id: trackId, kind: isMusic ? "bgm" : "voice", muted: false })
      const startSec = isMusic ? 0 : voiceCursor
      const audio: AudioClip = {
        id: uniqueClipId(`a_${e.from ?? audioIdx}`, used),
        trackId,
        path: e.output.path,
        label: e.from ?? `audio${audioIdx}`,
        startSec,
        duration: sec,
        inSec: 0,
        outSec: sec,
        volume: 1,
      }
      ops.push({ type: "add_audio", audio, track: { id: trackId, kind: isMusic ? "bgm" : "voice", muted: false } })
      if (!isMusic) voiceCursor += sec
      audioIdx += 1
    }
    if (typeof params.aspect === "string" && params.aspect) {
      ops.push({ type: "set_aspect", aspect: params.aspect as never })
    }

    // 时间线快照目录按节点隔离；重跑从空时间线开始（ops 语义幂等）。
    const key = safeNodeKey(ctx.sessionId, ctx.node.id)
    const dir = path.join(WORKSPACE_DIR, "timelines", key)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    const applied = await applyOps(key, ops, `project timeline node ${ctx.node.id}`)
    let snapshot: string
    try {
      snapshot = await readFile(path.join(dir, "current.json"), "utf-8")
    } catch {
      // 无实际变化时 applyOps 不落盘（本执行器恒定 add 镜头，理论到不了这里）
      snapshot = JSON.stringify(applied.timeline, null, 2)
    }
    const scratch = projectScratchDir(ctx.sessionId, `timeline-${ctx.node.id}`)
    await mkdir(scratch, { recursive: true })
    const snapshotPath = path.join(scratch, "current.json")
    await writeFile(snapshotPath, snapshot, "utf-8")
    const ingested = await ctx.ingest({ path: snapshotPath }, { port: "out", mime: "application/json", origin: "derived" })
    const tl = JSON.parse(snapshot) as Timeline
    return {
      ok: true,
      costCoins: 0,
      outputs: [{
        ...ingested,
        port: "out",
        meta: {
          version: applied.version,
          clips: tl.clips?.length ?? 0,
          audioClips: tl.audioClips?.length ?? 0,
          totalDurationSec: applied.total_duration_sec,
          aspect: tl.aspect ?? null,
          fps: typeof params.fps === "number" ? params.fps : null,
          styleId: typeof params.styleId === "string" ? params.styleId : null,
          order: Array.isArray(params.order) ? params.order : [],
        },
      }],
    }
  },
}
