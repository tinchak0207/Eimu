// 画布专案摘要（2026-10-01 效能审计 P0-B）。
//
// 历史清单只要「标题/更新时间/节点数」，原本却每次把用户全部专案（含节点、内嵌图片 data URL；
// 实测单用户索引 2.5MB）整包下载到前端再自己摘要。服务端与前端共用这一份摘要形状：
// `GET /api/canvas/projects?view=summary` 只回摘要；打开某张画布走 `?id=`，只回那一张。

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

/** 外部 JSON → 摘要（逐栏验证；不合法的项目丢弃，不整份作废）。 */
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
