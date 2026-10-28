// D1 语料，D3 才接入 research
// 本文件只提供卡类型和单行解析。生产 research / guidance / critic 本片不接。

export const LINE_IDS = [
  "single_image",
  "character_sheet",
  "scene_setup",
  "single_video",
  "feature_film",
  "novel_film",
  "novel_ip",
  "ecom_launch",
  "ecom_model",
  "shortdrama_visual",
  "shortdrama_poster",
  "art_curation",
  "art_style",
] as const

export const SCALES = ["远景", "全景", "中景", "近景", "特写"] as const
export const CAMERA_MOVES = ["固定", "推", "拉", "摇", "移", "跟", "升降", "手持"] as const

export type LineId = (typeof LINE_IDS)[number]
export type Scale = (typeof SCALES)[number]
export type CameraMove = (typeof CAMERA_MOVES)[number]

export type TasteCard = {
  lineId: LineId
  workTitle: string
  sourceUrl: string
  timecode: string
  shotSec: number | null
  scale: Scale
  subjectPosition: string
  headroom: string
  cameraMove: CameraMove
  transition: string
  transitionAt: string
  subtitleSize: string
  subtitlePlace: string
  subtitleInOut: string
  paletteHex: string[]
  beat: string
  note: string
}

const LINE_ID_SET = new Set<string>(LINE_IDS)
const SCALE_SET = new Set<string>(SCALES)
const CAMERA_SET = new Set<string>(CAMERA_MOVES)
const HEX = /^#[0-9A-Fa-f]{6}$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const needStr = (o: Record<string, unknown>, key: string): string => {
  const v = o[key]
  if (typeof v !== "string") throw new Error(`缺 ${key}`)
  return v
}

export function parseCardLine(line: string): TasteCard {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    throw new Error("卡行不是 JSON")
  }
  if (!isObj(raw)) throw new Error("卡行不是对象")

  const sourceUrl = raw.sourceUrl
  const timecode = raw.timecode
  if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") throw new Error("缺 sourceUrl")
  if (typeof timecode !== "string" || timecode.trim() === "") throw new Error("缺 timecode")

  const lineId = raw.lineId
  if (typeof lineId !== "string" || !LINE_ID_SET.has(lineId)) throw new Error("非法 lineId")

  const scale = needStr(raw, "scale")
  if (!SCALE_SET.has(scale)) throw new Error("非法景别")
  const cameraMove = needStr(raw, "cameraMove")
  if (!CAMERA_SET.has(cameraMove)) throw new Error("非法运镜")

  let shotSec: number | null
  if (raw.shotSec === null) shotSec = null
  else if (typeof raw.shotSec === "number" && Number.isFinite(raw.shotSec) && raw.shotSec >= 0) shotSec = raw.shotSec
  else throw new Error("非法 shotSec")

  if (!Array.isArray(raw.paletteHex) || raw.paletteHex.some((x) => typeof x !== "string" || !HEX.test(x))) {
    throw new Error("非法 paletteHex")
  }

  return {
    lineId: lineId as LineId,
    workTitle: needStr(raw, "workTitle"),
    sourceUrl,
    timecode,
    shotSec,
    scale: scale as Scale,
    subjectPosition: needStr(raw, "subjectPosition"),
    headroom: needStr(raw, "headroom"),
    cameraMove: cameraMove as CameraMove,
    transition: needStr(raw, "transition"),
    transitionAt: needStr(raw, "transitionAt"),
    subtitleSize: needStr(raw, "subtitleSize"),
    subtitlePlace: needStr(raw, "subtitlePlace"),
    subtitleInOut: needStr(raw, "subtitleInOut"),
    paletteHex: raw.paletteHex as string[],
    beat: needStr(raw, "beat"),
    note: needStr(raw, "note"),
  }
}
