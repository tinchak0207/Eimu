import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getAdobeAccessToken } from "@/lib/adobe-oauth-token";

export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET() {
  try {
    await requireAdminSession();
    return NextResponse.json({ accessToken: await getAdobeAccessToken() });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "管理员登录已失效" }, { status: 401 });
    }
    return NextResponse.json({ error: "Adobe OAuth 未连接，请重新授权" }, { status: 401 });
  }
}
