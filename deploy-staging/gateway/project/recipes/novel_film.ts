// S11a 配方（电影族）：novel_film 小说成片。映射原则见设计文档 §6；旧模板 workflow-templates/novel_film.ts 只读。
// 旧 role 清单由测试从旧模板文件现算（不手抄）：novel / script / character / char_gen / char_card / art_brief /
//   art_gen / art_card / storyboard / previz / keyframe_gen / keyframe / video_gen / shot_video / voiceover / final_cut。
// 骨架：novel → script → cast → style_anchor + 具名角色/场景图 → shots → sketch#shot → keyframe#shot
//   → clip#shot → voice#shot → music → timeline → subtitle → mix → qc → qc_look → export
//
// notes / 3D 预演（unsupported）：旧 previz 要白模 blocking、机位路径、动作模板，首/中/尾帧作视频参考，不是成片；
// .blend 缺失要写明，预演帧不得伪造。project/executors/index.ts 未注册 render3d。不造会跑的假节点，也不静默删掉这段。
// 逐镜参考接到具名角色节点和场景节点。校验在扇出之前，char_sheet#行 还不能当输入。
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
    camera: `镜头 ${i + 1}：景别/机位/运镜`,
    line: `镜头 ${i + 1}：台词（待写）`,
    seconds,
  }))
