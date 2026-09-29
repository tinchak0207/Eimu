// GET /api/notifications — 当前登录用户的通知列表 + 未读计数。
//
// 鉴权复用 requireVerifiedUser（上游校验 Authorization + x-user-id），
// 用户 id 只来自校验结果，绝不读客户端自称的 x-user-id 直接授权。
//
// 返回的通知里包含两类条目（kind 判别）：个人通知与对该用户生效的 inbox 面公告。
// 「已读」全部按当前 userId 计算 —— 读别人已读标记的路径不存在。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  NOTIFICATION_PAGE_SIZE,
  listInboxForUser,
  unreadCountForUser,
} from "@/lib/notification-store";

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
    const page = await listInboxForUser(auth.user.id, {
      page: req.nextUrl.searchParams.get("page"),
      pageSize: req.nextUrl.searchParams.get("pageSize") ?? NOTIFICATION_PAGE_SIZE,
    });
    const unreadCount = await unreadCountForUser(auth.user.id);

    return NextResponse.json({
      success: true,
      data: {
        notifications: page.items,
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.hasMore,
        unreadCount,
      },
    });
  } catch (error) {
    console.error("[notifications] 读取通知列表失败。", error);
    return fail(503, "通知列表暂时不可用，请稍后再试。", "notification_list_failed");
  }
}
