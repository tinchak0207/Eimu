// GET /api/notifications/announcements/[id] — 公告详情。
//
// 受众与生效期用的是列表那一把尺（getAnnouncementForUser）：不在时间窗内、
// 已停用、或受众不含当前用户，一律 404。列表看不到但直连 id 能看到 = 旁路，不留。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { getAnnouncementForUser } from "@/lib/notification-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  try {
    const { id } = await context.params;
    const announcement = await getAnnouncementForUser(id, auth.user.id);
    if (!announcement) return fail(404, "公告不存在或已下线。", "announcement_not_found");

    return NextResponse.json({ success: true, data: announcement });
  } catch (error) {
    console.error("[notifications] 读取公告详情失败。", error);
    return fail(503, "公告详情暂时不可用，请稍后再试。", "announcement_detail_failed");
  }
}