const defaultCast = (): Json[] => [
  { id: "char_a", kind: "character", look: "角色 A：DNA 八维固定短语 + 三视图（正/全身/侧）同 seed" },
  { id: "scene_1", kind: "scene", look: "场景 1：色板/光照/材质规范，固定后缀等价 sref 风格锁" },
]
const NODE_RE = /^[a-z][a-z0-9_]{0,47}$/
interface CastPlan { nodeId: NodeId; rowId: string; kind: "character" | "scene"; look: string }
function planCast(rows: Json[]): CastPlan[] {
  const used = new Set<string>(["char_sheet", "scene_1", "style_anchor", "sketch", "hook_frame", "novel", "script", "cast", "shots", "keyframe", "clip", "voice", "music", "timeline", "subtitle", "mix", "qc", "qc_look", "export"])
  const out: CastPlan[] = []
  let charSlot = true
  let sceneSlot = true
  let extra = 0
  for (const raw of rows) {
    const row = raw as { id?: unknown; kind?: unknown; look?: unknown }
    const rowId = typeof row.id === "string" && row.id ? row.id : `row_${out.length + 1}`
    const kind: "character" | "scene" = row.kind === "scene" || rowId.startsWith("scene") ? "scene" : "character"
    let nodeId: string
    if (kind === "character" && charSlot) { nodeId = "char_sheet"; charSlot = false }
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

export const novelFilmRecipe: Recipe = {
  id: "novel_film",
  title: "小说成片",
  build(p: Record<string, Json>) {
    const aspect = aspectOf(p, "16:9")
    const castRows = rowsOf(p, "cast", defaultCast())
    const plan = planCast(castRows)
    const rows = bindShots(rowsOf(p, "shots", defaultShots(num(p, "shotCount", 1, 60) ?? 3, 15)), plan)
    const charFrom = uniformNode(rows, plan, "character")
    const sceneFrom = uniformNode(rows, plan, "scene")
    const sceneLook = plan.find((c) => c.kind === "scene")?.look ?? "色板、光照、材质固定后缀"
    // 逐镜参考图合计 ≤5（角色图 + 场景 + 风格锚 + 线稿）。角色图默认 1 张，castCount 最多再加到 2。
    const views = Math.min(num(p, "castCount", 1, 4) ?? 1, 2)
    const imageModel = str(p, "imageModel")
    const videoModel = str(p, "videoModel")
    const voiceName = str(p, "voice")
    const style = str(p, "style")
    const imageSize = str(p, "imageSize") ?? IMAGE_BY_ASPECT[aspect] ?? "1024x1024"
    const preset = str(p, "preset") ?? PRESET_BY_ASPECT[aspect] ?? "landscape_169"
    const resolution = str(p, "resolution") ?? "720p"
    const lang = str(p, "lang") ?? "zh-CN"
    const durationSec = num(p, "durationSec", 1, 4 * 3600)
    const seconds: Json = num(p, "seconds", 5, 60) ?? "${row.seconds}"
    const musicPrompt = str(p, "musicPrompt") ?? "cinematic orchestral score, 90 BPM, D minor, tension and release"

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

    const sheetInputs = { style: { from: "style_anchor" as NodeId } }
    const shotRefs = {
      ...(charFrom ? { char_ref: { from: charFrom } } : {}),
      ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
      style: { from: "style_anchor" as NodeId },
      sketch: { from: "sketch" as NodeId },
    }
    const clipRefs = {
      first: { from: "keyframe" as NodeId },
      ...(charFrom ? { char_ref: { from: charFrom } } : {}),
      ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
      style: { from: "style_anchor" as NodeId },
    }
    const hookRefs = {
      ...(charFrom ? { char_ref: { from: charFrom } } : {}),
      ...(sceneFrom ? { scene_ref: { from: sceneFrom } } : {}),
      style: { from: "style_anchor" as NodeId },
    }
    const imageOf = (id: NodeId, intent: string, prompt: string, n: number, extra: Partial<Pick<NewNode, "inputs" | "takes">> = {}, role = "reference"): NewNode =>
      N(id, "keyframe", intent, {
        prompt,
        role,
        size: imageSize,
        n,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, extra)
    const hook = rows[0] as { action?: string; camera?: string } | undefined
    const nodes: NewNode[] = [
      N("novel", "script", "小说原文：全链首个资产，作为结构化剧本的输入（不改写用户原文）", {
        text: str(p, "novel") ?? str(p, "script") ?? "（待写：小说原文/题材/主角设定/章节文本）",
      }),
      N("script", "script", "结构化剧本：场次表/节拍/台词（4.5 字/秒仅初值，配音后以 ffprobe 为准）+ 钩子位；用户批准后才进视觉", {
        text: str(p, "script") ?? "（待写：场次表 / 节拍 / 台词 / 钩子位 / 情绪曲线）",
      }, { inputs: { novel: { from: "novel" } } }),
      N("cast", "shotlist", "角色与美术行：DNA 八维固定短语 + 场景色板/光照/材质（art_brief 落在这里）", { kind: "views", rows: castRows }, {
        inputs: { script: { from: "script" } },
      }),
      imageOf("style_anchor", "风格锚：色板、光照、材质做成一张参考图，角色、场景和逐镜都接这张图。", `风格锚（sref）：${style ? style + "。" : ""}${sceneLook}`, 1),
      ...plan.map((c) => imageOf(
        c.nodeId,
        c.kind === "character" ? "角色卡：三视图接风格锚，不跟场景图混成一张。" : "美术卡：场景设定图接风格锚，供逐镜单独引用。",
        c.look,
        c.kind === "character" ? views : 1,
        { inputs: sheetInputs },
      )),
      N("shots", "shotlist", "分镜表：每行一镜；action 含 state_change/beats，camera 写景别/机位/运镜，seconds 为时长", { kind: "shots", rows }, {
        inputs: { script: { from: "script" } },
      }),
      N("sketch", "keyframe", "sketch-lock：黑白线稿先锁构图，逐镜关键帧接本镜线稿，不先渲彩色。", {
        prompt: "黑白线稿，只锁构图。镜头 ${row.action}，${row.camera}",
        role: "reference",
        size: imageSize,
        n: 1,
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" } }),
      N("keyframe", "keyframe", "逐镜关键帧：只接本镜角色、场景、风格锚和线稿。render3d 未注册，3D 预演 unsupported。", {
        prompt: "镜头 ${row.action}，${row.camera}",
        role: "keyframe",
        size: imageSize,
        n: 1,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: shotRefs }),
      imageOf("hook_frame", "钩子位候选：出 3 张，按 film_frame_critic 择优。成片前 3 秒的第一钩。", `钩子位候选。${hook?.action ?? ""}，${hook?.camera ?? ""}`, 1, {
        inputs: hookRefs,
        takes: { n: 3, select: "qc", rubric: "film_frame_critic" },
      }, "keyframe"),
      N("clip", "clip", "逐镜视频：动作镜头优先 T2V 或关键帧参考；情绪时序链写进提醒，motion 证据验静态", {
        prompt: "${row.action}，${row.camera}",
        size: aspect,
        seconds,
        resolution,
        generateAudio: false,
        ...(style ? { styleLock: style } : {}),
        ...(videoModel ? { model: videoModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: clipRefs }),
      N("voice", "voice", "配音：逐镜台词音轨，时长以 ffprobe 实测为准；speed 不生效，不改写台词硬拉", { text: "${row.line}" }, {
        forEach: { over: "shots", as: "shot" },
      }),
      N("music", "music", "BGM：按情绪曲线分段，转折点对齐钩子位；人声优先 ducking", { prompt: musicPrompt, durationHint: "full" }, {
        inputs: { script: { from: "script" } },
      }),
      N("timeline", "timeline", "时间线：镜头顺序 + J/L-cut 标记；音频先行，视频时长向音轨对齐", { aspect, fps: 30 }, {
        inputs: { clips: { from: "clip" }, voice: { from: "voice" }, music: { from: "music" } },
      }),
      N("subtitle", "subtitle", "字幕轨：SRT 按台词时间码逐字对齐", { burnIn: p.burnIn === true, lang }, {
        inputs: { shots: { from: "shots" }, timeline: { from: "timeline" } },
      }),
      N("mix", "mix", "混音三层：人声/BGM/音效独立轨道，响度对齐 -14 LUFS", { levels: { voice: 0, music: -18 }, ducking: true, targetLufs: -14 }, {
        inputs: { voice: { from: "voice" }, music: { from: "music" }, timeline: { from: "timeline" } },
      }),
      N("qc", "qc", "机器质检：帧级查形变闪帧/口型漂移，响度/黑帧/冻结帧过阈值，时长偏差 ±10%", {
        mode: "machine",
        rubric: "film_default",
        thresholds: { durationTolerance: 0.1, targetLufs: -14, requireAudio: true },
      }, { inputs: { final: { from: "clip" } }, onFail: { action: "regenerate", max: 2 } }),
      N("qc_look", "qc", "抽帧按 film_frame_critic 逐项判定（含风格统一≥70、逐镜一致、storyboard_qc_17）；不过关不导出。", {
        mode: "critic",
        rubric: "film_frame_critic",
      }, { inputs: { image: { from: "keyframe" } }, onFail: { action: "regenerate", max: 2 } }),
      N("export", "export", "唯一交付出口：成片 MP4（拼接+混音+字幕）+ 封面帧 + 逐镜溯源表", { preset }, {
        inputs: { clips: { from: "clip" }, timeline: { from: "timeline" }, audio: { from: "mix" }, subtitle: { from: "subtitle", port: "srt" }, machine: { from: "qc" }, verdict: { from: "qc_look" } },
      }),
    ]

    return {
      nodes: withReviewedCandidate(nodes),
      targets: { aspect, shots: rows.length, subtitles: true, audio: "both" as const, ...(durationSec !== undefined ? { durationSec } : {}) },
      defaults,
    }
  },
  legacyRoleMap: {
    novel: "novel",
    script: "script",
    character: "cast",
    char_gen: { intentOf: "char_sheet" },
    char_card: "char_sheet",
    art_brief: "cast",
    art_gen: { intentOf: "scene_1" },
    art_card: "scene_1",
    storyboard: "shots",
    previz: { intentOf: "keyframe" },
    keyframe_gen: { intentOf: "keyframe" },
    keyframe: "keyframe",
    video_gen: { intentOf: "clip" },
    shot_video: "clip",
    voiceover: "voice",
    final_cut: "export",
  },
}
import { withReviewedCandidate } from "./final-candidate.ts"
