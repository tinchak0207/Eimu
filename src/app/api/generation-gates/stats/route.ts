// GET /api/generation-gates/stats —— 当前用户的生成品质门聚合统计。
// 认证：requireVerifiedUser（与 character-cards / canvas 同款，不信任 x-user-id）。
// 存储：generation-gate-log（Blob 世代模式，对齐 project-store）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { aggregateGateStats, listGateLog } from "@/lib/generation-gate-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) {
    return NextResponse.json(
      { success: false, error: caller.message, code: "unauthorized" },
      { status: caller.status },
    );
  }
  try {
    const entries = await listGateLog(caller.user.id);
    const stats = aggregateGateStats(entries);
    return NextResponse.json(
      { success: true, totalEntries: entries.length, stats },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[generation-gates] stats failed:", error);
    return NextResponse.json(
      { success: false, error: "读取生成质量门统计失败，请稍后再试", code: "internal_error" },
      { status: 500 },
    );
  }
}
