// 節點版本回退（B 端 API key 版）：POST /api/v1/canvas/nodes/[id]/revert
// body: { projectId: string; version?: number }
//   - version 有值＝回退到該版；省略＝回退到「上一版」。
//
// 這條是站內 `/api/canvas/nodes/[id]/revert`（user session 鑑權）的 B 端孿生兄弟：
// 目的是讓 MCP 的 workflow_rollback（B 端 key 身分）能真的跑通，而不必偽造 session。
// 兩件事刻意逐字沿用既有輪子，這裡不另寫一套：
//   ① 鑑權輪子＝/api/v1/workflow/compile 的 `authenticateBizApiKey`＋`readBearerToken`（B key 真源）。
//   ② 套用輪子＝站內 revert route 的同一組 `node-versions` 函式（append/apply/create/list/select）
//      與 `mutateCanvasProject`——語義（只還原 title＋metadata、座標不動、回退本身也落一版）逐字相同。
//
// **owner 校驗**：`mutateCanvasProject(auth.key.userId, projectId, …)`——畫布專案儲存以
// `canvas/<userId>/…` 為命名空間，別人的 projectId 在本 user 命名空間裡根本不存在，
// 因此「A 用戶的 key 改不到 B 用戶的畫布」是**結構性**成立的（找不到即 404，不區分
// 「不存在/無權」以防枚舉）。B 端 key 只代表「允許的服務身分」，不代表可跨越 user 邊界。
import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** Next 15 的動態段是異步的，params 必須 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);

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
    // owner 命名空間＝auth.key.userId；跨 owner 的 projectId 在此找不到 → null → 404。
    const updated = await mutateCanvasProject(auth.key.userId, projectId, (project) => {
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
    console.error("[canvas] biz node revert failed:", error);
    return fail(500, "回退节点失败，请稍后再试", "internal_error");
  }
}
