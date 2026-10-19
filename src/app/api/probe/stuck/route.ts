import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { listStuckJobs } from "@/lib/generation-core/job-events";

// P1.5 probe 侦查面：滞留名单 + 死因分类（pending_billing 未受理 / running 轮询断 /
// billing_unknown / 终态未投影）。鉴权沿用 admin 后台门禁，不造新轮子。
// 自检永不模拟成功：名单为空就返回空阵列，不伪造健康。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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
