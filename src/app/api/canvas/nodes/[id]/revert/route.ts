// 節點版本回退：POST /api/canvas/nodes/[id]/revert
// body: { projectId: string; version?: number }
//   - version 有值＝回退到該版
//   - 省略＝回退到「上一版」（最新版的前一版）
//
// 回退本身也落一版（reason "revert"）——版本歷史 append-only，回退可再被回退。
// 只還原 title＋metadata，座標/尺寸不動（版本＝內容歷史，不是版面歷史）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { mutateCanvasProject } from "@/lib/canvas/project-store";
import {
  appendNodeVersion,
  applyNodeVersion,
  createNodeVersion,
  listNodeVersions,
  previousNodeVersion,
  selectNodeVersion,
} from "@/lib/canvas/node-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Next 15 的動態段是異步的，params 必須 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const { id } = await context.params;
  let body: { projectId?: unknown; version?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown; version?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  if (!id || !projectId) return fail(400, "缺少节点 id 或 projectId", "invalid_payload");
  // version 可省略（回上一版）；有值必須是正整數。
  const version =
    body?.version === undefined
      ? undefined
      : typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 1
        ? body.version
        : null;
  if (version === null) return fail(400, "version 必须是从 1 起的整数", "invalid_version");

  try {
    const updated = await mutateCanvasProject(caller.user.id, projectId, (project) => {
      const node = project.nodes.find((n) => n.id === id);
      if (!node) return null;
      const versions = project.nodeVersions ?? [];
      const entry =
        version === undefined
          ? previousNodeVersion(versions, id)
          : selectNodeVersion(versions, id, version);
      if (!entry) return null;
      const reverted = applyNodeVersion(node, entry);
      const nodes = project.nodes.map((n) => (n.id === id ? reverted : n));
      const recorded = createNodeVersion(reverted, "revert", versions);
      return { ...project, nodes, nodeVersions: appendNodeVersion(versions, recorded) };
    });
    if (!updated) return fail(404, "节点不存在，或没有可回退的版本", "revert_target_missing");

    const node = updated.nodes.find((n) => n.id === id) ?? null;
    return NextResponse.json(
      {
        success: true,
        nodeId: id,
        projectId,
        node,
        versions: listNodeVersions(updated.nodeVersions ?? [], id),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] node revert failed:", error);
    return fail(500, "回退节点失败，请稍后再试", "internal_error");
  }
}
