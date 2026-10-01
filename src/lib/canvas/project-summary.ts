// 畫布專案摘要（2026-10-01 效能審計 P0-B）。
//
// 歷史清單只要「標題/更新時間/節點數」，原本卻每次把用戶全部專案（含節點、內嵌圖片 data URL；
// 實測單用戶索引 2.5MB）整包下載到前端再自己摘要。服務端與前端共用這一份摘要形狀：
// `GET /api/canvas/projects?view=summary` 只回摘要；打開某張畫布走 `?id=`，只回那一張。

import type { CanvasProject } from "./types";

export interface CanvasProjectSummaryWire {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export function toCanvasProjectSummaryWire(project: CanvasProject): CanvasProjectSummaryWire {
  return {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    nodeCount: Array.isArray(project.nodes) ? project.nodes.length : 0,
  };
}

/** 外部 JSON → 摘要（逐欄驗證；不合法的項目丟棄，不整份作廢）。 */
export function parseCanvasProjectSummaries(payload: unknown): CanvasProjectSummaryWire[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  return payload.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const s = item as Partial<CanvasProjectSummaryWire>;
    if (typeof s.id !== "string" || !s.id) return [];
    return [
      {
        id: s.id,
        title: typeof s.title === "string" ? s.title : "",
        createdAt: typeof s.createdAt === "string" ? s.createdAt : "",
        updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
        nodeCount: typeof s.nodeCount === "number" && Number.isFinite(s.nodeCount) ? s.nodeCount : 0,
      },
    ];
  });
}
