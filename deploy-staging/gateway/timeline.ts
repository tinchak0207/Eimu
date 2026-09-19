/**
 * timeline.ts — AI 自主後期：時間線生命週期層（施工片 B1，2026-08-31）
 *
 * 需求源：《Eimu 剪輯體驗 PRD v1.0》REQ-EDIT-01（可計算時間線）+ REQ-EDIT-05（版本/決策日誌）。
 * 真源：$WORKSPACE_DIR/timelines/<session_id>/current.json + append-only versions/<n>.json + log.jsonl。
 *
 * 輪子紀律：clip/音軌/字幕型別一律 import 自 ./editor/adapter/editorStore
 * （kunpeng-vendor @872a58b 逐行移植件），本檔不重新定義任何輪子型別；
 * 有效時長公式與 wheel clipLength 逐字一致：(outSec - inSec) / speed，下限 0.1s。
 *
 * 本檔只做「時間線生命週期層」：ops 套用/守衛/版本快照/決策日誌/欄位級 diff。
 * 不碰 composeEngine 的 harness state（匯出側由 assembleFilmNode 自行注入）。
 */
import { mkdir, readFile, readdir, rm, appendFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  EditorClip,
  AudioClip,
  SubtitleCue,
  AudioTrack,
  AudioTrackKind,
  EditorAspect,
  TransitionType,
  ClipFilter,
} from "./editor/adapter/editorStore"
import { EDITOR_ASPECTS } from "./editor/aspect"

// 與 gateway/index.ts L433 同值；env 可覆蓋（測試用）。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
const TIMELINES_DIR = path.join(WORKSPACE_DIR, "timelines")

// 保留策略：最近 20 版 + 每 10 版里程碑版（v % 10 === 0），其餘刪。
const KEEP_RECENT = 20
const MILESTONE_EVERY = 10

// ── 資料模型（import 輪子型別 + 擴展） ─────────────────────────────────────────

export interface TimelineClip extends EditorClip {
  /** 所屬場景 id（agent 語義層標註，軟欄位） */
  sceneId?: string
  /** 景別：wide/medium/close-up…（agent 標註，不做語義 lint） */
  shotSize?: string
  /** 情緒標籤（PRD 妥協清單：接受 agent 標註序列作軟輸入） */
  emotionTag?: string
  /** 鎖定：拒絕任何變更 op（unlock 除外） */
  locked?: boolean
  /** 分組名（同組語義標記，供 B 系列片聚合用） */
  group?: string
  /** 該鏡頭累計生成成本（幣），決策日誌 cost_delta 的來源 */
  costCoins?: number
  /** 調色四滑桿（B7 風格貨架；ClipFilter = 輪子型別，preset 存檔供 UI 高亮） */
  filter?: ClipFilter
}

export interface TimelineMarker {
  id: string
  timeSec: number
  label?: string
}

/** 與 vendor EditorBgm 同形（gateway editorStore 未 export 該符號，此處結構對齊，非重定義） */
export interface TimelineBgm {
  path: string
  label: string
  volume: number
}

export interface Timeline {
  session_id: string
  version: number
  clips: TimelineClip[]
  audioTracks: AudioTrack[]
  audioClips: AudioClip[]
  subtitles: SubtitleCue[]
  bgm?: TimelineBgm | null
  aspect: EditorAspect
  markers?: TimelineMarker[]
  updated_at: string
}

/** 機器可讀 diff 條目（ops 返回與 diffVersions 共用同一形態） */
export interface DiffEntry {
  clip_id: string
  field: string
  before: unknown
  after: unknown
}

/** 決策日誌條目（log.jsonl，append-only） */
export interface LogEntry {
  at: string
  action: string
  reason: string
  affected_clips: string[]
  diff: DiffEntry[]
  version_id: number
  cost_delta: number
}

// ── Ops 型別 ───────────────────────────────────────────────────────────────────

