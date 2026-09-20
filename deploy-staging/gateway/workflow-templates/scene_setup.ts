import type { WorkflowTemplate } from "./types";

export const sceneSetupTemplate: WorkflowTemplate = 
  // ── 场景建立 ──
  {
    id: "scene_setup",
    name: "场景建立",
    description: "地点描述 → 场景建立图。影片的环境锚点。",
    nodes: [
      { role: "scene", kind: "text", title: "场景描述" },
      { role: "generation", kind: "config", title: "场景图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "result", kind: "image", title: "场景图" },
    ],
    connections: [
      { fromRole: "scene", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
