import type { WorkflowTemplate } from "./types";

export const novelIpTemplate: WorkflowTemplate = 
  // ── IP 视觉包（8 环流水线；2026-09-20 注册，对齐前端 agent-novel-ip-visual-pack）──
  // 前端承诺 8 环：拆解世界观→炼情绪板→铸风格锚→建主角资产→绘名场面组图→
  //   造封面主视觉→出多画幅→铺衍生物料。
  // 落地形态（诚实对齐引擎能力）：拆解世界观=text（结构化产出，无生成）；
  //   其余 7 环全为 image（单图生成的编排序列，multiShot 可复制多张），
  //   每环配一个 config 节点承载 model/size/count/unit_price 价目表字段。
  // 本流程纯 image/text，无 audio/film 原语；未来若延伸配音/成片环节，
  //   执行时如实回报「上游不可用」，不造假成功。
  {
    id: "novel_ip",
    name: "IP视觉包",
    description:
      "网文 IP 全案视觉 → 8 环流水线：拆解世界观(text) → 炼情绪板(image) → 铸风格锚(image) → 建主角资产(image) → 绘名场面组图(image) → 造封面主视觉(image) → 出多画幅(image) → 铺衍生物料(image)。纯 image/text 两原语编排，风格锚先行、后续各环沿用同一锚，杜绝风格漂移。",
    multiShot: true,
    nodes: [
      // 环 1：拆解世界观（文本环节，无生成）
      { role: "world_bible", kind: "text", title: "世界观圣经（色彩域 HEX + 材质表 + 名场面候选 + 可绘制元素清单）", deliverable: "世界观圣经结构化卡（色彩域 HEX + 材质表 + 3 个名场面候选）+ 可绘制元素清单", gate: "世界观关键元素清单人工确认后才进情绪板" },
      // 环 2：炼情绪板（单图生成的编排序列）
      { role: "mood_gen", kind: "config", title: "情绪板生成配置", deliverable: "情绪板环节的生图价目与参数配置（model/size/count/单价），情绪板成图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "mood_board", kind: "image", title: "3x3 情绪板 + 情绪坐标轴", deliverable: "3x3 情绪板 + 情绪坐标轴（题材频道定位）", gate: "情绪板盲测门禁：拿给无关者猜题材频道，猜不对回炉重炼" },
      // 环 3：铸风格锚（canonical key art + sref 配方冻结）
      { role: "style_gen", kind: "config", title: "风格锚生成配置", deliverable: "风格锚环节的生图价目与参数配置（model/size/count/单价），key art 定调图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "style_anchor", kind: "image", title: "风格锚（canonical key art + sref 配方）", deliverable: "canonical key art 一张（全案定调）+ sref 码/权重/seed 配方冻结", gate: "风格锚配方复测门禁：同配方复测 2 次无偏差才算铸成" },
      // 环 4：建主角资产（DNA 签名 + 三视图 + 表情差列）
      { role: "char_gen", kind: "config", title: "主角资产生成配置", deliverable: "主角资产环节的生图价目与参数配置（model/size/count/单价），三视图与表情差列按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "char_card", kind: "image", title: "主角资产卡（三视图 + 表情差列）", deliverable: "主角 DNA 签名 8 维表 + 三视图 + 表情差列 6 格", gate: "洗牌盲认门禁：三视图与表情列打乱后用户仍能认出同一角色" },
      // 环 5：绘名场面组图（序列一致性；multiShot 逐场复制）
      { role: "scene_gen", kind: "config", title: "名场面组图生成配置", deliverable: "名场面组图环节的生图价目与参数配置（model/size/count/单价），序列分镜图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "scene_set", kind: "image", title: "名场面组图（序列化分镜图组）", deliverable: "3-5 张序列化分镜名场面（先 sketch-lock 黑白构图稿后成图）", gate: "并排零漂移门禁：组图并排后角色/风格零漂移才算过" },
      // 环 6：造封面主视觉（竖版 + 书名区留白）
      { role: "cover_gen", kind: "config", title: "封面主视觉生成配置", deliverable: "封面主视觉环节的生图价目与参数配置（model/size/count/单价），竖版封面按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "cover_key_art", kind: "image", title: "封面主视觉（竖版 + 书名区留白版）", deliverable: "竖版封面主视觉 + 书名区留白版（男频仰拍/女频留白双构图）", gate: "主视觉人工批准后出多画幅适配版" },
      // 环 7：出多画幅（每画幅重构图）
      { role: "aspect_gen", kind: "config", title: "多画幅生成配置", deliverable: "多画幅环节的生图价目与参数配置（model/size/count/单价），各画幅重构图按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "aspect_pack", kind: "image", title: "多画幅包（3:4 / 1:1 / 9:16）", deliverable: "封面多画幅包（3:4/1:1/9:16）+ 平台安全区核对清单（起点竖版/B 站 16:9 等）", gate: "多画幅套检门禁：任一画幅安全区/分辨率不达标即打回重排" },
      // 环 8：铺衍生物料（头像/立绘/海报/表情包 + 归档）
      { role: "derivative_gen", kind: "config", title: "衍生物料生成配置", deliverable: "衍生物料环节的生图价目与参数配置（model/size/count/单价），头像/立绘/海报/表情包按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "derivative_pack", kind: "image", title: "衍生物料（头像/立绘/海报/Q 版表情包）", deliverable: "头像/立绘/海报/Q 版表情包 + 归档（附 DNA 表与 sref 配方副本）", gate: "归档完整性门禁：DNA 表/sref 配方/衍生物料三者齐备才算完成" },
    ],
    connections: [
      { fromRole: "world_bible", toRole: "mood_gen" },
      { fromRole: "mood_gen", toRole: "mood_board" },
      { fromRole: "mood_board", toRole: "style_gen" },
      { fromRole: "style_gen", toRole: "style_anchor" },
      { fromRole: "style_anchor", toRole: "char_gen" },
      { fromRole: "char_gen", toRole: "char_card" },
      { fromRole: "char_card", toRole: "scene_gen" },
      { fromRole: "scene_gen", toRole: "scene_set" },
      { fromRole: "scene_set", toRole: "cover_gen" },
      { fromRole: "cover_gen", toRole: "cover_key_art" },
      { fromRole: "cover_key_art", toRole: "aspect_gen" },
      { fromRole: "aspect_gen", toRole: "aspect_pack" },
      { fromRole: "aspect_pack", toRole: "derivative_gen" },
      { fromRole: "derivative_gen", toRole: "derivative_pack" },
    ],
  }
;