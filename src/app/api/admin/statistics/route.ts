// GET /api/admin/statistics — 管理侧统计视图的只读端点（PRD REQ-C2）。
//
// 这个端点只做三件事：验管理员 session、验窗口参数、回一份投影。
// 所有数字都由 statistics-projection.ts 从既有帐本/能力表读出，本路由不含任何 SQL、
// 更不含任何写入（计费、扣额、重试一律不碰）。模型三态不在这里重算——管理页直接
// 消费既有的 /api/user/model-status（与 /v1/model-status 同一份判活），避免两套判活。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import {
  DEFAULT_FUNNEL_DAYS,
  DEFAULT_WINDOW_DAYS,
  FUNNEL_WINDOW_OPTIONS,
  MAX_WINDOW_DAYS,
  buildStatisticsProjection,
} from "@/lib/generation-core/statistics-projection";
import { statisticsCsvFilename, statisticsToCsv } from "@/lib/generation-core/statistics-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();

    const rawDays = req.nextUrl.searchParams.get("days");
    let days = DEFAULT_WINDOW_DAYS;
    if (rawDays !== null) {
      const parsed = Number(rawDays);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
        return NextResponse.json(
          { success: false, message: `days 必须是 1 到 ${MAX_WINDOW_DAYS} 的整数。` },
          { status: 400 },
        );
      }
      days = parsed;
    }

    const rawFunnelDays = req.nextUrl.searchParams.get("funnelDays");
    let funnelDays = DEFAULT_FUNNEL_DAYS;
    if (rawFunnelDays !== null) {
      const parsed = Number(rawFunnelDays);
      if (!(FUNNEL_WINDOW_OPTIONS as readonly number[]).includes(parsed)) {
        return NextResponse.json(
          { success: false, message: `funnelDays 只能是 ${FUNNEL_WINDOW_OPTIONS.join(" 或 ")}。` },
          { status: 400 },
        );
      }
      funnelDays = parsed;
    }

    // 内部流量预设不计；只有明确 includeInternal=1/true 才计入。
    const rawInclude = req.nextUrl.searchParams.get("includeInternal");
    const includeInternal = rawInclude === "1" || rawInclude === "true";

    // 导出格式（P2-1／对称差 D16）：`format=csv` 回同一个投影的 CSV（Excel 可直接开）。
    // 只认 json／csv 两种，其余具名 400——避免拼错 format 却拿到一份 JSON 以为是导出档。
    const format = req.nextUrl.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") {
      return NextResponse.json({ success: false, message: "format 只能是 json 或 csv。" }, { status: 400 });
    }

    const projection = await buildStatisticsProjection({ days, funnelDays, includeInternal });
    if (format === "csv") {
      // 导出档与画面上看到的数字**同一份投影**（统计页不是第二个真相，导出档也不是）。
      return new NextResponse(statisticsToCsv(projection), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${statisticsCsvFilename(projection)}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ success: true, ...projection }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "读取统计数据失败。");
  }
}
