// S11a 配方（电影族）：novel_film 小说成片。映射原则见设计文档 §6；旧模板 workflow-templates/novel_film.ts 只读。
// 旧 role 清单由测试从旧模板文件现算（不手抄）：novel / script / character / char_gen / char_card / art_brief /
//   art_gen / art_card / storyboard / previz / keyframe_gen / keyframe / video_gen / shot_video / voiceover / final_cut。
// novel/art_brief/storyboard → script/shotlist。骨架：novel → script → cast#view(角色/场景) → shots → keyframe#shot
//   → clip#shot → voice#shot → music → timeline → subtitle → mix → export → qc
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

export const novelFilmRecipe: Recipe = {
  id: "novel_film",
  title: "小说成片",
  build(p: Record<string, Json>) {
    const aspect = aspectOf(p, "16:9")
    const rows = rowsOf(p, "shots", defaultShots(num(p, "shotCount", 1, 60) ?? 3, 15))
    const castRows = rowsOf(p, "cast", defaultCast())
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
      N("char_sheet", "keyframe", "角色卡/美术卡：三视图与场景设定图，同 seed 同批；与 DNA 签名逐维比对", {
        prompt: "${row.look}",
        role: "reference",
        size: imageSize,
        n: num(p, "castCount", 1, 4) ?? 3,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "cast", as: "view" } }),
      N("shots", "shotlist", "分镜表：每行一镜；action 含 state_change/beats，camera 写景别/机位/运镜，seconds 为时长", { kind: "shots", rows }, {
        inputs: { script: { from: "script" } },
      }),
      N("keyframe", "keyframe", "逐镜关键帧：角色三视图 + 场景锚点双锁；3D 预演首中尾帧可作参考条件", {
        prompt: "镜头 ${row.action}，${row.camera}",
        role: "keyframe",
        size: imageSize,
        n: 1,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: { cast_ref: { from: "char_sheet" } } }),
      N("clip", "clip", "逐镜视频：动作镜头优先 T2V 或预演关键帧参考；情绪时序链写进提醒，motion 证据验静态", {
        prompt: "${row.action}，${row.camera}",
        size: aspect,
        seconds,
        resolution,
        generateAudio: false,
        ...(style ? { styleLock: style } : {}),
        ...(videoModel ? { model: videoModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: { first: { from: "keyframe" }, cast_ref: { from: "char_sheet" } } }),
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
      N("export", "export", "唯一交付出口：成片 MP4（拼接+混音+字幕）+ 封面帧 + 逐镜溯源表", { preset }, {
        inputs: { clips: { from: "clip" }, timeline: { from: "timeline" }, audio: { from: "mix" }, subtitle: { from: "subtitle", port: "srt" } },
      }),
      N("qc", "qc", "机器质检：帧级查形变闪帧/口型漂移，响度/黑帧/冻结帧过阈值，时长偏差 ±10%", {
        mode: "machine",
        rubric: "film_default",
        thresholds: { durationTolerance: 0.1, targetLufs: -14, requireAudio: true },
      }, { inputs: { final: { from: "export" } } }),
    ]

    return {
      nodes,
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
    art_gen: { intentOf: "char_sheet" },
    art_card: "char_sheet",
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
