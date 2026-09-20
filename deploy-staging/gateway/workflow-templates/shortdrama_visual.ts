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
      { role: "script", kind: "text", title: "结构化场次表＋台词本（场景/节拍/台词按 4.5 字/秒折算）" },
      // 环 2：铸造主演资产（角色 DNA 签名文本 → 生成配置 → 三视图角色卡；multiShot 可复制多角色）
      { role: "cast", kind: "text", title: "主演角色描述（DNA 签名 8 维 + 音色）" },
      { role: "cast_gen", kind: "config", title: "主演资产生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "cast_card", kind: "image", title: "主演资产（三视图 + 情绪九宫格 + 道具状态变体）" },
      // 环 3：锁定分镜（文本环节）——段≤15s/镜 2-5s/9:16/正反打成对（17 道 QC 全过）
      { role: "storyboard", kind: "text", title: "分镜表（逐场逐镜：景别/机位/时长/转场）" },
      // 环 4：3D 白模预演（导演台 director 原语未到 → 暫以 config 承载预演方案）
      { role: "previz", kind: "config", title: "3D 白模预演方案（逐镜构图/运镜/走位，待导演台原语）", defaults: { kind: "director", unit_price_coins: 0 } },
      // 环 5：渲染关键帧（逐镜首尾帧双锁 + CP 剧照 + 色调参照帧）
      { role: "keyframe_gen", kind: "config", title: "关键帧生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "keyframe", kind: "image", title: "关键帧（每镜首帧/尾帧 + CP 剧照）" },
      // 环 6：合成配音（audio 原语：真实 TTS 閉環；上游不可用时如实报错）
      { role: "voiceover", kind: "audio", title: "配音（TTS 台词音轨 + BGM/音效点位）" },
      // 环 7：生成镜头视频（I2V：关键帧首尾帧 + 角色/场景参考）
      { role: "video_gen", kind: "config", title: "镜头视频生成配置", defaults: { size: "9:16", kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "shot_video", kind: "video", title: "镜头视频（每镜一段，按 shot_order 命名）" },
      // 环 8：剪辑成片（film 原语：真实拼接＋混音＋字幕；与 novel_film/feature_film 同构）
      { role: "final_cut", kind: "film", title: "剪辑成片（拼接+混音+字幕，9:16 竖屏成片）" },
      // 环 9：产出投放物料（竖屏封面 + 预告切片物料）
      { role: "promo_gen", kind: "config", title: "投放物料生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1792", count: 3, kind: "image", unit_price_coins: 0.001 } },
      { role: "promo", kind: "image", title: "投放物料（竖屏封面 3 张 + 预告切片封面）" },
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