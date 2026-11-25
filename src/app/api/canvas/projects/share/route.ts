// 项目分享（发布不可变快照，可撤销）：
//   POST   { projectId }        → { shareId, path }   需登录，只能发布自己的项目
//   GET    ?shareId=            → 公开只读视图（无需登录）：标题、各镜采用稿、整体状态
//   DELETE ?shareId=            → 撤销（只认发布者）
// 读者「复制成我的项目」走 POST /api/canvas/projects/fork { shareId }。

import { NextRequest, NextResponse } from "next/server";
import { createProjectShare, getProjectShare, revokeProjectShare } from "@/lib/canvas/project-share";
import { readCanvasProject } from "@/lib/canvas/project-store";
import { buildProjectReview } from "@/lib/canvas/shot-review";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ success: false, error, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  let body: { projectId?: unknown } | null = null;
  try { body = (await req.json()) as { projectId?: unknown }; } catch { return fail(400, "请求体必须是合法 JSON", "invalid_json"); }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  const project = await readCanvasProject(caller.user.id, projectId);
  if (!project) return fail(404, "找不到这个项目（只能分享自己的个人项目）。", "project_not_found");
  const { shareId } = await createProjectShare(caller.user.id, project);
  return NextResponse.json({ ok: true, shareId, path: `/api/canvas/projects/share?shareId=${shareId}` }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const shareId = req.nextUrl.searchParams.get("shareId")?.trim() ?? "";
  const snapshot = await getProjectShare(shareId);
  if (!snapshot) return fail(404, "这个分享不存在或已撤销。", "share_not_found");
  const review = buildProjectReview(snapshot.project);
  return NextResponse.json(
    { ok: true, shareId, title: snapshot.project.title, createdAt: snapshot.createdAt, shots: review.shots.map((s) => ({ shotNumber: s.shotNumber, episodeNo: s.episodeNo, summary: s.summary, state: s.state, adoptedUrl: s.adoptedUrl, adoptedKind: s.adoptedKind })), summary: review.summary.headline },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  const shareId = req.nextUrl.searchParams.get("shareId")?.trim() ?? "";
  const ok = await revokeProjectShare(caller.user.id, shareId);
  if (!ok) return fail(404, "没有找到这条分享，或它不属于你。", "share_not_found");
  return NextResponse.json({ ok: true, revoked: true }, { headers: { "Cache-Control": "no-store" } });
}
