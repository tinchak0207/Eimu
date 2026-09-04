import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { listStuckJobs } from "@/lib/generation-core/job-events";

// P1.5 probe 偵查面：滯留名單 + 死因分類（pending_billing 未受理 / running 輪詢斷 /
// billing_unknown / 終態未投影）。鑑權沿用 admin 後台門禁，不造新輪子。
// 自檢永不模擬成功：名單為空就返回空陣列，不偽造健康。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();
    const rawMinutes = Number(req.nextUrl.searchParams.get("minutes") ?? 30);
    const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.min(Math.floor(rawMinutes), 60 * 24 * 7) : 30;
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 200;
    const jobs = await listStuckJobs({ minutes, limit });
    return NextResponse.json({ success: true, minutes, count: jobs.length, jobs });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Probe stuck failed.";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
