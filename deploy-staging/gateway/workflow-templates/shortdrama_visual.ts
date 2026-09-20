import type { WorkflowTemplate } from "./types";

export const shortdramaVisualTemplate: WorkflowTemplate =
  // ── 剧本视觉化（9 环流水线；2026-09-20 注册，对齐前端 agent-shortdrama-visual-assets）──
  // 前端承诺 9 环：拆解剧本→铸造主演资产→锁定分镜→3D 白模预演→渲染关键帧→
  //   合成配音→生成镜头视频→剪辑成片→产出投放物料。
  // 落地形态（诚实对齐引擎能力）：
  //   剧本/分镜=text（结构化文本产出）、主演资产/关键帧/投放物料=image、
  //   3D 白模预演=config（导演台 director 原语未到，暫以 config 承载预演方案节点）、
  //   配音=audio（真实 TTS 閉環；上游不可用时 runNode 如实报错，不造假成功）、
  //   镜头视频=video、剪辑成片=film（真实拼接＋混音＋字幕，同 novel_film/feature_film）。
  // 不造假原则：audio/film 节点可编排、可铺画布，执行时上游缺失即如实回报，
  //   不从模板消失、不用 prompt 冒充成功。
  {
    id: "shortdrama_visual",
    name: "剧本视觉化",
    description:
      "短剧剧本 → 9 环流水线：拆解剧本(text) → 主演资产(image) → 锁定分镜(text) → 3D 白模预演(config，导演台原语未到) → 关键帧(image) → 合成配音(audio) → 镜头视频(video) → 剪辑成片(film) → 投放物料(image)。配音为真实 TTS 生成（上游不可用时执行如实报错，不造假成功），成片为真实拼接＋混音。",
    multiShot: true,
    nodes: [
      // 环 1：拆解剧本（文本环节，无生成）——场次表 + 按角色聚合的台词本（含 TTS 音色）
      { role: "script", kind: "text", title: "结构化场次表＋台词本（场景/节拍/台词按 4.5 字/秒折算）", deliverable: "结构化场次 JSON（每场：场景/人物/道具/服装/情绪拍点/钩子位）+ 按角色聚合的台词本（每句标 TTS 音色与语速）", gate: "剧本人工批准：用户逐场确认或整体批准后才允许生成任何人物图；拒绝则带理由回流重写，禁止自动越门" },
      // 环 2：铸造主演资产（角色 DNA 签名文本 → 生成配置 → 三视图角色卡；multiShot 可复制多角色）
      { role: "cast", kind: "text", title: "主演角色描述（DNA 签名 8 维 + 音色）", deliverable: "主演角色描述文本（DNA 签名 8 维 + TTS 音色），作为主演资产卡生成的输入契约" },
      { role: "cast_gen", kind: "config", title: "主演资产生成配置", deliverable: "主演资产环节的生图价目与参数配置（model/size/count/单价），三视图角色卡按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "cast_card", kind: "image", title: "主演资产（三视图 + 情绪九宫格 + 道具状态变体）", deliverable: "每位主演的角色设定集：正/侧/背三视图 + 面部与服装的 DNA 签名描述串 + 情绪九宫格 + 道具状态变体", gate: "人物批准：主演三视图 + DNA 签名经用户确认后才进分镜；单角色可单独重铸不推倒全部" },
      // 环 3：锁定分镜（文本环节）——段≤15s/镜 2-5s/9:16/正反打成对（17 道 QC 全过）
      { role: "storyboard", kind: "text", title: "分镜表（逐场逐镜：景别/机位/时长/转场）", deliverable: "逐场分镜表：段（一次生成 ≤15 秒）→ 镜（每镜 2-5 秒硬门）→ 每镜 9:16 构图描述 + 机位（正打/反打/过肩）+ 转场标记", gate: "17 道分镜质量门全过：段≤15s/镜 2-5s/9:16/正反打成对/轴线连续/切点-台词对账/钩子位前置/资产引用完整/情绪链完整/无手部特写缺失预案/转场标记齐备" },
      // 环 4：3D 白模预演（导演台 director 原语未到 → 暫以 config 承载预演方案）
      { role: "previz", kind: "config", title: "3D 白模预演方案（逐镜构图/运镜/走位，待导演台原语）", deliverable: "白模预演方案（逐镜分镜构图/运镜/走位，3D 白模时间线可回放）+ 用户确认过的镜头方案记录", defaults: { kind: "director", unit_price_coins: 0 } },
      // 环 5：渲染关键帧（逐镜首尾帧双锁 + CP 剧照 + 色调参照帧）
      { role: "keyframe_gen", kind: "config", title: "关键帧生成配置", deliverable: "关键帧环节的生图价目与参数配置（model/size/count/单价），逐镜首尾帧与 CP 剧照按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "keyframe", kind: "image", title: "关键帧（每镜首帧/尾帧 + CP 剧照）", deliverable: "每镜起始帧（0.00 秒主图）+ 镜内切点子帧图 + 主演 CP 剧照（情绪高潮位双人构图）+ 每场色调参照帧" },
      // 环 6：合成配音（audio 原语：真实 TTS 閉環；上游不可用时如实报错）
      { role: "voiceover", kind: "audio", title: "配音（TTS 台词音轨 + BGM/音效点位）", deliverable: "全剧旁白与台词音轨：按角色聚合的 TTS 成片音频（每句独立文件带时长戳）+ BGM 情绪段标记表（进场/退场秒点）+ 音效点位表" },
      // 环 7：生成镜头视频（I2V：关键帧首尾帧 + 角色/场景参考）
      { role: "video_gen", kind: "config", title: "镜头视频生成配置", deliverable: "镜头视频环节的生图价目与参数配置（尺寸/每秒单价），逐镜 I2V 片段按此执行", defaults: { size: "9:16", kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "shot_video", kind: "video", title: "镜头视频（每镜一段，按 shot_order 命名）", deliverable: "每镜一段竖屏原生视频（9:16，I2V），按 shot_order 命名的片段序列 + 失败镜头重试清单" },
      // 环 8：剪辑成片（film 原语：真实拼接＋混音＋字幕；与 novel_film/feature_film 同构）
      { role: "final_cut", kind: "film", title: "剪辑成片（拼接+混音+字幕，9:16 竖屏成片）", deliverable: "每集成片视频（9:16，含字幕/音轨/BGM 混音）+ 剪映可继续编辑的草稿工程", gate: "成片验收：用户看片尾通过或标出秒点问题位；通过前不批量生成后续集" },
      // 环 9：产出投放物料（竖屏封面 + 预告切片物料）
      { role: "promo_gen", kind: "config", title: "投放物料生成配置", deliverable: "投放物料环节的生图价目与参数配置（model/size/count/单价），竖屏封面与预告切片物料按此执行", defaults: { model: "pixai-tsubaki2", size: "1024x1792", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "promo", kind: "image", title: "投放物料（竖屏封面 3 张 + 预告切片封面）", deliverable: "每集投放包：竖屏封面图 3 张（钩子位/CP 剧照/反转位各一）+ 15 秒竖屏切片预告（钩子前置版）+ 标题-简介文案" },
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