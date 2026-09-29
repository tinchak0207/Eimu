// POST /api/notifications/banners/[id]/dismiss — 关闭一条横幅（按用户记）。
//
// 关闭状态落在 notifications/u/<userId>/ 里，只影响当前用户；
// 别人仍然看得到同一条横幅。重复关闭返回 dismissed=false（幂等，不报错）。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { dismissBanner } from "@/lib/notification-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  try {
    const { id } = await context.params;
    const dismissed = await dismissBanner(auth.user.id, id);
    return NextResponse.json({ success: true, data: { id, dismissed } });
  } catch (error) {
    console.error("[notifications] 关闭横幅失败。", error);
    return fail(503, "关闭横幅暂时不可用，请稍后再试。", "banner_dismiss_failed");
  }
}
