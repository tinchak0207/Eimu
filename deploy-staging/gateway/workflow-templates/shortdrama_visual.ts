import type { WorkflowTemplate } from "./types";

export const shortdramaVisualTemplate: WorkflowTemplate =
  // ── 剧本视觉化（9 环流水线；2026-09-20 注册，对齐前端 agent-shortdrama-visual-assets）──
  // 前端承诺 9 环：拆解剧本→铸造主演资产→锁定分镜→3D 白模预演→渲染关键帧→
  //   合成配音→生成镜头视频→剪辑成片→产出投放物料。
  // 落地形态（诚实对齐引擎能力）：
  //   剧本/分镜=text（结构化文本产出）、主演资产/关键帧/投放物料=image、
  //   3D 白模预演=config（导演台 director 原语未到，暂以 config 承载预演方案节点）、
  //   配音=audio（真实 TTS 闭环；上游不可用时 runNode 如实报错，不造假成功）、
  //   镜头视频=video、剪辑成片=film（真实拼接＋混音＋字幕，同 novel_film/feature_film）。
  // 不造假原则：audio/film 节点可编排、可铺画布，执行时上游缺失即如实回报，
  //   不从模板消失、不用 prompt 冒充成功。
  // tools/notes 真源 = 前端 payload shortdrama-visual-assets.ts 的
  //   steps[].requiredTools / promptNotes，逐字回填到每环主产出节点。
  {
    id: "shortdrama_visual",
    name: "剧本视觉化",
    description:
      "短剧剧本 → 9 环流水线：拆解剧本(text) → 主演资产(image) → 锁定分镜(text) → 3D 白模预演(config，导演台原语未到) → 关键帧(image) → 合成配音(audio) → 镜头视频(video) → 剪辑成片(film) → 投放物料(image)。配音为真实 TTS 生成（上游不可用时执行如实报错，不造假成功），成片为真实拼接＋混音。",
    multiShot: true,
    nodes: [
      // 环 1：拆解剧本（文本环节，无生成）——场次表 + 按角色聚合的台词本（含 TTS 音色）
      {
        role: "script",
        kind: "text",
        title: "结构化场次表＋台词本（场景/节拍/台词按 4.5 字/秒折算）",
        deliverable: "结构化场次 JSON（每场：场景/人物/道具/服装/情绪拍点/钩子位）+ 按角色聚合的台词本（每句标 TTS 音色与语速）",
        gate: "剧本人工批准：用户逐场确认或整体批准后才允许生成任何人物图；拒绝则带理由回流重写，禁止自动越门",
        notes: [
          "场次拍点化：动作与台词交替成拍，台词时长按 4.5 字/秒确定性折算，每集总时长反推拍数",
          "前 3 拍冷开场兑现钩子是硬门：第 1 拍必须抛冲突，不许铺垫超过 10 秒",
          "台词本按角色聚合并带音色提示词，直接对接 TTS，不许后期再对一次角色名",
          "资产清单当场去重：同名人物/场景合并为单一实体，为一致性资产库打地基",
        ],
        tools: [
          { id: "script_scene_parse", input: "剧本原文", output: "结构化场次表（场景/节拍/台词按 4.5 字/秒折算时长）" },
          { id: "canvas_get_state", input: "画布", output: "节点/连线快照 JSON" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 2：铸造主演资产（角色 DNA 签名文本 → 生成配置 → 三视图角色卡；multiShot 可复制多角色）
      { role: "cast", kind: "text", title: "主演角色描述（DNA 签名 8 维 + 音色）", deliverable: "主演角色描述文本（DNA 签名 8 维 + TTS 音色），作为主演资产卡生成的输入契约" },
      { role: "cast_gen", kind: "config", title: "主演资产生成配置", deliverable: "主演资产环节的生图价目与参数配置（model/size/count/单价），三视图角色卡按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "cast_card",
        kind: "image",
        title: "主演资产（三视图 + 情绪九宫格 + 道具状态变体）",
        // 实体宣告（2026-09-24）：主演资产是**一张角色卡**的交付物（三视图/九宫格/变体
        // 同属该角色的参考图），画布侧据此自动落卡并回填分镜引用。
        defaults: { emitsEntity: { kind: "character", nameFrom: "input" } },
        deliverable: "每位主演的角色设定集：正/侧/背三视图 + 面部与服装的 DNA 签名描述串 + 情绪九宫格 + 道具状态变体",
        gate: "人物批准：主演三视图 + DNA 签名经用户确认后才进分镜；单角色可单独重铸不推倒全部",
        notes: [
          "三视图同一 seed 同一次生成，DNA 签名串写进每次出图 prompt 首行——一致性靠「固定 seed + 特征串复述」双保险，不靠运气",
          "场景设定图给一致性锚点（固定机位参照物）+ 尺度参照（门高/桌高），出无人无手白底图，避免手部崩坏污染资产",
          "情绪九宫格必须覆盖本剧情绪拍点表里出现过的所有情绪，后续 I2V 表情靠它当参考图",
          "道具要出「状态变体」：崭新/破损/血渍，剧情里道具变形时直接换图不换描述",
          "交付本节点时把主演角色名写进节点 metadata 的 input 字段（多角色各节点各写各的）——画布侧据它自动落成角色卡并当卡名",
        ],
        tools: [
          { id: "cast_asset_lock", input: "角色名单 + 外观描述", output: "角色三视图锁定卡（DNA 签名 + 专属 seed）" },
          { id: "character_dna_turnaround", input: "角色设定", output: "角色三视图 + DNA 签名 8 维" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 3：锁定分镜（文本环节）——段≤15s/镜 2-5s/9:16/正反打成对（17 道 QC 全过）
      {
        role: "storyboard",
        kind: "text",
        title: "分镜表（逐场逐镜：景别/机位/时长/转场）",
        deliverable: "逐场分镜表：段（一次生成 ≤15 秒）→ 镜（每镜 2-5 秒硬门）→ 每镜 9:16 构图描述 + 机位（正打/反打/过肩）+ 转场标记",
        gate: "17 道分镜质量门全过：段≤15s/镜 2-5s/9:16/正反打成对/轴线连续/切点-台词对账/钩子位前置/资产引用完整/情绪链完整/无手部特写缺失预案/转场标记齐备",
        notes: [
          "9:16 竖屏原生构图：主体占画面 2/3，头顶留 8% 安全区（字幕位），每段 ≤15 秒是生成模型硬上限，超了必拆",
          "正反打成对出：A 视角镜头与 B 视角镜头的视线方向、轴线、背景必须互为镜像，一次生成一对防跳轴",
          "每镜标切点时刻并逐字对账：镜头时长 = 台词字数 ÷ 4.5 + 表演留白，听见→停顿→眼神→表情→说话的情绪时序链在分镜表里就写死",
          "分镜只做输出不做新决定：叙事决定全部在剧本阶段做完，分镜阶段发现的坑记录为剧本批注回流，不擅自改戏",
        ],
        tools: [
          { id: "storyboard_qc_17", input: "分镜表", output: "17 项 QC 报告（通过/阻塞逐项）" },
          { id: "sketch_lock", input: "构图草稿", output: "黑白线稿锁定（低成本验证构图）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 4：3D 白模预演（导演台 director 原语未到 → 暂以 config 承载预演方案）
      {
        role: "previz",
        kind: "config",
        title: "3D 白模预演方案（逐镜构图/运镜/走位，待导演台原语）",
        deliverable: "白模预演方案（逐镜分镜构图/运镜/走位，3D 白模时间线可回放）+ 用户确认过的镜头方案记录",
        defaults: { kind: "director", unit_price_coins: 0 },
        notes: [
          "先 director_get_state 了解导演台工程状态（已有元素/方案/镜头），再动其它 director 工具，不在空工程上盲写",
          "用 director_propose_plans 按分镜表出预演方案（构图/机位/走位），出完停在门禁等用户确认，未确认不落任何镜头动作",
          "确认后 director_apply_proposal 落方案，再用 director_manage_shot/director_upsert_action 逐镜细化走位与运镜，形成可回放的白模预演",
        ],
        tools: [
          { id: "director_get_state", input: "导演台工程", output: "工程状态快照（元素/方案/镜头）" },
          { id: "director_propose_plans", input: "分镜表", output: "预演方案候选（构图/机位/走位）" },
          { id: "director_apply_proposal", input: "用户选定的方案", output: "已应用的镜头方案" },
          { id: "director_manage_shot", input: "镜头操作指令", output: "镜头序列更新结果" },
          { id: "director_upsert_action", input: "走位/运镜动作", output: "动作时间线更新结果" },
        ],
      },
      // 环 5：渲染关键帧（逐镜首尾帧双锁 + CP 剧照 + 色调参照帧）
      { role: "keyframe_gen", kind: "config", title: "关键帧生成配置", deliverable: "关键帧环节的生图价目与参数配置（model/size/count/单价），逐镜首尾帧与 CP 剧照按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "keyframe",
        kind: "image",
        title: "关键帧（每镜首帧/尾帧 + CP 剧照）",
        deliverable: "每镜起始帧（0.00 秒主图）+ 镜内切点子帧图 + 主演 CP 剧照（情绪高潮位双人构图）+ 每场色调参照帧",
        notes: [
          "I2V 起始结束帧双锁：起帧 = 本镜起始帧，尾帧 = 下一镜起始帧（或本镜切点子帧），首尾帧锁定后镜头间才不跳变",
          "参考图权重分层：DNA 签名串放 prompt 首行，三视图控制脸部，场景锚点图控制背景，材质高光比例写死（如「缎面高光 30%/皮肤 60%」）",
          "CP 剧照选情绪拍点表最高分位生成，构图学海报：双人视线引导线交叉，留投放标题位",
          "关键帧出图后立刻与三视图并排比对，脸部相似度肉眼不过关当场重roll，不带病进视频",
        ],
        tools: [
          { id: "keyframe_render", input: "分镜 + 角色锁定卡", output: "逐镜关键帧（首帧/尾帧双图）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 6：合成配音（audio 原语：真实 TTS 闭环；上游不可用时如实报错）
      {
        role: "voiceover",
        kind: "audio",
        title: "配音（TTS 台词音轨 + BGM/音效点位）",
        deliverable: "全剧旁白与台词音轨：按角色聚合的 TTS 成片音频（每句独立文件带时长戳）+ BGM 情绪段标记表（进场/退场秒点）+ 音效点位表",
        notes: [
          "语速锁 4.5 字/秒：TTS 输出实测时长与台词预折算时长偏差 >10% 的句子单独调语速重出，不许后期硬拉伸（会破音）",
          "情绪时序链的「听见→停顿」段落在音轨侧体现：台词间留白 = 表演留白时长，停顿本身是戏，不许压缩",
          "每个角色全剧用一个音色 ID + 固定 seed，跨集不变声；群杂用次要音色池防串音",
          "音频先行于视频：先锁音轨时长，视频段时长向音轨对齐，而不是反过来",
        ],
        tools: [
          { id: "audio_first_timeline", input: "台词表", output: "配音时间轴（含时长锚点）" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 7：生成镜头视频（I2V：关键帧首尾帧 + 角色/场景参考）
      { role: "video_gen", kind: "config", title: "镜头视频生成配置", deliverable: "镜头视频环节的生图价目与参数配置（尺寸/每秒单价），逐镜 I2V 片段按此执行", defaults: { size: "9:16", kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      {
        role: "shot_video",
        kind: "video",
        title: "镜头视频（每镜一段，按 shot_order 命名）",
        deliverable: "每镜一段竖屏原生视频（9:16，I2V），按 shot_order 命名的片段序列 + 失败镜头重试清单",
        notes: [
          "竖屏原生模型优先（Seedance/Kling/MiniMax 竖屏模式），不要横屏出图再裁——裁切会毁构图安全区与主体占比",
          "情绪时序链写进视频 prompt 的时间轴：0s 听见（微转头）→0.5s 停顿（静止）→1s 眼神（看向对方）→1.5s 表情（起情绪）→2s 开口",
          "镜头间连续性用首尾帧链：本镜尾帧 = 下镜首帧（last_frame_url 链式生成），对话正反打共享同一背景帧",
          "运动指令一镜一动词：推/拉/摇/跟/固定，复合运动会糊；单镜时长贴分镜表 2-5 秒，不贪长",
        ],
        tools: [
          { id: "last_frame_video_chain", input: "关键帧首尾帧 + 镜头顺序", output: "逐镜镜头视频链" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 8：剪辑成片（film 原语：真实拼接＋混音＋字幕；与 novel_film/feature_film 同构）
      {
        role: "final_cut",
        kind: "film",
        title: "剪辑成片（拼接+混音+字幕，9:16 竖屏成片）",
        deliverable: "每集成片视频（9:16，含字幕/音轨/BGM 混音）+ 剪映可继续编辑的草稿工程",
        gate: "成片验收：用户看片尾通过或标出秒点问题位；通过前不批量生成后续集",
        notes: [
          "J-cut/L-cut 情绪剪辑：下一镜声音先入 0.3-0.5 秒再切画面（J-cut），或画面先走声音拖尾（L-cut），对话戏与情绪转折戏优先",
          "台词字幕逐字对齐 TTS 时间戳，字号占屏宽 8%/底部安全区，竖屏字幕最多两行",
          "每集成片时长回归剧本折算目标（±10%），超了先剪空镜与留白，不剪台词",
          "导出双轨：成片 mp4 交付 + 剪映草稿工程（字幕/配音/节奏/转场全部可继续编辑）",
        ],
        tools: [
          { id: "editing_manifest", input: "镜头清单", output: "剪辑清单（ffmpeg/剪映引擎声明）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      // 环 9：产出投放物料（竖屏封面 + 预告切片物料）
      { role: "promo_gen", kind: "config", title: "投放物料生成配置", deliverable: "投放物料环节的生图价目与参数配置（model/size/count/单价），竖屏封面与预告切片物料按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1792", count: 3, kind: "image", unit_price_coins: 0.001 } },
      {
        role: "promo",
        kind: "image",
        title: "投放物料（竖屏封面 3 张 + 预告切片封面）",
        deliverable: "每集投放包：竖屏封面图 3 张（钩子位/CP 剧照/反转位各一）+ 15 秒竖屏切片预告（钩子前置版）+ 标题-简介文案",
        notes: [
          "封面标题位预留在上 1/3（9:16 信息流首屏只露上半），人物脸部 + 冲突元素必现，纯氛围图点击率必死",
          "15 秒预告结构：0-3s 冲突钩子（从第 1 拍抽）→3-12s 悬念升级（正反打快剪）→12-15s 断崖卡点留悬念，不剧透反转",
          "文案 A/B/C 同钩子不同角度写（冲突直给/悬念提问/身份反差），配对应封面组测投",
          "全部物料标注来源集数与镜头号，回流资产库可复用",
        ],
        tools: [
          { id: "image_upscale", input: "图片 URL + 放大倍数", output: "放大后图片 URL" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
    ],
    connections: [
      // 主链：按 9 步顺序串联
      { fromRole: "script", toRole: "cast" },
      { fromRole: "cast", toRole: "cast_gen" },
      { fromRole: "cast_gen", toRole: "cast_card" },
      { fromRole: "cast_card", toRole: "storyboard" },
      { fromRole: "storyboard", toRole: "previz" },
      { fromRole: "previz", toRole: "keyframe_gen" },
      { fromRole: "keyframe_gen", toRole: "keyframe" },
      { fromRole: "keyframe", toRole: "video_gen" },
      { fromRole: "video_gen", toRole: "shot_video" },
      { fromRole: "shot_video", toRole: "final_cut" },
      { fromRole: "final_cut", toRole: "promo_gen" },
      { fromRole: "promo_gen", toRole: "promo" },
      // 配音支线（同 novel_film）：台词本 → 配音 → 成片混音，音频先行对齐视频时长
      { fromRole: "script", toRole: "voiceover" },
      { fromRole: "voiceover", toRole: "final_cut" },
      // 参考注入：主演资产锁定三视图/场景锚点 → I2V
      { fromRole: "cast_card", toRole: "video_gen" },
    ],
  }
;
