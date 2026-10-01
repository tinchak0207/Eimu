// 路由遙測的 admin 讀取面：回傳最近的路由事件與按渠道聚合的統計。
// sampleNote 如實標註統計窗口大小——聚合只覆蓋取回的這批事件，不是全歷史。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { listRoutingEvents, summarizeModelBreakdown, summarizeRoutingEvents } from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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
