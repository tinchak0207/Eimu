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
      { role: "ref_gen", kind: "config", title: "代表作采集配置", deliverable: "代表作采集环节的生图价目与参数配置（model/size/count/单价），代表原图库按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "ref_pool", kind: "image", title: "代表作原图库（分期采样 + 盲测集冻结）", deliverable: "15-20 张代表作原图与元数据表", gate: "人工确认清单完整：至少两个创作期各有≥5张高清图、题材≥2类、盲测集已冻结；缺图时停在本步，不调用生图" },
      // 环 2：拆DNA（笔触/色盘/光观察/构图/题材五维）
      { role: "dna_gen", kind: "config", title: "DNA 解构图生成配置", deliverable: "DNA 解构环节的生图价目与参数配置（model/size/count/单价），五维解构图与证据局部按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "dna_board", kind: "image", title: "五维 DNA 解构图（含证据局部）", deliverable: "五维 DNA 解构 JSON 与证据局部图：笔触/色盘/光观察/构图习惯/题材偏好", gate: "五维每维≥3条可验证特征，所有特征均有证据 asset_id，且画什么/怎么看分栏无混淆；VLM 不可用时必须由用户或人工依据原图补齐" },
      // 环 3：签解构表（用户逐条签核的 DNA 卡）
      { role: "dna_card_gen", kind: "config", title: "解构卡生成配置", deliverable: "解构卡环节的生图价目与参数配置（model/size/count/单价），签核版 DNA 卡按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "dna_card", kind: "image", title: "style DNA 卡（用户逐条签核版）", deliverable: "用户逐条签核的 style DNA 卡与两张原作局部对位图", gate: "用户逐条确认并锁定版本；存在未决条目、来源不明条目或高权重项未确认时，工作流停留在本步" },
      // 环 4：拍临摹对照（逐维对拍 + 综合临摹 + 并排对照板）
      { role: "copy_gen", kind: "config", title: "临摹对拍生成配置", deliverable: "临摹对拍环节的生图价目与参数配置（model/size/count/单价），逐维对拍与对照板按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "copy_compare", kind: "image", title: "临摹对照板（逐维还原度）", deliverable: "逐维对拍 5 张、综合临摹 2 张、原作并排对照板与逐维还原度表", gate: "五维还原度全部≥70%、高权重项≥85%，综合临摹通过人工并排审查；任何低于阈值的维度必须回退到 style_dna_approved_v1 修订，不得硬闯" },
      // 环 5：跑变体矩阵（3 个新题材 x 3 个新构图）
      { role: "matrix_gen", kind: "config", title: "变体矩阵生成配置", deliverable: "变体矩阵环节的生图价目与参数配置（model/size/count/单价），3x3 泛化矩阵按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "variant_matrix", kind: "image", title: "3x3 泛化矩阵（逐格 DNA 泛化判定）", deliverable: "3x3 泛化矩阵（3 个新题材 x 3 个新构图）与逐格 DNA 泛化判定表", gate: "9 格至少 7 格保留四个以上 DNA 维度，且 outlier 原因已记录；未达到即回退修订 style_dna，不进入原创成组" },
      // 环 6：试LoRA（可选轨：上游未接，如实回报 unsupported_skip）
      { role: "lora_log", kind: "text", title: "LoRA 可选轨实验记录（未接 upstream 时交付跳过记录）", deliverable: "LoRA 可选轨实验记录：数据集/caption/参数/同 seed 对比；若未接 upstream 则交付明确跳过记录", gate: "可选轨门禁：只有 upstream LoRA 训练、挂载和同 seed 对比都真实可用且 LoRA 显著胜出才启用；当前必须交付 skip_reason 并继续原创路线" },
      // 环 7：做原创成组
      { role: "origin_gen", kind: "config", title: "原创成组生成配置", deliverable: "原创成组环节的生图价目与参数配置（model/size/count/单价），原创成组作品按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "origin_set", kind: "image", title: "原创成组作品（五维一致性自查）", deliverable: "6-8 张原创成组作品与五维一致性自查表", gate: "6-8 张全部通过五维自查，组内风格统一、构图不重复、题材未复刻单一代表作，且每张均有 seed/prompt/来源节点记录" },
      // 环 8：归档证物链（图库/DNA卡/对拍/矩阵/skip记录/成组/prompt骨架）
      { role: "archive_gen", kind: "config", title: "证物归档配置", deliverable: "证物归档环节的生图价目与参数配置（model/size/count/单价），内化证物档案按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "evidence_archive", kind: "image", title: "内化证物档案（来源/seed/版本可复现）", deliverable: "内化证物档案：代表作图库、签核 DNA 卡、逐维对拍、3x3 矩阵、LoRA 跳过记录、原创成组与可复用 prompt 骨架", gate: "六类核心 artifact 齐全、每一步 gate 决策可追溯、所有 seed/prompt/source node 已登记、unsupported 清单完整、prompt 骨架可单独复用；缺一项不得宣称内化完成" },
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