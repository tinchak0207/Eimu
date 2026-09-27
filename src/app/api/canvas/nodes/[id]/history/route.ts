// 節點版本歷史：GET /api/canvas/nodes/[id]/history?projectId=...
//
// 認證：requireVerifiedUser（同 /api/canvas/projects；只讀自己的專案）。
// 回傳該節點的版本清單（升序）＋當前快照指標（含軟刪狀態），供版本面板/回退確認用。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { readCanvasProject } from "@/lib/canvas/project-store";
import { listNodeVersions } from "@/lib/canvas/node-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Next 15 的動態段是異步的，params 必須 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest, context: RouteContext) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const { id } = await context.params;
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  if (!id || !projectId) return fail(400, "缺少节点 id 或 projectId", "invalid_payload");

  try {
    const project = await readCanvasProject(caller.user.id, projectId);
    if (!project) return fail(404, "画布项目不存在", "project_not_found");
    const node = project.nodes.find((n) => n.id === id) ?? null;
    if (!node) return fail(404, "节点不存在", "node_not_found");
    const versions = listNodeVersions(project.nodeVersions ?? [], id);
    return NextResponse.json(
      {
        success: true,
        nodeId: id,
        projectId,
        // 軟刪狀態（deletedAt 有值＝在垃圾桶裡，可 restore 後再回退）。
        deletedAt: node.deletedAt ?? null,
        current: { title: node.title, metadata: node.metadata ?? {} },
        versions,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] node history failed:", error);
    return fail(500, "读取节点历史失败，请稍后再试", "internal_error");
  }
}
