// S11a 配方（电影族）：shortdrama_visual 剧本视觉化（9:16 竖屏）。映射原则见设计文档 §6；旧模板
// workflow-templates/shortdrama_visual.ts 只读。旧 role 清单由测试从旧模板文件现算（不手抄）：
//   script / cast / cast_gen / cast_card / storyboard / previz / keyframe_gen / keyframe / voiceover /
//   video_gen / shot_video / final_cut / promo_gen / promo。
// 骨架：script → cast → 具名三视图/场景图 → shots → sketch#shot → keyframe#shot → clip#shot
//   → voice#shot → music → timeline → subtitle → mix → qc → qc_look → promo_pack / export
//
// notes / 3D 预演（unsupported）：旧 previz 是白模方案（构图/运镜/走位），导演台原语未到，render3d 也未注册。
// 不造会跑的假节点，也不把这段删掉。人物三视图是 cast_sheet 这张图上的参考边，不是等人点头的文字卡。
import { ASPECTS, NODE_SPECS, materializeDefaults } from "../specs"
import type { Json, NodeId, NewNode, NodeType, ProjectDefaults, Recipe } from "../types"

const PRESET_BY_ASPECT: Record<string, string> = { "16:9": "landscape_169", "9:16": "portrait_916", "21:9": "cinema_239" }
const IMAGE_BY_ASPECT: Record<string, string> = { "16:9": "1536x1024", "9:16": "1024x1792", "1:1": "1024x1024", "4:3": "1365x1024", "3:4": "1024x1365", "21:9": "1536x658" }

const str = (p: Record<string, Json>, k: string): string | undefined => (typeof p[k] === "string" && (p[k] as string).trim() !== "" ? (p[k] as string) : undefined)
const num = (p: Record<string, Json>, k: string, lo: number, hi: number): number | undefined => {
  const v = p[k]
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined
}
const aspectOf = (p: Record<string, Json>, fallback: string): string => {
  const a = str(p, "aspect")
  return a !== undefined && (ASPECTS as readonly string[]).includes(a) ? a : fallback
}
const rowsOf = (p: Record<string, Json>, k: string, fallback: Json[]): Json[] => {
  const v = p[k]
  if (Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r) && typeof (r as { id?: unknown }).id === "string")) return v
  return fallback
}
const defaultShots = (count: number, seconds: number): Json[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    action: `镜头 ${i + 1}：主体动作与可见状态变化`,
    camera: `镜头 ${i + 1}：景别/机位（正打/反打/过肩）`,
    line: `镜头 ${i + 1}：台词（待写）`,
    seconds,
  }))
const defaultCast = (): Json[] => [
  { id: "char_a", kind: "character", look: "主演 A：三视图 + DNA 八维固定短语 + 情绪九宫格 + 道具状态变体" },
  { id: "scene_1", kind: "scene", look: "场景 1：固定机位参照物 + 尺度参照（门高/桌高），无人无手白底" },
]
const NODE_RE = /^[a-z][a-z0-9_]{0,47}$/
interface CastPlan { nodeId: NodeId; rowId: string; kind: "character" | "scene"; look: string }
function planCast(rows: Json[]): CastPlan[] {
  const used = new Set<string>(["cast_sheet", "scene_1", "sketch", "script", "cast", "shots", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "promo", "qc", "qc_look", "promo_pack", "export"])
  const out: CastPlan[] = []
  let charSlot = true
  let sceneSlot = true
  let extra = 0
  for (const raw of rows) {
    const row = raw as { id?: unknown; kind?: unknown; look?: unknown }
    const rowId = typeof row.id === "string" && row.id ? row.id : `row_${out.length + 1}`
    const kind: "character" | "scene" = row.kind === "scene" || rowId.startsWith("scene") ? "scene" : "character"
    let nodeId: string
    if (kind === "character" && charSlot) { nodeId = "cast_sheet"; charSlot = false }
    else if (kind === "scene" && sceneSlot) { nodeId = "scene_1"; sceneSlot = false }
    else {
      extra += 1
      const want = typeof row.id === "string" && NODE_RE.test(row.id) ? row.id : `${kind}_${extra}`
      nodeId = want
      while (used.has(nodeId) || !NODE_RE.test(nodeId)) nodeId = `${kind}_${++extra}`
    }
    used.add(nodeId)
    const look = typeof row.look === "string" && row.look.trim() ? row.look : kind === "scene" ? "场景设定" : "角色设定"
    out.push({ nodeId, rowId, kind, look })
  }
  return out
}
function bindShots(rows: Json[], plan: CastPlan[]): Json[] {
  const char0 = plan.find((p) => p.kind === "character")
  const scene0 = plan.find((p) => p.kind === "scene")
  return rows.map((raw) => {
    const row = raw as Record<string, Json>
    const char = typeof row.char === "string" && row.char ? row.char : char0?.rowId
    const scene = typeof row.scene === "string" && row.scene ? row.scene : scene0?.rowId
    return { ...row, ...(char ? { char } : {}), ...(scene ? { scene } : {}) }
  })
}
function uniformNode(rows: Json[], plan: CastPlan[], kind: "character" | "scene"): NodeId | null {
  const key = kind === "character" ? "char" : "scene"
  const ids = new Set<string>()
  for (const raw of rows) {
    const rowId = (raw as Record<string, Json>)[key]
    if (typeof rowId !== "string") return null
    const hit = plan.find((p) => p.kind === kind && p.rowId === rowId)
    if (!hit) return null
    ids.add(hit.nodeId)
  }
  return ids.size === 1 ? [...ids][0] : null
}

