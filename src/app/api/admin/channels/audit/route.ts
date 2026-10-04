// 渠道 overrides 的稽核纪录查询：GET 回传最近 N 笔变更（谁、何时、diff、完整快照）。
// 认证与 route.ts 同一套 requireAdminSession——没有 session 就 401，不做任何弱化。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { listConfigChanges } from "@/lib/admin-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();

    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;

    const changes = await listConfigChanges("channel-overrides", limit);
    return NextResponse.json({ success: true, changes });
  } catch (error) {
    return errorResponse(error);
  }
}
