import type { WorkflowTemplate } from "./types";

export const shortdramaPosterTemplate: WorkflowTemplate = 
  // ── 投放海报线（短剧投放物料 7 步；2026-09-20 注册，对齐前端 agent-shortdrama-poster-line）──
  // 前端承诺 7 步：锚定视觉基调→提炼主演海报→排布CP对戏图→切片封面批量
  //             →生成变体测试包→回流迭代风格→锁定交付参数。
  // 落地形态（诚实对齐引擎能力）：本流程纯 image/text 两种节点，无 audio/film 环节。
  //   前 5 步 = image（每步一支 config 生成配置 + 一张 image 产出，全链竖版 9:16），
  //   第 6 步（回流迭代）与第 7 步（锁定交付参数）= text（报告 / 归档清单 + styleLock 参数卡），
  //   两者产出均为机器可读文本，不新增生成、不造假出图。
  {
    id: "shortdrama_poster",
    name: "投放海报线",
    description:
      "短剧投放物料 7 步流水线：视觉基调(image) → 主演海报(image) → CP对戏图(image) → 切片封面批量(image) → 变体测试包(image) → 回流迭代(text) → 锁定交付参数(text)。全链竖版 9:16，key art 作风格锚，安全区与字效遮脸为硬门禁。",
    multiShot: true,
    nodes: [
      // 步 1：锚定视觉基调（key art 定调，后续全链以它为风格锚）
      { role: "tone_gen", kind: "config", title: "基调生成配置", deliverable: "基调环节的生图价目与参数配置（model/size/count/单价），key art 主视觉按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "key_art", kind: "image", title: "剧设 key art 主视觉（竖版 9:16）", deliverable: "剧设 key art 主视觉 1 张（竖版 9:16）+ 色彩情绪规范 JSON（主色/辅色/对比度/光效方向/情绪关键词）", gate: "色彩规范 JSON 字段齐全（含 HEX/光效/情绪词各≥2），key art 与剧名题材气质对位，否则重出" },
      // 步 2：提炼主演海报（气场版 / 情绪版）
      { role: "poster_gen", kind: "config", title: "主演海报生成配置", deliverable: "主演海报环节的生图价目与参数配置（model/size/count/单价），气场版/情绪版海报按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "main_poster", kind: "image", title: "主演海报（气场版/情绪版）", deliverable: "主演海报 2 版：气场版（单人立势压场）| 情绪版（面部特写情绪爆点），各 1 张 9:16", gate: "两版五官一致性肉眼比对通过（同一个人）；取色全部落在规范 JSON 色板内" },
      // 步 3：排布 CP 对戏图（对视/逼近/拉扯三级张力）
      { role: "cp_gen", kind: "config", title: "CP 对戏生成配置", deliverable: "CP 对戏环节的生图价目与参数配置（model/size/count/单价），三级张力图组按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "cp_pair", kind: "image", title: "CP 对戏图（对视/逼近/拉扯）", deliverable: "CP 对戏图 3 张：对视版 | 逼近版 | 拉扯版（三级张力递进，供投放 A/B 测试）", gate: "三级张力肉眼可辨递进；双主演脸不互串（cref 各归各位）；不合格单张重出不整批重跑" },
      // 步 4：切片封面批量（剧名安全区模板，逐集对位情绪标签）
      { role: "cover_gen", kind: "config", title: "切片封面批量配置", deliverable: "切片封面环节的生图价目与参数配置（model/size/count/单价），批量信息流封面按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 8, kind: "image", unit_price_coins: 0.001 } },
      { role: "slice_cover", kind: "image", title: "信息流切片封面（批量）", deliverable: "信息流切片封面 6-9 张（9:16）：剧名安全区模板 + 每张对应一个切片剧情点 + 情绪标签对位表", gate: "安全区检查：9:16 内剧名区/平台 UI 区无关键元素入侵；固定 seed 抽查 3 张风格一致；切片情绪标签与剧情点一一对位" },
      // 步 5：生成变体测试包（单变量钩子/字效变体，供 A/B 归因）
      { role: "variant_gen", kind: "config", title: "投放变体生成配置", deliverable: "投放变体环节的生图价目与参数配置（model/size/count/单价），A/B 变体包按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 8, kind: "image", unit_price_coins: 0.001 } },
      { role: "variant_pack", kind: "image", title: "投放 A/B 变体包", deliverable: "投放 A/B 变体包：同一封面底图的 3 类钩子变体（钩子文案位上/中/下 | 花体字效版式 2-3 款 | 大字报冲击版），共 6-9 张", gate: "字效遮脸检查：所有文字与字效不覆盖演员面部关键区；变体命名规则完整可追溯" },
      // 步 6：回流迭代风格（文本环节，无生成）
      { role: "iteration", kind: "text", title: "数据回流迭代报告（赢家特征 + styleLock 参数更新建议）", deliverable: "数据回流迭代报告：高点击封面风格特征提炼（构图/色温/张力级别/文案位）+ 下一批次的 styleLock 参数更新建议", gate: "每条迭代建议都能追溯到具体变体 ID 的 CTR 数据，无数据支撑的猜测标记为待验证" },
      // 步 7：锁定交付参数（文本环节，无生成）
      { role: "delivery", kind: "text", title: "投放交付包（物料归档清单 + styleLock 参数卡）", deliverable: "投放物料交付包：全量物料按平台规格归档（9:16 主图 + 变体包 + 情绪标签对位表）+ 可复用 styleLock 参数卡（sref/cref/seed/色板 JSON）", gate: "全量门禁复核：安全区检查 + 字效遮脸检查 100% 通过；参数卡字段齐全可被机器读取" },
    ],
    connections: [
      { fromRole: "tone_gen", toRole: "key_art" },
      { fromRole: "key_art", toRole: "poster_gen" },
      { fromRole: "poster_gen", toRole: "main_poster" },
      { fromRole: "main_poster", toRole: "cp_gen" },
      { fromRole: "cp_gen", toRole: "cp_pair" },
      { fromRole: "cp_pair", toRole: "cover_gen" },
      { fromRole: "cover_gen", toRole: "slice_cover" },
      { fromRole: "slice_cover", toRole: "variant_gen" },
      { fromRole: "variant_gen", toRole: "variant_pack" },
      { fromRole: "variant_pack", toRole: "iteration" }, // 变体投放数据 → 回流归因
      { fromRole: "iteration", toRole: "delivery" }, // 参数更新 → 交付参数卡
    ],
  }
;