import type { WorkflowTemplate } from "./types";

export const featureFilmTemplate: WorkflowTemplate = 
  // ── 大片（工业级多镜头）──
  // feature_film 无前端 payload——tools/notes 照 novel_film 密度自写（配方级：
  // 具体数值/工具技术名/可验证判据），每节 2-3 条，节点只动 tools/notes 白名单。
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
        gate: "当前授权优先：完全访问或自动模式经独立评审自行通过，只有无持续授权或用户明确要求亲自签核时才执行以下人工停点；剧本人工批准门禁：用户未确认故事大纲和镜头清单前，禁止进入任何视觉环节",
        notes: [
          "按「场」切分：地点或时间变化即换场；每场提取起止拍、冲突点、情绪值（-5~+5），台词按 4.5 字/秒折算成秒数写进 JSON，后续镜头时长直接引用不重算",
          "每场标记钩子位（悬念/反转/情绪爆点），标注「留住观众的那一帧」候选；成片前 3 秒必须出现第一个钩子（黄金 3 秒法则）",
          "输出同时给机器可读 JSON 和人可读一页大纲，方便用户快速批准；无持续授权时大纲未批准不进任何视觉环节；完全访问或自动模式经独立评审后继续",
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
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 4, kind: "image", sheet: "4-view"},
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
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image"},
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
        deliverable: "镜头脚本＝状态变化 + 动作 beat 时间线（state_change.from → beats[].at_seconds/action/environment_change → state_change.to；每镜至少一次可见状态变化与一次环境变化）+ 景别/机位/运镜/秒数=台词折算+反应拍 + J/L-cut 转场标记",
        gate: "当前授权优先：完全访问或自动模式经独立评审自行通过，只有无持续授权或用户明确要求亲自签核时才执行以下人工停点；分镜人工批准门禁：镜头脚本给用户过目确认节奏与构图后才准渲染影片",
        notes: [
          "每镜先回答「什么在变」：主体动作、空间关系、环境状态至少一项；答不出来＝这一镜不能开拍。只写景别/机位/运镜/静帧外观＝静态六槽，模型只会做慢推",
          "写 `state_change:{from,to}` 与 `beats:[{at_seconds?,action,environment_change?}]`：action 用物理动词+身体机制+对象交互（压低重心起步冲刺/跃起挥刀/落地滑行），不写「缓缓抬头」这类形容词；at_seconds 严格递增且不越镜头时长",
          "每镜至少一次环境变化（光/风/尘/人群/门帘/水动）；动作/走位/多人/空间关系镜头必须接 3D 预演节点，单人物微表情/产品特写才可跳过",
          "转场预埋 J/L-cut：声音先入或延后 0.5-1s，剪辑阶段直接按标记执行；单镜 3-8 秒为宜，超长拆段拼接",
        ],
      },
      // 3D 预演（2026-10-20 影片范式改革）：kind 必须是 text——gateway 会 skip director kind 节点，
      // 预演能力通过 tools 卡接入 director-engine / blender。位置在镜头脚本之后、影片配置之前；
      // 连线保留 shot1→shot1_gen 直连（expandTemplate 的 R8 多镜克隆依赖这条原型边），
      // 另加 shot1→previz→shot1_gen 保证预演卡按顺序铺开。注意连线本身不传图：
      // 预演帧要成为参考条件，必须把 URL 写进该镜 shot.previz.keyframes（workflow-gw
      // 会并入 reference_images），否则预演只是文本交付。
      {
        role: "previz",
        kind: "text",
        title: "3D 预演（白模 blocking / 机位路径 / 动作模板）",
        deliverable: "每镜白模 blocking + 机位路径 + 动作模板，渲染首/中/尾关键帧；预演帧作为视频生成的参考条件，不是成片；交付含预演帧 + GLB，`.blend` 仅在 blender_* 真实可用时交付，否则明确标注缺失",
        gate: "预演穿模/遮挡矛盾/走位方向冲突不得进入生成；预演帧只锁 blocking 与构图，动作过程仍由 beats 时间线表达；`.blend` 缺失不算失败，但交付必须写明；预演帧/GLB 不得伪造",
        notes: [
          "能力闸门（2026-10-20 现场）：先查真实工具表，确认 blender_exec/blender_render/blender_export_gltf 是否真的可用（不看 SKILL 宣称、不看工具文件存在）；不可用 → 用 bash + 自建几何 + 光栅渲染出首/中/尾关键帧与 GLB，并记下每帧机位/动作参数；禁止用二维文生图冒充 3D 预演；`.blend` 缺失必须在交付标注",
          "动作/走位/多人/空间关系镜头先用 director-engine 白模（L1，免费）或 Blender（L2）定 blocking、机位路径与动作模板；渲染首/中/尾关键帧后，把关键帧 + 运镜 + beats 一起交给视频模型",
          "预演帧必须落成 URL 写进该镜 shot.previz.keyframes（网关会把它们并进 reference_images 传给视频模型）；只放在节点交付文本里不会进生成；首/中/尾至少各一帧",
          "预演帧是参考条件，不是成片也不是首帧硬锁：首帧负责起点，beats 负责过程；单人物微表情/产品特写等不涉及精确几何的镜头可跳过预演，直接首帧 I2V",
          "机位路径与动作事件对齐（跟拍从哪个动作起、急推落在哪个 beat），预演阶段发现的穿模/遮挡/轴线错误先改白模，不留给视频模型猜",
        ],
        tools: [
          { id: "director_manage_shot", input: "镜头操作指令", output: "白模镜头序列更新结果" },
          { id: "director_set_camera_keyframe", input: "机位关键帧（时点+位置）", output: "机位路径时间线" },
          { id: "director_set_motion_keyframe", input: "动作关键帧（时点+姿态）", output: "动作模板时间线" },
          // 能力闸门（2026-10-20 现场）：blender_* 在当前生产席位实际为 false，保留卡面但标记不可用。
          { id: "blender_exec", input: "Blender 建模/摆位脚本", output: "白模场景与动作", unsupported: true },
          { id: "blender_render", input: "白模镜头 + 帧范围", output: "首/中/尾关键帧 PNG", unsupported: true },
          { id: "bash", input: "自建几何/光栅渲染脚本", output: "预演帧 + GLB" },
        ],
      },
      // R8（2026-09-10 暴君裁定）：shot1_gen 不再写死 model=minimax-h3 / duration=5s——
      // 该模型当前不可用且 5s≠agent 计划时长，写死 = 每个大片任务都被逼手动
      // update_node。model 留空由 workflow-service.start 动态选可用视频模型
      //（/v1/model-status 判活）回填；duration_seconds 留空由 content 里该镜
      // shot JSON 的 output.duration_seconds 对齐回填（传 10s 就 10s，别回 5s）。
      {
        role: "shot1_gen",
        kind: "config",
        title: "镜头 1 影片配置",
        defaults: { size: "16:9", kind: "video", },
        deliverable: "影片生成配置（模型由 workflow-service 动态选活、时长对齐镜头脚本折算；动作镜头优先 T2V 或用预演关键帧作参考条件，首帧不是默认条件；单镜 3-8 秒，超长拆段拼接防崩坏）",
      },
      {
        role: "shot1_video",
        kind: "video",
        title: "镜头 1 影片",
        deliverable: "镜头 MP4（带元数据：时长/分辨率/首/中/尾帧缩略图），以角色四视图+场景图+预演关键帧为参考保跨镜一致与动作落点",
        gate: "逐镜抽帧质检：抽首/中/尾 3 帧比对角色漂移/形变/闪帧，不合格即重生成",
        notes: [
          "首帧不是默认条件：动作镜头优先 T2V，或把预演首/中/尾关键帧当参考条件（不锁构图）；只有必须精确复现构图/姿态时才当首帧，且 beats 必须写全",
          "镜头间链式衔接：下一镜起始帧可引用上一镜尾帧（last-frame 链），辅助动作连续；camera.start/end/trajectory/timing/parallax 或时间 keyframes 写入镜头；dolly 为物理位移、zoom 为固定机位变焦，合法 static 保留；首帧跳变不算运镜",
          "模型输出必须过 `video_evidence action=motion` 验收：逐镜读 median_diff/static_ratio，verdict=static 即重做或如实标未达标；全片不得每镜都慢推，至少一镜主体在画面内明显位移",
        ],
        tools: [
          { id: "last_frame_video_chain", input: "预演关键帧/首尾帧 + 镜头顺序", output: "逐镜镜头视频链" },
          { id: "video_evidence", input: "镜头 MP4", output: "动态证据（motion 指标 median_diff/static_ratio + 帧/边界）" },
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
      { fromRole: "shot1", toRole: "previz" },
      { fromRole: "shot1", toRole: "shot1_gen" }, // 直连保留：expandTemplate R8 以此为多镜克隆原型边
      { fromRole: "previz", toRole: "shot1_gen" }, // 3D 预演 → 影片
      { fromRole: "char_view1", toRole: "shot1_gen" }, // 角色参考 → 影片
      { fromRole: "scene_img", toRole: "shot1_gen" }, // 场景参考 → 影片
      { fromRole: "shot1_gen", toRole: "shot1_video" },
      { fromRole: "shot1_video", toRole: "final_cut" },
    ],
  }
;
