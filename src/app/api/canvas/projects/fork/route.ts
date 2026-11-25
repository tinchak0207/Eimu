// POST /api/canvas/projects/fork —— 把自己的一个项目复制成可续作副本（成片接着做）。
// body：{ projectId: string; title?: string }。回 { ok, projectId, nodeCount, title }。
// 只复制读得到的项目（个人库）；已采纳版本／音轨／图片按资产引用带过去，不重新生成、不扣费。

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { forkCanvasProject } from "@/lib/canvas/project-fork";
import { readCanvasProject, saveCanvasProject } from "@/lib/canvas/project-store";
import { getProjectShare } from "@/lib/canvas/project-share";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ success: false, error, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  let body: { projectId?: unknown; shareId?: unknown; title?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown; shareId?: unknown; title?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const shareId = typeof body?.shareId === "string" ? body.shareId.trim() : "";
  if (!projectId && !shareId) return fail(400, "缺少 projectId 或 shareId", "invalid_payload");
  const title = typeof body?.title === "string" ? body.title.slice(0, 120) : undefined;

  // 公开分享：复制发布那一刻的快照（已采用版本一并带走）；自己的项目：复制当前状态。
  const source = shareId
    ? (await getProjectShare(shareId))?.project ?? null
    : await readCanvasProject(caller.user.id, projectId);
  if (!source) return fail(404, shareId ? "这个分享不存在或已撤销。" : "找不到这个项目（只能复制自己的个人项目）。", shareId ? "share_not_found" : "project_not_found");

  const { project } = forkCanvasProject(source, { newProjectId: `canvas-${randomUUID()}`, title });
  await saveCanvasProject(caller.user.id, project);
  return NextResponse.json(
    { ok: true, projectId: project.id, title: project.title, nodeCount: project.nodes.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
