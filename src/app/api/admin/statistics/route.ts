// GET /api/admin/statistics — 管理側統計視圖的只讀端點（PRD REQ-C2）。
//
// 這個端點只做三件事：驗管理員 session、驗窗口參數、回一份投影。
// 所有數字都由 statistics-projection.ts 從既有帳本/能力表讀出，本路由不含任何 SQL、
// 更不含任何寫入（計費、扣額、重試一律不碰）。模型三態不在這裡重算——管理頁直接
// 消費既有的 /api/user/model-status（與 /v1/model-status 同一份判活），避免兩套判活。

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

    // 內部流量預設不計；只有明確 includeInternal=1/true 才計入。
    const rawInclude = req.nextUrl.searchParams.get("includeInternal");
    const includeInternal = rawInclude === "1" || rawInclude === "true";

    // 導出格式（P2-1／對稱差 D16）：`format=csv` 回同一個投影的 CSV（Excel 可直接開）。
    // 只認 json／csv 兩種，其餘具名 400——避免拼錯 format 卻拿到一份 JSON 以為是導出檔。
    const format = req.nextUrl.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") {
      return NextResponse.json({ success: false, message: "format 只能是 json 或 csv。" }, { status: 400 });
    }

    const projection = await buildStatisticsProjection({ days, funnelDays, includeInternal });
    if (format === "csv") {
      // 導出檔與畫面上看到的數字**同一份投影**（統計頁不是第二個真相，導出檔也不是）。
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
