// GET /api/notifications/banners — 当前用户生效中的横幅。
//
// 生效规则＝启用 + 时间窗（起讫，含端点）+ 可选受众范围；再减去该用户已关闭的。
// 关闭走 POST /api/notifications/banners/[id]/dismiss（按用户记，不是全局关闭）。
//
// 本路由只交付机制，不含任何运营文案。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { activeBanners } from "@/lib/notification-store";

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
    const banners = await activeBanners({ userId: auth.user.id });
    return NextResponse.json({ success: true, data: { banners } });
  } catch (error) {
    console.error("[notifications] 读取横幅失败。", error);
    return fail(503, "横幅暂时不可用，请稍后再试。", "banner_list_failed");
  }
}
