// GET /api/notifications/active-modal — 当前用户尚未读过的弹窗（没有则 data.modal = null）。
//
// 「未读过」＝ active 的 modal 面公告中，该用户尚未标记已读者；取最新一条。
// 本端点**无副作用**（GET 不留写痕迹）：前端展示后调 POST /api/notifications/mark-read
// 带 announcementIds 标记，弹窗才会消失。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { activeModal } from "@/lib/notification-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  try {
    const modal = await activeModal({ userId: auth.user.id });
    return NextResponse.json({ success: true, data: { modal } });
  } catch (error) {
    console.error("[notifications] 读取弹窗失败。", error);
    return fail(503, "弹窗暂时不可用，请稍后再试。", "active_modal_failed");
  }
}
