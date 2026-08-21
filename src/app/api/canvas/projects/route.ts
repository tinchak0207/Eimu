// 畫布專案 API：雲端持久化（list / save / delete）。
// 認證：requireVerifiedUser（上游 /api/user/self 驗證，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  deleteCanvasProjects,
  listCanvasProjects,
  saveCanvasProject,
} from "@/lib/canvas/project-store";
import type { CanvasProject } from "@/lib/canvas/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    const projects = await listCanvasProjects(caller.user.id);
    return NextResponse.json({ success: true, projects }, { status: 200, headers: { "Cache-Control": "no-store" } });
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
    await saveCanvasProject(caller.user.id, {
      id: body.id,
      title: body.title?.trim()?.slice(0, 200) || "未命名画布",
      createdAt: body.createdAt || now,
      updatedAt: body.updatedAt || now,
      nodes: body.nodes,
      connections: Array.isArray(body.connections) ? body.connections : [],
      viewport: body.viewport ?? { x: 0, y: 0, k: 1 },
      backgroundMode: body.backgroundMode === "blank" || body.backgroundMode === "lines" ? body.backgroundMode : "dots",
      ...(body.budget ? { budget: body.budget } : {}),
      ...(Array.isArray(body.cardIds) ? { cardIds: body.cardIds } : {}),
    });
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
