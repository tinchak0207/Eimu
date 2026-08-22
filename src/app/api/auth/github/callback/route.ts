import { NextRequest, NextResponse } from "next/server";
import { loginViaNewApi, getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { signEmuOauthCode } from "@/lib/emu-oauth";
import {
  buildGitHubEmail,
  buildGitHubPassword,
  buildGitHubUsername,
  type GitHubProfile,
} from "@/lib/github-auth";

export const preferredRegion = "sfo1";

function getBaseUrl(req: NextRequest) {
  return process.env.NEXT_PUBLIC_APP_URL
    ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

async function exchangeGithubCode(input: { code: string; redirectUri: string }) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    cache: "no-store",
  });
  return response.json() as Promise<{ access_token?: string; error?: string; error_description?: string }>;
}

async function fetchGithubProfile(accessToken: string) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "eimu.dev",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("获取 GitHub 用户信息失败");
  return response.json() as Promise<GitHubProfile>;
}

async function registerGithubUser(profile: GitHubProfile, password: string) {
  const gatewayBase = getGatewayBaseUrl();
  const username = buildGitHubUsername(profile);
  const email = buildGitHubEmail(profile);
  const response = await fetch(`${gatewayBase}/api/user/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      email,
    }),
    cache: "no-store",
  });

  const data = await response.json().catch(() => null) as { success?: boolean; message?: string } | null;
  if (!response.ok || !data?.success) {
    console.error("[auth/github/register]", { username, email, status: response.status, message: data?.message });
    if (data?.message?.includes("已存在") || data?.message?.includes("exists")) return;
    throw new Error(data?.message || "GitHub 用户自动注册失败");
  }
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stateCookie = req.cookies.get("github_oauth_state")?.value;

  if (!code || !state || !stateCookie || state !== stateCookie) {
    return NextResponse.redirect(`${getBaseUrl(req)}/?auth_error=github_state`);
  }

  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return NextResponse.redirect(`${getBaseUrl(req)}/?auth_error=github_config`);
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/api/auth/github/callback`;
    const tokenResult = await exchangeGithubCode({ code, redirectUri });
    if (!tokenResult.access_token) {
      throw new Error(`github_exchange:${tokenResult.error_description || tokenResult.error || "unknown"}`);
    }

    const profile = await fetchGithubProfile(tokenResult.access_token);
    const passwordSeed = process.env.GITHUB_LOGIN_SECRET || process.env.GITHUB_CLIENT_SECRET;
    const password = buildGitHubPassword(profile, passwordSeed);
    const username = buildGitHubUsername(profile);

    try {
      await registerGithubUser(profile, password);
    } catch (error) {
      throw new Error(`github_register:${error instanceof Error ? error.message : "unknown"}`);
    }

    const loginResult = await loginViaNewApi(getGatewayBaseUrl(), username, password);
    if (!loginResult.ok) {
      console.error("[auth/github/login]", { username, status: loginResult.status, message: loginResult.message });
      throw new Error(`github_login:${loginResult.message || "unknown"}`);
    }

    const redirect = NextResponse.redirect(`${getBaseUrl(req)}/auth/complete`);
    redirect.cookies.set("github_oauth_state", "", { path: "/", maxAge: 0 });
    redirect.cookies.set("napi_token", loginResult.token, {
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "lax",
      secure: true,
    });
    redirect.cookies.set("napi_user", JSON.stringify(loginResult.user), {
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "lax",
      secure: true,
    });
    // Emu OAuth 回环：start 路由种过 emu_oauth_loopback cookie 时，
    // 把用户已登录的事实签成 60s 凭证，302 回插件本地 loopback server。
    // napi_token / napi_user 照常设置 —— 用户同时保持站点登录。
    const loopback = req.cookies.get("emu_oauth_loopback")?.value;
    if (loopback) {
      const code = signEmuOauthCode(loginResult.user.id);
      redirect.cookies.set("emu_oauth_loopback", "", { path: "/", maxAge: 0 });
      redirect.headers.set(
        "Location",
        `${loopback}/emu-oauth/callback?code=${encodeURIComponent(code)}`,
      );
    }
    return redirect;
  } catch (error) {
    console.error("[auth/github/callback]", error);
    const message = error instanceof Error ? error.message : "github_unknown";
    const codeName = message.split(":", 1)[0] || "github_unknown";
    return NextResponse.redirect(`${getBaseUrl(req)}/?auth_error=${codeName}`);
  }
}