import { NextRequest, NextResponse } from "next/server";
import { loginViaNewApi, getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { signEmuOauthCode } from "@/lib/emu-oauth";
import {
  buildGitHubEmail,
  buildGitHubPassword,
  buildGitHubUsername,
  extractTicketFromState,
  type GitHubProfile,
} from "@/lib/github-auth";
import { deliverHandoff } from "@/lib/pwa-handoff";
import { ensureGatewayUserForOAuth } from "@/lib/gateway-admin";
import { FIRST_TOUCH_COOKIE, decodeFirstTouchCookieValue, type GitHubEmailEntry } from "@/lib/first-touch-attribution";
import { buildOAuthAttributionInput, recordUserAttributionViaRelay } from "@/lib/user-attribution";

export const preferredRegion = "sfo1";

// 外呼硬超时：本路由在回调请求内串行打 GitHub 与控面，任何一跳 hang 死都会
// 占满函数时限；GitHub/控面正常应答远低于 5s，超时即快速失败走既有 catch。
const GITHUB_UPSTREAM_TIMEOUT_MS = 5_000;

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
    signal: AbortSignal.timeout(GITHUB_UPSTREAM_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(GITHUB_UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("获取 GitHub 用户信息失败");
  return response.json() as Promise<GitHubProfile>;
}

// 可触达通道的原料：/user/emails 需要 user:email scope（authorize URL 已申请）。
// 旧授权若没有这个 scope 会回 404/403 —— 那不是登入失败，只回空阵列（email 留给下次登入补）。
async function fetchGithubEmails(accessToken: string): Promise<GitHubEmailEntry[]> {
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "eimu.dev",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? (data as GitHubEmailEntry[]) : [];
  } catch {
    return [];
  }
}

async function registerGithubUser(profile: GitHubProfile, password: string) {
  const username = buildGitHubUsername(profile);
  const email = buildGitHubEmail(profile);
  try {
    // 已存在（老用户）由 ensureGatewayUserForOAuth 内部按复用吸收，不抛。
    await ensureGatewayUserForOAuth({ username, password });
  } catch (error) {
    console.error("[auth/github/register]", {
      username,
      email,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stateCookie = req.cookies.get("github_oauth_state")?.value;

  // PWA 跨浏览器交接分支：state 内嵌 handoff ticket（常用浏览器打开授权链
  // 接，无本站 state cookie）。ticket 是 128-bit 随机 hex + 一次性消费，足以
  // 替代 state cookie 的 CSRF 防护；其余（exchange/注册/login）全走原路径。
  const handoffTicket = state ? extractTicketFromState(state) : null;
  if (handoffTicket) {
    // 落进下方共享流程；仅在 state 校验与最终 redirect 两处分叉。
    // handoff 链路同样必须有 code：GitHub 只在成功授权时回跳。
    if (!code) {
      return NextResponse.redirect(`${getBaseUrl(req)}/?auth_error=github_state`);
    }
  } else if (!code || !state || !stateCookie || state !== stateCookie) {
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

    // 侧车事实（触达 email ＋ 首次触达归因）：每次登入幂等 upsert，老用户再登入一次即被补上。
    // 绝不挡登入：失败只记 user_id 与错误讯息（email 永不进日志），流程照走。
    try {
      const emails = await fetchGithubEmails(tokenResult.access_token);
      await recordUserAttributionViaRelay(
        buildOAuthAttributionInput({
          userId: loginResult.user.id,
          provider: "github",
          githubEmails: emails,
          firstTouch: decodeFirstTouchCookieValue(req.cookies.get(FIRST_TOUCH_COOKIE)?.value),
        }),
      );
    } catch (error) {
      console.error(
        `[auth/github/attribution] skipped user=${loginResult.user.id}：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // PWA 交接分支：把会话投递到 ticket（PWA 侧轮询 claim 领回）；投递失败
    // 不挡主流程——浏览器侧照常拿到 cookie。
    if (handoffTicket) {
      try {
        await deliverHandoff(handoffTicket, loginResult.token, loginResult.user);
      } catch (error) {
        console.error("[auth/github/handoff-deliver]", error);
      }
      const handoffRedirect = NextResponse.redirect(`${getBaseUrl(req)}/auth/complete?handoff=1`);
      handoffRedirect.cookies.set("github_oauth_state", "", { path: "/", maxAge: 0 });
      handoffRedirect.cookies.set("napi_token", loginResult.token, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        secure: true,
      });
      handoffRedirect.cookies.set("napi_user", encodeURIComponent(JSON.stringify(loginResult.user)), {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        secure: true,
      });
      return handoffRedirect;
    }

    const redirect = NextResponse.redirect(`${getBaseUrl(req)}/auth/complete`);
    redirect.cookies.set("github_oauth_state", "", { path: "/", maxAge: 0 });
    redirect.cookies.set("napi_token", loginResult.token, {
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "lax",
      secure: true,
    });
    // 值必须 encodeURIComponent：客户端 setCookieValue/getCookieValue 按
    // encode/decode 对称写死，裸 JSON 含 `"` `,` 属 RFC 6265 非法字节，
    // 严格的浏览器会整颗丢弃 → localStorage 被清后 cookie 兜底失效，
    // 表现就是「明明登过录却偶尔跳未登录」（2026-09-05）。
    redirect.cookies.set("napi_user", encodeURIComponent(JSON.stringify(loginResult.user)), {
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