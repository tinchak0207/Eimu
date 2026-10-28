// 配方 scene_setup —— 由旧模板 deploy-staging/gateway/workflow-templates/scene_setup.ts（只读）改写。
// 映射原则：docs/architecture/project-graph.md §6。旧 role：scene(text) / generation(config) / result(image)。
// 单场景退化形态：1 个 keyframe + 1 个 export（qc 按图片族必含补齐）；scene 文本作 script；config 并入 params/defaults。
import type { Json, NewNode, ProjectDefaults, Recipe } from "../types"
import { materializeDefaults } from "../specs"

const str = (v: Json | undefined, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback)

const DEFAULT_SCENE = "场景设定：地点 / 时段 / 光源方向（写死，如 45° 侧逆光）/ 氛围关键词四字段写全，供全片镜头统一引用"

const DEFAULTS: ProjectDefaults = {
  imageModel: "gpt-image-2.5-flare",
  imageSize: "1024x1024",
  style: "场景锚点：光源方向与色温写死，构图完整，无人物与文字，重生成不漂移",
}

export const sceneSetupRecipe: Recipe = {
  id: "scene_setup",
  title: "场景建立",
  build(p) {
    const defaults: ProjectDefaults = {
      ...DEFAULTS,
      ...(typeof p.model === "string" && p.model ? { imageModel: p.model } : {}),
      ...(typeof p.size === "string" && p.size ? { imageSize: p.size } : {}),
      ...(typeof p.style === "string" && p.style ? { style: p.style } : {}),
    }
    const nodes: NewNode[] = [
      {
        id: "scene", type: "script",
        intent: "旧 role scene：场景设定文本（地点/时段/光源方向/氛围）。光源方向写死，后续镜头按此对齐。",
        params: { text: str(p.scene ?? p.prompt, DEFAULT_SCENE) },
      },
      {
        id: "keyframe", type: "keyframe",
        intent: "旧 role result 的场景设定图在此生成；旧 config generation 的 model/size/count 并入 params 与 defaults。固定 seed 重生成同场景不漂移，出图后标注光源方向与色温。",
        params: materializeDefaults("keyframe", "keyframe", { title: "场景图", prompt: "${scene}", role: "scene_setup" }, defaults),
      },
      {
        id: "qc", type: "qc",
        intent: "旧 notes 门禁：光源方向/色温与设定一致、无人物与文字、构图可作为背景参考锚点。",
        params: { mode: "critic", rubric: "scene_default", thresholds: { keepLightDirection: true, noCharacters: true, noText: true } },
        inputs: { image: { from: "keyframe" } },
      },
      {
        id: "export", type: "export",
        intent: "旧 role result 的交付出口：场景设定图按图片包导出，作为后续镜头生成的背景参考锚点。",
        params: { preset: "image_pack" },
        inputs: { images: { from: "keyframe" }, verdict: { from: "qc" } },
      },
    ]
    return { nodes, targets: { shots: 1, subtitles: false, audio: "none" }, defaults }
  },
  legacyRoleMap: {
    scene: "scene",
    generation: { intentOf: "keyframe" }, // config 不成节点：model/size/count 已并入 keyframe.params 与 defaults
    result: "keyframe",
  },
}
