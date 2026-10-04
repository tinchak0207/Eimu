// GET /api/v1/canvas/projects —— B 端 API key 的「列出本账号画布项目」端点。
//
// 动机：外部 coding agent 拿到 MCP 的 workflow_write / workflow_rollback 之后，
// 必须先知道有哪些 project_id 可以写——否则「改产线」这条链在探索面就断了。
// 本端点补上那一步：回本 key 所属帐号的画布项目摘要（id／名称／时间／节点数），
// 拿返回的 id 当 workflow_write / workflow_rollback 的 project_id。
//
// 鉴权与 owner 校验逐字沿用同目录 `workflow/route.ts` 的既有轮子（不另写一套）：
//   ① 鉴权＝`authenticateBizApiKey`＋`readBearerToken`（B key 真源）。
//   ② 取值＝`listCanvasProjects(auth.key.userId)`——画布专案储存以 `canvas/<userId>/…`
//      为命名空间，本函式只读该 user 命名空间，**结构性**回不到他人专案（无 leak）。
//   ③ 投影＝`toCanvasProjectSummaryWire`（与站内 `GET /api/canvas/projects?view=summary`
//      同一份摘要形状，只挑 id/title/createdAt/updatedAt/nodeCount，不回节点内容）。
// 不区分「不存在/无权」：此端点本就只回自己的，没有可枚举的他人物件。
import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { listCanvasProjects } from "@/lib/canvas/project-store";
import { toCanvasProjectSummaryWire } from "@/lib/canvas/project-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);

  try {
    // owner 命名空间＝auth.key.userId；只回本帐号的专案（newest 优先）。
    const projects = await listCanvasProjects(auth.key.userId);
    return NextResponse.json(
      {
        success: true,
        count: projects.length,
        projects: projects.map(toCanvasProjectSummaryWire),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] list biz projects failed:", error);
    return fail(500, "读取画布项目失败，请稍后再试", "internal_error");
  }
}
