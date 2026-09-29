// 批量恢復軟刪節點：POST /api/canvas/nodes/restore
// body: { projectId: string; ids: string[] }
//
// 軟刪（delete_nodes / UI 刪除）把節點收進 `nodes[].deletedAt`，本端點清掉該標記
// 即恢復。語義：
//   - ids 空＝不恢復任何節點（不製造「靜默全還原」）
//   - 只認專案裡真的存在的節點，猜不中的 id 忽略（不捏造節點）
//   - 全都不存在 → 404，不寫空更新
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { mutateCanvasProject } from "@/lib/canvas/project-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: { projectId?: unknown; ids?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown; ids?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const ids = Array.isArray(body?.ids)
    ? [...new Set(body.ids.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  if (ids.length === 0) return fail(400, "缺少 ids", "invalid_payload");

  try {
    let restoredIds: string[] = [];
    const updated = await mutateCanvasProject(caller.user.id, projectId, (project) => {
      const wanted = new Set(ids);
      const targets = project.nodes.filter((n) => wanted.has(n.id) && typeof n.deletedAt === "string");
      if (targets.length === 0) return null;
      restoredIds = targets.map((n) => n.id);
      const nodes = project.nodes.map((n) => {
        if (!wanted.has(n.id) || typeof n.deletedAt !== "string") return n;
        const { deletedAt: _dropped, ...rest } = n;
        return rest;
      });
      return { ...project, nodes };
    });
    if (!updated) return fail(404, "没有可恢复的已删除节点", "restore_target_missing");

    return NextResponse.json(
      { success: true, projectId, restored: restoredIds },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] node restore failed:", error);
    return fail(500, "恢复节点失败，请稍后再试", "internal_error");
  }
}
