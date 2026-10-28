// S11a 配方（电影族）：single_video 单支影片。映射原则见设计文档 §6；旧模板 workflow-templates/single_video.ts 只读。
// 旧 role 清单由测试从旧模板文件现算（不手抄）：shot / reference / previz / generation / result。
// 骨架：script → shotlist(shots) → keyframe#shot → clip#shot → voice#shot → music → timeline → subtitle → mix → export → qc
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
/** 调用方传 shots 行表就用它（坏形状回退默认，避免 build 抛出）；行里的 id/字段由 specs 的行校验与 expand 再验。 */
const rowsOf = (p: Record<string, Json>, fallback: Json[]): Json[] => {
  const v = p.shots
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

export const singleVideoRecipe: Recipe = {
  id: "single_video",
  title: "单支影片",
  build(p: Record<string, Json>) {
    const aspect = aspectOf(p, "16:9")
    const rows = rowsOf(p, defaultShots(num(p, "shotCount", 1, 60) ?? 1, 15))
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
      N("script", "script", "镜头脚本：状态变化 + 动作 beat 时间线，含景别/机位/运镜/时长；开拍前用户确认", {
        text: str(p, "script") ?? "（待写：state_change.from → beats[].at_seconds/action → state_change.to）",
      }),
      N("shots", "shotlist", "镜头表：每行一镜；action 写物理动作与环境变化，camera 写景别/机位/运镜，seconds 平台下限 5 秒", { kind: "shots", rows }, {
        inputs: { script: { from: "script" } },
      }),
      N("keyframe", "keyframe", "本镜关键帧/参考图；3D 预演首中尾帧可作参考条件，预演帧不是成片", {
        prompt: "镜头 ${row.action}，${row.camera}",
        role: "keyframe",
        size: imageSize,
        n: 1,
        ...(style ? { styleLock: style } : {}),
        ...(imageModel ? { model: imageModel } : {}),
      }, { forEach: { over: "shots", as: "shot" } }),
      N("clip", "clip", "本镜视频：动作镜头优先 T2V 或用预演关键帧作参考；抽帧与 motion 证据验形变/静态", {
        prompt: "${row.action}，${row.camera}",
        size: aspect,
        seconds,
        resolution,
        generateAudio: false,
        ...(style ? { styleLock: style } : {}),
        ...(videoModel ? { model: videoModel } : {}),
      }, { forEach: { over: "shots", as: "shot" }, inputs: { first: { from: "keyframe" } } }),
      N("voice", "voice", "逐镜配音；时长以 ffprobe 实测为准，不把 4.5 字/秒折算当终值", { text: "${row.line}" }, {
        forEach: { over: "shots", as: "shot" },
      }),
      N("music", "music", "BGM：按情绪曲线分段，人声优先 ducking；不使用在版歌曲旋律", { prompt: musicPrompt, durationHint: "full" }),
      N("timeline", "timeline", "时间线：镜头顺序来自镜头表，不靠 id 字符串；J/L-cut 标记在此执行", { aspect, fps: 30 }, {
        inputs: { clips: { from: "clip" }, voice: { from: "voice" }, music: { from: "music" } },
      }),
      N("subtitle", "subtitle", "字幕轨：按台词与时间轴生成 SRT/ASS", { burnIn: p.burnIn === true, lang }, {
        inputs: { shots: { from: "shots" }, timeline: { from: "timeline" } },
      }),
      N("mix", "mix", "混音：人声/BGM/音效独立轨道，响度对齐 -14 LUFS", { levels: { voice: 0, music: -18 }, ducking: true, targetLufs: -14 }, {
        inputs: { voice: { from: "voice" }, music: { from: "music" }, timeline: { from: "timeline" } },
      }),
      N("export", "export", "唯一交付出口：成片 MP4（拼接+混音+字幕），交付前重检解码/时长/音轨", { preset }, {
        inputs: { clips: { from: "clip" }, timeline: { from: "timeline" }, audio: { from: "mix" }, subtitle: { from: "subtitle", port: "srt" } },
      }),
      N("qc", "qc", "机器质检：首中尾抽帧查形变闪帧，响度/黑帧/冻结帧过阈值，时长偏差 ±10%", {
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
  // 旧 role 去向：说明性 text 并入 intent，config 参数进下游 params/defaults。
  legacyRoleMap: {
    shot: "script",
    reference: "keyframe",
    previz: { intentOf: "keyframe" },
    generation: { intentOf: "clip" },
    result: "clip",
  },
}
