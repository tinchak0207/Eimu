import type { WorkflowTemplate } from "./types";

export const artStyleTemplate: WorkflowTemplate =
  // ── 风格深研线（8 环流水线；2026-09-20 注册，对齐前端 agent-art-style-immersion）──
  // 前端承诺 8 环：采代表作→拆DNA→签解构表→拍临摹对照→跑变体矩阵→试LoRA→做原创成组→归档证物链。
  // 落地形态（诚实对齐引擎能力）：
  //   除「试LoRA」为 text 外，其余 7 环均落在 image 原语（逐环配套 config 生成节点）。
  //   本流程不铺 audio/film 节点：LoRA 训练、StyleAligned/StoryDiffusion 一致性机制
  //   均未接 upstream——「试LoRA」环执行时如实回报 unsupported_skip，不生成假模型文件。
  // tools/notes 真源 = 前端 payload art-style-immersion.ts 的
  //   steps[].requiredTools / promptNotes，逐字回填到每环主产出节点。
  {
    id: "art_style",
    name: "风格深研线",
    description:
      "艺术家风格深度内化：代表作采集(image) → 五维DNA解构(image) → 解构表签核(image) → 临摹对拍(image) → 3x3变体矩阵(image) → LoRA可选轨记录(text) → 原创成组(image) → 证物链归档(image)。纯 image/text 两原语；LoRA 训练与 StyleAligned/StoryDiffusion 一致性机制未接上游，执行时如实回报跳过（unsupported_skip），不造假成功。",
    multiShot: true,
    nodes: [
      // 环 1：采代表作（代表作原图库 + 元数据表）
      { role: "ref_gen", kind: "config", title: "代表作采集配置", deliverable: "代表作采集环节的生图价目与参数配置（model/size/count/单价），代表原图库按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "ref_pool",
        kind: "image",
        title: "代表作原图库（分期采样 + 盲测集冻结）",
        deliverable: "15-20 张代表作原图与元数据表",
        gate: "人工确认清单完整：至少两个创作期各有≥5张高清图、题材≥2类、盲测集已冻结；缺图时停在本步，不调用生图",
        notes: [
          "只收高清原图；印刷翻拍图会污染笔触与纸纹分析",
          "分期采样，避免把艺术家不同阶段的笔法混成一套 DNA",
          "保留 2-4 张不参与解构的盲测图，防止提示词只记住训练样本",
          "元数据表逐图登记：asset_id、创作期、年份、题材分类、来源 URL、分辨率；长边低于 1024px 的图标注「仅参考不进 DNA」，不参与笔触与纸纹量化",
          "盲测集当场冻结：图号+文件哈希写入冻结清单并回填画布节点，后续解构、临摹、变体各步禁止引用，只留最终盲测比对用",
        ],
        tools: [
          { id: "canvas_get_state", input: "画布", output: "节点/连线快照 JSON" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
        ],
      },
      // 环 2：拆DNA（笔触/色盘/光观察/构图/题材五维）
      { role: "dna_gen", kind: "config", title: "DNA 解构图生成配置", deliverable: "DNA 解构环节的生图价目与参数配置（model/size/count/单价），五维解构图与证据局部按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "dna_board",
        kind: "image",
        title: "五维 DNA 解构图（含证据局部）",
        deliverable: "五维 DNA 解构 JSON 与证据局部图：笔触/色盘/光观察/构图习惯/题材偏好",
        gate: "五维每维≥3条可验证特征，所有特征均有证据 asset_id，且画什么/怎么看分栏无混淆；VLM 不可用时必须由用户或人工依据原图补齐",
        notes: [
          "五维 DNA 必须拆到笔触厚度/方向/干湿、颜料堆叠、纸纹材质、HEX 色盘、光源方位、明暗交界、视点裁切与负形",
          "题材偏好只记录画什么；观察方式记录怎么看，例如边缘处理、环境色渗入、阴影补色与视觉焦点路径",
          "拒绝大气、唯美、电影感等不可验证套话；每条都要有数值、方向、比例、频率或原作局部证据",
          "色盘量化：HEX 主色 5-8 个按画面占比降序排（主色/辅色/点缀色三档），光源方位用钟点角度写死（如 10 点钟方向、约 45° 侧逆光），禁止只写「暖色调」",
          "证据登记规则：每条特征挂证据 asset_id + 局部定位（如 asset_007 左上 30% 区域的笔触走向），无证据特征标「待补证」不计入 gate 的≥3 条统计",
        ],
        tools: [
          { id: "style_dna_extract", input: "代表作", output: "风格 DNA 解构表（笔触/色板/构图）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 3：签解构表（用户逐条签核的 DNA 卡）
      { role: "dna_card_gen", kind: "config", title: "解构卡生成配置", deliverable: "解构卡环节的生图价目与参数配置（model/size/count/单价），签核版 DNA 卡按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "dna_card",
        kind: "image",
        title: "style DNA 卡（用户逐条签核版）",
        // 实体宣告（2026-09-24）：用户签核版 style DNA 卡是**一张风格卡**的交付物，
        // 画布侧据此自动落卡（后续可 @ 引用该风格）。
        defaults: { emitsEntity: { kind: "style", nameFrom: "input" } },
        deliverable: "用户逐条签核的 style DNA 卡与两张原作局部对位图",
        gate: "用户逐条确认并锁定版本；存在未决条目、来源不明条目或高权重项未确认时，工作流停留在本步",
        notes: [
          "每条 DNA 必须可回看原作局部，不让用户只凭抽象文字签核",
          "用户修正项写入 revision_log；高权重项在后续逐维对拍中权重 x2",
          "没有明确批准不能进入临摹或批量生图",
          "签核定版号 style_dna_approved_v1，版本号写进后续每张临摹的 prompt_snapshot 备查；revision_log 逐条记「谁改的/改了什么/依据哪张原作局部」",
          "两张对位图各圈 3 处高权重特征锚点（笔触走向线、明暗交界带、色盘取样点），签核时让用户逐处点选确认，不接受整图扫一眼通过",
          "交付本节点时把风格名写进节点 metadata 的 input 字段——画布侧据它自动落成风格卡并当卡名，缺了卡名只能退回节点标题「style DNA 卡（用户逐条签核版）」",
        ],
        tools: [
          { id: "style_dna_extract", input: "代表作 + DNA 草稿", output: "正式解构表（笔触/色板/构图/光照四栏）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 4：拍临摹对照（逐维对拍 + 综合临摹 + 并排对照板）
      { role: "copy_gen", kind: "config", title: "临摹对拍生成配置", deliverable: "临摹对拍环节的生图价目与参数配置（model/size/count/单价），逐维对拍与对照板按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "copy_compare",
        kind: "image",
        title: "临摹对照板（逐维还原度）",
        deliverable: "逐维对拍 5 张、综合临摹 2 张、原作并排对照板与逐维还原度表",
        gate: "五维还原度全部≥70%、高权重项≥85%，综合临摹通过人工并排审查；任何低于阈值的维度必须回退到 style_dna_approved_v1 修订，不得硬闯",
        notes: [
          "固定 seed 贯穿同一轮对拍，差异只允许来自 prompt 的单一维度替换；seed 必须同时写入 seed_log 与 prompt_snapshot",
          "笔触复现写厚度、笔触方向、颜料堆叠和干湿边缘；材质复现写可见 paint ridges、干底层覆盖和冷压纸纹显现",
          "逐维还原度=复现成功特征数/该维 DNA 特征总数；低于 60% 回到解构表补写，高权重项低于 85% 不放行",
          "StyleAligned 与 StoryDiffusion 都是研究中的一致性机制，本 harness 未接 upstream，只能用固定 seed、同一 prompt 骨架和人工对拍",
          "逐维替换法控制变量：prompt 骨架（材质短语+观察层短语原文复用）保持不动，一轮只换一个维度的描述词；每维 5 张去掉还原度最高与最低各 1 张，取中间 3 张的中位数计分，防偶然命中",
          "7 张对照图（5 逐维+2 综合）统一尺寸 1024x1024 并排贴板，与原作局部左右对照；每次生图先向用户说明这张在验哪个维度再扣费",
        ],
        tools: [
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 5：跑变体矩阵（3 个新题材 x 3 个新构图）
      { role: "matrix_gen", kind: "config", title: "变体矩阵生成配置", deliverable: "变体矩阵环节的生图价目与参数配置（model/size/count/单价），3x3 泛化矩阵按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "variant_matrix",
        kind: "image",
        title: "3x3 泛化矩阵（逐格 DNA 泛化判定）",
        deliverable: "3x3 泛化矩阵（3 个新题材 x 3 个新构图）与逐格 DNA 泛化判定表",
        gate: "9 格至少 7 格保留四个以上 DNA 维度，且 outlier 原因已记录；未达到即回退修订 style_dna，不进入原创成组",
        notes: [
          "泛化检验必须离开艺术家惯用题材，验证怎么看仍成立，而不是重复画花瓶或同一人物",
          "9 格共用观察层 DNA，变量只改题材与构图；同一 seed 便于对照，但不等同于已获得 StyleAligned 一致性",
          "任一格丢失两个以上 DNA 维度即标为 outlier，检查题材词是否偷偷带回了画什么层",
          "判定表逐格填字段：格号、题材词、构图词、seed、保留维度数（0-5）、丢失维度名、outlier 判定（是/否）、原因备注；9 格全部入表，禁止空格或只记结论",
          "选材硬指标：3 个新题材中至少 1 个与艺术家惯用题材零重叠（如风景画家换工业静物），3 个构图覆盖远/中/近三种景别 + 各自不同视点高度",
        ],
        tools: [
          { id: "style_aligned_batch", input: "风格锚 + 清单", output: "成组渲染（风格对齐批量）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 6：试LoRA（可选轨：上游未接，如实回报 unsupported_skip）
      {
        role: "lora_log",
        kind: "text",
        title: "LoRA 可选轨实验记录（未接 upstream 时交付跳过记录）",
        deliverable: "LoRA 可选轨实验记录：数据集/caption/参数/同 seed 对比；若未接 upstream 则交付明确跳过记录",
        gate: "可选轨门禁：只有 upstream LoRA 训练、挂载和同 seed 对比都真实可用且 LoRA 显著胜出才启用；当前必须交付 skip_reason 并继续原创路线",
        notes: [
          "LoRA 原理上冻结基础权重并注入可训练低秩矩阵，但本 harness 没有训练、上传或挂载 upstream；不能把参数起点写成已可执行能力",
          "若未来接通训练，caption 只写内容不写风格，且必须同 seed 同 prompt 比较纯 prompt 与 prompt+LoRA",
          "当前执行结果应是 unsupported_skip，不生成假模型文件，直接回接已通过矩阵的 prompt 骨架",
          "skip 记录须含可复算字段：skip_reason=upstream_unavailable、替代方案=固定 seed+共享 prompt 骨架（写明骨架版本号）、引用已通过的 3x3 矩阵结论；记录归档后未来真接通训练时可直接被同 seed 对比实验覆盖更新",
        ],
        tools: [
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费", unsupported: true },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 7：做原创成组
      { role: "origin_gen", kind: "config", title: "原创成组生成配置", deliverable: "原创成组环节的生图价目与参数配置（model/size/count/单价），原创成组作品按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "origin_set",
        kind: "image",
        title: "原创成组作品（五维一致性自查）",
        deliverable: "6-8 张原创成组作品与五维一致性自查表",
        gate: "6-8 张全部通过五维自查，组内风格统一、构图不重复、题材未复刻单一代表作，且每张均有 seed/prompt/来源节点记录",
        notes: [
          "成组共用怎么看的 DNA（笔触逻辑、色盘纪律、光处理、材质），但题材、构图和叙事必须原创且不复刻代表作",
          "每张生成后逐条核对五维；掉维就重生成或记录人工修复，不把 outlier 混入最终系列",
          "StyleAligned/LoRA 未接通时只报告固定 seed + 共享 prompt 骨架的实际方法，不宣称注意力共享或适配器已生效",
          "自查表四维打分：五维还原度（≥70%、高权重≥85% 复用临摹阈值）、组内色盘纪律（HEX 主色偏移≤2 档）、构图查重（任意两张的景别/视点/负形三项不完全相同）、题材查重（对照代表作库无单一复刻）",
          "成组张数 6-8 张为人工逐张自查的可控上限；一张一张生成、逐张过自查表后再下一张，掉维重生成不超过 2 次即记人工修复待办",
        ],
        tools: [
          { id: "style_aligned_batch", input: "风格锚 + 清单", output: "成组渲染（风格对齐批量）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 8：归档证物链（图库/DNA卡/对拍/矩阵/skip记录/成组/prompt骨架）
      { role: "archive_gen", kind: "config", title: "证物归档配置", deliverable: "证物归档环节的生图价目与参数配置（model/size/count/单价），内化证物档案按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "evidence_archive",
        kind: "image",
        title: "内化证物档案（来源/seed/版本可复现）",
        deliverable: "内化证物档案：代表作图库、签核 DNA 卡、逐维对拍、3x3 矩阵、LoRA 跳过记录、原创成组与可复用 prompt 骨架",
        gate: "六类核心 artifact 齐全、每一步 gate 决策可追溯、所有 seed/prompt/source node 已登记、unsupported 清单完整、prompt 骨架可单独复用；缺一项不得宣称内化完成",
        notes: [
          "骨架 prompt 拆成笔触、色盘、光观察、构图、材质五个可复用模块，并保留题材层为变量",
          "每张结果旁登记 seed、prompt snapshot、模型、尺寸、来源节点和 gate 结论，确保能复现也能追责",
          "把 StyleAligned、StoryDiffusion、LoRA、VLM 的 unsupported 状态归档，避免后续用户把研究方法误读成已接能力",
          "证物链用 asset_provenance_archive 按节点-资产映射登记：节点 ID、artifact 类型、asset_id 清单、gate 结论与时间戳；要求任一张成品图 3 跳内可追到源原作 asset_id",
          "可复用 prompt 骨架以 JSON 存档：笔触/色盘/光观察/构图/材质五模块各自带使用说明与适用范围，题材层留空位变量；unsupported 清单四项各附当前真实替代方法，防止误读为已接能力",
        ],
        tools: [
          { id: "asset_provenance_archive", input: "物料清单", output: "证物链归档（来源/seed/版本）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
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
