// GET  /api/canvas/projects/review?projectId=   —— 手机端作品审阅：每镜采用稿／版本／四态＋「做完了没有」汇总。
// POST /api/canvas/projects/review              —— 用这条／回旧版：{ projectId, nodeId, version? | candidateId? }
//   只改这一镜的星标，回执含 touchedNodes（恒≤1）；其余镜头、台词、音轨原样。

import { NextRequest, NextResponse } from "next/server";
import { mutateCanvasProject, readCanvasProject } from "@/lib/canvas/project-store";
import { adoptShotVersion, buildProjectReview, type AdoptReceipt } from "@/lib/canvas/shot-review";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string) {
  return NextResponse.json({ success: false, error, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  const project = await readCanvasProject(caller.user.id, projectId);
  if (!project) return fail(404, "找不到这个项目。", "project_not_found");
  return NextResponse.json({ ok: true, review: buildProjectReview(project) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
  const version = typeof body?.version === "string" ? body.version.trim() : undefined;
  const candidateId = typeof body?.candidateId === "string" ? body.candidateId.trim() : undefined;
  if (!projectId || !nodeId || (!version && !candidateId)) return fail(400, "缺少 projectId / nodeId / version(或 candidateId)", "invalid_payload");

  let receipt: AdoptReceipt | null = null;
  const saved = await mutateCanvasProject(caller.user.id, projectId, (project) => {
    const result = adoptShotVersion(project, { nodeId, version, candidateId });
    receipt = result.receipt;
    return result.receipt.ok ? result.project : null;
  });
  if (!saved) {
    const r = receipt as AdoptReceipt | null;
    if (r && !r.ok) return fail(r.reason === "not_found" ? 404 : 409, "这一镜没有这一版，没有改动任何内容。", r.reason ?? "adopt_failed");
    return fail(404, "找不到这个项目。", "project_not_found");
  }
  return NextResponse.json(
    { ok: true, receipt, review: buildProjectReview(saved) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
