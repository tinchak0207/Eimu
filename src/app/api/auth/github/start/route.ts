import { NextRequest, NextResponse } from "next/server";
import { buildGitHubAuthorizeUrl, createGitHubState, embedTicketInState } from "@/lib/github-auth";

export const preferredRegion = "sfo1";

function getBaseUrl(req: NextRequest) {
  return process.env.NEXT_PUBLIC_APP_URL
    ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ success: false, message: "GitHub OAuth 未配置" }, { status: 500 });
  }

  // PWA 跨浏览器交接：?handoff=<ticket> 时把 ticket 嵌进 state（callback 侧
  // 经 extractTicketInState… extractTicketFromState 取回；该分支靠 ticket 的
  // 128-bit 随机 + 一次性消费防护）。无参数时行为不变。
  const handoffTicket = req.nextUrl.searchParams.get("handoff")?.trim() || "";
  const state = handoffTicket
    ? embedTicketInState(createGitHubState(), handoffTicket)
    : createGitHubState();
  const redirectUri = `${getBaseUrl(req)}/api/auth/github/callback`;
  const authorizeUrl = buildGitHubAuthorizeUrl({
    clientId,
    state,
    redirectUri,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("github_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}
