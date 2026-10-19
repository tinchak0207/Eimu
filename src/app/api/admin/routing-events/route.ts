// 路由遥测的 admin 读取面：回传最近的路由事件与按渠道聚合的统计。
// sampleNote 如实标注统计窗口大小——聚合只覆盖取回的这批事件，不是全历史。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { listRoutingEvents, summarizeModelBreakdown, summarizeRoutingEvents } from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const DEFAULT_LIMIT = 50;

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();

    const rawLimit = req.nextUrl.searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        return NextResponse.json({ success: false, message: "limit 必须是 1 到 200 的整数。" }, { status: 400 });
      }
      limit = parsed;
    }

    const events = await listRoutingEvents(limit);
    return NextResponse.json({
      events,
      aggregates: summarizeRoutingEvents(events),
      modelBreakdown: summarizeModelBreakdown(events),
      sampleNote: `统计窗口：最近 ${events.length} 条事件`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "读取路由事件失败。";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
