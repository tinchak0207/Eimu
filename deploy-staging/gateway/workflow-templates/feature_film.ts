import type { WorkflowTemplate } from "./types";

export const featureFilmTemplate: WorkflowTemplate = 
  // ── 大片（工业级多镜头）──
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
      },
      {
        role: "character",
        kind: "text",
        title: "角色 A 描述",
        deliverable: "角色圣经（DNA 签名 8 维：脸型/发型/瞳色/体型/服装/配饰/肤色/气质，每维一个固定短语供全片复用，换词=换脸）",
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
        deliverable: "正/侧/背/动作四张设定图，锁定 DNA 签名供全片引用",
        gate: "用户逐角色确认后才进镜头生成（换脸是最大返工源）",
      },
      { role: "char_view2", kind: "image", title: "角色 A 侧面", deliverable: "侧面视图，与正面同 seed 同签名，锁定轮廓与发型基线" },
      { role: "char_view3", kind: "image", title: "角色 A 背面", deliverable: "背面视图，锁定服装背部细节与发型后视图" },
      { role: "char_view4", kind: "image", title: "角色 A 动作", deliverable: "动作视图，锁定典型姿态与服装动态形变（供 I2V 运动参考）" },
      {
        role: "scene",
        kind: "text",
        title: "场景描述",
        deliverable: "美术规范（世界观关键词库 + 色板 + 光照方案 + 材质规范，风格提示词做成固定后缀模板等价于 sref 风格锁）",
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
        deliverable: "场景设定图 1-2 张，建档编号充当全部镜头生成的背景参考",
        gate: "风格统一性审计≥70 分（色彩方差/质感一致性/风格关键词命中），不达标回去重修风格模板",
      },
      {
        role: "shot1",
        kind: "text",
        title: "镜头 1 脚本",
        deliverable: "镜头脚本（景别/机位/运镜/秒数=台词折算+反应拍 + J/L-cut 转场标记；情绪时序链「听见→停顿→眼神→表情→说话」拆反应镜头）",
        gate: "分镜人工批准门禁：镜头脚本给用户过目确认节奏与构图后才准渲染影片",
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
      },
      {
        role: "final_cut",
        kind: "film",
        title: "成片（按镜头顺序拼接全部镜头）",
        deliverable: "成片 MP4（全部镜头按时序拼接 + J/L-cut 转场执行 + 响度对齐 -14 LUFS）+ 逐镜溯源表（每镜关联的关键帧/seed/重渲次数，方便点名返工单镜）",
        gate: "出厂终检：成片完整播放核对口型/节奏/钩子位，用户验收通过即归档",
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
