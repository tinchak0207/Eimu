import type { WorkflowTemplate } from "./types";

export const singleVideoTemplate: WorkflowTemplate = 
  // ── 单镜头影片 ──
  {
    id: "single_video",
    name: "单支影片",
    description: "镜头脚本 → 一支影片（可带参考图）。",
    nodes: [
      { role: "shot", kind: "text", title: "镜头脚本", deliverable: "镜头脚本（景别/机位/运镜/时长秒数 + 运动与情绪描述，按「听见→停顿→眼神→表情→说话」拆反应）" },
      { role: "reference", kind: "image", title: "参考图（可选）", deliverable: "参考图（角色/场景锚点），带上可保人物一致性" },
      { role: "generation", kind: "config", title: "影片配置", defaults: { model: "minimax-h3", size: "16:9", duration_seconds: 5, kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 }, deliverable: "视频生成参数（模型/画幅/时长，单镜 3-8 秒为宜）" },
      { role: "result", kind: "video", title: "影片", deliverable: "镜头 MP4 URL + 实际花费", gate: "抽首/中/尾 3 帧质检：出现明显形变/闪帧/角色漂移即重生成" },
    ],
    connections: [
      { fromRole: "shot", toRole: "generation" },
      { fromRole: "reference", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  }
;
