import type { WorkflowTemplate } from "./types";

export const singleImageTemplate: WorkflowTemplate = 
  // ── 单图（v1 三元组的工作流化）──
  {
    id: "single_image",
    name: "单张图片",
    description: "一段提示词 → 一张图。最简单的工作流。",
    nodes: [
      {
        role: "prompt",
        kind: "text",
        title: "提示词",
        deliverable: "生图提示词（主体/风格/构图一句话写全，模型只认显式描述）",
        notes: [
          "提示词一次写全主体/风格/构图三要素，模型只认显式描述，缺什么就写什么",
        ],
        tools: [
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "generation",
        kind: "config",
        title: "生成配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
        deliverable: "生成参数（模型/尺寸/张数/seed），改参数在此改、不改提示词",
      },
      {
        role: "result",
        kind: "image",
        title: "图片",
        deliverable: "成品图片 URL + 实际花费",
        notes: [
          "出图后核对主体/风格/构图三要素是否命中，跑偏先改提示词再重出，不改参数掩过",
        ],
        tools: [
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
        ],
      },
    ],
    connections: [
      { fromRole: "prompt", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
