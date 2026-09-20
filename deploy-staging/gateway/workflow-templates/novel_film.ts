import type { WorkflowTemplate } from "./types";

export const novelFilmTemplate: WorkflowTemplate = 
  // ── 小说成片（8 环流水线；2026-08-27 注册，对齐前端 agent-novel-film-pipeline）──
  // 前端承诺 8 环：剧本→角色卡→美术卡→分镜→关键帧→视频→配音→成片。
  // 落地形态（诚实对齐引擎能力）：
  //   剧本=text（结构化文本产出）、角色卡/美术卡=image（单图生成编排）、
  //   分镜=text、关键帧=image、视频=video（现有 single_video 能力）、
  //   配音=audio、成片=film——audio/film 为新原语：可编排、可铺画布、
  //   执行时如实回报「上游不可用」，不从模板消失、不造假成功。
  {
    id: "novel_film",
    name: "小说成片",
    description:
      "小说文本 → 8 环流水线：剧本(text) → 角色卡(image) → 美术卡(image) → 分镜(text) → 关键帧(image) → 视频(video) → 配音(audio) → 成片(film)。配音为真实 TTS 生成、成片为真实拼接＋混音（上游不可用时执行如实报错，不造假成功）。",
    multiShot: true,
    nodes: [
      // 环 1：剧本（文本环节，无生成）
      {
        role: "novel",
        kind: "text",
        title: "小说原文",
        deliverable: "小说原文（题材/主角设定/章节文本），作为全链首个资产注入流水线",
      },
      {
        role: "script",
        kind: "text",
        title: "结构化剧本（场次表/节拍/台词折算）",
        deliverable: "结构化剧本 JSON（场次表 + 节拍 beat list + 台词表按 4.5 字/秒折算时长 + 每场钩子位标注 + 情绪曲线标注）+ 一页故事大纲",
        gate: "剧本人工批准门禁：用户未确认大纲和场次表前，禁止进入任何视觉环节",
      },
      // 环 2：角色卡（单图生成的编排序列；multiShot 可复制多角色）
      {
        role: "character",
        kind: "text",
        title: "角色描述（DNA 签名 8 维）",
        deliverable: "角色圣经 JSON（每角色 DNA 签名 8 维：脸型/发型/瞳色/体型/服装/配饰/肤色/气质）",
      },
      {
        role: "char_gen",
        kind: "config",
        title: "角色卡生成配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
        deliverable: "角色卡生成配置（模型/尺寸/张数/固定 seed），锁定三视图生成参数供全片复用",
      },
      {
        role: "char_card",
        kind: "image",
        title: "角色卡（三视图）",
        deliverable: "每角色三视图关键帧（正面/全身/侧面），锁定 face_identity 面部基线与 look_lock 造型",
        gate: "角色三视图人工确认门禁：用户逐角色点头后才可进美术阶段（换脸是成片最大返工源）",
      },
      // 环 3：美术卡
      {
        role: "art_brief",
        kind: "text",
        title: "美术规范（色板/光照/材质）",
        deliverable: "美术圣经 JSON（世界观关键词库 + 色板 + 光照方案 + 材质规范）",
      },
      {
        role: "art_gen",
        kind: "config",
        title: "美术卡生成配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
        deliverable: "美术卡生成配置（同一固定 seed 族，只变场景内容不变风格参数，等价于 sref 风格锁）",
      },
      {
        role: "art_card",
        kind: "image",
        title: "美术卡（场景设定图）",
        deliverable: "每场景设定图 1-2 张 + 统一风格参考图组（材质高光比例进规范：金属×1.5、皮肤×0.5），建档编号供镜头生成引用",
        gate: "风格统一性审计≥70 分：设定图组跑视觉审计（色彩方差/质感一致性/风格关键词命中），低于 70 分回去重修风格模板",
      },
      // 环 4：分镜（文本环节）
      {
        role: "storyboard",
        kind: "text",
        title: "分镜表（逐镜景别/机位/运镜/时长）",
        deliverable: "分镜表 JSON（逐镜：景别/机位/运镜/时长取自台词折算/转场标记 J-cut 或 L-cut）+ 黑白 sketch-lock 线稿分镜板（低成本低分辨率先行）",
        gate: "分镜人工批准门禁：sketch 板 + 分镜表给用户过目，确认节奏与构图后才准进关键帧渲染",
      },
      // 环 5：关键帧（逐镜首帧；分镜 → 关键帧 → 视频链式）
      {
        role: "keyframe_gen",
        kind: "config",
        title: "关键帧生成配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
        deliverable: "关键帧生成配置（角色 DNA 短语原文复用 + 专属固定 seed + 三视图参考图三重锁）",
      },
      {
        role: "keyframe",
        kind: "image",
        title: "关键帧（镜头首帧）",
        deliverable: "逐镜头彩色关键帧 PNG（全镜头覆盖）+ 每镜首帧/尾帧双图（供 I2V 起止帧用）+ 失败镜头重渲记录；钩子位镜头多出 2-3 候选帧",
        gate: "逐镜一致性检查门禁：每镜关键帧与角色三视图比对（脸部/服装/配色），不一致镜头打回重渲，全镜头通过才进视频合成",
      },
      // 环 6：视频（I2V：关键帧 + 角色/场景参考）
      {
        role: "video_gen",
        kind: "config",
        title: "视频生成配置",
        defaults: { model: "minimax-h3", size: "16:9", duration_seconds: 15, kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 },
        deliverable: "视频生成配置（I2V 双帧法：起始帧定入场、结束帧定落点；单镜 3-8 秒，超长拆段拼接）",
      },
      {
        role: "shot_video",
        kind: "video",
        title: "镜头视频",
        deliverable: "逐镜头视频片段 MP4（I2V 起止帧驱动）+ 镜头元数据（时长/分辨率/首尾帧缩略图）+ 失败重试记录；镜头间 last-frame 链式衔接保证动作连续",
        gate: "逐镜抽帧质检：每段视频抽首/中/尾 3 帧与关键帧比对，出现明显形变/闪帧/角色漂移即重生成",
      },
      // 环 7：配音（audio 原语：编排存在，执行诚实报上游）
      {
        role: "voiceover",
        kind: "audio",
        title: "配音（TTS 台词音轨）",
        deliverable: "逐镜头配音音轨（TTS 按台词表生成，语速对齐 4.5 字/秒折算时长）+ BGM 分段音轨（按情绪曲线标注定情绪与入出点）+ 音效点位表",
        gate: "音画对齐抽检：随机抽 3 个对白镜头核对人声时长与口型镜头时长偏差≤0.5s，超标回炉",
      },
      // 环 8：成片（film 原语：编排存在，执行诚实报上游）
      {
        role: "final_cut",
        kind: "film",
        title: "成片（拼接+混音+字幕）",
        deliverable: "成片 MP4（全镜头按时序拼接 + J/L-cut 转场执行 + 音轨混音，响度对齐 -14 LUFS）+ 字幕轨（SRT 按台词时间码）+ 封面帧 + 逐镜溯源表",
        gate: "出厂终检：成片完整播放一遍核对口型/字幕/响度/钩子位节奏，统计表随片交付；用户验收通过即归档全流水线资产",
      },
    ],
    connections: [
      { fromRole: "novel", toRole: "script" },
      { fromRole: "script", toRole: "character" },
      { fromRole: "character", toRole: "char_gen" },
      { fromRole: "char_gen", toRole: "char_card" },
      { fromRole: "script", toRole: "art_brief" },
      { fromRole: "art_brief", toRole: "art_gen" },
      { fromRole: "art_gen", toRole: "art_card" },
      { fromRole: "script", toRole: "storyboard" },
      { fromRole: "storyboard", toRole: "keyframe_gen" },
      { fromRole: "keyframe_gen", toRole: "keyframe" },
      { fromRole: "keyframe", toRole: "video_gen" },
      { fromRole: "char_card", toRole: "video_gen" }, // 角色参考 → 视频
      { fromRole: "art_card", toRole: "video_gen" }, // 场景参考 → 视频
      { fromRole: "video_gen", toRole: "shot_video" },
      { fromRole: "storyboard", toRole: "voiceover" }, // 台词表 → 配音
      { fromRole: "shot_video", toRole: "final_cut" },
      { fromRole: "voiceover", toRole: "final_cut" },
    ],
  }
;
