// 画布专案 API：云端持久化（list / save / delete）。
// 认证：requireVerifiedUser（上游 /api/user/self 验证，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { filterCardIdsForProject } from "@/lib/asset-library";
import { deleteCanvasProjects } from "@/lib/canvas/project-store";
import {
  listCanvasProjectsForCaller,
  readTeamCanvasProjectsForCaller,
  saveCanvasProjectWithTeamGate,
} from "@/lib/canvas/team-canvas-gate";
import type { CanvasProject } from "@/lib/canvas/types";
import { toCanvasProjectSummaryWire } from "@/lib/canvas/project-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/**
 * 回应形状（效能审计 P0-B，2026-10-01）：
 *   `?id=<projectId>` → `{ project }`，只回那一张（找不到 404）；
 *   `?view=summary`   → `{ summaries }`，只回标题/时间/节点数（历史清单用）；
 *   缺省              → `{ projects }` 全量（旧客户端相容，形状逐字不变）。
 * 可见范围与全量一致（同一份 listCanvasProjectsForCaller / 团队读闸结果），只是少传。
 */
function projectsResponse(projects: CanvasProject[], params: URLSearchParams): NextResponse {
  const headers = { "Cache-Control": "no-store" };
  const id = params.get("id")?.trim();
  if (id) {
    const project = projects.find((p) => p.id === id);
    if (!project) return fail(404, "画布不存在或已删除", "not_found");
    return NextResponse.json({ success: true, project }, { status: 200, headers });
  }
  if (params.get("view") === "summary") {
    return NextResponse.json({ success: true, summaries: projects.map(toCanvasProjectSummaryWire) }, { status: 200, headers });
  }
  return NextResponse.json({ success: true, projects }, { status: 200, headers });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    // 团队可读（片P 刀 2）：显式指定 teamId ⇒ 只回该团队画布（非成员 403，同刀3 码/文案）；
    // 不指定 ⇒ 我个人的 + 我所属团队的（relay 查不到成员身份时只回个人，fail-open，不 500）。
    const teamId = req.nextUrl.searchParams.get("teamId")?.trim();
    let projects: CanvasProject[];
    if (teamId) {
      const scoped = await readTeamCanvasProjectsForCaller(caller.user.id, teamId);
      if (!scoped.ok) return fail(scoped.status, scoped.message, scoped.code);
      projects = scoped.projects;
    } else {
      projects = await listCanvasProjectsForCaller(caller.user.id);
    }
    return projectsResponse(projects, req.nextUrl.searchParams);
  } catch (error) {
    console.error("[canvas] list projects failed:", error);
    return fail(500, "读取画布失败，请稍后再试", "internal_error");
  }
}

export async function PUT(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Partial<CanvasProject> | null = null;
  try {
    body = (await req.json()) as Partial<CanvasProject>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (!body || typeof body.id !== "string" || !Array.isArray(body.nodes)) {
    return fail(400, "缺少 id 或 nodes", "invalid_payload");
  }
  if (body.nodes.length > 500) {
    return fail(400, "节点数量超限", "too_many_nodes");
  }

  try {
    const now = new Date().toISOString();
    // REQ-B2 作用域闸：cardIds 逐个过作用域裁决——跨项目、未显式分享的卡不得锁进本项目
    // （生成时的卡注入读的就是这份 cardIds）。走 asset-library 的单一裁决入口
    // （内部＝resolveAssetVisibility）；个人卡逐位不变，查不到的 id 不猜（原样保留）。
    const cardIds = Array.isArray(body.cardIds)
      ? await filterCardIdsForProject({
          userId: caller.user.id,
          projectId: body.id,
          cardIds: body.cardIds.filter((id): id is string => typeof id === "string"),
        })
      : null;
    // 团队建画布闸（片F 面 2）：先判后存。成员且团队关闭「成员建画布」时拒新建，
    // 既有专案更新与非成员（个人画布）不受影响；拒绝时不落盘（无半成品）。
    const gate = await saveCanvasProjectWithTeamGate(caller.user.id, {
      id: body.id,
      title: body.title?.trim()?.slice(0, 200) || "未命名画布",
      createdAt: body.createdAt || now,
      updatedAt: body.updatedAt || now,
      nodes: body.nodes,
      connections: Array.isArray(body.connections) ? body.connections : [],
      viewport: body.viewport ?? { x: 0, y: 0, k: 1 },
      backgroundMode: body.backgroundMode === "blank" || body.backgroundMode === "lines" ? body.backgroundMode : "dots",
      ...(body.budget ? { budget: body.budget } : {}),
      ...(cardIds ? { cardIds } : {}),
      // 作品/剧集（2026-09-15 刀 1）：原样透传。清洗一律交给 project-store 的逐栏白名单，
      // 本路由不重复实作洗栏逻辑（避免两处白名单漂移）。不在此静默丢栏。
      ...(body.projectType !== undefined ? { projectType: body.projectType } : {}),
      ...(body.currentStep !== undefined ? { currentStep: body.currentStep } : {}),
      ...(body.episodes !== undefined ? { episodes: body.episodes } : {}),
      // 专案级风格绑定（P1-8／对称差 D34）：原样透传，清洗（＝STYLE_LIBRARY 注册面查询）
      // 交给 project-store 的 normalizeProject，本路由不重复实作（避免两处白名单漂移）。
      ...(body.styleId !== undefined ? { styleId: body.styleId } : {}),
      // 解说剧设定（P1-5／D7）：原样透传，清洗/值域一律交给 project-store 的逐栏白名单
      // （本路由不重复实作，避免两处白名单漂移——同上方 projectType/episodes 的既有范式）。
      ...(body.scriptType !== undefined ? { scriptType: body.scriptType } : {}),
      ...(body.narrationVoice !== undefined ? { narrationVoice: body.narrationVoice } : {}),
      // 节点版本历史（2026-09-27）：原样透传，清洗/裁剪交给 project-store 的
      // normalizeNodeVersions（与读取端同一份），本路由不重复实作。
      ...(body.nodeVersions !== undefined ? { nodeVersions: body.nodeVersions } : {}),
      // 作用域（片P 刀 1）：只透传「宣告为 team」的情形；清洗在 project-store，
      // teamId 由 team-canvas-gate 以已验成员身份的权威值盖章（不采信客户端值）。
      ...(body.scope === "team" ? { scope: "team" as const } : {}),
      ...(body.scope === "team" && typeof body.teamId === "string" ? { teamId: body.teamId } : {}),
    });
    if (!gate.ok) return fail(gate.status, gate.message, gate.code);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("[canvas] save project failed:", error);
    return fail(500, "保存画布失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (!ids.length) return fail(400, "缺少 ids", "invalid_payload");

  try {
    const deleted = await deleteCanvasProjects(caller.user.id, ids);
    return NextResponse.json({ success: true, deleted }, { status: 200 });
  } catch (error) {
    console.error("[canvas] delete projects failed:", error);
    return fail(500, "删除画布失败，请稍后再试", "internal_error");
  }
}
