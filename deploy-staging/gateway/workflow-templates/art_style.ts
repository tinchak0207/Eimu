import type { WorkflowTemplate } from "./types";

export const artStyleTemplate: WorkflowTemplate =
  // ── 风格深研线（8 环流水线；2026-09-20 注册，对齐前端 agent-art-style-immersion）──
  // 前端承诺 8 环：采代表作→拆DNA→签解构表→拍临摹对照→跑变体矩阵→试LoRA→做原创成组→归档证物链。
  // 落地形态（诚实对齐引擎能力）：
  //   除「试LoRA」为 text 外，其余 7 环均落在 image 原语（逐环配套 config 生成节点）。
  //   本流程不铺 audio/film 节点：LoRA 训练、StyleAligned/StoryDiffusion 一致性机制
  //   均未接 upstream——「试LoRA」环执行时如实回报 unsupported_skip，不生成假模型文件。
  {
    id: "art_style",
    name: "风格深研线",
    description:
      "艺术家风格深度内化：代表作采集(image) → 五维DNA解构(image) → 解构表签核(image) → 临摹对拍(image) → 3x3变体矩阵(image) → LoRA可选轨记录(text) → 原创成组(image) → 证物链归档(image)。纯 image/text 两原语；LoRA 训练与 StyleAligned/StoryDiffusion 一致性机制未接上游，执行时如实回报跳过（unsupported_skip），不造假成功。",
    multiShot: true,
    nodes: [
      // 环 1：采代表作（代表作原图库 + 元数据表）
      { role: "ref_gen", kind: "config", title: "代表作采集配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "ref_pool", kind: "image", title: "代表作原图库（分期采样 + 盲测集冻结）" },
      // 环 2：拆DNA（笔触/色盘/光观察/构图/题材五维）
      { role: "dna_gen", kind: "config", title: "DNA 解构图生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "dna_board", kind: "image", title: "五维 DNA 解构图（含证据局部）" },
      // 环 3：签解构表（用户逐条签核的 DNA 卡）
      { role: "dna_card_gen", kind: "config", title: "解构卡生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "dna_card", kind: "image", title: "style DNA 卡（用户逐条签核版）" },
      // 环 4：拍临摹对照（逐维对拍 + 综合临摹 + 并排对照板）
      { role: "copy_gen", kind: "config", title: "临摹对拍生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "copy_compare", kind: "image", title: "临摹对照板（逐维还原度）" },
      // 环 5：跑变体矩阵（3 个新题材 x 3 个新构图）
      { role: "matrix_gen", kind: "config", title: "变体矩阵生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "variant_matrix", kind: "image", title: "3x3 泛化矩阵（逐格 DNA 泛化判定）" },
      // 环 6：试LoRA（可选轨：上游未接，如实回报 unsupported_skip）
      { role: "lora_log", kind: "text", title: "LoRA 可选轨实验记录（未接 upstream 时交付跳过记录）" },
      // 环 7：做原创成组
      { role: "origin_gen", kind: "config", title: "原创成组生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "origin_set", kind: "image", title: "原创成组作品（五维一致性自查）" },
      // 环 8：归档证物链（图库/DNA卡/对拍/矩阵/skip记录/成组/prompt骨架）
      { role: "archive_gen", kind: "config", title: "证物归档配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "evidence_archive", kind: "image", title: "内化证物档案（来源/seed/版本可复现）" },
    ],
    connections: [
      { fromRole: "ref_gen", toRole: "ref_pool" },
      { fromRole: "ref_pool", toRole: "dna_gen" },
      { fromRole: "dna_gen", toRole: "dna_board" },
      { fromRole: "dna_board", toRole: "dna_card_gen" },
      { fromRole: "dna_card_gen", toRole: "dna_card" },
      { fromRole: "dna_card", toRole: "copy_gen" }, // 签核版 DNA 卡 → 临摹对拍（宪法先行）
      { fromRole: "copy_gen", toRole: "copy_compare" },
      { fromRole: "copy_compare", toRole: "matrix_gen" },
      { fromRole: "matrix_gen", toRole: "variant_matrix" },
      { fromRole: "variant_matrix", toRole: "lora_log" }, // 可选轨记录
      { fromRole: "lora_log", toRole: "origin_gen" }, // 跳过记录 → 原创成组（不阻断主线）
      { fromRole: "origin_gen", toRole: "origin_set" },
      { fromRole: "origin_set", toRole: "archive_gen" },
      { fromRole: "archive_gen", toRole: "evidence_archive" },
    ],
  }
;