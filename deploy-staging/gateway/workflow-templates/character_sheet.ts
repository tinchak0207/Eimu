import type { WorkflowTemplate } from "./types";

export const characterSheetTemplate: WorkflowTemplate = 
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
  }
;
