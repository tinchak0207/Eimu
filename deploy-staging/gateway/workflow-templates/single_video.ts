import type { WorkflowTemplate } from "./types";

export const singleVideoTemplate: WorkflowTemplate = 
  // ── 单镜头影片 ──
  {
    id: "single_video",
    name: "单支影片",
    description: "镜头脚本 → 一支影片（可带参考图）。",
    nodes: [
      { role: "shot", kind: "text", title: "镜头脚本" },
      { role: "reference", kind: "image", title: "参考图（可选）" },
      { role: "generation", kind: "config", title: "影片配置", defaults: { model: "minimax-h3", size: "16:9", duration_seconds: 5, kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "result", kind: "video", title: "影片" },
    ],
    connections: [
      { fromRole: "shot", toRole: "generation" },
      { fromRole: "reference", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
