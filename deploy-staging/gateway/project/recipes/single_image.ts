// 配方 single_image —— 由旧模板 deploy-staging/gateway/workflow-templates/single_image.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6。旧 role：prompt(text) / generation(config) / result(image)。
// 单图退化形态：1 个 keyframe + 1 个 export（qc 按图片族必含补齐），旧 text 作 script，旧 config 并入 params/defaults。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

const DEFAULT_PROMPT = "一张成品单图：主体居中、背景干净，柔和棚拍光，材质纹理清晰，构图完整不裁切。负向尾缀：no fake text, no extra objects, no label distortion"

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "单图交付：主体/风格/构图三要素显式写全（模型只认显式描述），画面无伪造文字与多余主体",
}

export const singleImageRecipe: Recipe = {
  id: "single_image",
  title: "单张图片",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const nodes: NewNode[] = [
      {
        id: "prompt", type: "script",
        intent: "旧 role prompt：生图提示词本体。主体/风格/构图一次写全，缺什么就写什么。",
        params: { text: str(p.prompt, DEFAULT_PROMPT) },
      },
      {
        id: "keyframe", type: "keyframe",
        intent: "旧 role result 的成品图在此生成；旧 config generation 的 model/size/count 并入本节点 params 与工程 defaults。跑偏先改提示词再重出，不改参数掩过。",
        params: materializeDefaults("keyframe", "keyframe", { title: "单图", prompt: "${prompt}", role: "single_image" }, defaults),
      },
      {
        id: "qc", type: "qc",
        intent: "旧 notes 的核对门禁：主体/风格/构图三要素是否命中，不命中先改提示词重出。评审结论随产物重算。",
        params: { mode: "critic", rubric: "image_default", thresholds: { mustHit: ["主体", "风格", "构图"], noFakeText: true } },
        inputs: { image: { from: "keyframe" } },
      },
      {
        id: "export", type: "export",
        intent: "旧 role result 的交付出口：成品图 + 实际花费由账本给出，按图片包导出。",
        params: { preset: "image_pack" },
        inputs: { images: { from: "keyframe" }, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: 1, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    prompt: "prompt",
    generation: { intentOf: "keyframe" }, // config 不成节点：model/size/count 已并入 keyframe.params 与 defaults
    result: "keyframe",
  },
}
