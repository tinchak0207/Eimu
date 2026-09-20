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
      { role: "tone_gen", kind: "config", title: "基调生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "key_art", kind: "image", title: "剧设 key art 主视觉（竖版 9:16）" },
      // 步 2：提炼主演海报（气场版 / 情绪版）
      { role: "poster_gen", kind: "config", title: "主演海报生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 2, kind: "image", unit_price_coins: 0.001 } },
      { role: "main_poster", kind: "image", title: "主演海报（气场版/情绪版）" },
      // 步 3：排布 CP 对戏图（对视/逼近/拉扯三级张力）
      { role: "cp_gen", kind: "config", title: "CP 对戏生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "cp_pair", kind: "image", title: "CP 对戏图（对视/逼近/拉扯）" },
      // 步 4：切片封面批量（剧名安全区模板，逐集对位情绪标签）
      { role: "cover_gen", kind: "config", title: "切片封面批量配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 8, kind: "image", unit_price_coins: 0.001 } },
      { role: "slice_cover", kind: "image", title: "信息流切片封面（批量）" },
      // 步 5：生成变体测试包（单变量钩子/字效变体，供 A/B 归因）
      { role: "variant_gen", kind: "config", title: "投放变体生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1536", count: 8, kind: "image", unit_price_coins: 0.001 } },
      { role: "variant_pack", kind: "image", title: "投放 A/B 变体包" },
      // 步 6：回流迭代风格（文本环节，无生成）
      { role: "iteration", kind: "text", title: "数据回流迭代报告（赢家特征 + styleLock 参数更新建议）" },
      // 步 7：锁定交付参数（文本环节，无生成）
      { role: "delivery", kind: "text", title: "投放交付包（物料归档清单 + styleLock 参数卡）" },
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