export type TimelineOp =
  | { type: "add"; clip: TimelineClip; index?: number }
  | { type: "remove"; clipId: string }
  | { type: "reorder"; clipId: string; toIndex: number }
  | { type: "trim"; clipId: string; inSec?: number; outSec?: number }
  | { type: "split"; clipId: string; atSec: number }
  | { type: "speed"; clipId: string; speed: number }
  | { type: "lock"; clipId: string }
  | { type: "unlock"; clipId: string }
  | { type: "group"; clipIds: string[]; group: string }
  | { type: "ungroup"; clipIds?: string[]; group?: string }
  | { type: "set_transition"; clipId: string; transition: { type: TransitionType; duration: number } }
  | { type: "set_meta"; clipId: string; meta: { sceneId?: string; shotSize?: string; emotionTag?: string; costCoins?: number } }
  | { type: "set_style"; clipId: string; filter: ClipFilter }
  | { type: "add_audio"; audio: AudioClip; track?: { id: string; kind: AudioTrackKind; muted?: boolean } }
  | { type: "add_subtitle"; cue: SubtitleCue }
  | { type: "set_aspect"; aspect: EditorAspect }

// ── 錯誤（HTTP 層映射：blocked→409 flat {blocked, reason}；invalid→400） ────────

export class TimelineBlockedError extends Error {
  constructor(public readonly blocked: string, message?: string) {
    super(message || `clip ${blocked} is locked; mutation refused`)
    this.name = "TimelineBlockedError"
  }
}

export class TimelineValidationError extends Error {
  constructor(message: string, public readonly opIndex?: number) {
    super(message)
    this.name = "TimelineValidationError"
  }
}

export class TimelineNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimelineNotFoundError"
  }
}

// ── 工具函數 ───────────────────────────────────────────────────────────────────

/** 有效時長：與 wheel clipLength 逐字一致（editorStore.ts L228-230） */
export function clipLength(c: EditorClip): number {
  return Math.max(0.1, (c.outSec - c.inSec) / (c.speed && c.speed > 0 ? c.speed : 1))
}

/** 總時長：主軌求和 + 音軌/字幕尾端（wheel totalDuration 口徑，去掉本層沒有的 overlay/text/fx 軌） */
export function totalDurationSec(tl: Pick<Timeline, "clips" | "audioClips" | "subtitles">): number {
  const main = tl.clips.reduce((sum, c) => sum + clipLength(c), 0)
  const tails = [
    ...tl.audioClips.map((a) => a.startSec + Math.max(0.1, a.outSec - a.inSec || a.duration || 0)),
    ...tl.subtitles.map((s) => s.endSec),
  ]
  return Math.max(main, ...tails, 0)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function assertSessionId(sid: string): void {
  if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) {
    throw new TimelineValidationError("session_id must match [A-Za-z0-9_-]{1,64}")
  }
}

function sessionDir(sid: string): string {
  return path.join(TIMELINES_DIR, sid)
}
function currentPath(sid: string): string {
  return path.join(sessionDir(sid), "current.json")
}
function versionPath(sid: string, v: number): string {
  return path.join(sessionDir(sid), "versions", `${v}.json`)
}
function logPath(sid: string): string {
  return path.join(sessionDir(sid), "log.jsonl")
}