export const shortdramaVisualRecipe: Recipe = {
  id: "shortdrama_visual",
  title: "剧本视觉化",
  build(p: Record<string, Json>) {
    const aspect = aspectOf(p, "9:16")
    const castRows = rowsOf(p, "cast", defaultCast())
    const plan = planCast(castRows)
    const rows = bindShots(rowsOf(p, "shots", defaultShots(num(p, "shotCount", 1, 60) ?? 3, 5)), plan)
    const charFrom = uniformNode(rows, plan, "character")
    const sceneFrom = uniformNode(rows, plan, "scene")
    const views = num(p, "castCount", 1, 4) ?? 3
    const imageModel = str(p, "imageModel")
    const videoModel = str(p, "videoModel")
    const voiceName = str(p, "voice")
    const style = str(p, "style")
    const imageSize = str(p, "imageSize") ?? IMAGE_BY_ASPECT[aspect] ?? "1024x1792"
    const preset = str(p, "preset") ?? PRESET_BY_ASPECT[aspect] ?? "portrait_916"
    const resolution = str(p, "resolution") ?? "720p"
    const lang = str(p, "lang") ?? "zh-CN"
    const durationSec = num(p, "durationSec", 1, 4 * 3600)
    const seconds: Json = num(p, "seconds", 5, 60) ?? "${row.seconds}"
    const musicPrompt = str(p, "musicPrompt") ?? "cinematic orchestral score, 90 BPM, D minor, tension and release"
    const promoSize = str(p, "promoSize") ?? "1024x1792"
    const promoPrompt = str(p, "promoPrompt") ?? "竖屏封面：钩子位人物冲突特写，标题位预留上 1/3，人物脸部与冲突元素必现"

    const defaults: ProjectDefaults = {}
    if (imageModel) defaults.imageModel = imageModel
    if (videoModel) defaults.videoModel = videoModel
    if (voiceName) defaults.voice = voiceName
    if (str(p, "imageSize")) defaults.imageSize = imageSize
    if (style) defaults.style = style

    const params = (type: NodeType, id: NodeId, raw: Record<string, Json>, fanout = false): Record<string, Json> => {
      const out = materializeDefaults(type, id, raw, defaults)
      // 扇出模板不落 seed：实例按自身 id 取 seed，否则整批镜头同 seed
      if (fanout && NODE_SPECS[type].seeded && raw.seed === undefined) delete out.seed
      return out
    }
    const N = (
      id: NodeId, type: NodeType, intent: string, raw: Record<string, Json>,
      extra: Partial<Pick<NewNode, "inputs" | "refs" | "forEach" | "takes" | "onFail">> = {},
    ): NewNode => ({ id, type, intent, params: params(type, id, raw, extra.forEach !== undefined), ...extra })

    const nodes: NewNode[] = [
      N("script", "script", "结构化场次表 + 台词本：前 3 拍抛钩子，台词按角色聚合带音色；用户逐场确认后才生人物图", {
        text: str(p, "script") ?? "（待写：场次表（场景/人物/道具/服装/情绪拍点/钩子位）+ 按角色聚合的台词本）",
      }),
      N("cast", "shotlist", "主演与场景锚点行：DNA 八维 + 音色 + 场景尺度参照；三视图和场景图分开出", { kind: "views", rows: castRows }, {
        inputs: { script: { from: "script" } },
      }),
      ...plan.map((c) => N(c.nodeId, "keyframe", c.kind === "character"
        ? "主演三视图：正/侧/背 + 情绪九宫格，作为逐镜参考边，不做成等人点头的空卡。"
        : "场景锚点：固定机位与尺度参照，无人无手，供逐镜单独引用。", {
        prompt: c.look,
        role: "reference",
        size: imageSize,
        n: c.kind === "character" ? views : 1,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      })),
      N("shots", "shotlist", "分镜表：每行一镜；9:16 原生构图，段 ≤15 秒、镜 2-5 秒（平台生成下限取 5 秒），正反打成对", {
        kind: "shots",
        rows,
      }, { inputs: { script: { from: "script" } } }),
      N("sketch", "keyframe", "sketch-lock：黑白线稿先锁构图，逐镜关键帧接本镜线稿。", {
        prompt: "黑白线稿，只锁构图。镜头 ${row.action}，${row.camera}",
        role: "reference",
        size: imageSize,
        n: 1,
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" } }),
      N("keyframe", "keyframe", "逐镜关键帧：接本镜三视图和场景图。render3d 未注册，3D 预演 unsupported。", {
        prompt: "镜头 ${row.action}，${row.camera}",
        role: "keyframe",
        size: imageSize,
        n: 1,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: {
        ...(charFrom ? { char_ref: { from: charFrom } } : {}),
        ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
        sketch: { from: "sketch" },
      } }),
      N("clip", "clip", "逐镜竖屏视频：9:16 原生模型优先，不横屏出图再裁；一镜一动词，首尾帧链保持连续", {
        prompt: "${row.action}，${row.camera}",
        size: aspect,
        seconds,
        resolution,
        generateAudio: false,
        ...(style ? { styleLock: style } : {}),
        ...(videoModel ? { model: videoModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: {
        first: { from: "keyframe" },
        ...(charFrom ? { char_ref: { from: charFrom } } : {}),
        ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
      } }),
      N("voice", "voice", "配音：台词间留白是戏不压缩；时长以实测为准，speed 不生效不改写台词硬拉", { text: "${row.line}" }, {
        forEach: { over: "shots", as: "shot" },
      }),
      N("music", "music", "BGM：按情绪段标记进场/退场，转折点对齐钩子位；人声优先 ducking", { prompt: musicPrompt, durationHint: "full" }, {
        inputs: { script: { from: "script" } },
      }),
      N("timeline", "timeline", "时间线：J-cut/L-cut 情绪剪辑；每集时长回归剧本折算目标 ±10%，先剪空镜不剪台词", { aspect, fps: 30 }, {
        inputs: { clips: { from: "clip" }, voice: { from: "voice" }, music: { from: "music" } },
      }),
      N("subtitle", "subtitle", "字幕轨：逐字对齐 TTS 时间戳；竖屏烧入，底部安全区最多两行", { burnIn: p.burnIn !== undefined ? p.burnIn === true : true, lang }, {
        inputs: { shots: { from: "shots" }, timeline: { from: "timeline" } },
      }),
      N("mix", "mix", "混音三层：人声/BGM/音效独立，响度对齐 -14 LUFS", { levels: { voice: 0, music: -18 }, ducking: true, targetLufs: -14 }, {
        inputs: { voice: { from: "voice" }, music: { from: "music" }, timeline: { from: "timeline" } },
      }),
      N("promo", "keyframe", "投放物料：竖屏封面 3 张（钩子位/CP 剧照/反转位），标题位预留上 1/3", {
        prompt: promoPrompt,
        role: "poster",
        size: promoSize,
        n: num(p, "promoCount", 1, 4) ?? 3,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { inputs: {
        ...(charFrom ? { char_ref: { from: charFrom } } : {}),
        ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
      } }),
      N("qc", "qc", "机器质检：帧级查形变闪帧/角色漂移，响度/黑帧/冻结帧过阈值，时长偏差 ±10%，单段不超过 15 秒", {
        mode: "machine",
        rubric: "film_default",
        thresholds: { durationTolerance: 0.1, targetLufs: -14, requireAudio: true, maxDurationSec: 15 },
      }, { inputs: { final: { from: "clip" } }, onFail: { action: "regenerate", max: 2 } }),
      N("qc_look", "qc", "抽帧按 film_frame_critic：段≤15s、正反打成对、轴线连续、切点与台词；不过关不导出。", {
        mode: "critic",
        rubric: "film_frame_critic",
      }, { inputs: { image: { from: "keyframe" } }, onFail: { action: "regenerate", max: 2 } }),
      N("promo_pack", "export", "投放物料交付包（image_pack）：封面 3 张 + 预告切片封面；与成片分开出口", { preset: "image_pack" }, {
        inputs: { images: { from: "promo" }, verdict: { from: "qc_look" } },
      }),
      N("export", "export", "唯一成片出口：9:16 成片 MP4（拼接+混音+字幕）+ 可继续编辑的剪辑工程声明", { preset }, {
        inputs: { clips: { from: "clip" }, timeline: { from: "timeline" }, audio: { from: "mix" }, subtitle: { from: "subtitle", port: "srt" }, machine: { from: "qc" }, verdict: { from: "qc_look" } },
      }),
    ]

    return {
      nodes,
      targets: { aspect, shots: rows.length, subtitles: true, audio: "both" as const, ...(durationSec !== undefined ? { durationSec } : {}) },
      defaults,
    }
  },
  legacyRoleMap: {
    script: "script",
    cast: "cast",
    cast_gen: { intentOf: "cast_sheet" },
    cast_card: "cast_sheet",
    storyboard: "shots",
    previz: { intentOf: "shots" },
    keyframe_gen: { intentOf: "keyframe" },
    keyframe: "keyframe",
    voiceover: "voice",
    video_gen: { intentOf: "clip" },
    shot_video: "clip",
    final_cut: "export",
    promo_gen: { intentOf: "promo" },
    promo: "promo",
  },
}
