// GET /api/canvas/masters?projectId=… —— 该画布是否已有「验过的成片」（作品面板的 hasCut 真源）。
//
// 成片导出登记时（gateway `registerMasterExport` → 控制面 `film_export` 产物）索引里只有
// session_id（project_id 为 null），所以按**画布节点自己记着的 agent 会话**（`metadata.session_id`）
// 反查本人名下（tenant＝`web:<userId>`）的成片：有一条 probe 过档的成片＝已出片。
// 不是「有导出任务」而是「有验过的成片」；没有索引行就如实回 `hasCut:false`，不推断。

import { NextRequest, NextResponse } from "next/server";
import { readCanvasProject } from "@/lib/canvas/project-store";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { listMasterArtifacts } from "@/lib/generation-core/master-artifact-index";
import { requireVerifiedUser } from "@/lib/accounts/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** 一张画布最多反查几个会话（会话 id 取自节点 metadata，防止恶意大画布放大查询）。 */
const MAX_SESSIONS = 8;

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return NextResponse.json({ success: false, error: caller.message, code: "unauthorized" }, { status: caller.status });

  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) return NextResponse.json({ success: false, error: "缺少 projectId", code: "invalid_payload" }, { status: 400 });

  // 控制面未配置＝站点查不到成片索引：如实说「未知」，不冒充「没有成片」。
  if (!generationControlPlaneEnabled()) {
    return NextResponse.json({ ok: true, known: false, hasCut: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const project = await readCanvasProject(caller.user.id, projectId).catch(() => null);
  if (!project) return NextResponse.json({ success: false, error: "画布项目不存在", code: "project_not_found" }, { status: 404 });

  const sessionIds = new Set<string>();
  for (const node of project.nodes ?? []) {
    const sid = (node.metadata as Record<string, unknown> | undefined)?.session_id;
    if (typeof sid === "string" && sid.trim()) sessionIds.add(sid.trim());
    if (sessionIds.size >= MAX_SESSIONS) break;
  }
  if (sessionIds.size === 0) {
    return NextResponse.json({ ok: true, known: true, hasCut: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const tenantId = `web:${caller.user.id}`;
  const lists = await Promise.all(
    [...sessionIds].map((sessionId) => listMasterArtifacts({ tenantId, sessionId, limit: 5 }).catch(() => [])),
  );
  const verified = lists.flat().filter((record) => record.probe?.verified !== false);
  verified.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = verified[0];
  return NextResponse.json(
    {
      ok: true,
      known: true,
      hasCut: !!latest,
      ...(latest
        ? {
            latest: {
              deliveryUrl: latest.deliveryUrl,
              coverUrl: latest.coverUrl,
              durationSec: latest.durationSec,
              createdAt: latest.createdAt.toISOString(),
              preset: latest.preset,
            },
          }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
