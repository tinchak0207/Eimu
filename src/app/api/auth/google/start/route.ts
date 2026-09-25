import { NextRequest, NextResponse } from "next/server";
import { buildGoogleAuthorizeUrl, createGoogleState } from "@/lib/google-auth";
import { embedTicketInState } from "@/lib/github-auth";

export const preferredRegion = "sfo1";

function getBaseUrl(req: NextRequest) {
  return process.env.NEXT_PUBLIC_APP_URL
    ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  // PWA 跨浏览器交接：?handoff=<ticket> 时把 ticket 嵌进 state（callback 侧
  // 经 extractTicketFromState 取回；该分支靠 ticket 的 128-bit 随机 +
  // 一次性消费防護）。无参数时行为不变。
  const handoffTicket = req.nextUrl.searchParams.get("handoff")?.trim() || "";
  if (!clientId) {
    // handoff 入口由 PWA 面板消费 JSON，保持原契约；一般入口是登录按钮，
    // 停在 JSON 死页会让用户看到裸报错，改为带着错误码回首页。
    if (handoffTicket) {
      return NextResponse.json({ success: false, message: "Google OAuth 未配置" }, { status: 500 });
    }
    return NextResponse.redirect(`${getBaseUrl(req)}/?auth_error=google_config`);
  }

  const state = handoffTicket
    ? embedTicketInState(createGoogleState(), handoffTicket)
    : createGoogleState();
  const redirectUri = `${getBaseUrl(req)}/api/auth/google/callback`;
  const authorizeUrl = buildGoogleAuthorizeUrl({
    clientId,
    state,
    redirectUri,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}