function emptyTimeline(sid: string): Timeline {
  return {
    session_id: sid,
    version: 0,
    clips: [],
    audioTracks: [],
    audioClips: [],
    subtitles: [],
    bgm: null,
    aspect: "16:9",
    markers: [],
    updated_at: new Date(0).toISOString(),
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

function sumCost(tl: Timeline): number {
  return tl.clips.reduce((s, c) => s + (typeof c.costCoins === "number" && isFinite(c.costCoins) ? c.costCoins : 0), 0)
}

function findClip(tl: Timeline, id: string): TimelineClip | undefined {
  return tl.clips.find((c) => c.id === id)
}

/** locked 守衛：任何以該 clip 為目標的變更 op 一律整批拒絕（unlock 除外） */
function guardLocked(clip: TimelineClip | undefined, opIndex: number): void {
  if (clip && clip.locked) {
    throw new TimelineBlockedError(clip.id, `op[${opIndex}]: clip ${clip.id} is locked; mutation refused`)
  }
}

function num(v: unknown, name: string, opIndex: number, opts?: { min?: number; max?: number; gt?: number }): number {
  if (typeof v !== "number" || !isFinite(v)) throw new TimelineValidationError(`${name} must be a finite number`, opIndex)
  if (opts?.min !== undefined && v < opts.min) throw new TimelineValidationError(`${name} must be >= ${opts.min}`, opIndex)
  if (opts?.max !== undefined && v > opts.max) throw new TimelineValidationError(`${name} must be <= ${opts.max}`, opIndex)
  if (opts?.gt !== undefined && !(v > opts.gt)) throw new TimelineValidationError(`${name} must be > ${opts.gt}`, opIndex)
  return v
}

function str(v: unknown, name: string, opIndex: number): string {
  if (typeof v !== "string" || v.length === 0) throw new TimelineValidationError(`${name} must be a non-empty string`, opIndex)
  return v
}

// ── 單 op 套用（對 draft 就地修改並 push diff；呼叫前已通過驗證） ──────────────
// 設計：驗證與套用共用同一 switch，驗證階段跑在 draft 副本上（先全驗證後套用），
// 因此每個 op 的「驗證」其實就是「套用到 draft 前的檢查」，套用於第二輪。

function validateOp(tl: Timeline, op: TimelineOp, i: number): void {
  if (!op || typeof op !== "object" || typeof (op as { type?: unknown }).type !== "string") {
    throw new TimelineValidationError(`op[${i}]: missing type`, i)
  }
  switch (op.type) {
    case "add": {
      const c = op.clip as Partial<TimelineClip> | undefined
      if (!c) throw new TimelineValidationError(`op[${i}]: clip is required`, i)
      str(c.id, "clip.id", i)
      if (findClip(tl, c.id!)) throw new TimelineValidationError(`op[${i}]: duplicate clip id ${c.id}`, i)
      str(c.path, "clip.path", i)
      if (typeof c.label !== "string") throw new TimelineValidationError(`op[${i}]: clip.label must be string`, i)
      num(c.duration, "clip.duration", i, { gt: 0 })
      num(c.inSec, "clip.inSec", i, { min: 0 })
      num(c.outSec, "clip.outSec", i, { gt: c.inSec })
      if (c.outSec! > c.duration!) throw new TimelineValidationError(`op[${i}]: clip.outSec ${c.outSec} exceeds duration ${c.duration}`, i)
      if (op.index !== undefined) num(op.index, "index", i, { min: 0, max: tl.clips.length })
      break
    }
    case "remove": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      break
    }
    case "reorder": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      num(op.toIndex, "toIndex", i, { min: 0, max: tl.clips.length - 1 })
      break
    }
    case "trim": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      const inSec = op.inSec !== undefined ? num(op.inSec, "inSec", i, { min: 0 }) : c.inSec
      const outSec = op.outSec !== undefined ? num(op.outSec, "outSec", i, { gt: 0 }) : c.outSec
      if (!(inSec < outSec)) throw new TimelineValidationError(`op[${i}]: trim requires inSec < outSec`, i)
      if (outSec > c.duration) throw new TimelineValidationError(`op[${i}]: outSec ${outSec} exceeds duration ${c.duration}`, i)
      break
    }
    case "split": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      const at = num(op.atSec, "atSec", i)
      const sp = c.speed && c.speed > 0 ? c.speed : 1
      if (!(at > c.inSec && at < c.outSec)) throw new TimelineValidationError(`op[${i}]: atSec must be inside (inSec, outSec)`, i)
      if ((at - c.inSec) / sp < 0.1 || (c.outSec - at) / sp < 0.1) {
        throw new TimelineValidationError(`op[${i}]: both split halves must keep effective length >= 0.1s`, i)
      }
      break
    }
    case "speed": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      num(op.speed, "speed", i, { min: 0.1, max: 4 })
      break
    }
    case "lock": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      break
    }
    case "unlock": {
      if (!findClip(tl, str(op.clipId, "clipId", i))) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      break
    }
    case "group": {
      const g = str(op.group, "group", i)
      if (!Array.isArray(op.clipIds) || op.clipIds.length === 0) throw new TimelineValidationError(`op[${i}]: clipIds must be non-empty array`, i)
      for (const id of op.clipIds) {
        const c = findClip(tl, str(id, "clipIds[]", i))
        if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${id}`, i)
        guardLocked(c, i)
      }
      if (g.length > 64) throw new TimelineValidationError(`op[${i}]: group name too long (max 64)`, i)
      break
    }
    case "ungroup": {
      if (!op.clipIds && !op.group) throw new TimelineValidationError(`op[${i}]: ungroup needs clipIds or group`, i)
      const targets = op.clipIds
        ? op.clipIds.map((id) => findClip(tl, str(id, "clipIds[]", i)))
        : tl.clips.filter((c) => c.group === op.group)
      for (const c of targets) {
        if (!c) throw new TimelineValidationError(`op[${i}]: clip not found`, i)
        guardLocked(c, i)
      }
      break
    }
    case "set_transition": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      if (!op.transition || typeof op.transition.type !== "string") throw new TimelineValidationError(`op[${i}]: transition.type required`, i)
      num(op.transition.duration, "transition.duration", i, { min: 0, max: 30 })
      break
    }
    case "set_meta": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      const m = op.meta
      if (!m || (m.sceneId === undefined && m.shotSize === undefined && m.emotionTag === undefined && m.costCoins === undefined)) {
        throw new TimelineValidationError(`op[${i}]: meta must set at least one of sceneId/shotSize/emotionTag/costCoins`, i)
      }
      if (m.costCoins !== undefined) num(m.costCoins, "meta.costCoins", i, { min: 0 })
      break
    }
    case "set_style": {
      const c = findClip(tl, str(op.clipId, "clipId", i))
      if (!c) throw new TimelineValidationError(`op[${i}]: clip not found: ${op.clipId}`, i)
      guardLocked(c, i)
      const f = op.filter
      if (!f || typeof f !== "object") throw new TimelineValidationError(`op[${i}]: filter is required`, i)
      for (const k of ["brightness", "contrast", "saturation", "temperature"] as const) {
        num(f[k], `filter.${k}`, i, { min: -100, max: 100 })
      }
      break
    }
    case "add_audio": {
      const a = op.audio as Partial<AudioClip> | undefined
      if (!a) throw new TimelineValidationError(`op[${i}]: audio is required`, i)
      str(a.id, "audio.id", i)
      if (tl.audioClips.some((x) => x.id === a.id)) throw new TimelineValidationError(`op[${i}]: duplicate audio id ${a.id}`, i)
      str(a.trackId, "audio.trackId", i)
      str(a.path, "audio.path", i)
      num(a.startSec, "audio.startSec", i, { min: 0 })
      num(a.inSec, "audio.inSec", i, { min: 0 })
      num(a.outSec, "audio.outSec", i, { gt: a.inSec })
      num(a.duration, "audio.duration", i, { gt: 0 })
      if (a.volume !== undefined) num(a.volume, "audio.volume", i, { min: 0, max: 1 })
      if (op.track) {
        str(op.track.id, "track.id", i)
        if (op.track.id !== a.trackId) throw new TimelineValidationError(`op[${i}]: track.id must equal audio.trackId`, i)
        if (!["bgm", "sfx", "voice"].includes(op.track.kind)) throw new TimelineValidationError(`op[${i}]: track.kind must be bgm|sfx|voice`, i)
      }
      break
    }
    case "add_subtitle": {
      const s = op.cue as Partial<SubtitleCue> | undefined
      if (!s) throw new TimelineValidationError(`op[${i}]: cue is required`, i)
      str(s.id, "cue.id", i)
      if (tl.subtitles.some((x) => x.id === s.id)) throw new TimelineValidationError(`op[${i}]: duplicate subtitle id ${s.id}`, i)
      num(s.startSec, "cue.startSec", i, { min: 0 })
      num(s.endSec, "cue.endSec", i, { gt: s.startSec })
      str(s.text, "cue.text", i)
      break
    }
    case "set_aspect": {
      if (!EDITOR_ASPECTS.includes(op.aspect)) throw new TimelineValidationError(`op[${i}]: aspect must be one of ${EDITOR_ASPECTS.join(",")}`, i)
      break
    }
    default:
      throw new TimelineValidationError(`op[${i}]: unknown op type ${(op as { type: string }).type}`, i)
  }
}

function applyOp(tl: Timeline, op: TimelineOp, diff: DiffEntry[], affected: Set<string>): void {
  const touch = (id: string) => affected.add(id)
  switch (op.type) {
    case "add": {
      const clip = clone(op.clip)
      if (!clip.transitionAfter) clip.transitionAfter = { type: "cut", duration: 0 }
      const idx = op.index === undefined ? tl.clips.length : Math.min(op.index, tl.clips.length)
      tl.clips.splice(idx, 0, clip)
      diff.push({ clip_id: clip.id, field: "added", before: null, after: clip })
      touch(clip.id)
      break
    }
    case "remove": {
      const i = tl.clips.findIndex((c) => c.id === op.clipId)
      const [gone] = tl.clips.splice(i, 1)
      diff.push({ clip_id: gone.id, field: "removed", before: gone, after: null })
      touch(gone.id)
      break
    }
    case "reorder": {
      const from = tl.clips.findIndex((c) => c.id === op.clipId)
      const [moved] = tl.clips.splice(from, 1)
      tl.clips.splice(op.toIndex, 0, moved)
      diff.push({ clip_id: moved.id, field: "index", before: from, after: op.toIndex })
      touch(moved.id)
      break
    }
    case "trim": {
      const c = findClip(tl, op.clipId)!
      if (op.inSec !== undefined && op.inSec !== c.inSec) {
        diff.push({ clip_id: c.id, field: "inSec", before: c.inSec, after: op.inSec })
        c.inSec = op.inSec
      }
      if (op.outSec !== undefined && op.outSec !== c.outSec) {
        diff.push({ clip_id: c.id, field: "outSec", before: c.outSec, after: op.outSec })
        c.outSec = op.outSec
      }
      touch(c.id)
      break
    }
    case "split": {
      const idx = tl.clips.findIndex((c) => c.id === op.clipId)
      const orig = tl.clips[idx]
      let newId = `${orig.id}_b`
      let n = 2
      while (findClip(tl, newId)) newId = `${orig.id}_b${n++}`
      const tail: TimelineClip = {
        ...clone(orig),
        id: newId,
        inSec: op.atSec,
        transitionAfter: { type: "cut", duration: 0 },
        locked: false,
      }
      // 記帳衛生：生成成本屬源鏡頭，拆分不重複計費（costCoins 留在原段，後半段不帶）
      delete tail.costCoins
      diff.push({ clip_id: orig.id, field: "outSec", before: orig.outSec, after: op.atSec })
      orig.outSec = op.atSec
      tl.clips.splice(idx + 1, 0, tail)
      diff.push({ clip_id: newId, field: "added", before: null, after: tail })
      touch(orig.id)
      touch(newId)
      break
    }
    case "speed": {
      const c = findClip(tl, op.clipId)!
      if (c.speed !== op.speed) {
        diff.push({ clip_id: c.id, field: "speed", before: c.speed ?? 1, after: op.speed })
        c.speed = op.speed
      }
      touch(c.id)
      break
    }
    case "lock": {
      const c = findClip(tl, op.clipId)!
      if (!c.locked) {
        diff.push({ clip_id: c.id, field: "locked", before: false, after: true })
        c.locked = true
      }
      touch(c.id)
      break
    }
    case "unlock": {
      const c = findClip(tl, op.clipId)!
      if (c.locked) {
        diff.push({ clip_id: c.id, field: "locked", before: true, after: false })
        c.locked = false
      }
      touch(c.id)
      break
    }
    case "group": {
      for (const id of op.clipIds) {
        const c = findClip(tl, id)!
        if (c.group !== op.group) {
          diff.push({ clip_id: c.id, field: "group", before: c.group ?? null, after: op.group })
          c.group = op.group
        }
        touch(c.id)
      }
      break
    }
    case "ungroup": {
      const targets = op.clipIds
        ? op.clipIds.map((id) => findClip(tl, id)!)
        : tl.clips.filter((c) => c.group === op.group)
      for (const c of targets) {
        if (c.group !== undefined) {
          diff.push({ clip_id: c.id, field: "group", before: c.group, after: null })
          delete c.group
        }
        touch(c.id)
      }
      break
    }
    case "set_transition": {
      const c = findClip(tl, op.clipId)!
      const before = c.transitionAfter
      if (before?.type !== op.transition.type || before?.duration !== op.transition.duration) {
        diff.push({ clip_id: c.id, field: "transitionAfter", before: before ?? null, after: op.transition })
        c.transitionAfter = { type: op.transition.type, duration: op.transition.duration }
      }
      touch(c.id)
      break
    }
    case "set_meta": {
      const c = findClip(tl, op.clipId)!
      for (const k of ["sceneId", "shotSize", "emotionTag", "costCoins"] as const) {
        const v = op.meta[k]
        if (v !== undefined && c[k] !== v) {
          diff.push({ clip_id: c.id, field: k, before: c[k] ?? null, after: v })
          ;(c as Record<string, unknown>)[k] = v
        }
      }
      touch(c.id)
      break
    }
    case "set_style": {
      const c = findClip(tl, op.clipId)!
      const before = c.filter
      if (JSON.stringify(before) !== JSON.stringify(op.filter)) {
        diff.push({ clip_id: c.id, field: "filter", before: before ?? null, after: op.filter })
        c.filter = { ...op.filter }
      }
      touch(c.id)
      break
    }
    case "add_audio": {
      const a = clone(op.audio)
      if (a.volume === undefined) a.volume = 1
      if (!tl.audioTracks.some((t) => t.id === a.trackId)) {
        const t: AudioTrack = op.track
          ? { id: op.track.id, kind: op.track.kind, muted: op.track.muted ?? false }
          : { id: a.trackId, kind: "voice", muted: false }
        tl.audioTracks.push(t)
        diff.push({ clip_id: `track:${t.id}`, field: "track.added", before: null, after: t })
      }
      tl.audioClips.push(a)
      diff.push({ clip_id: a.id, field: "audio.added", before: null, after: a })
      touch(a.id)
      break
    }
    case "add_subtitle": {
      const s = clone(op.cue)
      tl.subtitles.push(s)
      diff.push({ clip_id: s.id, field: "subtitle.added", before: null, after: s })
      touch(s.id)
      break
    }
    case "set_aspect": {
      if (tl.aspect !== op.aspect) {
        diff.push({ clip_id: "timeline", field: "aspect", before: tl.aspect, after: op.aspect })
        tl.aspect = op.aspect
      }
      break
    }
  }
}

// ── 快照級欄位 diff（diffVersions 用） ─────────────────────────────────────────

function diffRecordList<T extends { id: string }>(
  before: T[],
  after: T[],
  kind: "clip" | "audio" | "subtitle" | "marker",
  diff: DiffEntry[],
): void {
  const bMap = new Map(before.map((x) => [x.id, x]))
  const aMap = new Map(after.map((x) => [x.id, x]))
  for (const [id, b] of bMap) {
    const a = aMap.get(id)
    if (!a) {
      diff.push({ clip_id: id, field: `${kind}.removed`, before: b, after: null })
      continue
    }
    const keys = new Set([...Object.keys(b), ...Object.keys(a)])
    for (const k of keys) {
      const bv = (b as Record<string, unknown>)[k]
      const av = (a as Record<string, unknown>)[k]
      if (JSON.stringify(bv ?? null) !== JSON.stringify(av ?? null)) {
        diff.push({ clip_id: id, field: k, before: bv ?? null, after: av ?? null })
      }
    }
  }
  for (const [id, a] of aMap) {
    if (!bMap.has(id)) diff.push({ clip_id: id, field: `${kind}.added`, before: null, after: a })
  }
  // 順序變化（僅主軌 clip 有時間軸語義）
  if (kind === "clip") {
    const bOrder = before.map((c) => c.id)
    const aOrder = after.map((c) => c.id)
    for (let i = 0; i < aOrder.length; i++) {
      const j = bOrder.indexOf(aOrder[i])
      if (j !== -1 && j !== i) {
        diff.push({ clip_id: aOrder[i], field: "index", before: j, after: i })
      }
    }
  }
}

export function computeTimelineDiff(before: Timeline, after: Timeline): DiffEntry[] {
  const diff: DiffEntry[] = []
  diffRecordList(before.clips, after.clips, "clip", diff)
  diffRecordList(before.audioClips, after.audioClips, "audio", diff)
  diffRecordList(before.subtitles, after.subtitles, "subtitle", diff)
  diffRecordList(before.markers ?? [], after.markers ?? [], "marker", diff)
  if (before.aspect !== after.aspect) diff.push({ clip_id: "timeline", field: "aspect", before: before.aspect, after: after.aspect })
  if (JSON.stringify(before.bgm ?? null) !== JSON.stringify(after.bgm ?? null)) {
    diff.push({ clip_id: "timeline", field: "bgm", before: before.bgm ?? null, after: after.bgm ?? null })
  }
  return diff
}

// ── 並發鎖（per-session 串行化 read-modify-write） ─────────────────────────────

const sessionLocks = new Map<string, { tail: Promise<void>; pending: number }>()

async function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  let entry = sessionLocks.get(sid)
  if (!entry) {
    entry = { tail: Promise.resolve(), pending: 0 }
    sessionLocks.set(sid, entry)
  }
  entry.pending++
  const prev = entry.tail
  let release!: () => void
  entry.tail = new Promise<void>((r) => (release = r))
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    entry.pending--
    if (entry.pending === 0) sessionLocks.delete(sid)
  }
}

// ── 持久化 ─────────────────────────────────────────────────────────────────────

async function loadCurrent(sid: string): Promise<Timeline | null> {
  try {
    const raw = await readFile(currentPath(sid), "utf-8")
    const tl = JSON.parse(raw) as Timeline
    // 防禦：缺欄位補默認，避免舊檔炸后续 op
    tl.clips ??= []
    tl.audioTracks ??= []
    tl.audioClips ??= []
    tl.subtitles ??= []
    tl.markers ??= []
    return tl
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null
    throw e
  }
}

async function loadVersion(sid: string, v: number): Promise<Timeline> {
  try {
    return JSON.parse(await readFile(versionPath(sid, v), "utf-8")) as Timeline
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new TimelineNotFoundError(`version ${v} not found`)
    throw e
  }
}

async function writeCurrent(sid: string, tl: Timeline): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await writeFile(currentPath(sid), JSON.stringify(tl, null, 2), "utf-8")
}

async function writeVersion(sid: string, tl: Timeline): Promise<void> {
  await mkdir(path.join(sessionDir(sid), "versions"), { recursive: true })
  await writeFile(versionPath(sid, tl.version), JSON.stringify(tl, null, 2), "utf-8")
}

async function appendLog(sid: string, entry: LogEntry): Promise<void> {
  await mkdir(sessionDir(sid), { recursive: true })
  await appendFile(logPath(sid), JSON.stringify(entry) + "\n", "utf-8")
}

/** 保留策略：最近 KEEP_RECENT 版 + 每 MILESTONE_EVERY 版里程碑，其餘刪 */
async function pruneVersions(sid: string, latest: number): Promise<void> {
  const dir = path.join(sessionDir(sid), "versions")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/)
    if (!m) continue
    const v = Number(m[1])
    const keep = v > latest - KEEP_RECENT || v % MILESTONE_EVERY === 0
    if (!keep) await rm(path.join(dir, name), { force: true }).catch(() => {})
  }
}

// ── 公開函數面 ─────────────────────────────────────────────────────────────────

export async function getTimeline(sessionId: string): Promise<Timeline> {
  assertSessionId(sessionId)
  return (await loadCurrent(sessionId)) ?? emptyTimeline(sessionId)
}

export interface ApplyOpsResult {
  timeline: Timeline
  diff: DiffEntry[]
  version: number
  total_duration_sec: number
  affected_clips: string[]
}

/**
 * 一批 ops：先全驗證（跑在 draft 上）後套用；驗證失敗整批拒絕並回報第一顆炸點。
 * locked clip 拒絕任何變更 op → TimelineBlockedError（HTTP 409, {blocked, reason:"locked"}）。
 * 成功且有實際變化 → version+1、寫 current + versions/<n>.json + log.jsonl、按策略裁剪。
 */
export async function applyOps(sessionId: string, ops: TimelineOp[], reason = ""): Promise<ApplyOpsResult> {
  assertSessionId(sessionId)
  if (!Array.isArray(ops) || ops.length === 0) throw new TimelineValidationError("ops must be a non-empty array")
  if (ops.length > 200) throw new TimelineValidationError("too many ops in one batch (max 200)")

  return withSessionLock(sessionId, async () => {
    const current = (await loadCurrent(sessionId)) ?? emptyTimeline(sessionId)
    const draft = clone(current)

    // 第一輪：全驗證（逐 op 套用到 draft，驗證即套用前檢查）
    const diff: DiffEntry[] = []
    const affected = new Set<string>()
    for (let i = 0; i < ops.length; i++) {
      validateOp(draft, ops[i], i)
      applyOp(draft, ops[i], diff, affected)
    }

    const costDelta = round3(sumCost(draft) - sumCost(current))

    if (diff.length === 0) {
      // 無實際變化（冪等 op）：不 bump 版本、不寫日誌
      return {
        timeline: current,
        diff: [],
        version: current.version,
        total_duration_sec: round3(totalDurationSec(current)),
        affected_clips: [],
      }
    }

    draft.session_id = sessionId
    draft.version = current.version + 1
    draft.updated_at = new Date().toISOString()

    await writeCurrent(sessionId, draft)
    await writeVersion(sessionId, draft)
    await appendLog(sessionId, {
      at: draft.updated_at,
      action: ops.map((o) => o.type).join("+"),
      reason,
      affected_clips: [...affected],
      diff,
      version_id: draft.version,
      cost_delta: costDelta,
    })
    await pruneVersions(sessionId, draft.version)

    return {
      timeline: draft,
      diff,
      version: draft.version,
      total_duration_sec: round3(totalDurationSec(draft)),
      affected_clips: [...affected],
    }
  })
}

export interface VersionSummary {
  version: number
  updated_at: string
  clips: number
  total_duration_sec: number
}

export async function listVersions(sessionId: string): Promise<VersionSummary[]> {
  assertSessionId(sessionId)
  const dir = path.join(sessionDir(sessionId), "versions")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: VersionSummary[] = []
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/)
    if (!m) continue
    try {
      const tl = JSON.parse(await readFile(path.join(dir, name), "utf-8")) as Timeline
      out.push({
        version: Number(m[1]),
        updated_at: tl.updated_at,
        clips: tl.clips?.length ?? 0,
        total_duration_sec: round3(totalDurationSec(tl)),
      })
    } catch {
      /* 壞快照跳過，不炸列表 */
    }
  }
  out.sort((a, b) => a.version - b.version)
  return out
}

/** 欄位級 diff：版本 a → 版本 b（含被裁剪的版本 → TimelineNotFoundError） */
export async function diffVersions(sessionId: string, a: number, b: number): Promise<DiffEntry[]> {
  assertSessionId(sessionId)
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    throw new TimelineValidationError("a and b must be positive integers")
  }
  const [ta, tb] = await Promise.all([loadVersion(sessionId, a), loadVersion(sessionId, b)])
  return computeTimelineDiff(ta, tb)
}

/**
 * 還原到版本 v：內容回到 v 的快照，版本號單調遞增（新版本 = current+1），
 * restore 本身寫日誌（action="restore"）。
 */
export async function restoreVersion(sessionId: string, v: number): Promise<ApplyOpsResult> {
  assertSessionId(sessionId)
  if (!Number.isInteger(v) || v < 1) throw new TimelineValidationError("version must be a positive integer")
  return withSessionLock(sessionId, async () => {
    const current = (await loadCurrent(sessionId)) ?? emptyTimeline(sessionId)
    const target = await loadVersion(sessionId, v)
    const restored = clone(target)
    restored.version = current.version + 1
    restored.updated_at = new Date().toISOString()
    const diff = computeTimelineDiff(current, restored)
    await writeCurrent(sessionId, restored)
    await writeVersion(sessionId, restored)
    await appendLog(sessionId, {
      at: restored.updated_at,
      action: "restore",
      reason: `restore to v${v}`,
      affected_clips: [...new Set(diff.map((d) => d.clip_id))],
      diff,
      version_id: restored.version,
      cost_delta: round3(sumCost(restored) - sumCost(current)),
    })
    await pruneVersions(sessionId, restored.version)
    return {
      timeline: restored,
      diff,
      version: restored.version,
      total_duration_sec: round3(totalDurationSec(restored)),
      affected_clips: [...new Set(diff.map((d) => d.clip_id))],
    }
  })
}

export async function getLog(sessionId: string): Promise<LogEntry[]> {
  assertSessionId(sessionId)
  let raw: string
  try {
    raw = await readFile(logPath(sessionId), "utf-8")
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return []
    throw e
  }
  const out: LogEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LogEntry)
    } catch {
      /* 壞行跳過 */
    }
  }
  return out
}
