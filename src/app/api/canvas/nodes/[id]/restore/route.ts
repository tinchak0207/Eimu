// 单节点软删恢复：POST /api/canvas/nodes/[id]/restore
// body: { projectId: string }
//
// 与批量端点 `POST /api/canvas/nodes/restore` 同一语义，差别只在目标是路径上的单一 id。
// （竞品同时有 `/{id}/restore` 与 `/batch-restore` 两个入口，这里对齐。）
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { mutateCanvasProject } from "@/lib/canvas/project-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const { id } = await context.params;
  let body: { projectId?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  if (!id || !projectId) return fail(400, "缺少节点 id 或 projectId", "invalid_payload");

  try {
    const updated = await mutateCanvasProject(caller.user.id, projectId, (project) => {
      const target = project.nodes.find((n) => n.id === id);
      if (!target || typeof target.deletedAt !== "string") return null;
      const nodes = project.nodes.map((n) => {
        if (n.id !== id) return n;
        const { deletedAt: _dropped, ...rest } = n;
        return rest;
      });
      return { ...project, nodes };
    });
    if (!updated) return fail(404, "节点不存在或未被删除", "restore_target_missing");

    return NextResponse.json(
      { success: true, projectId, restored: [id], node: updated.nodes.find((n) => n.id === id) ?? null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] node restore failed:", error);
    return fail(500, "恢复节点失败，请稍后再试", "internal_error");
  }
}
