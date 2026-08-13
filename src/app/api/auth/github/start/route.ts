import { NextRequest, NextResponse } from "next/server";
import { buildGitHubAuthorizeUrl, createGitHubState } from "@/lib/github-auth";

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

  const state = createGitHubState();
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
