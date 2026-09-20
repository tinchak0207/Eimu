import type { WorkflowTemplate } from "./types";

export const sceneSetupTemplate: WorkflowTemplate = 
  // ── 场景建立 ──
  {
    id: "scene_setup",
    name: "场景建立",
    description: "地点描述 → 场景建立图。影片的环境锚点。",
    nodes: [
      { role: "scene", kind: "text", title: "场景描述", deliverable: "场景设定文本（地点/时段/光源方向/氛围关键词，光源方向写死全片统一）" },
      { role: "generation", kind: "config", title: "场景图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 }, deliverable: "场景图生成参数（固定 seed 保证同场景重生成不漂移）" },
      { role: "result", kind: "image", title: "场景图", deliverable: "场景设定图，作为后续镜头生成的背景参考锚点" },
    ],
    connections: [
      { fromRole: "scene", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
