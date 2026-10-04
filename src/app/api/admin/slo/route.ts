// SLO 唯读面：GET 回报窗口内每个 (tenant, model) 分组的成功率/延迟/退款等指标，
// 以及依门槛计算出的 breach 清单。这条路由读的是租户级成本/可靠性资料，
// 跟 /api/admin/channels 一样走 requireAdminSession，不对外公开。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { computeSloWindow, evaluateSloBreaches, type SloThresholds } from "@/lib/generation-core/slo-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_THRESHOLDS: SloThresholds = {
  minSuccessRate: 0.95,
  maxP95LatencyMs: 30_000,
  maxRefundRate: 0.02,
};

function parsePositiveNumber(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFraction(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "查询失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();

    const params = req.nextUrl.searchParams;
    const tenantId = params.get("tenantId")?.trim() || undefined;
    const modelId = params.get("modelId")?.trim() || undefined;
    const windowMinutes = parsePositiveNumber(params.get("windowMinutes"), DEFAULT_WINDOW_MINUTES);

    const thresholds: SloThresholds = {
      minSuccessRate: parseFraction(params.get("minSuccessRate"), DEFAULT_THRESHOLDS.minSuccessRate),
      maxP95LatencyMs: parsePositiveNumber(params.get("maxP95LatencyMs"), DEFAULT_THRESHOLDS.maxP95LatencyMs),
      maxRefundRate: parseFraction(params.get("maxRefundRate"), DEFAULT_THRESHOLDS.maxRefundRate),
    };

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60_000);

    const rows = await computeSloWindow({ tenantId, modelId, windowStart, windowEnd });
    const breaches = evaluateSloBreaches(rows, thresholds);

    return NextResponse.json({ rows, breaches, windowStart, windowEnd, thresholds });
  } catch (error) {
    return errorResponse(error);
  }
}
