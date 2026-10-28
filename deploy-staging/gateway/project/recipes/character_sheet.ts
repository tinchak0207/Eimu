// 配方 character_sheet —— 由旧模板 deploy-staging/gateway/workflow-templates/character_sheet.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6（角色族：shotlist(views) + keyframe#view → qc → export）。
// 旧 role：character(text) / sheet(config) / view1..view4(image)。正面是面部基线，侧面/背面/动作引用它。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

type Row = { id: string; role: string; label: string; size: string; prompt: string; n?: number }
const asRow = (r: Row): { [k: string]: Json } => ({ id: r.id, role: r.role, label: r.label, size: r.size, prompt: r.prompt, n: r.n ?? 1 })

const DEFAULT_CHARACTER =
  "角色 DNA 签名（八维固定短语）：脸型 / 发型 / 瞳色 / 体型 / 服装 / 配饰 / 肤色 / 气质。每维一个固定短语，全片复用，禁止同义替换（换词=换脸）。"

const VIEWS: Row[] = [
  {
    id: "front", role: "character_front", label: "正面", size: "1024x1024",
    prompt: "正面全身设定图，平视机位，纯灰背景均匀柔光；锁面部基线 face_identity；画面无文字、无多余角色。",
  },
  {
    id: "side", role: "character_side", label: "侧面", size: "1024x1024",
    prompt: "90° 侧面设定图，平视机位，纯灰背景均匀柔光；锁轮廓与发型基线；画面无文字。",
  },
  {
    id: "back", role: "character_back", label: "背面", size: "1024x1024",
    prompt: "背面设定图，平视机位，纯灰背景均匀柔光；锁服装背部细节；画面无文字。",
  },
  {
    id: "action", role: "character_action", label: "动作", size: "1024x1024",
    prompt: "动作设定图：典型姿态全身入画（供视频生成运动参考），同一角色同一服装；画面无文字。",
  },
]

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "角色四视图：DNA 八维逐维固定短语，禁止同义替换；同一 seed 同批生成锁 face_identity",
}

export const characterSheetRecipe: Recipe = {
  id: "character_sheet",
  title: "角色设定",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const character = str(p.character ?? p.prompt, DEFAULT_CHARACTER)
    const nodes: NewNode[] = [
      {
        id: "character", type: "script",
        intent: "旧 role character：角色圣经（DNA 签名八维，每维一个固定短语）。后续所有图复用同一短语，换词=换脸。",
        params: { text: character },
      },
      {
        id: "views", type: "shotlist",
        intent: "旧 role view2..view4 的行表：侧面/背面/动作。正面 view_front 是面部基线，这三行引用它。",
        params: { kind: "views", rows: VIEWS.filter((r) => r.id !== "front").map(asRow) },
      },
      {
        id: "view_front", type: "keyframe",
        intent: "旧 role view1：正面设定图，锁定面部基线，侧面/背面/动作引用这张。",
        params: materializeDefaults("keyframe", "view_front", {
          title: "正面",
          prompt: "${character}\n本张视图：" + VIEWS[0].prompt,
          role: "character_front",
          size: "1024x1024",
          n: 1,
        }, defaults),
        inputs: { brief: { from: "character" }, catalog: { from: "views" } },
      },
      {
        id: "keyframe", type: "keyframe", forEach: { over: "views", as: "view" },
        intent: "旧 role view2-4：侧面/背面/动作，引用正面面部基线。旧 role sheet 的 4-view 配置并入 params 与 defaults。",
        params: materializeDefaults("keyframe", "keyframe", {
          title: "${row.label}",
          prompt: "${character}\n本张视图：${row.prompt}",
          role: "${row.role}",
          size: "${row.size}",
          n: "${row.n}",
        }, defaults),
        inputs: { face: { from: "view_front" } },
      },
      {
        id: "qc", type: "qc",
        intent: "旧 view1 的 gate：四视图逐维比对 DNA 签名，五官三锚点漂移即该张重出；用户逐角色确认后才可供后续镜头引用（换脸是最大返工源）。",
        params: {
          mode: "critic",
          rubric: "character_sheet",
          thresholds: { dnaDims: 8, identityAnchors: ["瞳距", "脸型轮廓", "发际线"], humanConfirm: true, noFakeText: true },
        },
        inputs: { image: { from: "keyframe" }, face: { from: "view_front" } },
        onFail: { action: "regenerate", max: 2 },
      },
      {
        id: "export", type: "export",
        intent: "旧 role view1 的交付：四视图参考图组（view2/3/4 为本卡参考图）按图片包导出，供后续分镜引用。",
        params: { preset: "image_pack" },
        inputs: { images: { from: "keyframe" }, face: { from: "view_front" }, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: VIEWS.length, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    character: "character",
    sheet: { intentOf: "keyframe" }, // config 不成节点：model/size/count=4 已并入 keyframe.params 与 defaults
    view1: "view_front",
    view2: "keyframe#side",
    view3: "keyframe#back",
    view4: "keyframe#action",
  },
}
