import { ensureNewApiSessionTokenViaRelay } from "@/lib/newapi-session-token";

type NewApiUserData = {
  id: number;
  username: string;
  display_name?: string;
  role?: number;
  status?: number;
  group?: string;
  email?: string;
  quota?: number;
  used_quota?: number;
};

type LoginResult = {
  success: boolean;
  message?: string;
  data?: NewApiUserData;
};

type SelfResult = {
  success: boolean;
  message?: string;
  data?: NewApiUserData;
};

type TokenResult = {
  success: boolean;
  message?: string;
  data?: string;
};

// [riskclose 2026-09-27] TLS channel: nginx store vhost rewrites /newapi/* -> new-api.
// The old bare-IP plaintext gateway (http://43.172.85.76) had its /api management
// surface closed with 444; only this TLS path is reachable by the Vercel site.
const PROD_GATEWAY_BASE = "https://store.tinchak0207.xyz/newapi";

export function getGatewayBaseUrl() {
  return (process.env.GATEWAY_BASE_URL
    ?? (process.env.NODE_ENV === "production" ? PROD_GATEWAY_BASE : "http://localhost:3001"))
    .replace(/^\uFEFF+/, "")
    .trim();
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

function getCookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function fetchSelf(baseUrl: string, cookieHeader: string, userId: number) {
  const response = await fetch(`${baseUrl}/api/user/self`, {
    headers: {
      Cookie: cookieHeader,
      "New-Api-User": String(userId),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  const data = await parseJson<SelfResult>(response);
  return { response, data };
}

async function fetchAccessToken(baseUrl: string, cookieHeader: string, userId: number) {
  const response = await fetch(`${baseUrl}/api/user/token`, {
    headers: {
      Cookie: cookieHeader,
      "New-Api-User": String(userId),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  const data = await parseJson<TokenResult>(response);
  return { response, data };
}

export async function loginViaNewApi(baseUrl: string, username: string, password: string) {
  const loginResponse = await fetch(`${baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  const loginData = await parseJson<LoginResult>(loginResponse);
  if (!loginResponse.ok || !loginData.success || !loginData.data?.id) {
    return {
      ok: false,
      status: 401,
      message: loginData.message ?? "登录失败，请重试",
    } as const;
  }

  const cookieHeader = getCookieHeader(loginResponse);
  if (!cookieHeader) {
    return {
      ok: false,
      status: 503,
      message: "后端没有返回 session cookie。",
    } as const;
  }

  const userId = loginData.data.id;

  const { response: selfResponse, data: selfData } = await fetchSelf(baseUrl, cookieHeader, userId);

  if (!selfResponse.ok || !selfData.success || !selfData.data) {
    return {
      ok: false,
      status: 503,
      message: selfData.message ?? "获取用户信息失败。",
    } as const;
  }

  // 优先走控制面的稳定会话令牌（/api/user/token 每次调用都会重置该用户的
  // 唯一 access_token，任何一次新登录会杀掉所有旧会话；稳定通道查表验活
  // 复用同一 token）。通道未配置或失败 → 回退原重置型端点（本地开发/降级）。
  const ensured = await ensureNewApiSessionTokenViaRelay(userId, cookieHeader);
  if (ensured) {
    return {
      ok: true,
      token: ensured.token,
      user: selfData.data,
    } as const;
  }

  const { response: tokenResponse, data: tokenData } = await fetchAccessToken(baseUrl, cookieHeader, userId);

  if (!tokenResponse.ok || !tokenData.success || !tokenData.data) {
    return {
      ok: false,
      status: 503,
      message: tokenData.message ?? "生成 access token 失败。",
    } as const;
  }

  return {
    ok: true,
    token: tokenData.data,
    user: selfData.data,
  } as const;
}
