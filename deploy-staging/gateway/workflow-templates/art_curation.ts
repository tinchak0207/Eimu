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
      { role: "theme_brief", kind: "text", title: "策展立意（关键词 JSON + 立意主张句）", deliverable: "主题关键词 JSON（题材/时代/情绪/冲突各 3-5 词）+ 一句话策展立意（这个展主张什么）+ 目标观众与展览调性", gate: "策展立意必须是一句可陈述的主张句；关键词 JSON 四层字段齐全才放行" },
      // 环 2：情绪板（单图生成编排）
      { role: "moodboard_gen", kind: "config", title: "情绪板生成配置", deliverable: "情绪板环节的生图价目与参数配置（model/size/count/单价），情绪板参考图组按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "moodboard", kind: "image", title: "情绪板（9-12 格参考图）", deliverable: "情绪板一组（9-12 格参考图）+ 三类字段化标签：色彩（主色 3 + 点缀色 2，HEX 值）、材质（如哑光颗粒/丝绸）、情绪词", gate: "色彩/材质/情绪三类标签齐备且已收敛为唯一方向；存在两套打架的主色即打回" },
      // 环 3：风格锚（canonical key art，全组对表基准）
      { role: "style_gen", kind: "config", title: "风格锚生成配置", deliverable: "风格锚环节的生图价目与参数配置（model/size/count/单价），canonical key art 按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "style_anchor", kind: "image", title: "风格锚（canonical key art）", deliverable: "canonical key art 一张（全展定调之作）+ style DNA 文字描述（笔触/光源/构图法则/渲染质感）", gate: "key art 与 style DNA 互证：拿描述反查画面，四个维度全部可指认才算铸成" },
      // 环 4：构图稿（黑白 sketch-lock）
      { role: "composition_gen", kind: "config", title: "构图稿生成配置", deliverable: "构图稿环节的生图价目与参数配置（model/size/count/单价），黑白 sketch-lock 线稿按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "composition", kind: "image", title: "构图稿（黑白线稿）", deliverable: "全组每张的黑白构图稿（thumbnail sketch）+ 统一呼吸感说明（留白占画面比例区间、视线动线走向）", gate: "黑白稿并排时留白节奏统一、视觉焦点不超标；任一张黑白灰关系跳脱全组即重画该张" },
      // 环 5：成组渲染（同风格锚批量成稿）
      { role: "batch_gen", kind: "config", title: "成组渲染配置", deliverable: "成组渲染环节的生图价目与参数配置（model/size/count/单价），成组彩色成稿按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "batch_render", kind: "image", title: "成组彩色成稿", deliverable: "成组彩色成稿 5-6 张（全组同 seed 域、同风格锚）", gate: "全组并排：色温一致、光源方向一致、笔触密度目测同级；两张放在一起像同一个展的作品才算过" },
      // 环 6：一致性审计（文本环节：审计表 + outlier 重生清单）
      { role: "audit", kind: "text", title: "一致性审计表（色盘/笔触/留白 + outlier 清单）", deliverable: "一致性审计表（每张的色盘偏离度、笔触密度、留白占比数值）+ outlier 张重生命令清单", gate: "全组零 outlier：每张色盘偏离度、笔触密度、留白占比三项数值全部落入门禁区间，不达标张必须重生并复审" },
      // 环 7：展陈主视觉（海报/墙面布置/图录）
      { role: "exhibition_gen", kind: "config", title: "展陈主视觉生成配置", deliverable: "展陈主视觉环节的生图价目与参数配置（model/size/count/单价），海报/墙面模拟/图录按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "exhibition_visual", kind: "image", title: "展陈主视觉（海报/墙面/图录）", deliverable: "展览海报 1 张（key art 为主视觉 + 展名 + 立意句排版）+ 墙面布置模拟图（成组作品挂墙观展动线）+ 图录版式", gate: "海报、墙面模拟、图录三者并排观感统一：同色系、同留白节奏、同立意表达；任何一个像另一个展的物料即重排" },
      // 环 8：多规格交付（印刷级文件 + 线上展厅素材）
      { role: "delivery_gen", kind: "config", title: "多规格交付生成配置", deliverable: "多规格交付环节的生图价目与参数配置（model/size/count/单价），印刷级成品与展厅素材按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "delivery", kind: "image", title: "多规格交付包（印刷级 + 展厅素材）", deliverable: "印刷级成品包（300 DPI 印刷分辨率作品文件 + 展签成品文案）+ 线上 3D 展厅素材包（展厅空间图 + 挂点布置图）", gate: "抽查任一印刷文件的分辨率达 300 DPI 且画幅像素量正确；线上展厅挂点数与作品数一致；缺一项即补齐后才算交付完成" },
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