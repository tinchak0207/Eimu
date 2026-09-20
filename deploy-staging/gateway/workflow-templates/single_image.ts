import type { WorkflowTemplate } from "./types";

export const singleImageTemplate: WorkflowTemplate = 
  // ── 单图（v1 三元组的工作流化）──
  {
    id: "single_image",
    name: "单张图片",
    description: "一段提示词 → 一张图。最简单的工作流。",
    nodes: [
      { role: "prompt", kind: "text", title: "提示词" },
      { role: "generation", kind: "config", title: "生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "result", kind: "image", title: "图片" },
    ],
    connections: [
      { fromRole: "prompt", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
