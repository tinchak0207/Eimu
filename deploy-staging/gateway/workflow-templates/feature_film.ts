import type { WorkflowTemplate } from "./types";

export const featureFilmTemplate: WorkflowTemplate = 
  // ── 大片（工业级多镜头）──
  // feature_film 无前端 payload——tools/notes 照 novel_film 密度自写（配方级：
  // 具体数值/工具技術名/可验证判据），每节 2-3 条，节点只动 tools/notes 白名单。
  {
    id: "feature_film",
    name: "大片",
    description:
      "故事脚本 → 角色设定(四视图) → 场景设定 → 每镜头一支影片 → 成片(按镜头顺序拼接全部 shotN_video 输出完整 MP4)。工业级节点流，角色/场景跨镜一致；克隆新镜头后必须把每个 shotN_video 连到 final_cut。",
    multiShot: true,
    nodes: [
      {
        role: "script",
        kind: "text",
        title: "故事脚本 / 分镜",
        deliverable: "结构化故事脚本（场次表 + 逐镜景别/机位/运镜 + 台词按 4.5 字/秒折算时长 + 钩子位标注），一页大纲供用户快速批准",
        gate: "剧本人工批准门禁：用户未确认故事大纲和镜头清单前，禁止进入任何视觉环节",
        notes: [
          "按「场」切分：地点或时间变化即换场；每场提取起止拍、冲突点、情绪值（-5~+5），台词按 4.5 字/秒折算成秒数写进 JSON，后续镜头时长直接引用不重算",
          "每场标记钩子位（悬念/反转/情绪爆点），标注「留住观众的那一帧」候选；成片前 3 秒必须出现第一个钩子（黄金 3 秒法则）",
          "输出同时给机器可读 JSON 和人可读一页大纲，方便用户快速批准；大纲未批准不进任何视觉环节",
        ],
        tools: [
          { id: "script_scene_parse", input: "剧本原文", output: "结构化场次表（场景/节拍/台词按 4.5 字/秒折算时长）" },
          { id: "canvas_get_state", input: "画布", output: "节点/连线快照 JSON" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "character",
        kind: "text",
        title: "角色 A 描述",
        deliverable: "角色圣经（DNA 签名 8 维：脸型/发型/瞳色/体型/服装/配饰/肤色/气质，每维一个固定短语供全片复用，换词=换脸）",
        notes: [
          "DNA 签名 8 维逐维写死为固定短语，后续所有镜头与四视图复用同一短语，禁止同义替换（换词=换脸）",
          "每角色记录专属 seed 与参考图 ID 入资产表；主要角色 2-5 个为宜，配角可合并建档",
        ],
        tools: [
          { id: "character_dna_turnaround", input: "角色设定", output: "角色四视图 + DNA 签名 8 维" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "char_sheet",
        kind: "config",
        title: "角色 A 四视图配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 4, kind: "image", sheet: "4-view", unit_price_coins: 0.001 },
        deliverable: "四视图生成配置（模型/尺寸/张数 + 角色专属固定 seed，材质高光比例写死：金属×1.5、皮肤×0.5）",
      },
      {
        role: "char_view1",
        kind: "image",
        title: "角色 A 正面",
        // 实体宣告（2026-09-24）：四视图是**同一张角色卡的多张参考图**，只标 char_view1——
        // 四颗都标会落四张重复卡。画布侧据 emitsEntity 自动落卡并回填分镜引用。
        // referenceRoles（2026-09-24 四视图聚合）：char_view2/3/4 的交付图是本卡的参考图，
        // 由 expandTemplate 的参考图 post-pass 解成 referenceNodeIds（作者不手写后者）。
        defaults: {
          emitsEntity: { kind: "character", nameFrom: "input", referenceRoles: ["char_view2", "char_view3", "char_view4"] },
        },
        deliverable: "正/侧/背/动作四张设定图，锁定 DNA 签名供全片引用",
        gate: "用户逐角色确认后才进镜头生成（换脸是最大返工源）",
        notes: [
          "四视图同 seed 同批生成，材质高光比例写进签名（金属×1.5、皮肤×0.5）防质感漂移",
          "每张出图后立即与 DNA 签名逐维比对，五官/发型/服装任一维漂移即该张重出，不整批返工",
          "交付本节点时把角色名写进节点 metadata 的 input 字段——画布侧据它自动落成角色卡并当卡名，缺了卡名只能退回节点标题「角色 A 正面」",
        ],
      },
      { role: "char_view2", kind: "image", title: "角色 A 侧面", deliverable: "侧面视图，与正面同 seed 同签名，锁定轮廓与发型基线" },
      { role: "char_view3", kind: "image", title: "角色 A 背面", deliverable: "背面视图，锁定服装背部细节与发型后视图" },
      { role: "char_view4", kind: "image", title: "角色 A 动作", deliverable: "动作视图，锁定典型姿态与服装动态形变（供 I2V 运动参考）" },
      {
        role: "scene",
        kind: "text",
        title: "场景描述",
        deliverable: "美术规范（世界观关键词库 + 色板 + 光照方案 + 材质规范，风格提示词做成固定后缀模板等价于 sref 风格锁）",
        notes: [
          "风格提示词做成固定后缀模板（镜头语言+渲染质感+色板+光照），全片所有生图统一追加，等价于 sref 风格锁；改任一项必须走返工流程并记录原因",
          "色板字段化为 5 个 HEX（主色 3 + 点缀 2），光源方向与色温写死（如 45° 侧逆光、主光 5500K），后续镜头逐字复用，出现规范外主色即判风格漂移",
        ],
      },
      {
        role: "scene_gen",
        kind: "config",
        title: "场景图配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
        deliverable: "场景图生成配置（同一固定 seed 族，只变场景内容不变风格参数）",
      },
      {
        role: "scene_img",
        kind: "image",
        title: "场景图",
        // 实体宣告（2026-09-24）：场景设定图是**一张场景卡**的交付物，画布侧据此自动落卡。
        defaults: { emitsEntity: { kind: "scene", nameFrom: "input" } },
        deliverable: "场景设定图 1-2 张，建档编号充当全部镜头生成的背景参考",
        gate: "风格统一性审计≥70 分（色彩方差/质感一致性/风格关键词命中），不达标回去重修风格模板",
        notes: [
          "每张设定图用同一固定 seed 族生成，只变场景内容不变风格参数，肉眼比对风格漂移；建档编号供镜头生成引用",
          "材质高光比例进规范：金属×1.5、皮肤×0.5，避免不同镜头忽油忽干",
          "交付本节点时把场景名写进节点 metadata 的 input 字段——画布侧据它自动落成场景卡并当卡名，缺了卡名只能退回节点标题「场景图」",
        ],
        tools: [
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "shot1",
        kind: "text",
        title: "镜头 1 脚本",
        deliverable: "镜头脚本（景别/机位/运镜/秒数=台词折算+反应拍 + J/L-cut 转场标记；情绪时序链「听见→停顿→眼神→表情→说话」拆反应镜头）",
        gate: "分镜人工批准门禁：镜头脚本给用户过目确认节奏与构图后才准渲染影片",
        notes: [
          "每镜写清摄影语言：景别（远全中近特）、机位角度、运镜（推拉摇移跟）、秒数=台词折算时长+反应拍，情绪时序链排进镜头设计不拍满面瘫对白",
          "转场预埋 J/L-cut：声音先入或延后 0.5-1s，剪辑阶段直接按标记执行；单镜 3-8 秒为宜，超长拆段拼接",
        ],
      },
      // R8（2026-09-10 暴君裁定）：shot1_gen 不再寫死 model=minimax-h3 / duration=5s——
      // 該模型當前不可用且 5s≠agent 計劃時長，寫死 = 每個大片任務都被逼手動
      // update_node。model 留空由 workflow-service.start 動態選可用視頻模型
      //（/v1/model-status 判活）回填；duration_seconds 留空由 content 裡該鏡
      // shot JSON 的 output.duration_seconds 對齊回填（傳 10s 就 10s，別回 5s）。
      {
        role: "shot1_gen",
        kind: "config",
        title: "镜头 1 影片配置",
        defaults: { size: "16:9", kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 },
        deliverable: "影片生成配置（模型由 workflow-service 动态选活、时长对齐镜头脚本折算；单镜 3-8 秒，超长拆段拼接防崩坏）",
      },
      {
        role: "shot1_video",
        kind: "video",
        title: "镜头 1 影片",
        deliverable: "镜头 MP4（带元数据：时长/分辨率/首尾帧缩略图），以角色四视图+场景图为参考保跨镜一致",
        gate: "逐镜抽帧质检：抽首/中/尾 3 帧比对角色漂移/形变/闪帧，不合格即重生成",
        notes: [
          "镜头间链式衔接：下一镜起始帧可引用上一镜尾帧（last-frame 链），保证动作连续场景不跳变",
          "运动提示词只描述起止帧之间的运动与情绪变化，不重复描述静态外观；单镜时长 3-8 秒，超长拆多段生成后拼接防运动幅度过大崩坏",
        ],
        tools: [
          { id: "last_frame_video_chain", input: "镜头首尾帧 + 镜头顺序", output: "逐镜镜头视频链" },
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
      {
        role: "final_cut",
        kind: "film",
        title: "成片（按镜头顺序拼接全部镜头）",
        deliverable: "成片 MP4（全部镜头按时序拼接 + J/L-cut 转场执行 + 响度对齐 -14 LUFS）+ 逐镜溯源表（每镜关联的关键帧/seed/重渲次数，方便点名返工单镜）",
        gate: "出厂终检：成片完整播放核对口型/节奏/钩子位，用户验收通过即归档",
        notes: [
          "转场按分镜表预埋标记执行：J-cut 声音先入 0.5-1s、L-cut 画面先切声音延后，情绪戏优先 J/L-cut 硬切为辅；混音响度对齐平台规范 -14 LUFS",
          "节奏检查：钩子位前不留空拍，成片前 3 秒必须出现第一个钩子；交付时附逐镜溯源表，每镜关联的关键帧/seed/重渲次数，方便用户点名返工单镜",
        ],
        tools: [
          { id: "editing_manifest", input: "镜头清单", output: "剪辑清单（ffmpeg/剪映引擎声明）" },
          { id: "delivery_assets", input: "成品清单", output: "交付包 URI 清单（多格式）" },
          { id: "canvas_apply_ops", input: "节点/连线操作指令", output: "画布更新结果" },
        ],
      },
    ],
    connections: [
      { fromRole: "character", toRole: "char_sheet" },
      { fromRole: "char_sheet", toRole: "char_view1" },
      { fromRole: "char_sheet", toRole: "char_view2" },
      { fromRole: "char_sheet", toRole: "char_view3" },
      { fromRole: "char_sheet", toRole: "char_view4" },
      { fromRole: "scene", toRole: "scene_gen" },
      { fromRole: "scene_gen", toRole: "scene_img" },
      { fromRole: "script", toRole: "shot1" },
      { fromRole: "shot1", toRole: "shot1_gen" },
      { fromRole: "char_view1", toRole: "shot1_gen" }, // 角色参考 → 影片
      { fromRole: "scene_img", toRole: "shot1_gen" }, // 场景参考 → 影片
      { fromRole: "shot1_gen", toRole: "shot1_video" },
      { fromRole: "shot1_video", toRole: "final_cut" },
    ],
  }
;
