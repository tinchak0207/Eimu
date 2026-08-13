import { NextRequest, NextResponse } from "next/server";
import { MOCK_MODE, mockGetSelf } from "@/lib/mock";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";

export const preferredRegion = "sfo1";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const userIdHeader = req.headers.get("x-user-id");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, message: "未授权" }, { status: 401 });
  }
  const token = authHeader.slice(7);

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (MOCK_MODE) {
    const result = mockGetSelf(token);
    return NextResponse.json(result, { status: result.success ? 200 : 401 });
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (userIdHeader) headers["New-Api-User"] = userIdHeader;
    const upstream = await fetch(`${getGatewayBaseUrl()}/api/user/self`, {
      headers,
      cache: "no-store",
    });
    if (upstream.status === 401) {
      return NextResponse.json({ success: false, message: "session_expired" }, { status: 401 });
    }
    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[auth/me]", err);
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}
