import { NextRequest, NextResponse } from "next/server";
import { readAdminPools } from "@/lib/admin-pool-store";
import { inferSupportedModels } from "@/lib/admin-pools";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;
    const pool = (await readAdminPools()).find((item) => item.id === id);
    if (!pool) return NextResponse.json({ success: false, message: "渠道不存在。" }, { status: 404 });

    const startedAt = Date.now();
    const response = await fetch(`${pool.baseURL}/models`, {
      headers: { Authorization: `Bearer ${pool.apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      return NextResponse.json(
        { success: false, message: `上游返回 HTTP ${response.status}`, elapsedMs },
        { status: 502 },
      );
    }
    const payload = await response.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;
    if (Array.isArray(payload?.data)) {
      const available = new Set(payload.data.map((model) => model.id).filter(Boolean));
      const missing = inferSupportedModels(pool).filter((model) => !available.has(model));
      if (missing.length > 0) {
        return NextResponse.json(
          { success: false, message: `渠道未返回已声明模型：${missing.join("、")}`, elapsedMs },
          { status: 502 },
        );
      }
    }
    return NextResponse.json({ success: true, message: "连接、授权和模型能力正常。", elapsedMs });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    const message = error instanceof Error && error.name === "TimeoutError" ? "连接超时。" : "无法连接上游。";
    return NextResponse.json({ success: false, message }, { status: 502 });
  }
}
