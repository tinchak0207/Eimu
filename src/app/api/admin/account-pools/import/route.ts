import { NextRequest, NextResponse } from "next/server";
import { buildAccountImportRequest, normalizeAccountImportResult, sanitizeSub2APIError, sub2APIAdminFetch } from "@/lib/sub2api-admin";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();
    const request = buildAccountImportRequest(await req.json() as Record<string, unknown>);
    const response = await sub2APIAdminFetch(request.path, {
      method: "POST",
      body: JSON.stringify(request.payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return NextResponse.json({ success: false, message: sanitizeSub2APIError(body, response.status) }, { status: 502 });
    return NextResponse.json({ success: true, data: normalizeAccountImportResult(body, request.format) });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "SUB2API_NOT_CONFIGURED") {
      return NextResponse.json({ success: false, message: "Sub2API 管理连接尚未配置。" }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "导入失败。";
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
