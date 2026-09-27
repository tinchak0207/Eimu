// POST /api/notifications/mark-read — 标记个人通知 / 公告已读。
//
// body: { notificationIds?: string[], announcementIds?: string[] }
//
// 只写当前登录用户自己的已读子文档（notifications/u/<userId>/），
// 不存在「全局已读」这条路。返回重算后的未读数，让前端不必再拉一次列表。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { markNotificationsRead } from "@/lib/notification-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

export async function POST(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体格式不正确。", "invalid_request");
  }

  try {
    const result = await markNotificationsRead(auth.user.id, {
      notificationIds: body.notificationIds,
      announcementIds: body.announcementIds,
    });
    return NextResponse.json({
      success: true,
      data: {
        notificationIds: result.notificationIds,
        announcementIds: result.announcementIds,
        unreadCount: result.unreadCount,
      },
    });
  } catch (error) {
    console.error("[notifications] 标记已读失败。", error);
    return fail(503, "标记已读暂时不可用，请稍后再试。", "mark_read_failed");
  }
}
