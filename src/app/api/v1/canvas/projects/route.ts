// GET /api/v1/canvas/projects —— B 端 API key 的「列出本账号畫布项目」端點。
//
// 動機：外部 coding agent 拿到 MCP 的 workflow_write / workflow_rollback 之後，
// 必須先知道有哪些 project_id 可以寫——否則「改產線」這條鏈在探索面就斷了。
// 本端點補上那一步：回本 key 所屬帳號的畫布项目摘要（id／名稱／時間／節點數），
// 拿返回的 id 當 workflow_write / workflow_rollback 的 project_id。
//
// 鑑權與 owner 校驗逐字沿用同目錄 `workflow/route.ts` 的既有輪子（不另寫一套）：
//   ① 鑑權＝`authenticateBizApiKey`＋`readBearerToken`（B key 真源）。
//   ② 取值＝`listCanvasProjects(auth.key.userId)`——畫布專案儲存以 `canvas/<userId>/…`
//      為命名空間，本函式只讀該 user 命名空間，**結構性**回不到他人專案（無 leak）。
//   ③ 投影＝`toCanvasProjectSummaryWire`（與站內 `GET /api/canvas/projects?view=summary`
//      同一份摘要形狀，只挑 id/title/createdAt/updatedAt/nodeCount，不回節點內容）。
// 不區分「不存在/無權」：此端點本就只回自己的，沒有可枚舉的他人物件。
import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { listCanvasProjects } from "@/lib/canvas/project-store";
import { toCanvasProjectSummaryWire } from "@/lib/canvas/project-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);

  try {
    // owner 命名空間＝auth.key.userId；只回本帳號的專案（newest 優先）。
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
