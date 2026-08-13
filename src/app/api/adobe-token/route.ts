import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getAdobeAccessToken } from "@/lib/adobe-oauth-token";

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
