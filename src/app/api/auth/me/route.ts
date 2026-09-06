import { NextRequest, NextResponse } from "next/server";
import { MOCK_MODE, mockGetSelf } from "@/lib/mock";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

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
    const data = await upstream.json().catch(() => null) as
      | { success?: boolean; message?: string; data?: unknown }
      | null;

    // new-api 对 Bearer 模式强制 New-Api-User 头；前端 user 存储可能是坏残留
    // （缺失或旧 id）。token 的唯一可信 userId 在控面稳定令牌表——反查重试。
    if (!upstream.ok || !data?.success) {
      const lookedUp = await lookupUserIdByTokenViaRelay(token);
      if (lookedUp) {
        const retry = await fetch(`${getGatewayBaseUrl()}/api/user/self`, {
          headers: { Authorization: `Bearer ${token}`, "New-Api-User": String(lookedUp) },
          cache: "no-store",
        });
        if (retry.ok) {
          const retryData = await retry.json().catch(() => null);
          if (retryData?.success) return NextResponse.json(retryData);
        }
      }
    }

    if (!upstream.ok || !data?.success) {
      console.error("[auth/me] upstream rejected", {
        status: upstream.status,
        message: data?.message ?? null,
        tokenPrefix: token.slice(0, 8),
        hasUserIdHeader: Boolean(userIdHeader),
      });
      return NextResponse.json(
        { success: false, message: upstream.status === 401 ? "session_expired" : data?.message ?? "获取用户信息失败" },
        { status: upstream.status === 401 ? 401 : 502 },
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error("[auth/me]", err);
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}
