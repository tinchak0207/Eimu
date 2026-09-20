import type { WorkflowTemplate } from "./types";

export const characterSheetTemplate: WorkflowTemplate = 
  // ── 角色设定 ──
  {
    id: "character_sheet",
    name: "角色设定",
    description: "角色描述 → 四视图设定表（正/侧/背/动作）。影片大片的角色锚点。",
    nodes: [
      {
        role: "character",
        kind: "text",
        title: "角色描述",
        deliverable: "角色圣经（DNA 签名：脸型/发型/瞳色/体型/服装/配饰/肤色/气质，每维一个固定短语供全片复用，换词=换脸）",
        notes: [
          "DNA 签名逐维写死为固定短语，后续所有图复用同一短语，禁止同义替换（换词=换脸）",
        ],
        tools: [
          { id: "character_dna_turnaround", input: "角色设定", output: "角色四视图 + DNA 签名 8 维" },
        ],
      },
      {
        role: "sheet",
        kind: "config",
        title: "四视图配置",
        defaults: { model: "pixai-tsubaki2", size: "1024x1024", count: 4, kind: "image", sheet: "4-view", unit_price_coins: 0.001 },
        deliverable: "四视图生成配置（模型/尺寸 + 角色专属固定 seed）",
      },
      {
        role: "view1",
        kind: "image",
        title: "正面",
        deliverable: "正面设定图，锁定面部基线 face_identity",
        gate: "用户逐角色确认四视图后才可供后续镜头引用（换脸是最大返工源）",
        notes: [
          "四视图同 seed 同批生成锁 face_identity；每张与 DNA 签名逐维比对，漂移即该张重出",
        ],
        tools: [
          { id: "image_generate", input: "prompt + 模型 + 尺寸/张数", output: "图片 URL + 实际花费" },
        ],
      },
      { role: "view2", kind: "image", title: "侧面", deliverable: "侧面设定图，锁定轮廓与发型基线" },
      { role: "view3", kind: "image", title: "背面", deliverable: "背面设定图，锁定服装背部细节" },
      { role: "view4", kind: "image", title: "动作", deliverable: "动作设定图，锁定典型姿态（供视频生成运动参考）" },
    ],
    connections: [
      { fromRole: "character", toRole: "sheet" },
      { fromRole: "sheet", toRole: "view1" },
      { fromRole: "sheet", toRole: "view2" },
      { fromRole: "sheet", toRole: "view3" },
      { fromRole: "sheet", toRole: "view4" },
    ],
  }
;
