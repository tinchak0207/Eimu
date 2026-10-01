import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getJobTimeline } from "@/lib/generation-core/job-events";

// P1.5 probe 偵查面：一條命令 30 秒出死因（含上游錯誤原文），不開 docker exec、不進 VPS。
// 鑑權沿用 admin 後台門禁（與 /api/admin/* 同源），不造新輪子。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;
    const timeline = await getJobTimeline(id);
    if (!timeline) {
      return NextResponse.json({ success: false, message: "Job not found." }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...timeline });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Probe timeline failed.";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
