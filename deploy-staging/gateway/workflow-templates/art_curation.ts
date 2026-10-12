import type { WorkflowTemplate } from "./types";

export const artCurationTemplate: WorkflowTemplate =
  // ── 策展式创作（8 环流水线，对齐前端 agent-art-curation-series）──
  // 前端承诺 8 环：立意→情绪板→风格锚→构图稿→成组渲染→一致性审计→展陈主视觉→多规格交付。
  // 落地形态（诚实对齐引擎能力）：本流程纯 image/text 两种节点，无 audio/film 环节；
  //   立意/审计=text（结构化文本产出），其余各环=image（单图生成编排）；
  //   image 环一律用「config 生成配置 + image 产出」成对节点，与 novel_film 同构。
  // 未来若延伸配音/成片环节，后端会如实回报「上游暂不可用」，不造假成功。
  // tools/notes 真源 = 前端 payload art-curation-series.ts 的
  //   steps[].requiredTools / promptNotes，逐字回填到每环主产出节点。
  {
    id: "art_curation",
    name: "策展式创作",
    description:
      "主题 → 8 环策展流水线：立意结构化(text) → 情绪板(image) → 风格锚(image) → 构图稿(image) → 成组渲染(image) → 一致性审计(text) → 展陈主视觉(image) → 多规格交付(image)。全链纯 image/text 节点，保持系列作品风格一致性。",
    multiShot: true,
    nodes: [
      // 环 1：立意（文本环节，无生成）
      {
        role: "theme_brief",
        kind: "text",
        title: "策展立意（关键词 JSON + 立意主张句）",
        deliverable: "主题关键词 JSON（题材/时代/情绪/冲突各 3-5 词）+ 一句话策展立意（这个展主张什么）+ 目标观众与展览调性",
        gate: "策展立意必须是一句可陈述的主张句；关键词 JSON 四层字段齐全才放行",
        notes: [
          "先问用户：这个展想让人记住哪一句话？立意先于一切画面",
          "关键词分四层字段化：题材层/视觉层/情绪层/观念层，禁止混杂",
          "立意写成可陈述句而非名词堆砌，例：『城市的孤独在霓虹下更亮』",
          "四层关键词各收 3-5 词后做去重检查：情绪层与观念层出现同义重复即合并，四层合计不超过 20 词，超了先砍修饰词",
          "目标观众写成一句话画像（年龄/看展场景/动机），展览调性从中派生 2-3 个调性词，作为下一步情绪板收敛的唯一判据",
        ],
        tools: [
          { id: "moodboard_diverge_converge", input: "主题词", output: "情绪板（发散→收敛）" },
          { id: "canvas_get_state", input: "画布", output: "节点/连线快照 JSON" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 2：情绪板（单图生成编排）
      { role: "moodboard_gen", kind: "config", title: "情绪板生成配置", deliverable: "情绪板环节的生图价目与参数配置（model/size/count；价格由当前目录取得），情绪板参考图组按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "moodboard",
        kind: "image",
        title: "情绪板（9-12 格参考图）",
        deliverable: "情绪板一组（9-12 格参考图）+ 三类字段化标签：色彩（主色 3 + 点缀色 2，HEX 值）、材质（如哑光颗粒/丝绸）、情绪词",
        gate: "色彩/材质/情绪三类标签齐备且已收敛为唯一方向；存在两套打架的主色即打回",
        notes: [
          "两轮制：第一轮纯发散（每层关键词各搜一轮），第二轮按策展立意砍掉一半以上",
          "每格参考图必须打上三类标签，无标签的图不进板",
          "色彩收敛到唯一方向：主色 3 个 HEX + 点缀 2 个，写死不允许漂移",
          "色彩标签带占比数值：3 个主色合计约 70% 画面覆盖，2 个点缀色合计 ≤10%，其余为中性色与留白，占比进 JSON 字段",
          "材质标签限 2-3 种（如哑光颗粒/丝绸/生锈金属），每种附一句质感短语，后续 style DNA 与审计阈值直接引用该短语",
        ],
        tools: [
          { id: "emotion_board_matrix", input: "情绪关键词", output: "情绪板矩阵图组" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 3：风格锚（canonical key art，全组对表基准）
      { role: "style_gen", kind: "config", title: "风格锚生成配置", deliverable: "风格锚环节的生图价目与参数配置（model/size/count；价格由当前目录取得），canonical key art 按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "style_anchor",
        kind: "image",
        title: "风格锚（canonical key art）",
        // 实体宣告（2026-09-24）：canonical key art + style DNA 是**一张风格卡**的交付物，
        // 画布侧据此自动落卡（后续可 @ 引用该风格锚）。
        defaults: { emitsEntity: { kind: "style", nameFrom: "input" } },
        deliverable: "canonical key art 一张（全展定调之作）+ style DNA 文字描述（笔触/光源/构图法则/渲染质感）",
        gate: "key art 与 style DNA 互证：拿描述反查画面，四个维度全部可指认才算铸成",
        notes: [
          "key art 只出一张定调，这张不过关全组返工，绝不带病下行",
          "style DNA 描述四个维度：笔触肌理、光源法则（方向/硬度/色温）、构图法则、渲染质感",
          "key art 定稿后锁定为 sref / 风格参考锚，成组阶段所有图共用此锚",
          "prompt 里显式写『本作为本展 canonical key art，气质 = 立意句』",
          "光源法则写成可执行参数：方向（如 45° 侧逆光）+ 硬度（硬光/柔光）+ 色温（如主光 5500K 暖补 3200K），全系列生图逐字复用，换词=换气质",
          "交付本节点时把风格名写进节点 metadata 的 input 字段——画布侧据它自动落成风格卡并当卡名，缺了卡名只能退回节点标题「风格锚（canonical key art）」",
        ],
        tools: [
          { id: "style_anchor_sref", input: "风格参考图", output: "风格锚（sref 级固定后缀模板）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 4：构图稿（黑白 sketch-lock）
      { role: "composition_gen", kind: "config", title: "构图稿生成配置", deliverable: "构图稿环节的生图价目与参数配置（model/size/count；价格由当前目录取得），黑白 sketch-lock 线稿按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "composition",
        kind: "image",
        title: "构图稿（黑白线稿）",
        deliverable: "全组每张的黑白构图稿（thumbnail sketch）+ 统一呼吸感说明（留白占画面比例区间、视线动线走向）",
        gate: "黑白稿并排时留白节奏统一、视觉焦点不超标；任一张黑白灰关系跳脱全组即重画该张",
        notes: [
          "sketch-lock：每张先出纯黑白构图稿，色彩完全后置，只谈黑白灰分布与视觉重量",
          "统一呼吸感：全组留白占比定一个区间（如 30%-45%），张与张之间留白节奏差异不超过一档",
          "规划观展动线：把 5-6 张构图按起承转合排序，开场留白最足、高潮密度最高（StoryDiffusion 实测 5-6 条 prompt 布局）",
          "每张构图稿标注：主体位置九宫格坐标 + 视觉焦点数（1-2 个，不超）",
          "黑白稿统一走低分辨率先行（如 768px 档）快速迭代，构图批准后彩色成稿才上 1024x1024 / 1536x1024 正式规格，把返工成本压在灰度阶段",
        ],
        tools: [
          { id: "sketch_lock", input: "构图草稿", output: "黑白线稿锁定（低成本验证构图）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 5：成组渲染（同风格锚批量成稿）
      { role: "batch_gen", kind: "config", title: "成组渲染配置", deliverable: "成组渲染环节的生图价目与参数配置（model/size/count；价格由当前目录取得），成组彩色成稿按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "batch_render",
        kind: "image",
        title: "成组彩色成稿",
        deliverable: "成组彩色成稿 5-6 张（全组同 seed 域、同风格锚）",
        gate: "全组并排：色温一致、光源方向一致、笔触密度目测同级；两张放在一起像同一个展的作品才算过",
        notes: [
          "StyleAligned 注意力共享：全组同 batch 生成，去噪早期步共享 self-attention 的 Q/K，让各张在风格层互相校准",
          "共享强度调平衡：注意力共享太少风格不一致，太多图像趋同——早期步共享、后期步放任自采，保布局差异",
          "固定 seed 策略：全组共用同一 seed 基准，保证色彩系统与笔触基因同源",
          "逐张对表：每张成稿出来立即对照 style DNA 四维 + 色板 HEX，不对表不进组",
          "每张 prompt 结构 = 构图稿九宫格坐标 + style DNA 固定后缀 + 立意句气质词，只换主体与景别字段，风格字段逐字不变，防止 prompt 层引入漂移",
        ],
        tools: [
          { id: "style_aligned_batch", input: "风格锚 + 清单", output: "成组渲染（风格对齐批量）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 6：一致性审计（文本环节：审计表 + outlier 重生清单）
      {
        role: "audit",
        kind: "text",
        title: "一致性审计表（色盘/笔触/留白 + outlier 清单）",
        deliverable: "一致性审计表（每张的色盘偏离度、笔触密度、留白占比数值）+ outlier 张重生命令清单",
        gate: "全组零 outlier：每张色盘偏离度、笔触密度、留白占比三项数值全部落入门禁区间，不达标张必须重生并复审",
        notes: [
          "色盘审计：逐张提取主色 HEX，与锁定的 3 主色 + 2 点缀比对，色相偏移超阈值即标记 outlier",
          "笔触密度审计：统计画面纹理/笔触覆盖密度，与 key art 基准比对，密度差超一档即标记",
          "outlier 只重生标记张，不带病重跑全组：重生时沿用同 seed 域 + 同风格锚 + 同黑白构图稿",
          "审计不过的张退回上一步的构图稿，检查是否构图本身引入了不可救的偏离",
          "三项数值门禁写死：色相偏移 >8° 或主色与锁定 HEX 色差 ΔE>12 记 outlier；笔触密度与 key art 基准差 >15% 记超标；留白占比须落在 30%-45%，单张偏差超 ±5 个百分点打回",
        ],
        tools: [
          { id: "outlier_audit_regenerate", input: "成组图", output: "离群审计 + 重生指令" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 7：展陈主视觉（海报/墙面布置/图录）
      { role: "exhibition_gen", kind: "config", title: "展陈主视觉生成配置", deliverable: "展陈主视觉环节的生图价目与参数配置（model/size/count；价格由当前目录取得），海报/墙面模拟/图录按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "exhibition_visual",
        kind: "image",
        title: "展陈主视觉（海报/墙面/图录）",
        deliverable: "展览海报 1 张（key art 为主视觉 + 展名 + 立意句排版）+ 墙面布置模拟图（成组作品挂墙观展动线）+ 图录版式",
        gate: "海报、墙面模拟、图录三者并排观感统一：同色系、同留白节奏、同立意表达；任何一个像另一个展的物料即重排",
        notes: [
          "海报 = key art + 立意句：主视觉直接复用风格锚，展名字体气质与 style DNA 同源，不另起炉灶",
          "墙面模拟按观展动线排：把起承转合的成组排序落到墙面，留白节奏延续到挂画间距",
          "图录版式：每件作品配展签文案（作品名/媒介/尺寸/一句话阐释），阐释从立意句派生",
          "展陈视觉的排版留白与作品留白节奏同频，观感是同一个展而不是拼盘",
          "墙面动线量化：单面墙挂 3-4 幅为限，挂画中心线统一 150cm 视平高度，间距取单幅宽的 50%-80%；起（开场）墙留白最足，合（收尾）墙挂最强一张回扣立意句",
        ],
        tools: [
          { id: "canonical_key_art_lock", input: "风格锚 + 主体", output: "主视觉锁定卡" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 8：多规格交付（印刷级文件 + 线上展厅素材）
      { role: "delivery_gen", kind: "config", title: "多规格交付生成配置", deliverable: "多规格交付环节的生图价目与参数配置（model/size/count；价格由当前目录取得），印刷级成品与展厅素材按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"} },
      {
        role: "delivery",
        kind: "image",
        title: "多规格交付包（印刷级 + 展厅素材）",
        deliverable: "印刷级成品包（300 DPI 印刷分辨率作品文件 + 展签成品文案）+ 线上 3D 展厅素材包（展厅空间图 + 挂点布置图）",
        gate: "抽查任一印刷文件的分辨率达 300 DPI 且画幅像素量正确；线上展厅挂点数与作品数一致；缺一项即补齐后才算交付完成",
        notes: [
          "印刷规范：作品按 300 DPI 出印刷分辨率，按目标画幅（如 A2/A1）计算像素量，不做低清放大",
          "展签成品：每件作品一张展签（作品名/媒介/尺寸/年份/一句话阐释），字号规范统一",
          "线上 3D 展厅：生成展厅空间 + 挂点图，作品位置沿用墙面模拟的动线，灯光方案延续 key art 光源法则",
          "交付前逐张核对色彩：印刷用途做 CMYK 预检提示，线上素材保持 HEX 色板原样",
          "像素量按公式算死：A2（420×594mm）@300DPI = 4961×7016px，A1（594×841mm）= 7016×9933px，各加 3mm 出血；CMYK 预检项：总墨量 TAC ≤300%、小字用 K100 单色黑、超出色域色标注最接近替代",
        ],
        tools: [
          { id: "exhibition_delivery_manifest", input: "展陈主视觉", output: "多规格交付清单" },
          { id: "multi_aspect_reflow", input: "主视觉", output: "多画幅切图（横/竖/方）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
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
