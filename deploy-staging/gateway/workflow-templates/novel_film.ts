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
      { role: "novel", kind: "text", title: "小说原文" },
      { role: "script", kind: "text", title: "结构化剧本（场次表/节拍/台词折算）" },
      // 环 2：角色卡（单图生成的编排序列；multiShot 可复制多角色）
      { role: "character", kind: "text", title: "角色描述（DNA 签名 8 维）" },
      { role: "char_gen", kind: "config", title: "角色卡生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "char_card", kind: "image", title: "角色卡（三视图）" },
      // 环 3：美术卡
      { role: "art_brief", kind: "text", title: "美术规范（色板/光照/材质）" },
      { role: "art_gen", kind: "config", title: "美术卡生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "art_card", kind: "image", title: "美术卡（场景设定图）" },
      // 环 4：分镜（文本环节）
      { role: "storyboard", kind: "text", title: "分镜表（逐镜景别/机位/运镜/时长）" },
      // 环 5：关键帧（逐镜首帧；分镜 → 关键帧 → 视频链式）
      { role: "keyframe_gen", kind: "config", title: "关键帧生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "keyframe", kind: "image", title: "关键帧（镜头首帧）" },
      // 环 6：视频（I2V：关键帧 + 角色/场景参考）
      { role: "video_gen", kind: "config", title: "视频生成配置", defaults: { model: "minimax-h3", size: "16:9", duration_seconds: 15, kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "shot_video", kind: "video", title: "镜头视频" },
      // 环 7：配音（audio 原语：编排存在，执行诚实报上游）
      { role: "voiceover", kind: "audio", title: "配音（TTS 台词音轨）" },
      // 环 8：成片（film 原语：编排存在，执行诚实报上游）
      { role: "final_cut", kind: "film", title: "成片（拼接+混音+字幕）" },
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
