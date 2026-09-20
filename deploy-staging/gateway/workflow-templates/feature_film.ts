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
      { role: "script", kind: "text", title: "故事脚本 / 分镜" },
      { role: "character", kind: "text", title: "角色 A 描述" },
      { role: "char_sheet", kind: "config", title: "角色 A 四视图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 4, kind: "image", sheet: "4-view", unit_price_coins: 0.001 } },
      { role: "char_view1", kind: "image", title: "角色 A 正面" },
      { role: "char_view2", kind: "image", title: "角色 A 侧面" },
      { role: "char_view3", kind: "image", title: "角色 A 背面" },
      { role: "char_view4", kind: "image", title: "角色 A 动作" },
      { role: "scene", kind: "text", title: "场景描述" },
      { role: "scene_gen", kind: "config", title: "场景图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "scene_img", kind: "image", title: "场景图" },
      { role: "shot1", kind: "text", title: "镜头 1 脚本" },
      // R8（2026-09-10 暴君裁定）：shot1_gen 不再寫死 model=minimax-h3 / duration=5s——
      // 該模型當前不可用且 5s≠agent 計劃時長，寫死 = 每個大片任務都被逼手動
      // update_node。model 留空由 workflow-service.start 動態選可用視頻模型
      //（/v1/model-status 判活）回填；duration_seconds 留空由 content 裡該鏡
      // shot JSON 的 output.duration_seconds 對齊回填（傳 10s 就 10s，別回 5s）。
      { role: "shot1_gen", kind: "config", title: "镜头 1 影片配置", defaults: { size: "16:9", kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "shot1_video", kind: "video", title: "镜头 1 影片" },
      { role: "final_cut", kind: "film", title: "成片（按镜头顺序拼接全部镜头）" },
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
