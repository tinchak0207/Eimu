import type { WorkflowTemplate } from "./types";

export const artCurationTemplate: WorkflowTemplate =
  // ── 策展式创作（8 环流水线，对齐前端 agent-art-curation-series）──
  // 前端承诺 8 环：立意→情绪板→风格锚→构图稿→成组渲染→一致性审计→展陈主视觉→多规格交付。
  // 落地形态（诚实对齐引擎能力）：本流程纯 image/text 两种节点，无 audio/film 环节；
  //   立意/审计=text（结构化文本产出），其余各环=image（单图生成编排）；
  //   image 环一律用「config 生成配置 + image 产出」成对节点，与 novel_film 同构。
  // 未来若延伸配音/成片环节，后端会如实回报「上游暂不可用」，不造假成功。
  {
    id: "art_curation",
    name: "策展式创作",
    description:
      "主题 → 8 环策展流水线：立意结构化(text) → 情绪板(image) → 风格锚(image) → 构图稿(image) → 成组渲染(image) → 一致性审计(text) → 展陈主视觉(image) → 多规格交付(image)。全链纯 image/text 节点，保持系列作品风格一致性。",
    multiShot: true,
    nodes: [
      // 环 1：立意（文本环节，无生成）
      { role: "theme_brief", kind: "text", title: "策展立意（关键词 JSON + 立意主张句）" },
      // 环 2：情绪板（单图生成编排）
      { role: "moodboard_gen", kind: "config", title: "情绪板生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "moodboard", kind: "image", title: "情绪板（9-12 格参考图）" },
      // 环 3：风格锚（canonical key art，全组对表基准）
      { role: "style_gen", kind: "config", title: "风格锚生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "style_anchor", kind: "image", title: "风格锚（canonical key art）" },
      // 环 4：构图稿（黑白 sketch-lock）
      { role: "composition_gen", kind: "config", title: "构图稿生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "composition", kind: "image", title: "构图稿（黑白线稿）" },
      // 环 5：成组渲染（同风格锚批量成稿）
      { role: "batch_gen", kind: "config", title: "成组渲染配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "batch_render", kind: "image", title: "成组彩色成稿" },
      // 环 6：一致性审计（文本环节：审计表 + outlier 重生清单）
      { role: "audit", kind: "text", title: "一致性审计表（色盘/笔触/留白 + outlier 清单）" },
      // 环 7：展陈主视觉（海报/墙面布置/图录）
      { role: "exhibition_gen", kind: "config", title: "展陈主视觉生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "exhibition_visual", kind: "image", title: "展陈主视觉（海报/墙面/图录）" },
      // 环 8：多规格交付（印刷级文件 + 线上展厅素材）
      { role: "delivery_gen", kind: "config", title: "多规格交付生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "delivery", kind: "image", title: "多规格交付包（印刷级 + 展厅素材）" },
    ],
    connections: [
      { fromRole: "theme_brief", toRole: "moodboard_gen" },
      { fromRole: "moodboard_gen", toRole: "moodboard" },
      { fromRole: "moodboard", toRole: "style_gen" },
      { fromRole: "style_gen", toRole: "style_anchor" },
      { fromRole: "style_anchor", toRole: "composition_gen" },
      { fromRole: "composition_gen", toRole: "composition" },
      { fromRole: "composition", toRole: "batch_gen" },
      { fromRole: "batch_gen", toRole: "batch_render" },
      { fromRole: "batch_render", toRole: "audit" },
      { fromRole: "audit", toRole: "exhibition_gen" },
      { fromRole: "exhibition_gen", toRole: "exhibition_visual" },
      { fromRole: "exhibition_visual", toRole: "delivery_gen" },
      { fromRole: "delivery_gen", toRole: "delivery" },
    ],
  }
;