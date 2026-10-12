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
  // tools/notes 真源 = 前端 payload novel-ip-visual-pack.ts 的
  //   steps[].requiredTools / promptNotes，逐字回填到每环主产出节点。
  {
    id: "novel_ip",
    name: "IP视觉包",
    description:
      "网文 IP 全案视觉 → 8 环流水线：拆解世界观(text) → 炼情绪板(image) → 铸风格锚(image) → 建主角资产(image) → 绘名场面组图(image) → 造封面主视觉(image) → 出多画幅(image) → 铺衍生物料(image)。纯 image/text 两原语编排，风格锚先行、后续各环沿用同一锚，杜绝风格漂移。",
    multiShot: true,
    nodes: [
      // 环 1：拆解世界观（文本环节，无生成）
      {
        role: "world_bible",
        kind: "text",
        title: "世界观圣经（色彩域 HEX + 材质表 + 名场面候选 + 可绘制元素清单）",
        deliverable: "世界观圣经结构化卡（色彩域 HEX + 材质表 + 3 个名场面候选）+ 可绘制元素清单",
        gate: "世界观关键元素清单人工确认后才进情绪板",
        notes: [
          "LLM 先抽取可绘制元素再做情绪板：world_bible_extract 跑全文出关键词库/地理/势力三段 JSON，关键词去重后按出现频次只留前 30 个，超出即砍",
          "世界观色彩域字段化为 5 个 HEX（主色 3 + 点缀 2），材质表按金属/皮肤/布料/环境四类各写一条高光比例（金属×1.5、皮肤×0.5），后续所有生图按此表查",
          "名场面候选固定给 3 个，各配一行钩子说明（悬念/反转/情绪爆点）+ 情绪值（-5~+5），让用户有的比，不搞单选绑架",
          "可绘制元素清单按场景/道具/人物三类编号建档（scene-01/prop-01/char-01），后续步骤引用编号不重写描述，防止转述走样",
        ],
        tools: [
          { id: "world_bible_extract", input: "小说文本", output: "世界观 JSON（关键词库/地理/势力）" },
          { id: "canvas_get_state", input: "画布", output: "节点/连线快照 JSON" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 2：炼情绪板（单图生成的编排序列）
      {
        role: "mood_gen",
        kind: "config",
        title: "情绪板生成配置",
        deliverable: "情绪板环节的生图价目与参数配置（model/size/count；价格由当前目录取得），情绪板成图按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "mood_board",
        kind: "image",
        title: "3x3 情绪板 + 情绪坐标轴",
        deliverable: "3x3 情绪板 + 情绪坐标轴（题材频道定位）",
        gate: "情绪板盲测门禁：拿给无关者猜题材频道，猜不对回炉重炼",
        notes: [
          "情绪板两轮制：第一轮用 emotion_board_matrix 发散出 3x3 共 9 格，第二轮按频道定位收敛砍到方向唯一的 1 组",
          "收敛判据量化：9 格中 ≥7 格命中同一频道关键词（男频=史诗/战场/权谋，女频=氛围/情感/留白）才算收敛，不达标换种子关键词回炉重炼",
          "色彩收敛到主色 3 HEX + 点缀 2 HEX 写死进配方，后续任何图出现规范外主色即判风格漂移，直接返工",
          "每格配 1-2 词情绪标签且格子间不重复；情绪坐标轴标注本作在「热血↔治愈」「暗黑↔明亮」两轴的落点，给封面构图选型当依据",
        ],
        tools: [
          { id: "emotion_board_matrix", input: "情绪关键词", output: "情绪板矩阵图组" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 3：铸风格锚（canonical key art + sref 配方冻结）
      {
        role: "style_gen",
        kind: "config",
        title: "风格锚生成配置",
        deliverable: "风格锚环节的生图价目与参数配置（model/size/count；价格由当前目录取得），key art 定调图按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "style_anchor",
        kind: "image",
        title: "风格锚（canonical key art + sref 配方）",
        // 实体宣告（2026-09-24）：canonical key art + 冻结 sref 配方是**一张风格卡**的
        // 交付物，画布侧据此自动落卡（后续可 @ 引用该风格锚）。
        defaults: { emitsEntity: { kind: "style", nameFrom: "input" } },
        deliverable: "canonical key art 一张（全案定调）+ sref 码/权重/seed 配方冻结",
        gate: "风格锚配方复测门禁：同配方复测 2 次无偏差才算铸成",
        notes: [
          "key art 只出一张 16:9 定调（视点拉远交代史诗尺度），不过关全组返工，绝不带病下行",
          "sref 权重测试法：0.4/0.5/0.6/0.7 四档各出 1 图，按色彩/质感/笔触三项比对情绪板打分，选命中度最高档冻结",
          "冻结配方三件套写进锁定卡：sref 码 + 权重 + seed，全案后续生图逐字复用，改任一项必须走返工流程并记录原因",
          "配方复测：同配方重跑 2 次肉眼比对色彩方差与构图逻辑，无偏差才算铸成；有偏差说明 seed 不稳，换 seed 后四档重测",
          "交付本节点时把风格名写进节点 metadata 的 input 字段——画布侧据它自动落成风格卡并当卡名，缺了卡名只能退回节点标题「风格锚（canonical key art + sref 配方）」",
        ],
        tools: [
          { id: "style_anchor_sref", input: "风格参考图", output: "风格锚（sref 级固定后缀模板）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 4：建主角资产（DNA 签名 + 三视图 + 表情差列）
      {
        role: "char_gen",
        kind: "config",
        title: "主角资产生成配置",
        deliverable: "主角资产环节的生图价目与参数配置（model/size/count；价格由当前目录取得），三视图与表情差列按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "char_card",
        kind: "image",
        title: "主角资产卡（三视图 + 表情差列）",
        // 实体宣告（2026-09-24）：三视图与表情差列是**一张角色卡**的交付物，
        // 画布侧据此自动落卡并回填分镜引用。
        defaults: { emitsEntity: { kind: "character", nameFrom: "input" } },
        deliverable: "主角 DNA 签名 8 维表 + 三视图 + 表情差列 6 格",
        gate: "洗牌盲认门禁：三视图与表情列打乱后用户仍能认出同一角色",
        notes: [
          "DNA 签名 8 维（脸型/发型/瞳色/体型/服装/配饰/肤色/气质）逐字段写死为固定短语，后续所有图复用同一短语，禁止同义替换（换词=换脸）",
          "三视图（正面特写/全身/侧面）用同一 seed 同一次生成锁 face_identity；材质高光比例随 DNA 附带（金属×1.5、皮肤×0.5）防质感漂移",
          "表情差列 6 格固定覆盖喜/怒/哀/惧/狂/静，同 seed 只换情绪关键词，后续 Q 版与表情包物料直接从这 6 格取情绪不重画",
          "每角色记录专属 seed 与参考图 ID 入资产表；主角必须单独成卡，配角 2-3 个可合并建档，被并档的配角进名场面前先补卡",
          "交付本节点时把角色名写进节点 metadata 的 input 字段——画布侧据它自动落成角色卡并当卡名，缺了卡名只能退回节点标题「主角资产卡（三视图 + 表情差列）」",
        ],
        tools: [
          { id: "character_dna_turnaround", input: "角色设定", output: "角色三视图 + DNA 签名 8 维" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 5：绘名场面组图（序列一致性；multiShot 逐场复制）
      {
        role: "scene_gen",
        kind: "config",
        title: "名场面组图生成配置",
        deliverable: "名场面组图环节的生图价目与参数配置（model/size/count；价格由当前目录取得），序列分镜图按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "scene_set",
        kind: "image",
        title: "名场面组图（序列化分镜图组）",
        deliverable: "3-5 张序列化分镜名场面（先 sketch-lock 黑白构图稿后成图）",
        gate: "并排零漂移门禁：组图并排后角色/风格零漂移才算过",
        notes: [
          "先 sketch-lock 黑白构图稿：3-5 张名场面先全铺线稿验证叙事节奏与构图，构图错重画线稿成本远低于重出成图",
          "序列内共享 DNA 8 维全文 + 场景锚编号，5-6 条 prompt 做版面安排；每张写明景别/机位/光位三字段，光位全程统一不许打架",
          "三景别节奏固定：全景建场→中景关系→特写爆点；特写对应钩子位多出 2 候选择优，落选帧留档不删",
          "用 story_sequence_consistency 做跨图一致性检查：组图并排后角色脸/服装/配色与三视图逐一比对，零漂移才过门禁",
        ],
        tools: [
          { id: "story_sequence_consistency", input: "名场面清单 + 角色卡", output: "序列图组（跨图一致性）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 6：造封面主视觉（竖版 + 书名区留白）
      {
        role: "cover_gen",
        kind: "config",
        title: "封面主视觉生成配置",
        deliverable: "封面主视觉环节的生图价目与参数配置（model/size/count；价格由当前目录取得），竖版封面按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "cover_key_art",
        kind: "image",
        title: "封面主视觉（竖版 + 书名区留白版）",
        deliverable: "竖版封面主视觉 + 书名区留白版（男频仰拍/女频留白双构图）",
        gate: "当前授权优先：完全访问或自动模式经独立评审自行通过，只有无持续授权或用户明确要求亲自签核时才执行以下人工停点；主视觉人工批准后出多画幅适配版",
        notes: [
          "按频道选构图：男频仰拍拉气场（低机位、人物占画面 60%+、透视向上），女频留白造氛围（人物约 40%、负空间承接情绪）",
          "顶部 1/3 留书名区：竖版 3:4 按 600x800 出图，书名区约 y=0-266px 保持低细节近平色，人物主体压下半区拉气势",
          "文字后排版：主视觉区禁 AI 文字，任何乱码不允许出现在封面主视觉；书名/笔名由用户后期排版叠加到预留区",
          "用 canonical_key_art_lock 出仰拍/留白双构图各 1 张给用户二选一，选定即锁卡冻结，多画幅只从锁定版派生不再改设定",
        ],
        tools: [
          { id: "canonical_key_art_lock", input: "风格锚 + 主体", output: "主视觉锁定卡" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 7：出多画幅（每画幅重构图）
      {
        role: "aspect_gen",
        kind: "config",
        title: "多画幅生成配置",
        deliverable: "多画幅环节的生图价目与参数配置（model/size/count；价格由当前目录取得），各画幅重构图按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "aspect_pack",
        kind: "image",
        title: "多画幅包（3:4 / 1:1 / 9:16）",
        deliverable: "封面多画幅包（3:4/1:1/9:16）+ 平台安全区核对清单（起点竖版/B 站 16:9 等）",
        gate: "多画幅套检门禁：任一画幅安全区/分辨率不达标即打回重排",
        notes: [
          "每画幅用 multi_aspect_reflow 重新构图而非裁切：主体与书名区随画幅重排，禁止简单 center-crop 砍头砍手",
          "尺寸基准写死：3:4 = 600x800（起点/QQ阅读竖版）、1:1 = 1080x1080（社媒信息流）、9:16 = 1080x1920（短视频封面/抖音）、16:9 = 1920x1080（B 站/横版 banner）",
          "平台安全区核对清单逐项过：起点竖版避让顶部 25% 书名区、B 站 16:9 右下 15% 区域留空避让时长角标、抖音 9:16 底部 20% 避让账号信息条",
          "每画幅出图后跑套检三项：书名区完整、主体无截断、分辨率达标；任一不过打回重排，全过才入交付包",
        ],
        tools: [
          { id: "multi_aspect_reflow", input: "主视觉", output: "多画幅切图（横/竖/方）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 8：铺衍生物料（头像/立绘/海报/表情包 + 归档）
      {
        role: "derivative_gen",
        kind: "config",
        title: "衍生物料生成配置",
        deliverable: "衍生物料环节的生图价目与参数配置（model/size/count；价格由当前目录取得），头像/立绘/海报/表情包按此执行",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
      },
      {
        role: "derivative_pack",
        kind: "image",
        title: "衍生物料（头像/立绘/海报/Q 版表情包）",
        deliverable: "头像/立绘/海报/Q 版表情包 + 归档（附 DNA 表与 sref 配方副本）",
        gate: "归档完整性门禁：DNA 表/sref 配方/衍生物料三者齐备才算完成",
        notes: [
          "全部衍生物料从锁定资产派生（DNA 表 + key art + 多画幅包），不做新设定不引入规范外色彩，风格漂移当场指出",
          "物料规格固定：头像 512x512、立绘竖版 1024x1536（透明底便于运营抠图）、海报 16:9 1920x1080、Q 版表情包 8-12 张 240x240",
          "Q 版表情包用表情差列 6 格（喜/怒/哀/惧/狂/静）直取情绪扩展到 8-12 张，同 seed 只换情绪关键词，保证 IP 表情体系统一",
          "归档用 asset_provenance_archive 记证物链：每件物料附来源资产 ID/seed/sref 配方/版本号，续作时按链复原不重炼",
        ],
        tools: [
          { id: "asset_provenance_archive", input: "物料清单", output: "证物链归档（来源/seed/版本）" },
          { id: "multi_aspect_reflow", input: "主视觉", output: "多画幅切图（横/竖/方）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
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
