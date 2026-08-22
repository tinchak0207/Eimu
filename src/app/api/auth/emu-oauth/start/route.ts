import { NextRequest, NextResponse } from "next/server";
import { buildGitHubAuthorizeUrl, createGitHubState } from "@/lib/github-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function getBaseUrl(req: NextRequest) {
  return process.env.NEXT_PUBLIC_APP_URL
    ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

/**
 * GET /api/auth/emu-oauth/start?port=<loopback 端口>
 *
 * DSH 插件一键授权入口：与 github/start 完全相同的 state + authorizeUrl 构造
 * （redirect_uri 仍是站点 callback，不能改），额外把回环地址写进
 * emu_oauth_loopback cookie，callback 成功后据此 302 回插件本地 server。
 */
export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ success: false, message: "GitHub OAuth 未配置" }, { status: 500 });
  }

  const rawPort = req.nextUrl.searchParams.get("port");
  if (!rawPort || !/^\d{1,5}$/.test(rawPort)) {
    return NextResponse.json(
      { success: false, message: "缺少有效的 port 参数。", code: "invalid_port" },
      { status: 400 },
    );
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json(
      { success: false, message: "缺少有效的 port 参数。", code: "invalid_port" },
      { status: 400 },
    );
  }

  const loopback = `http://127.0.0.1:${port}`;
  const state = createGitHubState();
  const redirectUri = `${getBaseUrl(req)}/api/auth/github/callback`;
  const authorizeUrl = buildGitHubAuthorizeUrl({ clientId, state, redirectUri });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set("github_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  response.cookies.set("emu_oauth_loopback", loopback, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}
