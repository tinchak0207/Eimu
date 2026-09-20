// 画布工作流模板库（Workflow Templates）
//
// 暴君策略 v2：Deepseek 只当「参数/提示词传达人」，节点流结构骨架由后端模板提供。
// 模板定义「编排好的流程」：Deepseek 填内容（prompt/model/size 等），
// 引擎（workflow-engine.ts）把模板展开成 CanvasNode[] + 连线并执行。
//
// 本档案 = 纯资料 + 纯函式（不依赖 Bun），可单独单测。

export interface WorkflowNodeSpec {
  role: string // 节点在工作流中的角色（text/config/image/video/audio/film）
  kind: "text" | "config" | "image" | "video" | "audio" | "film"
  title: string
  // 模板预设 metadata；Deepseek 填的内容会 merge 进来。
  defaults?: Record<string, unknown>
  // 提示：引擎生成时提示 Deepseek 应填哪些栏位（放在 SKILL，不进执行）。
}

export interface WorkflowConnectionSpec {
  fromRole: string
  toRole: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string // 给 Deepseek 看的一句心智
  // 节点是否可复制（大片：多镜头 = 同角色节点复制多份，id 加后缀）。
  multiShot?: boolean
  nodes: WorkflowNodeSpec[]
  connections: WorkflowConnectionSpec[]
}

// unit_price_coins（2026-08-29 R5-D2 價目表糾偏）：config 節點單價（幣/張），來源 =
// 暴君權威價目表（pixai 系 = 0.001 幣/張；/v1/models 目錄 x_coins_per_image 的 0.001
// 從來不是髒數據，與 /pricing 同源正確）。R5-B 曾誤把 ledger 實扣 1,500,000 quota
//（=3 幣/張）當錨點——真相是計費層多扣 3000 倍的 bug（另線修復）；價目表優先，
// 本欄位僅作 pixai 模板的本地鏡像，其他圖片模型一律走目錄價（同源）。
// unit_price_per_second（2026-08-29 暴君價目表）：影片 config 秒價（幣/秒），
// MiniMax H3 檔位：720P = 5 幣/秒（預設檔）、1080P = 10 幣/秒。平台目錄對
// minimax-h3 標 0.25 是 RMB 混幣髒價，影片估價禁用目錄、只用此欄位。
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ── 单图（v1 三元组的工作流化）──
  {
    id: "single_image",
    name: "单张图片",
    description: "一段提示词 → 一张图。最简单的工作流。",
    nodes: [
      { role: "prompt", kind: "text", title: "提示词" },
      { role: "generation", kind: "config", title: "生成配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "result", kind: "image", title: "图片" },
    ],
    connections: [
      { fromRole: "prompt", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  },

  // ── 角色设定 ──
  {
    id: "character_sheet",
    name: "角色设定",
    description: "角色描述 → 四视图设定表（正/侧/背/动作）。影片大片的角色锚点。",
    nodes: [
      { role: "character", kind: "text", title: "角色描述" },
      { role: "sheet", kind: "config", title: "四视图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 4, kind: "image", sheet: "4-view", unit_price_coins: 0.001 } },
      { role: "view1", kind: "image", title: "正面" },
      { role: "view2", kind: "image", title: "侧面" },
      { role: "view3", kind: "image", title: "背面" },
      { role: "view4", kind: "image", title: "动作" },
    ],
    connections: [
      { fromRole: "character", toRole: "sheet" },
      { fromRole: "sheet", toRole: "view1" },
      { fromRole: "sheet", toRole: "view2" },
      { fromRole: "sheet", toRole: "view3" },
      { fromRole: "sheet", toRole: "view4" },
    ],
  },

  // ── 场景建立 ──
  {
    id: "scene_setup",
    name: "场景建立",
    description: "地点描述 → 场景建立图。影片的环境锚点。",
    nodes: [
      { role: "scene", kind: "text", title: "场景描述" },
      { role: "generation", kind: "config", title: "场景图配置", defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 } },
      { role: "result", kind: "image", title: "场景图" },
    ],
    connections: [
      { fromRole: "scene", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  },

  // ── 单镜头影片 ──
  {
    id: "single_video",
    name: "单支影片",
    description: "镜头脚本 → 一支影片（可带参考图）。",
    nodes: [
      { role: "shot", kind: "text", title: "镜头脚本" },
      { role: "reference", kind: "image", title: "参考图（可选）" },
      { role: "generation", kind: "config", title: "影片配置", defaults: { model: "minimax-h3", size: "16:9", duration_seconds: 5, kind: "video", unit_price_per_second: 5, unit_price_per_second_1080p: 10 } },
      { role: "result", kind: "video", title: "影片" },
    ],
    connections: [
      { fromRole: "shot", toRole: "generation" },
      { fromRole: "reference", toRole: "generation" },
      { fromRole: "generation", toRole: "result" },
    ],
  },

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
  },

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
  },
]

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id)
}

/**
 * 0920 暴君裁定（第二版）：模板判定完成即建骨架彈上畫布——不等 Expert 去調
 * workflow_start（實錘：Expert 根本沒調，右邊永遠空白，「太慢了」）。
 *
 * 後端 startSync 要求每個 text role 非空，故建構時用「佔位內容」先滿足驗證；
 * Expert 之後同模板呼叫 workflow_start 走 P0 冪等守衛復用同一支 wf，再用
 * workflow_update_node 回填真內容。config/image/video/audio/film role 無需 content。
 */
export function templatePlaceholderContent(templateId: string): Record<string, unknown> {
  const t = getWorkflowTemplate(templateId)
  if (!t) return {}
  const content: Record<string, unknown> = {}
  for (const n of t.nodes) {
    // 契約形狀：{ role: { content: "..." } }（startSync 逐 role 讀 c.content）；
    // 傳純字串會被判「缺少必要内容」而 400（實錘 2026-09-20）。
    if (n.kind === "text") content[n.role] = { content: `（待填：${n.title}）` }
  }
  return content
}

export function listWorkflowTemplates(): { id: string; name: string; description: string; multiShot?: boolean }[] {
  return WORKFLOW_TEMPLATES.map(({ id, name, description, multiShot }) => ({ id, name, description, multiShot }))
}
